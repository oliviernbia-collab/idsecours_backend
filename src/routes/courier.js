/* Portail des livreurs partenaires (organigramme : « Livreurs — se rend chez la personne qui a trouvé le document,
   récupère le document, le dépose au service Collecte & Livraison »). R49 : uniquement les données nécessaires à la mission. */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { q, one } = require("../config/db");
const U = require("../lib/util");
const REC = require("../lib/recovery");
const { h, fail, str } = U;

const SECRET = () => process.env.JWT_SECRET || "dev-secret";

router.post("/login", rateLimit({ windowMs: 15 * 60e3, limit: 20, message: { error: "Trop de tentatives. Réessayez plus tard." } }), h(async (req, res) => {
  const p = await one("SELECT * FROM partners WHERE collecteur_code = ?", [String(req.body.code || "").trim().toUpperCase()]);
  if (!p || p.status !== "ACTIF" || !p.pin_hash || !(await bcrypt.compare(String(req.body.pin || ""), p.pin_hash))) fail(401, "Code livreur ou PIN incorrect.");
  U.audit(null, "COURIER_LOGIN", "partner", p.collecteur_code);
  res.json({ token: jwt.sign({ sub: p.id, aud: "courier" }, SECRET(), { expiresIn: "12h" }) });
}));

router.use(h(async (req, res, next) => {
  const t = (req.headers.authorization || "").replace(/^Bearer /, "");
  let pl; try { pl = jwt.verify(t, SECRET(), { audience: "courier" }); } catch { fail(401, "Session expirée. Reconnectez-vous."); }
  req.partner = await one("SELECT * FROM partners WHERE id = ? AND status = 'ACTIF'", [pl.sub]);
  if (!req.partner) fail(401, "Partenaire suspendu.");
  next();
}));

const view = f => ({
  ref: f.ref, mission: f.mission_ref, cat: f.cat, step: f.step, slot: f.slot, repere: f.repere, commune: f.commune,
  lat: +f.lat, lng: +f.lng, tel: f.tel ? U.fmtTel(f.tel) : null, handT: f.handed_at, depositT: f.deposit_at
});
const SQL = `SELECT f.*, c.label cat, COALESCE(u.tel, f.reporter_tel) tel FROM found_reports f JOIN doc_categories c ON c.code = f.category_code
             LEFT JOIN users u ON u.id = f.reporter_user_id WHERE f.partner_id = ?`;

router.get("/me", h(async (req, res) => res.json({ partner: { nom: req.partner.nom, collecteur: req.partner.collecteur, code: req.partner.collecteur_code, vehicule: req.partner.vehicule } })));
router.get("/missions", h(async (req, res) => {
  const rows = await q(`${SQL} AND (f.step BETWEEN 3 AND 5 OR (f.step >= 6 AND f.deposit_at > DATE_SUB(NOW(), INTERVAL 7 DAY))) ORDER BY f.step, f.id DESC`, [req.partner.id]);
  res.json({ items: rows.map(view) });
}));
const mission = async (req, steps) => {
  const f = await one(`${SQL} AND f.ref = ?`, [req.partner.id, req.params.ref]);
  if (!f) fail(404, "Mission introuvable.");
  if (!steps.includes(f.step)) fail(409, "Action impossible à cette étape de la mission.");
  return f;
};
router.post("/missions/:ref/enroute", h(async (req, res) => {
  const f = await mission(req, [3]);
  await q("UPDATE found_reports SET step = 4, step_at = NOW(), courier_enroute_at = NOW() WHERE id = ?", [f.id]);
  await U.notify(f.reporter_user_id, "Livreur en route", `${req.partner.collecteur} (${req.partner.nom}) arrive pour la mission ${f.mission_ref}.`, "collecte|" + f.ref);
  if (!f.reporter_user_id && f.reporter_tel) await U.sms(f.reporter_tel, `ID SECOURS : le livreur ${req.partner.collecteur} arrive pour récupérer le document (mission ${f.mission_ref}). Ne remettez le document qu’après validation de votre code.`);
  U.audit(null, "COURIER_ENROUTE", "found", f.ref, req.partner.collecteur_code);
  res.json({ ok: true });
}));
/* validation du code / QR présenté par la personne qui a trouvé le document (R50) */
router.post("/missions/:ref/handover", h(async (req, res) => {
  const f = await mission(req, [3, 4]);
  const code = String(req.body.code || "").trim().replace(/^IDSECOURS:COL:[^:]+:/, "");
  if (code !== f.collect_code) { U.audit(null, "COLLECT_CODE_KO", "found", f.ref, req.partner.collecteur_code); fail(400, "Code de collecte invalide."); }
  await q("UPDATE found_reports SET step = 5, step_at = NOW(), handed_at = NOW() WHERE id = ?", [f.id]);
  await U.notify(f.reporter_user_id, "Document collecté", `Mission ${f.mission_ref} · code invalidé. Merci pour votre geste !`, "collecte|" + f.ref);
  U.audit(null, "COLLECT_HANDOVER", "found", f.ref, req.partner.collecteur_code);
  res.json({ ok: true });
}));

/* ---------- livraisons au propriétaire (Collecte §36–§46) ---------- */
const DSQL = `SELECT d.*, r.ref rec_ref, r.withdrawal_code, r.user_id ruser, c.label cat, u.prenom, u.nom, COALESCE(u.tel, r.tel) tel
  FROM deliveries d JOIN recoveries r ON r.id = d.recovery_id JOIN doc_categories c ON c.code = r.category_code LEFT JOIN users u ON u.id = d.user_id WHERE d.partner_id = ?`;
