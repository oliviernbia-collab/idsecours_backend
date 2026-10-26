/* Profil, position, notifications, journal, dossiers, reçus — §64, §65, §66 */
const router = require("express").Router();
const { q, one } = require("../config/db");
const { h, fail, str, dateOrNull } = require("../lib/util");
const { requireUser } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { userView } = require("./auth");

router.use(requireUser);

router.patch("/", upload.single("photo"), h(async (req, res) => {
  const b = req.body, u = req.user;
  await q("UPDATE users SET prenom=?, nom=?, email=?, dob=?, commune=?, avenue=?, rue=?, complement=?, photo=? WHERE id=?",
    [str(b.prenom, 60) || u.prenom, str(b.nom, 60) || u.nom, b.email !== undefined ? str(b.email, 120) : u.email, b.dob !== undefined ? dateOrNull(b.dob) : u.dob,
     str(b.commune, 40) || u.commune, b.avenue !== undefined ? str(b.avenue, 80) : u.avenue, b.rue !== undefined ? str(b.rue, 80) : u.rue,
     b.complement !== undefined ? str(b.complement, 160) : u.complement, req.file ? fileUrl(req.file) : u.photo, u.id]);
  res.json({ user: userView(await one("SELECT * FROM users WHERE id = ?", [u.id])) });
}));

router.put("/position", h(async (req, res) => {
  const { commune, lat, lng, acc } = req.body;
  if (!isFinite(lat) || !isFinite(lng)) fail(400, "Position invalide.");
  await q("UPDATE users SET pos_commune=?, pos_lat=?, pos_lng=?, pos_acc=?, pos_at=NOW() WHERE id=?", [str(commune, 40), lat, lng, Math.round(acc || 0), req.user.id]);
  res.json({ position: { commune, lat, lng, acc, t: new Date() } });
}));

router.get("/notifications", h(async (req, res) => {
  const rows = await q("SELECT id, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100", [req.user.id]);
  res.json({ items: rows.map(n => ({ id: n.id, title: n.title, body: n.body, link: n.link, read: !!n.read_at, t: n.created_at })), unread: rows.filter(n => !n.read_at).length });
}));
router.post("/notifications/read", h(async (req, res) => {
  if (req.body.id) await q("UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?", [req.body.id, req.user.id]);
  else await q("UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL", [req.user.id]);
  res.json({ ok: true });
}));

router.get("/activity", h(async (req, res) => {
  res.json({ items: await q("SELECT label l, created_at t FROM user_activity WHERE user_id = ? ORDER BY id DESC LIMIT 200", [req.user.id]) });
}));

/* tous les dossiers : déclarations, récupérations, signalements */
router.get("/dossiers", h(async (req, res) => {
  const uid = req.user.id;
  const [decl, recs, founds] = await Promise.all([
    q(`SELECT l.ref, l.created_at t, l.closed, d.id doc_id, d.category_code cat, d.status st FROM loss_declarations l JOIN documents d ON d.id = l.document_id WHERE l.user_id = ?`, [uid]),
    q("SELECT ref, created_at t, category_code cat, status, verif_status, protected, paid, done_at FROM recoveries WHERE user_id = ?", [uid]),
    q("SELECT ref, created_at t, category_code cat, step FROM found_reports WHERE reporter_user_id = ?", [uid])
  ]);
  res.json({ decl, recs, founds });
}));

router.get("/receipts", h(async (req, res) => {
  const rows = await q("SELECT ref, label, amount, method, detail_lines, created_at t FROM payments WHERE user_id = ? AND status = 'RÉUSSI' ORDER BY id DESC", [req.user.id]);
  const meths = Object.fromEntries((await q("SELECT code, label FROM pay_methods")).map(m => [m.code, m.label]));
  res.json({ items: rows.map(({ detail_lines, ...r }) => ({ ...r, method: meths[r.method] || r.method, lines: JSON.parse(detail_lines || "[]") })) });
}));

/* suppression du compte (droit à l'effacement) */
router.delete("/", h(async (req, res) => {
  const open = await one("SELECT COUNT(*) n FROM recoveries WHERE user_id = ? AND done_at IS NULL", [req.user.id]);
  if (open.n) fail(409, "Un dossier de récupération est en cours. Clôturez-le avant de supprimer votre compte.");
  await q("DELETE FROM users WHERE id = ?", [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
