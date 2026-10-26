/* Profil de l'agent connecté (back-office) : identité, coordonnées, photo, mot de passe, sessions, historique.
   Monté dans routes/admin.js après requireStaff : req.staff est l'agent authentifié. */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { q, one } = require("../config/db");
const U = require("../lib/util");
const { signStaff } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { h, fail, str } = U;

const sensitive = rateLimit({ windowMs: 15 * 60e3, limit: 20, message: { error: "Trop de tentatives. Réessayez plus tard." } });
const checkPw = async (s, pw) => { if (!(await bcrypt.compare(String(pw || ""), s.password_hash))) fail(403, "Mot de passe actuel incorrect."); };
/* politique interne : 8 caractères minimum, au moins une lettre et un chiffre */
const policy = pw => {
  if (pw.length < 8) fail(400, "Le nouveau mot de passe doit contenir au moins 8 caractères.");
  if (!/[A-Za-zÀ-ÿ]/.test(pw) || !/\d/.test(pw)) fail(400, "Le nouveau mot de passe doit contenir au moins une lettre et un chiffre.");
};
/* ferme toutes les sessions ouvertes et renvoie un nouveau jeton pour la session courante */
const revokeOthers = async s => {
  /* tronqué à la seconde (DATETIME) : le nouveau jeton, émis dans la même seconde, reste valide */
  await q("UPDATE staff SET sessions_revoked_at = ? WHERE id = ?", [new Date(Math.floor(Date.now() / 1000) * 1000), s.id]);
  return signStaff(s);
};

router.get("/", h(async (req, res) => {
  const s = req.staff;
  const [access, logins, activity, stats] = await Promise.all([
    s.perms.length ? q("SELECT code, module, label FROM permissions WHERE code IN (?) ORDER BY module, label", [s.perms]) : [],
    q("SELECT id, success, ip, user_agent, created_at FROM staff_logins WHERE staff_id = ? ORDER BY id DESC LIMIT 15", [s.id]),
    q("SELECT id, action, entity, entity_ref, details, created_at FROM audit_logs WHERE actor_type = 'STAFF' AND actor_id = ? ORDER BY id DESC LIMIT 30", [s.id]),
    one(`SELECT (SELECT COUNT(*) FROM audit_logs WHERE actor_type = 'STAFF' AND actor_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) actions30,
                (SELECT COUNT(*) FROM staff_logins WHERE staff_id = ? AND success = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) logins30,
                (SELECT COUNT(*) FROM staff_logins WHERE staff_id = ? AND success = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) failed30`, [s.id, s.id, s.id])
  ]);
  res.json({
    profile: { id: s.id, prenom: s.prenom, nom: s.nom, email: s.email, tel: s.tel, photo: s.photo, role: s.role_code, roleLabel: s.role_label, agency: s.agency_nom,
      status: s.status, last_login: s.last_login, created_at: s.created_at, pw_changed_at: s.pw_changed_at },
    access, stats, logins, activity
  });
}));

/* identité et téléphone ; le changement de téléphone (qui reçoit les codes de connexion) exige le mot de passe */
router.patch("/", sensitive, h(async (req, res) => {
  const s = req.staff, b = req.body;
  const prenom = str(b.prenom, 60), nom = str(b.nom, 60), tel = b.tel !== undefined ? U.normTel(b.tel) : U.normTel(s.tel || "");
  if (!prenom || !nom) fail(400, "Le prénom et le nom sont obligatoires.");
  if (tel && tel.length < 8) fail(400, "Numéro de téléphone invalide.");
  if (!tel && !U.DEV) fail(400, "Un numéro de téléphone est obligatoire pour recevoir les codes de connexion.");
  const telChanged = tel !== U.normTel(s.tel || "");
  if (telChanged) {
    await checkPw(s, b.password);
    if (tel && await one("SELECT id FROM staff WHERE tel = ? AND id <> ?", [tel, s.id])) fail(409, "Ce numéro est déjà attribué à un autre agent.");
  }
  await q("UPDATE staff SET prenom = ?, nom = ?, tel = ? WHERE id = ?", [prenom, nom, tel || null, s.id]);
  U.audit(req, "STAFF_PROFILE_UPDATE", "staff", String(s.id), telChanged ? "téléphone modifié" : "identité modifiée");
  if (telChanged && s.tel) await U.sms(s.tel, "ID SECOURS : le numéro associé à votre compte agent vient d’être modifié. Si ce n’est pas vous, contactez immédiatement le Super Admin.");
  res.json({ ok: true });
}));

router.post("/photo", upload.single("photo"), h(async (req, res) => {
  if (!req.file || !/^image\//.test(req.file.mimetype)) fail(400, "Choisissez une image (JPG, PNG ou WebP).");
  await q("UPDATE staff SET photo = ? WHERE id = ?", [fileUrl(req.file), req.staff.id]);
  U.audit(req, "STAFF_PHOTO_UPDATE", "staff", String(req.staff.id));
  res.json({ photo: fileUrl(req.file) });
}));
router.delete("/photo", h(async (req, res) => {
  await q("UPDATE staff SET photo = NULL WHERE id = ?", [req.staff.id]);
  res.json({ ok: true });
}));

/* changement de mot de passe : ferme les autres sessions, prévient l'agent par SMS */
router.post("/password", sensitive, h(async (req, res) => {
  const s = req.staff, next = String(req.body.next || "");
  await checkPw(s, req.body.current);
  policy(next);
  if (await bcrypt.compare(next, s.password_hash)) fail(400, "Le nouveau mot de passe doit être différent de l’actuel.");
  await q("UPDATE staff SET password_hash = ?, pw_changed_at = NOW() WHERE id = ?", [await bcrypt.hash(next, 10), s.id]);
  const token = await revokeOthers(s);
  U.audit(req, "STAFF_PASSWORD_CHANGE", "staff", String(s.id));
  if (s.tel) await U.sms(s.tel, "ID SECOURS : le mot de passe de votre compte agent a été modifié. Si ce n’est pas vous, contactez immédiatement le Super Admin.");
  res.json({ token });
}));

router.post("/logout-others", h(async (req, res) => {
  const token = await revokeOthers(req.staff);
  U.audit(req, "STAFF_SESSIONS_REVOKED", "staff", String(req.staff.id));
  res.json({ token });
}));

module.exports = router;
