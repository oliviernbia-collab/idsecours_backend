/* Dossier de récupération — §32 à §39 (avec compte ou via jeton d'accès) */
const router = require("express").Router();
const QRCode = require("qrcode");
const { q, one } = require("../config/db");
const U = require("../lib/util");
const D = require("../lib/domain");
const { optionalUser } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { dossierFor } = require("../lib/dossiers");
const REC = require("../lib/recovery");
const { h, fail, str, dateOrNull, DEV } = U;

router.use(optionalUser);

async function getRec(req) { const d = await dossierFor(req, req.params.ref); if (d.type !== "rec") fail(404, "Dossier introuvable."); return d.row; }

async function recView(r) {
  const held = await one("SELECT h.*, a.nom agence, a.adresse lieu, a.horaires FROM held_documents h JOIN agencies a ON a.id = h.agency_id WHERE h.id = ?", [r.held_id]);
  const confirmed = r.verif_status === "PROPRIÉTAIRE CONFIRMÉ", authorized = confirmed && (r.protected || r.paid) && r.status === "RÉCUPÉRATION AUTORISÉE";
  return {
    ref: r.ref, t: r.created_at, cat: r.category_code, num: U.maskNum(held.numero), nom: U.maskName(held.nom), etat: held.etat,
    agence: held.agence, lieu: held.lieu, horaires: held.horaires, protected: !!r.protected, paid: !!r.paid, payRef: r.pay_ref,
    fee: r.fee_amount, st: r.status, verif: { st: r.verif_status, otpSent: !!r.tel && !!(await one("SELECT id FROM otp_codes WHERE purpose = 'recovery' AND ref = ? LIMIT 1", [r.ref])), needTel: !r.user_id && !r.tel },
    delivery: !!r.delivery, done: !!r.done_at, doneT: r.done_at, docId: r.document_id,
    livraison: await one(`SELECT d.ref, d.status st, d.commune, d.repere, d.slot, d.fail_reason, d.delivered_at, d.out_at, p.nom partner, p.collecteur
      FROM deliveries d LEFT JOIN partners p ON p.id = d.partner_id WHERE d.recovery_id = ? AND d.status <> 'ANNULEE' ORDER BY d.id DESC LIMIT 1`, [r.id]),
    qr: authorized && !r.done_at ? await QRCode.toDataURL(`IDSECOURS:RET:${r.ref}:${r.withdrawal_code}`, { margin: 1, width: 300 }) : null,
    withdrawalCode: authorized && !r.done_at ? r.withdrawal_code : null
  };
}

router.get("/:ref", h(async (req, res) => res.json({ rec: await recView(await getRec(req)) })));
router.get("/:ref/proof", h(async (req, res) => {
  const r = await getRec(req), p = await REC.proof(r.ref);
  if (!p) fail(404, "Aucune preuve : document non restitué.");
  delete p.signature; res.json({ proof: p });
}));

router.post("/:ref/otp", h(async (req, res) => {
  const r = await getRec(req);
  let tel = r.tel;
  if (!r.user_id) { const t = U.normTel(req.body.tel); if (t.length < 8) fail(400, "Saisissez votre numéro de téléphone."); tel = t; await q("UPDATE recoveries SET tel = ? WHERE id = ?", [tel, r.id]); }
  const code = await U.createOtp(tel, "recovery", r.ref);
  await U.sms(tel, `Code de vérification du dossier ${r.ref} : ${code}`);
  res.json({ ok: true, ...(DEV ? { devCode: code } : {}) });
}));

