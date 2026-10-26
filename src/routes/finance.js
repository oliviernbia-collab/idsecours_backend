/* Direction financière : remboursements (double validation), rapprochements, écarts, alertes — Finance §26–§39, DF01–DF25.
   Monté sous /api/admin/fin (authentification agent déjà appliquée). */
const router = require("express").Router();
const { q, one, tx } = require("../config/db");
const U = require("../lib/util");
const { can } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { h, fail, str, fcfa } = U;

const step = (id, label, staffId) => q("INSERT INTO refund_steps (refund_id, label, staff_id) VALUES (?,?,?)", [id, label, staffId]);
const isAdmin = req => req.staff.role_code === "SUPER_ADMIN";

/* ---------- alertes financières (§38, DF23–DF24) ---------- */
router.get("/alerts", can("finance.view"), h(async (req, res) => {
  const min = +(await U.setting("payment_pending_alert_min", 15));
  const [pend, toRec, refunds, gaps, expiring] = await Promise.all([
    one("SELECT COUNT(*) n FROM payments WHERE status = 'EN ATTENTE' AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)", [min]),
    one("SELECT COUNT(*) n FROM payments WHERE status = 'RÉUSSI' AND (reconciled IS NULL OR reconciled = 'À RAPPROCHER')"),
    one("SELECT COUNT(*) n FROM refunds WHERE status IN ('EN ATTENTE D’ANALYSE','EN ATTENTE SUPER ADMIN')"),
    one("SELECT COUNT(*) n FROM finance_gaps WHERE status NOT IN ('CLÔTURÉ')"),
    one("SELECT COUNT(*) n FROM protections WHERE suspended = 0 AND exp_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)")
  ]);
  res.json({ alerts: [
    { k: "pending", n: pend.n, l: `paiement(s) en attente de confirmation depuis plus de ${min} min`, c: "orange", to: "transactions" },
    { k: "torec", n: toRec.n, l: "transaction(s) à rapprocher", c: "blue", to: "rapprochements" },
    { k: "refunds", n: refunds.n, l: "remboursement(s) en attente de validation", c: "red", to: "remboursements" },
    { k: "gaps", n: gaps.n, l: "écart(s) financier(s) à traiter", c: "red", to: "ecarts" },
    { k: "expiring", n: expiring.n, l: "abonnement(s) arrivant à expiration (30 j)", c: "grey", to: null }
  ] });
}));

