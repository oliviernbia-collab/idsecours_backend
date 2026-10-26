/* Messagerie contextuelle liée à un dossier — §21, §22, §47, §48 */
const router = require("express").Router();
const { q } = require("../config/db");
const { h, fail, str } = require("../lib/util");
const { optionalUser } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { dossierFor } = require("../lib/dossiers");

router.use(optionalUser);

const view = m => ({ id: m.id, me: m.sender === "USER", kind: m.kind, text: m.body, file: m.file_url, name: m.file_name, dur: m.duration, t: m.created_at, agent: m.sender !== "USER" });

router.get("/:ref", h(async (req, res) => {
  await dossierFor(req, req.params.ref);
  const rows = await q("SELECT * FROM messages WHERE dossier_ref = ? ORDER BY id", [req.params.ref]);
  res.json({ items: rows.map(view) });
}));

router.post("/:ref", upload.single("file"), h(async (req, res) => {
  await dossierFor(req, req.params.ref);
  const b = req.body, f = req.file;
  let kind = "text";
  if (f) kind = f.mimetype.startsWith("audio/") ? "voice" : "file";
  else if (!str(b.text)) fail(400, "Message vide.");
  await q("INSERT INTO messages (dossier_ref, sender, kind, body, file_url, file_name, duration) VALUES (?, 'USER', ?, ?, ?, ?, ?)",
    [req.params.ref, kind, str(b.text, 2000), fileUrl(f), f ? str(b.name || f.originalname, 160) : null, b.dur ? Math.round(+b.dur) : null]);
  const rows = await q("SELECT * FROM messages WHERE dossier_ref = ? ORDER BY id", [req.params.ref]);
  res.status(201).json({ items: rows.map(view) });
}));

module.exports = router;
