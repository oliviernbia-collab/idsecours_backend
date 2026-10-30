/* Avis de satisfaction après une étape terminée : restitution au guichet, livraison, collecte d'un document trouvé.
   Accessible avec un compte ou avec le jeton d'accès du dossier (comme le dossier lui-même) ; un avis par dossier. */
const router = require("express").Router();
const { q, one } = require("../config/db");
const U = require("../lib/util");
const { optionalUser, requireUser } = require("../middleware/auth");
const { dossierFor } = require("../lib/dossiers");
const { h, fail, str } = U;

const CONTEXT = { RESTITUTION: "Restitution au guichet", LIVRAISON: "Livraison à domicile", COLLECTE: "Collecte du document trouvé", ASSISTANCE: "Assistance aux agences" };

/* contexte évaluable d'un dossier terminé (sinon null) */
async function target(d) {
  if (d.type === "rec" && d.row.done_at) {
    const r = d.row, h = await one("SELECT agency_id FROM held_documents WHERE id = ?", [r.held_id]);
    const dl = await one("SELECT partner_id FROM deliveries WHERE recovery_id = ? AND status = 'LIVREE' ORDER BY id DESC LIMIT 1", [r.id]);
    return { context: dl ? "LIVRAISON" : "RESTITUTION", ref: r.ref, user_id: r.user_id, agency_id: h && h.agency_id, partner_id: dl ? dl.partner_id : null };
  }
  if (d.type === "found" && d.row.step >= 6 && !d.row.cancelled_at)
    return { context: "COLLECTE", ref: d.row.ref, user_id: d.row.reporter_user_id, agency_id: d.row.agency_id, partner_id: d.row.partner_id };
  return null;
}

/* une note basse alerte le pilotage pour amélioration continue */
async function save(t, { note, commentaire, staffId = null }) {
  note = parseInt(note, 10); if (!(note >= 1 && note <= 5)) fail(400, "Choisissez une note de 1 à 5 étoiles.");
  if (await one("SELECT id FROM feedbacks WHERE context = ? AND ref = ?", [t.context, t.ref])) fail(409, "Vous avez déjà donné votre avis pour ce dossier. Merci !");
  const c = str(commentaire, 500);
  await q("INSERT INTO feedbacks (context, ref, user_id, staff_id, agency_id, partner_id, note, commentaire) VALUES (?,?,?,?,?,?,?,?)",
    [t.context, t.ref, t.user_id || null, staffId, t.agency_id || null, t.partner_id || null, note, c]);
  if (note <= 2) await require("../lib/alerts").push("feedback:" + t.ref, ["performance.view", "incidents.manage"], `Avis négatif · ${CONTEXT[t.context]}`, `${t.ref} · ${note}/5${c ? " · « " + c.slice(0, 200) + " »" : ""}`, "feedback", "HAUTE");
}

/* avis en attente pour l'utilisateur connecté (accueil) */
router.get("/pending", requireUser, h(async (req, res) => {
  const recs = await q(`SELECT r.ref, r.category_code cat, r.done_at t, EXISTS(SELECT 1 FROM deliveries d WHERE d.recovery_id = r.id AND d.status = 'LIVREE') livre FROM recoveries r
    WHERE r.user_id = ? AND r.done_at > DATE_SUB(NOW(), INTERVAL 60 DAY) AND NOT EXISTS (SELECT 1 FROM feedbacks f WHERE f.ref = r.ref)`, [req.user.id]);
  const founds = await q(`SELECT f.ref, f.category_code cat, f.received_at t FROM found_reports f WHERE f.reporter_user_id = ? AND f.step >= 6 AND f.cancelled_at IS NULL
    AND f.received_at > DATE_SUB(NOW(), INTERVAL 60 DAY) AND NOT EXISTS (SELECT 1 FROM feedbacks x WHERE x.ref = f.ref)`, [req.user.id]);
  const items = [...recs.map(r => ({ ref: r.ref, cat: r.cat, t: r.t, context: r.livre ? "LIVRAISON" : "RESTITUTION" })), ...founds.map(f => ({ ...f, context: "COLLECTE" }))]
    .sort((a, b) => new Date(b.t) - new Date(a.t)).map(x => ({ ...x, label: CONTEXT[x.context] }));
  res.json({ items });
}));

router.get("/:ref", optionalUser, h(async (req, res) => {
  const t = await target(await dossierFor(req, req.params.ref));
  if (!t) return res.json({ eligible: false });
  const f = await one("SELECT note, commentaire, created_at FROM feedbacks WHERE context = ? AND ref = ?", [t.context, t.ref]);
  res.json({ eligible: true, context: t.context, label: CONTEXT[t.context], feedback: f });
}));
router.post("/:ref", optionalUser, h(async (req, res) => {
  const t = await target(await dossierFor(req, req.params.ref));
  if (!t) fail(409, "Vous pourrez donner votre avis une fois l’étape terminée.");
  await save(t, req.body);
  U.audit(null, "FEEDBACK", "feedback", t.ref, `${t.context} · ${req.body.note}/5`);
  res.status(201).json({ ok: true });
}));

module.exports = router;
module.exports.save = save;
module.exports.CONTEXT = CONTEXT;