/* ---------- remboursements ---------- */
router.get("/refunds", can("finance.view"), h(async (req, res) => {
  const rows = await q(`SELECT r.*, p.ref pay_ref, p.label pay_label, p.method, u.prenom, u.nom, rq.prenom rq_prenom, rq.nom rq_nom, va.prenom va_prenom, va.nom va_nom, ad.prenom ad_prenom, ad.nom ad_nom
    FROM refunds r JOIN payments p ON p.id = r.payment_id LEFT JOIN users u ON u.id = p.user_id LEFT JOIN staff rq ON rq.id = r.requested_by
    LEFT JOIN staff va ON va.id = r.validated_by LEFT JOIN staff ad ON ad.id = r.admin_by ORDER BY r.id DESC LIMIT 200`);
  for (const r of rows) r.steps = await q("SELECT s.label, s.created_at, st.prenom, st.nom FROM refund_steps s LEFT JOIN staff st ON st.id = s.staff_id WHERE s.refund_id = ? ORDER BY s.id", [r.id]);
  res.json({ items: rows, seuil: +(await U.setting("refund_double_seuil", 5000)) });
}));
/* demande : toujours rattachée à une transaction initiale (DF09), motif obligatoire (DF10) */
router.post("/refunds", can("finance.refund"), upload.single("justificatif"), h(async (req, res) => {
  const p = await one("SELECT * FROM payments WHERE ref = ?", [req.body.payment]); if (!p) fail(404, "Transaction initiale introuvable.");
  if (p.status !== "RÉUSSI") fail(409, "Seule une transaction encaissée peut être remboursée.");
  const amount = Math.round(+req.body.amount || p.amount), already = +(await one("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE payment_id = ? AND status NOT IN ('REFUSÉ')", [p.id])).s;
  if (amount <= 0 || amount + already > p.amount) fail(400, `Montant invalide : maximum remboursable ${fcfa(p.amount - already)}.`);
  if (!str(req.body.motif)) fail(400, "Le motif du remboursement est obligatoire.");
  const ref = await U.nextRef("rmb", "RMB");
  const r = await q("INSERT INTO refunds (ref, payment_id, amount_original, amount, motif, justificatif, requested_by) VALUES (?,?,?,?,?,?,?)",
    [ref, p.id, p.amount, amount, str(req.body.motif, 500), fileUrl(req.file), req.staff.id]);
  await step(r.insertId, `Demande créée · ${fcfa(amount)} sur ${fcfa(p.amount)} · ${str(req.body.motif, 200)}`, req.staff.id);
  U.audit(req, "REFUND_REQUESTED", "refund", ref, `${p.ref} · ${fcfa(amount)}`);
  res.status(201).json({ ref });
}));
router.post("/refunds/:ref/decision", can("finance.refund"), h(async (req, res) => {
  const r = await one("SELECT * FROM refunds WHERE ref = ?", [req.params.ref]); if (!r) fail(404, "Remboursement introuvable.");
  const a = req.body.action, note = str(req.body.note, 500), seuil = +(await U.setting("refund_double_seuil", 5000));
  if (a === "refuse") {
    if (["REMBOURSÉ", "REFUSÉ"].includes(r.status)) fail(409, "Remboursement déjà clôturé.");
    if (!note) fail(400, "Motif du refus obligatoire.");
    await q("UPDATE refunds SET status = 'REFUSÉ', decided_note = ? WHERE id = ?", [note, r.id]);
    await step(r.id, "Refusé · " + note, req.staff.id);
  } else if (a === "validate") {
    /* séparation des fonctions (DF11, §29) : celui qui prépare ne valide pas */
    if (r.status === "EN ATTENTE D’ANALYSE") {
      if (r.requested_by === req.staff.id) fail(403, "Double validation : l’agent qui a préparé la demande ne peut pas la valider.");
      const needAdmin = r.amount >= seuil;
      await q("UPDATE refunds SET status = ?, validated_by = ?, validated_at = NOW() WHERE id = ?", [needAdmin ? "EN ATTENTE SUPER ADMIN" : "INITIÉ", req.staff.id, r.id]);
      await step(r.id, `Transaction et motif contrôlés · validé${needAdmin ? ` · montant ≥ ${fcfa(seuil)} : validation Super Admin requise` : ""}`, req.staff.id);
      if (!needAdmin) await initiate(r, req);
    } else if (r.status === "EN ATTENTE SUPER ADMIN") {
      if (!isAdmin(req)) fail(403, "Validation supplémentaire réservée au Super Admin.");
      if ([r.requested_by, r.validated_by].includes(req.staff.id)) fail(403, "Un même agent ne peut pas valider deux fois.");
      await q("UPDATE refunds SET status = 'INITIÉ', admin_by = ?, admin_at = NOW() WHERE id = ?", [req.staff.id, r.id]);
      await step(r.id, "Validation Super Admin", req.staff.id);
      await initiate(r, req);
    } else fail(409, "Aucune validation attendue à ce stade.");
  } else fail(400, "Action inconnue.");
  U.audit(req, "REFUND_" + a.toUpperCase(), "refund", r.ref, note);
  res.json({ ok: true });
}));
/* remboursement initié auprès du prestataire ; confirmation (simulée hors production) */
async function initiate(r, req) {
  await step(r.id, "Remboursement initié auprès du prestataire", req.staff.id);
  if (process.env.PAYMENT_MODE === "live") return; // confirmation reçue ensuite par webhook du prestataire
  const pref = "RF-" + U.token(4).toUpperCase();
  await tx(async c => {
    await c.query("UPDATE refunds SET status = 'REMBOURSÉ', provider_ref = ?, done_at = NOW() WHERE id = ?", [pref, r.id]);
    await c.query("UPDATE payments SET refunded_amount = refunded_amount + ?, status = IF(refunded_amount >= amount, 'REMBOURSÉ', status) WHERE id = ?", [r.amount, r.payment_id]);
    await c.query("INSERT INTO refund_steps (refund_id, label, staff_id) VALUES (?,?,NULL)", [r.id, `Confirmation du prestataire · ${pref} · REMBOURSÉ`]);
  });
}

