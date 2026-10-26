/* Création de compte (OTP), connexion, mot de passe oublié — §3, §4 */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { q, one } = require("../config/db");
const { h, fail, normTel, str, dateOrNull, createOtp, checkOtp, sms, notify, activity, audit, DEV } = require("../lib/util");
const { signUser, requireUser } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");

const limiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Trop de tentatives. Réessayez dans quelques minutes." } });
router.use(limiter);

const userView = u => ({ id: u.id, prenom: u.prenom, nom: u.nom, tel: u.tel, email: u.email, dob: u.dob, ville: u.ville, commune: u.commune, avenue: u.avenue, rue: u.rue, complement: u.complement, photo: u.photo, verified: !!u.verified,
  position: u.pos_lat ? { commune: u.pos_commune, lat: +u.pos_lat, lng: +u.pos_lng, acc: u.pos_acc, t: u.pos_at } : null });

/* étape 1 : envoi de l'OTP avec les données d'inscription (rien n'est créé avant vérification) */
router.post("/signup", upload.single("photo"), h(async (req, res) => {
  const b = req.body, tel = normTel(b.tel);
  const miss = ["nom", "prenoms", "tel"].filter(k => !str(b[k]));
  if (miss.length) fail(400, "Complétez les champs obligatoires (*).", { fields: miss });
  if (tel.length < 8) fail(400, "Numéro de téléphone invalide.", { fields: ["tel"] });
  if (String(b.password || "").length < 6) fail(400, "Mot de passe : 6 caractères minimum.");
  if (!(b.cgu === "true" || b.cgu === true)) fail(400, "Acceptez les trois conditions pour continuer.");
  if (await one("SELECT id FROM users WHERE tel = ?", [tel])) fail(409, "Ce numéro possède déjà un compte. Connectez-vous.");
  const payload = {
    prenom: str(b.prenoms, 80), nom: str(b.nom, 60), email: str(b.email, 120), dob: dateOrNull(b.dob), ville: str(b.ville, 60) || "Abidjan",
    commune: str(b.commune, 40), avenue: str(b.avenue, 80), rue: str(b.rue, 80), complement: str(b.compl, 160),
    photo: fileUrl(req.file), hash: await bcrypt.hash(String(b.password), 10)
  };
  const code = await createOtp(tel, "signup", null, payload);
  await sms(tel, `Votre code de vérification ID SECOURS est ${code}. Il expire dans 10 minutes.`);
  res.json({ ok: true, tel, ...(DEV ? { devCode: code } : {}) });
}));

router.post("/signup/resend", h(async (req, res) => {
  const tel = normTel(req.body.tel);
  const last = await one("SELECT payload FROM otp_codes WHERE tel = ? AND purpose = 'signup' ORDER BY id DESC LIMIT 1", [tel]);
  if (!last) fail(400, "Recommencez l’inscription.");
  const code = await createOtp(tel, "signup", null, JSON.parse(last.payload));
  await sms(tel, `Votre code de vérification ID SECOURS est ${code}.`);
  res.json({ ok: true, ...(DEV ? { devCode: code } : {}) });
}));

/* étape 2 : vérification de l'OTP → création du compte (aucune protection activée) */
router.post("/signup/verify", h(async (req, res) => {
  const tel = normTel(req.body.tel);
  const p = await checkOtp(tel, "signup", req.body.code);
  if (await one("SELECT id FROM users WHERE tel = ?", [tel])) fail(409, "Ce numéro possède déjà un compte.");
  const r = await q(`INSERT INTO users (prenom, nom, tel, email, password_hash, dob, ville, commune, avenue, rue, complement, photo, verified, pos_commune)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    [p.prenom.split(" ")[0], p.nom, tel, p.email, p.hash, p.dob, p.ville, p.commune, p.avenue, p.rue, p.complement, p.photo, p.commune || "Cocody"]);
  const id = r.insertId;
  await q("INSERT INTO sos_settings (user_id) VALUES (?)", [id]);
  await notify(id, "Numéro vérifié", "Bienvenue sur ID SECOURS. La création du compte n’active aucune protection.", "protChoice");
  await activity(id, "Création du compte · numéro vérifié");
  audit(null, "USER_SIGNUP", "user", String(id));
  const u = await one("SELECT * FROM users WHERE id = ?", [id]);
  res.json({ token: signUser(u), user: userView(u) });
}));

router.post("/login", h(async (req, res) => {
  const tel = normTel(req.body.tel), pw = String(req.body.password || "");
  if (!tel || pw.length < 4) fail(400, "Renseignez votre numéro et votre mot de passe.");
  const u = await one("SELECT * FROM users WHERE tel = ?", [tel]);
  if (u && u.status === "A_ACTIVER") fail(403, "Compte à activer : utilisez « Mot de passe oublié / activer mon compte » avec votre numéro.");
  if (!u || !(await bcrypt.compare(pw, u.password_hash))) fail(401, "Numéro ou mot de passe incorrect.");
  if (u.status !== "ACTIF") fail(403, "Compte suspendu. Contactez le support.");
  await activity(u.id, "Connexion par mot de passe");
  res.json({ token: signUser(u), user: userView(u) });
}));

/* mot de passe oublié : code puis nouveau mot de passe */
router.post("/forgot", h(async (req, res) => {
  const tel = normTel(req.body.tel);
  const u = await one("SELECT id FROM users WHERE tel = ?", [tel]);
  let devCode;
  if (u) { devCode = await createOtp(tel, "reset"); await sms(tel, `Votre code de réinitialisation ID SECOURS : ${devCode}. Il expire dans 10 minutes.`); }
  res.json({ ok: true, ...(DEV && devCode ? { devCode } : {}) }); // réponse identique que le compte existe ou non
}));
router.post("/reset", h(async (req, res) => {
  const tel = normTel(req.body.tel);
  if (String(req.body.password || "").length < 6) fail(400, "Mot de passe : 6 caractères minimum.");
  await checkOtp(tel, "reset", req.body.code);
  /* également utilisé pour activer un compte préparé par un conseiller commercial (numéro vérifié par l'OTP) */
  const before = await one("SELECT status FROM users WHERE tel = ?", [tel]);
  await q("UPDATE users SET password_hash = ?, verified = 1, status = IF(status = 'A_ACTIVER', 'ACTIF', status) WHERE tel = ?", [await bcrypt.hash(String(req.body.password), 10), tel]);
  const u = await one("SELECT * FROM users WHERE tel = ?", [tel]);
  if (u.status === "SUSPENDU") fail(403, "Compte suspendu. Contactez le support.");
  await activity(u.id, before && before.status === "A_ACTIVER" ? "Compte activé · numéro vérifié" : "Mot de passe réinitialisé");
  res.json({ token: signUser(u), user: userView(u) });
}));

router.get("/me", requireUser, h(async (req, res) => res.json({ user: userView(req.user) })));

module.exports = router;
module.exports.userView = userView;