/* vérification du propriétaire : OTP + selfie + informations connues + justificatif */
router.post("/:ref/verify", upload.fields([{ name: "selfie", maxCount: 1 }, { name: "just", maxCount: 1 }]), h(async (req, res) => {
  const r = await getRec(req), b = req.body, f = req.files || {};
  if (r.verif_status === "PROPRIÉTAIRE CONFIRMÉ") return res.json({ rec: await recView(r) });
  if (r.verif_tries >= 5) fail(429, "Trop de tentatives : un agent Vérification & Contrôle reprendra votre dossier.");
  if (!r.tel) fail(400, "Demandez d’abord votre code OTP.");
  await q("UPDATE recoveries SET verif_tries = verif_tries + 1 WHERE id = ?", [r.id]);
  try { await U.checkOtp(r.tel, "recovery", b.otp, r.ref); }
  catch (e) { await q("UPDATE recoveries SET verif_status = 'VÉRIFICATION ÉCHOUÉE', status = 'VÉRIFICATION ÉCHOUÉE' WHERE id = ?", [r.id]); throw e; }
  const selfie = (f.selfie || [])[0] ? fileUrl(f.selfie[0]) : r.selfie;
  const just = (f.just || [])[0] ? fileUrl(f.just[0]) : r.justificatif;
  const dob = dateOrNull(b.dob) || r.dob, lieu = str(b.lieu, 80) || r.lieu_naissance;
  /* une correspondance n'est qu'une aide à la décision (VC02, Vérification §17–§20) :
     la confirmation du propriétaire est toujours prononcée par un agent Vérification & Contrôle */
  const st = !selfie || !dob || !lieu ? "COMPLÉMENT REQUIS" : "EN VÉRIFICATION";
  await q("UPDATE recoveries SET selfie = ?, justificatif = ?, dob = ?, lieu_naissance = ?, verif_status = ?, status = ? WHERE id = ?",
    [selfie, just, dob, lieu, st, st, r.id]);
  U.audit(req, "RECOVERY_VERIFY", "recovery", r.ref, st);
  res.json({ rec: await recView(await one("SELECT * FROM recoveries WHERE id = ?", [r.id])) });
}));

/* document protégé et propriétaire confirmé : récupération autorisée sans frais */
router.post("/:ref/authorize", h(async (req, res) => {
  const r = await getRec(req);
  if (r.verif_status !== "PROPRIÉTAIRE CONFIRMÉ") fail(409, "La vérification du propriétaire est requise.");
  if (!r.protected && !r.paid) fail(402, "Les frais de récupération doivent être réglés.");
  if (r.status !== "RÉCUPÉRATION AUTORISÉE") {
    await q("UPDATE recoveries SET status = 'RÉCUPÉRATION AUTORISÉE', withdrawal_code = COALESCE(withdrawal_code, ?) WHERE id = ?", [U.code6(), r.id]);
    const held = await one("SELECT a.nom FROM held_documents h JOIN agencies a ON a.id = h.agency_id WHERE h.id = ?", [r.held_id]);
    await U.notify(r.user_id, "Récupération autorisée", `Dossier ${r.ref} : présentez-vous à ${held.nom}.`, "recAuth|" + r.ref);
  }
  res.json({ rec: await recView(await one("SELECT * FROM recoveries WHERE id = ?", [r.id])) });
}));

/* livraison au propriétaire (Collecte §31–§35) : contrôles système, point de livraison confirmé,
   incluse dans la formule (quota) sinon payante ; le service Collecte planifie ensuite la mission */
router.post("/:ref/delivery", h(async (req, res) => {
  const r = await getRec(req), b = req.body;
  const c = await REC.conditions(r);
  if (!c.ok) fail(409, "Livraison non autorisée : " + c.list.filter(x => !x.ok).map(x => x.motif).join(" · "));
  if (await one("SELECT id FROM deliveries WHERE recovery_id = ? AND status NOT IN ('RETOURNEE','ANNULEE')", [r.id])) fail(409, "Une livraison est déjà demandée pour ce dossier.");
  const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
  if (!str(b.commune) || !isFinite(lat) || !isFinite(lng)) fail(400, "Confirmez votre point de livraison.");
  let included = false;
  if (r.user_id) { const ctx = await D.userCtx(r.user_id); included = (await D.deliveriesLeft(r.user_id, ctx)) > 0; }
  const ref = await U.nextRef("liv", "LIV");
  await q("INSERT INTO deliveries (ref, recovery_id, held_id, user_id, status, included, commune, lat, lng, repere, slot) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [ref, r.id, r.held_id, r.user_id, included ? "A_PLANIFIER" : "ATTENTE_PAIEMENT", included ? 1 : 0, str(b.commune, 40), lat, lng, str(b.repere, 160), str(b.slot, 60)]);
  if (included) {
    await q("UPDATE recoveries SET delivery = 1, deliv_ref = 'INCLUS-FORMULE' WHERE id = ?", [r.id]);
    await U.notify(r.user_id, "Livraison programmée", `Mission ${ref} : un partenaire agréé livrera votre document au point confirmé.`, "recAuth|" + r.ref);
  }
  res.json({ included, ref, amount: included ? 0 : +(await U.setting("frais_livraison", 1500)), rec: await recView(await one("SELECT * FROM recoveries WHERE id = ?", [r.id])) });
}));

module.exports = router;
module.exports.recView = recView;
