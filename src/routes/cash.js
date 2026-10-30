/* Direction financière — paiements en espèces en agence (§42), clôture de caisse (§43)
   et clôture financière journalière (§69). Chaque recette espèces a une référence, une caisse et un agent. */
const router = require("express").Router();
const { q, one } = require("../config/db");
const U = require("../lib/util");
const { requireStaff, can } = require("../middleware/auth");
const PAY = require("./payments");
const { h, fail, str, fcfa } = U;

router.use(requireStaff);

const openSession = (agency) => one("SELECT * FROM cash_sessions WHERE agency_id = ? AND status = 'OUVERTE'", [agency]);
const sessionTotals = async s => {
  const r = await one("SELECT COUNT(*) n, COALESCE(SUM(amount), 0) total FROM payments WHERE cash_session_id = ? AND status IN ('RÉUSSI','REMBOURSÉ')", [s.id]);
  return { n: r.n, encaissements: +r.total, theorique: s.opening_balance + +r.total };
};

/* ---------- caisse de l'agence ---------- */
router.get("/cash", can("cash.collect", "finance.view"), h(async (req, res) => {
  const agency = req.staff.agency_id;
  const cur = agency ? await openSession(agency) : null;
  const sessions = await q(`SELECT c.*, a.nom agence, CONCAT(s.prenom, ' ', s.nom) caissier, CONCAT(v.prenom, ' ', v.nom) controleur,
      (SELECT COUNT(*) FROM payments p WHERE p.cash_session_id = c.id) n
    FROM cash_sessions c JOIN agencies a ON a.id = c.agency_id LEFT JOIN staff s ON s.id = c.staff_id LEFT JOIN staff v ON v.id = c.controlled_by
    ${agency && !req.staff.perms.includes("finance.view") ? "WHERE c.agency_id = ?" : ""} ORDER BY c.id DESC LIMIT 100`, agency ? [agency] : []);
  res.json({
    agency: agency ? (await one("SELECT id, nom FROM agencies WHERE id = ?", [agency])) : null,
    current: cur ? { ...cur, ...(await sessionTotals(cur)), lines: await q("SELECT ref, label, amount, created_at FROM payments WHERE cash_session_id = ? ORDER BY id DESC", [cur.id]) } : null,
    sessions, enabled: !!(await one("SELECT code FROM pay_methods WHERE code = 'ESPECES' AND active = 1"))
  });
}));
router.post("/cash/open", can("cash.collect"), h(async (req, res) => {
  const agency = req.staff.agency_id; if (!agency) fail(409, "Seul un agent rattaché à une agence peut ouvrir la caisse de cette agence.");
  if (await openSession(agency)) fail(409, "La caisse de l’agence est déjà ouverte.");
  const opening = Math.round(+req.body.opening); if (!(opening >= 0)) fail(400, "Solde d’ouverture invalide.");
  const ref = await U.nextRef("cai", "CAI");
  await q("INSERT INTO cash_sessions (ref, agency_id, staff_id, opening_balance) VALUES (?,?,?,?)", [ref, agency, req.staff.id, opening]);
  U.audit(req, "CASH_OPENED", "cash", ref, fcfa(opening)); res.status(201).json({ ref });
}));
/* encaissement : frais d'un dossier de récupération, ou paiement en attente initié dans l'application */
router.post("/cash/collect", can("cash.collect"), h(async (req, res) => {
  if (!(await one("SELECT code FROM pay_methods WHERE code = 'ESPECES' AND active = 1"))) fail(409, "Les paiements en espèces ne sont pas autorisés (Paramètres › Moyens de paiement).");
  const s = req.staff.agency_id && await openSession(req.staff.agency_id); if (!s) fail(409, "Ouvrez la caisse de l’agence avant tout encaissement.");
  const b = req.body; let p;
  if (b.payment) {
    p = await one("SELECT * FROM payments WHERE ref = ?", [str(b.payment, 30)]); if (!p) fail(404, "Transaction introuvable.");
    if (p.status !== "EN ATTENTE") fail(409, "Cette transaction n’est pas en attente de paiement.");
  } else if (b.recovery) {
    const r = await one("SELECT * FROM recoveries WHERE ref = ?", [str(b.recovery, 30)]); if (!r) fail(404, "Dossier introuvable.");
    const qt = await PAY.quote({ body: { kind: "frais", recovery: r.ref }, user: r.user_id ? { id: r.user_id } : null, get: () => r.access_token });
    const ref = await U.nextRef("pay", "PAY");
    await q("INSERT INTO payments (ref, user_id, kind, label, amount, method, status, meta) VALUES (?,?,?,?,?, 'ESPECES', 'EN ATTENTE', ?)", [ref, r.user_id, qt.kind, qt.label, qt.amount, JSON.stringify(qt.meta)]);
    p = await one("SELECT * FROM payments WHERE ref = ?", [ref]);
  } else fail(400, "Indiquez un dossier de récupération ou une référence de paiement.");
  const recu = Math.round(+b.recu); if (!(recu >= p.amount)) fail(400, `Montant remis insuffisant : ${fcfa(p.amount)} attendus.`);
  await q("UPDATE payments SET method = 'ESPECES', agency_id = ?, cash_session_id = ?, cash_by = ? WHERE id = ?", [s.agency_id, s.id, req.staff.id, p.id]);
  const out = await PAY.finalize({ ...p, method: "ESPECES" });
  U.audit(req, "CASH_COLLECTED", "payment", p.ref, `${fcfa(p.amount)} · caisse ${s.ref}`);
  res.status(201).json({ ...out, recu, rendu: recu - p.amount, caisse: s.ref });
}));
router.post("/cash/close", can("cash.collect"), h(async (req, res) => {
  const s = req.staff.agency_id && await openSession(req.staff.agency_id); if (!s) fail(409, "Aucune caisse ouverte.");
  const declared = Math.round(+req.body.declared); if (!(declared >= 0)) fail(400, "Solde déclaré invalide.");
  const t = await sessionTotals(s), ecart = declared - t.theorique, just = str(req.body.justificatif, 500);
  if (ecart !== 0 && !just) fail(400, `Écart de ${fcfa(ecart)} : un justificatif est obligatoire.`);
  await q(`UPDATE cash_sessions SET status = 'A_CONTROLER', closed_at = NOW(), closed_by = ?, encaissements = ?, theoretical_balance = ?, declared_balance = ?, ecart = ?, justificatif = ? WHERE id = ?`,
    [req.staff.id, t.encaissements, t.theorique, declared, ecart, just || null, s.id]);
  U.audit(req, "CASH_CLOSED", "cash", s.ref, `théorique ${fcfa(t.theorique)} · déclaré ${fcfa(declared)} · écart ${fcfa(ecart)}`);
  res.json({ ok: true, ...t, declared, ecart });
}));
/* contrôle par la Finance (autre agent que le caissier) — transmission Finance → rapprochement */
router.post("/cash/:ref/control", can("finance.view"), h(async (req, res) => {
  const s = await one("SELECT * FROM cash_sessions WHERE ref = ?", [req.params.ref]); if (!s) fail(404, "Caisse introuvable.");
  if (s.status !== "A_CONTROLER" && s.status !== "ECART_A_JUSTIFIER") fail(409, "Cette caisse n’est pas à contrôler.");
  if ([s.staff_id, s.closed_by].includes(req.staff.id)) fail(403, "Séparation des fonctions : le caissier ne contrôle pas sa propre caisse.");
  const st = req.body.decision === "VALIDEE" ? "VALIDEE" : "ECART_A_JUSTIFIER", note = str(req.body.note, 255);
  if (st === "VALIDEE" && s.ecart !== 0 && !note) fail(400, "Validation d’une caisse avec écart : motif obligatoire.");
  await q("UPDATE cash_sessions SET status = ?, controlled_by = ?, controlled_at = NOW(), control_note = ? WHERE id = ?", [st, req.staff.id, note || null, s.id]);
  U.audit(req, "CASH_CONTROLLED", "cash", s.ref, `${st}${note ? " · " + note : ""}`); res.json({ ok: true });
}));