const dview = d => ({ ref: d.ref, cat: d.cat, st: d.status, commune: d.commune, repere: d.repere, slot: d.slot, lat: +d.lat, lng: +d.lng,
  destinataire: d.prenom ? `${d.prenom} ${String(d.nom || "")[0] || ""}.` : "Titulaire du dossier", tel: d.tel ? U.fmtTel(d.tel) : null, deliveredT: d.delivered_at, failReason: d.fail_reason });
router.get("/deliveries", h(async (req, res) => {
  const rows = await q(`${DSQL} AND (d.status IN ('PLANIFIEE','EN_LIVRAISON','REMISE_BLOQUEE','ECHEC') OR (d.status = 'LIVREE' AND d.delivered_at > DATE_SUB(NOW(), INTERVAL 7 DAY))) ORDER BY FIELD(d.status,'EN_LIVRAISON','PLANIFIEE','ECHEC','REMISE_BLOQUEE','LIVREE')`, [req.partner.id]);
  res.json({ items: rows.map(dview) });
}));
const delivery = async (req, statuses) => {
  const d = await one(`${DSQL} AND d.ref = ?`, [req.partner.id, req.params.ref]);
  if (!d) fail(404, "Livraison introuvable.");
  if (!statuses.includes(d.status)) fail(409, "Action impossible à cette étape de la livraison.");
  return d;
};
/* OTP temporaire envoyé au propriétaire au moment de la remise (§41) */
router.post("/deliveries/:ref/otp", h(async (req, res) => {
  const d = await delivery(req, ["EN_LIVRAISON"]);
  if (!d.tel) fail(409, "Aucun numéro vérifié : utilisez le QR code de récupération du propriétaire.");
  const code = await U.createOtp(d.tel, "delivery", d.ref);
  await U.sms(d.tel, `ID SECOURS : code de remise de votre document (livraison ${d.ref}) : ${code}. Ne le communiquez qu’au livreur, au moment de la remise.`);
  U.audit(null, "DELIVERY_OTP_SENT", "delivery", d.ref, req.partner.collecteur_code);
  res.json({ ok: true, ...(U.DEV ? { devCode: code } : {}) });
}));
/* remise au propriétaire uniquement (§45) : OTP ou QR de récupération ; échecs répétés → REMISE BLOQUÉE */
router.post("/deliveries/:ref/confirm", h(async (req, res) => {
  const d = await delivery(req, ["EN_LIVRAISON"]);
  const raw = String(req.body.code || "").trim();
  let method = null;
  if (/^IDSECOURS:RET:/.test(raw) || raw === d.withdrawal_code) { if (raw.replace(/^IDSECOURS:RET:[^:]+:/, "") === d.withdrawal_code) method = "QR de récupération"; }
  if (!method && d.tel) { try { await U.checkOtp(d.tel, "delivery", raw, d.ref); method = "OTP"; } catch { /* échec compté ci-dessous */ } }
  if (!method) {
    const fails = d.otp_fails + 1;
    await q("UPDATE deliveries SET otp_fails = ?, status = IF(? >= 3, 'REMISE_BLOQUEE', status), fail_reason = IF(? >= 3, 'OTP / QR invalide (3 échecs)', fail_reason), fail_at = IF(? >= 3, NOW(), fail_at) WHERE id = ?", [fails, fails, fails, fails, d.id]);
    U.audit(null, "DELIVERY_CODE_KO", "delivery", d.ref, `${req.partner.collecteur_code} · échec ${fails}`);
    fail(400, fails >= 3 ? "REMISE BLOQUÉE : trop d’échecs. Ramenez le document à l’agence." : `Code invalide (${fails}/3).`);
  }
  await q("UPDATE deliveries SET status = 'LIVREE', delivered_at = NOW(), method = ? WHERE id = ?", [method, d.id]);
  const r = await one("SELECT * FROM recoveries WHERE id = ?", [d.recovery_id]);
  await REC.complete(r, { staffId: null, label: `Livraison effectuée · ${d.ref} · ${req.partner.nom} · ${method}`, mode: `Livraison ${d.ref} · ${req.partner.nom} · ${method}` });
  U.audit(null, "DELIVERY_DONE", "delivery", d.ref, `${req.partner.collecteur_code} · ${method}`);
  res.json({ ok: true, method });
}));
const FAIL_REASONS = ["Propriétaire absent", "Numéro injoignable", "Adresse incorrecte", "OTP incorrect", "QR invalide", "Refus de réception", "Impossibilité de confirmer l’identité", "Incident du partenaire", "Problème de sécurité"];
router.post("/deliveries/:ref/fail", h(async (req, res) => {
  const d = await delivery(req, ["EN_LIVRAISON"]);
  if (!FAIL_REASONS.includes(req.body.reason)) fail(400, "Motif obligatoire.");
  const motif = req.body.reason + (str(req.body.note, 120) ? " · " + str(req.body.note, 120) : "");
  await q("UPDATE deliveries SET status = 'ECHEC', fail_reason = ?, fail_at = NOW() WHERE id = ?", [motif, d.id]);
  await U.notify(d.ruser, "Livraison impossible", `${motif}. Le document retourne à l’agence ID SECOURS.`, "recAuth|" + d.rec_ref);
  U.audit(null, "DELIVERY_FAILED", "delivery", d.ref, `${req.partner.collecteur_code} · ${motif}`);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.FAIL_REASONS = FAIL_REASONS;