/* ---------- rapprochements (§31–§34) ---------- */
router.get("/reconciliations", can("finance.view"), h(async (req, res) => {
  const batches = await q("SELECT b.*, s.prenom, s.nom FROM reconciliations b LEFT JOIN staff s ON s.id = b.staff_id ORDER BY b.id DESC LIMIT 50");
  const tot = await one("SELECT SUM(reconciled = 'RAPPROCHÉ') ok, SUM(reconciled = 'ÉCART') gaps, SUM(status = 'RÉUSSI' AND (reconciled IS NULL OR reconciled = 'À RAPPROCHER')) pending FROM payments WHERE status IN ('RÉUSSI','REMBOURSÉ')");
  res.json({ batches, totals: { ok: +tot.ok || 0, gaps: +tot.gaps || 0, pending: +tot.pending || 0 } });
}));
router.get("/reconciliations/:ref", can("finance.view"), h(async (req, res) => {
  const b = await one("SELECT * FROM reconciliations WHERE ref = ?", [req.params.ref]); if (!b) fail(404, "Rapprochement introuvable.");
  res.json({ batch: b, lines: await q("SELECT l.*, p.ref pay_ref, p.amount pay_amount, p.status pay_status FROM reconciliation_lines l LEFT JOIN payments p ON p.id = l.payment_id WHERE l.batch_id = ? ORDER BY l.status DESC, l.id", [b.id]) });
}));
/* relevé de test à partir des transactions (simulation : aucun prestataire réel connecté) */
router.get("/reconciliations-sample/:source", can("finance.view"), h(async (req, res) => {
  const rows = await q("SELECT ref, provider_ref, amount, DATE(created_at) d FROM payments WHERE method = ? AND status IN ('RÉUSSI','REMBOURSÉ') ORDER BY id", [req.params.source]);
  res.json({ csv: ["reference_idsecours;reference_prestataire;montant;date;statut", ...rows.map(r => `${r.ref};${r.provider_ref || "EXT-" + r.ref.slice(-6)};${r.amount};${r.d};SUCCESS`)].join("\n") });
}));
/* import d'un relevé prestataire (CSV : reference_idsecours;reference_prestataire;montant;date;statut) et rapprochement automatique */
router.post("/reconciliations", can("finance.view"), h(async (req, res) => {
  const source = String(req.body.source || "").toUpperCase();
  if (!(await one("SELECT code FROM pay_methods WHERE code = ?", [source])) && source !== "CAISSE") fail(400, "Source inconnue.");
  const lines = String(req.body.csv || "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^reference/i.test(l)).map(l => l.split(/[;,]/).map(x => x.trim()));
  if (!lines.length) fail(400, "Relevé vide.");
  const ref = await U.nextRef("rap", "RAP");
  const b = await q("INSERT INTO reconciliations (ref, source, staff_id) VALUES (?,?,?)", [ref, source, req.staff.id]);
  const seen = new Set(), gapsMade = [];
  const gap = async (type, payment, lineId, diff, note) => { const g = await U.nextRef("eca", "ECA"); await q("INSERT INTO finance_gaps (ref, type, payment_id, line_id, batch_id, amount_diff, note) VALUES (?,?,?,?,?,?,?)", [g, type, payment, lineId, b.insertId, diff, note]); gapsMade.push(g); };
  let matched = 0, gaps = 0, dates = [];
  for (const [idsRef, extRef, amountS, date, st] of lines) {
    const amount = Math.round(+amountS || 0), d = U.dateOrNull(date); if (d) dates.push(d);
    const p = idsRef ? await one("SELECT * FROM payments WHERE ref = ?", [idsRef]) : null;
    let status = "RAPPROCHÉ", note = null, diff = 0, type = null;
    if (seen.has(extRef)) { status = "ÉCART"; type = "Transaction dupliquée"; }
    else if (!p) { status = "ÉCART"; type = idsRef ? "Référence inconnue" : "Paiement confirmé chez le prestataire mais absent dans ID SECOURS"; }
    else if (amount !== p.amount) { status = "ÉCART"; type = "Montant différent"; diff = amount - p.amount; }
    else if (!/^(SUCCESS|OK|RÉUSSI|REUSSI|PAID)$/i.test(st || "") || p.status === "EN ATTENTE") { status = "À RAPPROCHER"; note = `Statut prestataire ${st || "?"} / ID SECOURS ${p.status}`; }
    seen.add(extRef);
    const l = await q("INSERT INTO reconciliation_lines (batch_id, ext_ref, ids_ref, ext_amount, ext_date, ext_status, payment_id, status, diff, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [b.insertId, str(extRef, 60), str(idsRef, 30), amount, d, str(st, 30), p ? p.id : null, status, diff, note || type]);
    if (p) await q("UPDATE payments SET reconciled = ?, provider_ref = COALESCE(provider_ref, ?) WHERE id = ?", [status, str(extRef, 60), p.id]);
    if (status === "RAPPROCHÉ") matched++;
    if (status === "ÉCART") { gaps++; await gap(type, p ? p.id : null, l.insertId, diff, `${extRef} · ${fcfa(amount)}`); }
  }
  /* paiements ID SECOURS de la période sans confirmation externe */
  if (dates.length) {
    dates.sort();
    const missing = await q(`SELECT * FROM payments WHERE method = ? AND status = 'RÉUSSI' AND DATE(created_at) BETWEEN ? AND ? AND (reconciled IS NULL OR reconciled = 'À RAPPROCHER')
      AND id NOT IN (SELECT payment_id FROM reconciliation_lines WHERE batch_id = ? AND payment_id IS NOT NULL)`, [source, dates[0], dates[dates.length - 1], b.insertId]);
    for (const p of missing) { gaps++; await q("UPDATE payments SET reconciled = 'ÉCART' WHERE id = ?", [p.id]); await gap("Paiement présent dans ID SECOURS mais non confirmé extérieurement", p.id, null, -p.amount, p.ref); }
    await q("UPDATE reconciliations SET date_from = ?, date_to = ? WHERE id = ?", [dates[0], dates[dates.length - 1], b.insertId]);
  }
  const pending = (await one("SELECT COUNT(*) n FROM reconciliation_lines WHERE batch_id = ? AND status = 'À RAPPROCHER'", [b.insertId])).n;
  await q("UPDATE reconciliations SET lines_total = ?, matched = ?, gaps = ?, pending = ? WHERE id = ?", [lines.length, matched, gaps, pending, b.insertId]);
  U.audit(req, "RECONCILIATION_IMPORT", "reconciliation", ref, `${source} · ${lines.length} lignes · ${matched} rapprochées · ${gaps} écarts`);
  res.status(201).json({ ref, lines: lines.length, matched, gaps, ecarts: gapsMade, pending });
}));
/* rapprochement manuel d'une ligne (§33) — toute intervention est journalisée */
router.post("/reconciliation-lines/:id", can("finance.view"), h(async (req, res) => {
  const l = await one("SELECT * FROM reconciliation_lines WHERE id = ?", [req.params.id]); if (!l) fail(404, "Ligne introuvable.");
  const a = req.body.action, note = str(req.body.note, 255);
  if (!note) fail(400, "Commentaire obligatoire.");
  if (a === "rapprocher") { await q("UPDATE reconciliation_lines SET status = 'RAPPROCHÉ', note = ? WHERE id = ?", [note, l.id]); if (l.payment_id) await q("UPDATE payments SET reconciled = 'RAPPROCHÉ' WHERE id = ?", [l.payment_id]); }
  else if (a === "ecart") { await q("UPDATE reconciliation_lines SET status = 'ÉCART', note = ? WHERE id = ?", [note, l.id]); const g = await U.nextRef("eca", "ECA"); await q("INSERT INTO finance_gaps (ref, type, payment_id, line_id, batch_id, note) VALUES (?, 'Autre anomalie', ?, ?, ?, ?)", [g, l.payment_id, l.id, l.batch_id, note]); }
  else fail(400, "Action inconnue.");
  U.audit(req, "RECONCILIATION_MANUAL_" + a.toUpperCase(), "reconciliation_line", String(l.id), note);
  res.json({ ok: true });
}));

/* ---------- écarts (§35–§36) ---------- */
router.get("/gaps", can("finance.view"), h(async (req, res) => {
  res.json({ items: await q(`SELECT g.*, p.ref pay_ref, p.amount pay_amount, b.ref batch_ref, s.prenom, s.nom FROM finance_gaps g LEFT JOIN payments p ON p.id = g.payment_id
    LEFT JOIN reconciliations b ON b.id = g.batch_id LEFT JOIN staff s ON s.id = g.updated_by ORDER BY (g.status = 'CLÔTURÉ'), g.id DESC LIMIT 200`) });
}));
const GAP_ST = ["NOUVEAU", "EN ANALYSE", "JUSTIFIÉ", "CORRIGÉ", "ESCALADÉ", "CLÔTURÉ"];
router.patch("/gaps/:ref", can("finance.view"), h(async (req, res) => {
  const g = await one("SELECT * FROM finance_gaps WHERE ref = ?", [req.params.ref]); if (!g) fail(404, "Écart introuvable.");
  const st = req.body.status; if (!GAP_ST.includes(st)) fail(400, "Statut inconnu.");
  if (g.status === "CLÔTURÉ") fail(409, "Écart clôturé.");
  if (st === "CLÔTURÉ" && !str(req.body.reason)) fail(400, "Le motif de clôture est obligatoire.");
  await q("UPDATE finance_gaps SET status = ?, note = COALESCE(?, note), closed_reason = IF(? = 'CLÔTURÉ', ?, closed_reason), updated_by = ? WHERE id = ?", [st, str(req.body.note, 500), st, str(req.body.reason, 500), req.staff.id, g.id]);
  if (["JUSTIFIÉ", "CORRIGÉ", "CLÔTURÉ"].includes(st) && g.payment_id) await q("UPDATE payments SET reconciled = 'RAPPROCHÉ' WHERE id = ? AND reconciled = 'ÉCART'", [g.payment_id]);
  U.audit(req, "FINANCE_GAP_" + st, "finance_gap", g.ref, req.body.reason || req.body.note);
  res.json({ ok: true });
}));

module.exports = router;