/* ---------- clôture financière journalière (§69) ---------- */
async function dayTotals(day) {
  const pays = await q("SELECT p.kind, p.amount, p.status, p.refunded_amount, p.method, m.fee_pct, m.fee_fixed FROM payments p LEFT JOIN pay_methods m ON m.code = p.method WHERE DATE(p.created_at) = ?", [day]);
  const ok = pays.filter(p => ["RÉUSSI", "REMBOURSÉ"].includes(p.status)), sum = a => a.reduce((s, p) => s + p.amount, 0);
  const brut = sum(ok), remb = ok.reduce((s, p) => s + (p.status === "REMBOURSÉ" ? p.amount : p.refunded_amount || 0), 0);
  const frais = Math.round(ok.reduce((s, p) => s + p.amount * (+p.fee_pct || 0) / 100 + (+p.fee_fixed || 0), 0));
  const [gaps, cash] = await Promise.all([
    one("SELECT COUNT(*) n FROM finance_gaps WHERE status NOT IN ('JUSTIFIÉ','CORRIGÉ','CLÔTURÉ') AND DATE(created_at) <= ?", [day]),
    one("SELECT COUNT(*) n, COALESCE(SUM(ABS(ecart)), 0) e FROM cash_sessions WHERE DATE(opened_at) = ? AND status IN ('OUVERTE','A_CONTROLER','ECART_A_JUSTIFIER')", [day])
  ]);
  return {
    abonnements: sum(ok.filter(p => ["indiv", "pack", "formule"].includes(p.kind))), renouvellements: sum(ok.filter(p => p.kind === "renew")),
    recuperation: sum(ok.filter(p => ["frais", "livraison"].includes(p.kind))), especes: sum(ok.filter(p => p.method === "ESPECES")),
    remboursements: remb, brut, frais_paiement: frais, net: brut - remb - frais,
    en_attente: pays.filter(p => p.status === "EN ATTENTE").length, echouees: pays.filter(p => p.status === "ÉCHOUÉ").length,
    ecarts_ouverts: gaps.n, caisses_non_controlees: cash.n, ecart_caisse: +cash.e
  };
}
router.get("/fin-day", can("finance.view"), h(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : new Date().toISOString().slice(0, 10);
  const closure = await one("SELECT c.*, CONCAT(s.prenom, ' ', s.nom) agent FROM fin_closures c LEFT JOIN staff s ON s.id = c.staff_id WHERE c.day = ?", [day]);
  res.json({ day, totals: closure ? JSON.parse(closure.totals) : await dayTotals(day), closure, history: await q("SELECT day, status, created_at FROM fin_closures ORDER BY day DESC LIMIT 30") });
}));
router.post("/fin-day/close", can("finance.view"), h(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || "") ? req.body.date : null; if (!day) fail(400, "Date invalide.");
  if (await one("SELECT id FROM fin_closures WHERE day = ?", [day])) fail(409, "Cette journée est déjà clôturée.");
  const t = await dayTotals(day), anomalies = t.en_attente + t.ecarts_ouverts + t.caisses_non_controlees;
  const policy = await U.setting("cloture_bloquante", "0");
  if (anomalies && policy === "1") fail(409, "Clôture bloquée : transactions en attente, écarts ou caisses non contrôlées (politique « cloture_bloquante »).");
  const note = str(req.body.note, 500); if (anomalies && !note) fail(400, "Anomalies présentes : un commentaire est obligatoire pour clôturer.");
  await q("INSERT INTO fin_closures (day, status, totals, note, staff_id) VALUES (?,?,?,?,?)", [day, anomalies ? "CLOTURE_AVEC_ANOMALIES" : "CLOTUREE", JSON.stringify(t), note || null, req.staff.id]);
  U.audit(req, "FIN_DAY_CLOSED", "finance", day, anomalies ? `avec ${anomalies} anomalie(s)` : "sans anomalie"); res.json({ ok: true, status: anomalies ? "CLOTURE_AVEC_ANOMALIES" : "CLOTUREE" });
}));

module.exports = router;
