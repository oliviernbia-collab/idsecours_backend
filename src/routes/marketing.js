/* Service commercial — compléments du cahier des charges : segments (§32), campagnes (§30–§33),
   opportunités et pipeline (§20–§23). Aucune donnée documentaire n'est utilisée pour le ciblage (§32, COM-11). */
const router = require("express").Router();
const { q, one } = require("../config/db");
const U = require("../lib/util");
const { requireStaff, can } = require("../middleware/auth");
const { h, fail, str } = U;

router.use(requireStaff);

/* ---------- segments commerciaux : critères non sensibles uniquement ---------- */
const ACTIVE = "EXISTS (SELECT 1 FROM protections p WHERE p.user_id = u.id AND p.exp_at > NOW() AND p.suspended = 0)";
const SEGMENTS = {
  NOUVEAUX: ["Nouveaux inscrits (30 j) sans protection", `u.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) AND NOT ${ACTIVE}`],
  ACTIFS: ["Abonnés actifs", ACTIVE],
  EXPIRANT: ["Protection expirant sous 30 jours", "EXISTS (SELECT 1 FROM protections p WHERE p.user_id = u.id AND p.exp_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY))"],
  ANCIENS: ["Anciens abonnés (non renouvelés)", `EXISTS (SELECT 1 FROM protections p WHERE p.user_id = u.id) AND NOT ${ACTIVE}`],
  SANS_PROTECTION: ["Inscrits n’ayant jamais souscrit", "NOT EXISTS (SELECT 1 FROM protections p WHERE p.user_id = u.id)"],
  PARTENAIRE: ["Utilisateurs issus d’un partenaire", "u.acquisition_source = 'Partenaire'"]
};
const segUsers = (code, cols = "u.id, u.prenom, u.tel") => q(`SELECT ${cols} FROM users u WHERE u.status = 'ACTIF' AND ${SEGMENTS[code][1]}`);
router.get("/segments", can("commercial.view"), h(async (req, res) => {
  const items = [];
  for (const [code, [label, where]] of Object.entries(SEGMENTS)) items.push({ code, label, n: (await one(`SELECT COUNT(*) n FROM users u WHERE u.status = 'ACTIF' AND ${where}`)).n });
  items.push({ code: "PROSPECTS", label: "Prospects non convertis", n: (await one("SELECT COUNT(*) n FROM prospects WHERE statut NOT IN ('CONVERTI','PERDU')")).n });
  res.json({ items });
}));

/* ---------- campagnes : brouillon → validation (Direction, autre agent) → lancement → résultats ---------- */
const CMP_ST = ["A_VALIDER", "VALIDEE", "EN_COURS", "TERMINEE", "REFUSEE", "ANNULEE"];
router.get("/campaigns", can("commercial.view", "campaigns.validate"), h(async (req, res) => {
  await q("UPDATE campaigns SET statut = 'TERMINEE' WHERE statut = 'EN_COURS' AND date_fin < CURDATE()");
  const rows = await q(`SELECT c.*, CONCAT(s.prenom, ' ', s.nom) auteur, CONCAT(v.prenom, ' ', v.nom) valideur,
      (SELECT COUNT(*) FROM campaign_targets t WHERE t.campaign_id = c.id) cibles,
      (SELECT COUNT(DISTINCT t.user_id) FROM campaign_targets t JOIN protections p ON p.user_id = t.user_id
         WHERE t.campaign_id = c.id AND p.created_at >= t.sent_at AND p.created_at < DATE_ADD(c.date_fin, INTERVAL 1 DAY)) conversions,
      (SELECT COALESCE(SUM(pay.amount), 0) FROM campaign_targets t JOIN payments pay ON pay.user_id = t.user_id
         WHERE t.campaign_id = c.id AND pay.status = 'RÉUSSI' AND pay.created_at >= t.sent_at AND pay.created_at < DATE_ADD(c.date_fin, INTERVAL 1 DAY)) ca
    FROM campaigns c LEFT JOIN staff s ON s.id = c.created_by LEFT JOIN staff v ON v.id = c.validated_by ORDER BY c.id DESC`);
  res.json({ items: rows.map(r => ({ ...r, segment_label: (SEGMENTS[r.segment] || ["Prospects non convertis"])[0], taux: r.cibles ? Math.round(r.conversions * 1000 / r.cibles) / 10 : 0 })), segments: Object.keys(SEGMENTS).concat("PROSPECTS") });
}));
router.post("/campaigns", can("prospects.manage"), h(async (req, res) => {
  const b = req.body;
  if (!str(b.nom) || !str(b.message)) fail(400, "Nom et message obligatoires.");
  if (!SEGMENTS[b.segment] && b.segment !== "PROSPECTS") fail(400, "Segment inconnu.");
  if (!["NOTIFICATION", "SMS", "NOTIFICATION+SMS"].includes(b.canal)) fail(400, "Canal invalide.");
  if (!b.date_debut || !b.date_fin || b.date_fin < b.date_debut) fail(400, "Période invalide.");
  const ref = await U.nextRef("cmp", "CMP");
  await q(`INSERT INTO campaigns (ref, nom, objectif, segment, offre, canal, message, date_debut, date_fin, budget, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [ref, str(b.nom, 120), str(b.objectif, 255), b.segment, str(b.offre, 60), b.canal, str(b.message, 320), b.date_debut, b.date_fin, Math.max(0, Math.round(+b.budget || 0)), req.staff.id]);
  U.audit(req, "CAMPAIGN_CREATED", "campaign", ref); res.status(201).json({ ref });
}));
const campaign = async ref => { const c = await one("SELECT * FROM campaigns WHERE ref = ?", [ref]); if (!c) fail(404, "Campagne introuvable."); return c; };
router.post("/campaigns/:ref/decision", can("campaigns.validate"), h(async (req, res) => {
  const c = await campaign(req.params.ref), ok = !!req.body.approve, motif = str(req.body.motif, 255);
  if (c.statut !== "A_VALIDER") fail(409, "Campagne déjà traitée.");
  if (c.created_by === req.staff.id) fail(403, "La campagne doit être validée par un autre agent que son auteur.");
  if (!ok && !motif) fail(400, "Motif de refus obligatoire.");
  await q("UPDATE campaigns SET statut = ?, validated_by = ?, validated_at = NOW(), motif = ? WHERE id = ?", [ok ? "VALIDEE" : "REFUSEE", req.staff.id, motif || null, c.id]);
  U.audit(req, ok ? "CAMPAIGN_VALIDATED" : "CAMPAIGN_REFUSED", "campaign", c.ref, motif); res.json({ ok: true });
}));
/* lancement : envoi au segment (notification et/ou SMS), chaque envoi est tracé (historique des relances §28) */
router.post("/campaigns/:ref/launch", can("prospects.manage"), h(async (req, res) => {
  const c = await campaign(req.params.ref);
  if (c.statut !== "VALIDEE") fail(409, "Seule une campagne validée peut être lancée.");
  const today = new Date().toISOString().slice(0, 10), fin = new Date(c.date_fin).toISOString().slice(0, 10);
  if (fin < today) fail(409, "La période de la campagne est dépassée.");
  const max = +(await U.setting("campagne_max_envois", 5000));
  const notif = c.canal.includes("NOTIFICATION"), sms = c.canal.includes("SMS");
  let n = 0;
  if (c.segment === "PROSPECTS") {
    for (const p of (await q("SELECT id, tel FROM prospects WHERE statut NOT IN ('CONVERTI','PERDU') AND tel IS NOT NULL")).slice(0, max)) {
      await U.sms(p.tel, `ID SECOURS : ${c.message}`);
      await q("INSERT INTO campaign_targets (campaign_id, prospect_id, canal) VALUES (?,?, 'SMS')", [c.id, p.id]); n++;
    }
  } else for (const u of (await segUsers(c.segment)).slice(0, max)) {
    if (notif) await U.notify(u.id, c.nom, c.message, "protChoice");
    if (sms && u.tel) await U.sms(u.tel, `ID SECOURS : ${c.message}`);
    await q("INSERT INTO campaign_targets (campaign_id, user_id, canal) VALUES (?,?,?)", [c.id, u.id, c.canal]); n++;
    /* campagne de renouvellement : inscrite dans l'historique des relances (§28) */
    if (["EXPIRANT", "ANCIENS"].includes(c.segment)) await q("INSERT INTO renewal_reminders (user_id, channel, campaign_ref, message, result, staff_id) VALUES (?,?,?,?,?,?)",
      [u.id, c.canal, c.ref, String(c.message).slice(0, 600), "Envoyé", req.staff.id]);
  }
  await q("UPDATE campaigns SET statut = 'EN_COURS', launched_at = NOW() WHERE id = ?", [c.id]);
  U.audit(req, "CAMPAIGN_LAUNCHED", "campaign", c.ref, `${n} envoi(s)`); res.json({ ok: true, sent: n });
}));
router.post("/campaigns/:ref/cancel", can("prospects.manage", "campaigns.validate"), h(async (req, res) => {
  const c = await campaign(req.params.ref);
  if (!["A_VALIDER", "VALIDEE", "EN_COURS"].includes(c.statut)) fail(409, "Campagne déjà close.");
  await q("UPDATE campaigns SET statut = ? WHERE id = ?", [c.statut === "EN_COURS" ? "TERMINEE" : "ANNULEE", c.id]);
  U.audit(req, "CAMPAIGN_CLOSED", "campaign", c.ref); res.json({ ok: true });
}));

/* ---------- opportunités : pipeline historisé, rattachement obligatoire (COM-04) ---------- */
const OPP_ST = ["NOUVEAU", "EN_CONTACT", "PROPOSITION", "NEGOCIATION", "EN_ATTENTE", "CONVERTI", "PERDU"];
router.get("/opportunities", can("commercial.view"), h(async (req, res) => {
  const items = await q(`SELECT o.*, pr.nom prospect, CONCAT(u.prenom, ' ', u.nom) client, cp.nom partenaire, CONCAT(s.prenom, ' ', s.nom) commercial,
      DATEDIFF(NOW(), o.updated_at) inactif_j
    FROM opportunities o LEFT JOIN prospects pr ON pr.id = o.prospect_id LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN com_partners cp ON cp.id = o.com_partner_id LEFT JOIN staff s ON s.id = o.staff_id ORDER BY o.id DESC LIMIT 300`);
  const closed = items.filter(o => ["CONVERTI", "PERDU"].includes(o.statut));
  const conv = items.filter(o => o.statut === "CONVERTI");
  const dur = conv.filter(o => o.closed_at).map(o => (new Date(o.closed_at) - new Date(o.created_at)) / 864e5);
  res.json({
    items, statuts: OPP_ST,
    stats: { total: items.length, ouvertes: items.length - closed.length, conversions: conv.length, abandons: closed.length - conv.length,
      taux: closed.length ? Math.round(conv.length * 100 / closed.length) : 0, delai_moyen_j: dur.length ? Math.round(dur.reduce((a, b) => a + b, 0) / dur.length) : null,
      pipeline: OPP_ST.map(s => ({ s, n: items.filter(o => o.statut === s).length, v: items.filter(o => o.statut === s).reduce((a, o) => a + (o.valeur || 0), 0) })) }
  });
}));
router.get("/opportunities/:ref/history", can("commercial.view"), h(async (req, res) => {
  res.json({ items: await q(`SELECT hst.*, CONCAT(s.prenom, ' ', s.nom) agent FROM opportunity_history hst JOIN opportunities o ON o.id = hst.opportunity_id
    LEFT JOIN staff s ON s.id = hst.staff_id WHERE o.ref = ? ORDER BY hst.id`, [req.params.ref]) });
}));
router.post("/opportunities", can("prospects.manage"), h(async (req, res) => {
  const b = req.body;
  if (!str(b.titre)) fail(400, "Intitulé obligatoire.");
  const link = { prospect_id: +b.prospect_id || null, user_id: +b.user_id || null, com_partner_id: +b.com_partner_id || null };
  if (!link.prospect_id && !link.user_id && !link.com_partner_id && !str(b.organisation)) fail(400, "Rattachez l’opportunité à un prospect, un client, un partenaire ou une organisation (COM-04).");
  const ref = await U.nextRef("opp", "OPP");
  const r = await q(`INSERT INTO opportunities (ref, titre, type, organisation, offre, valeur, prochaine_action, prochaine_date, notes, prospect_id, user_id, com_partner_id, staff_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [ref, str(b.titre, 160), str(b.type, 30) || "Particulier", str(b.organisation, 120), str(b.offre, 60), Math.max(0, Math.round(+b.valeur || 0)),
    str(b.prochaine_action, 160), U.dateOrNull(b.prochaine_date), str(b.notes, 500), link.prospect_id, link.user_id, link.com_partner_id, req.staff.id]);
  await q("INSERT INTO opportunity_history (opportunity_id, from_st, to_st, staff_id) VALUES (?, NULL, 'NOUVEAU', ?)", [r.insertId, req.staff.id]);
  U.audit(req, "OPPORTUNITY_CREATED", "opportunity", ref); res.status(201).json({ ref });
}));
router.patch("/opportunities/:ref", can("prospects.manage"), h(async (req, res) => {
  const o = await one("SELECT * FROM opportunities WHERE ref = ?", [req.params.ref]); if (!o) fail(404, "Opportunité introuvable.");
  const b = req.body, set = {};
  if (b.statut != null) { if (!OPP_ST.includes(b.statut)) fail(400, "Statut inconnu."); set.statut = b.statut; }
  for (const k of ["prochaine_action", "notes"]) if (b[k] != null) set[k] = str(b[k], k === "notes" ? 500 : 160);
  if (b.prochaine_date !== undefined) set.prochaine_date = U.dateOrNull(b.prochaine_date);
  if (b.valeur != null) set.valeur = Math.max(0, Math.round(+b.valeur || 0));
  if (!Object.keys(set).length) fail(400, "Rien à modifier.");
  if (set.statut && ["CONVERTI", "PERDU"].includes(set.statut)) set.closed_at = new Date();
  await q(`UPDATE opportunities SET ${Object.keys(set).map(k => k + " = ?").join(", ")}, updated_at = NOW() WHERE id = ?`, [...Object.values(set), o.id]);
  if (set.statut && set.statut !== o.statut) await q("INSERT INTO opportunity_history (opportunity_id, from_st, to_st, staff_id, motif) VALUES (?,?,?,?,?)", [o.id, o.statut, set.statut, req.staff.id, str(b.motif, 255)]);
  U.audit(req, "OPPORTUNITY_UPDATED", "opportunity", o.ref, JSON.stringify(set)); res.json({ ok: true });
}));

module.exports = router;
module.exports.CMP_ST = CMP_ST;
