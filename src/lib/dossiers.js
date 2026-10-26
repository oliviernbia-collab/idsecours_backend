/* Résolution d'un dossier (déclaration, récupération, signalement) + contrôle d'accès
   propriétaire connecté OU jeton d'accès (parcours sans compte) OU agent habilité */
const { one } = require("../config/db");
const { fail } = require("./util");

async function resolveDossier(ref) {
  if (/^IDS-PER-/.test(ref)) { const r = await one("SELECT * FROM loss_declarations WHERE ref = ?", [ref]); return r && { type: "decl", row: r, userId: r.user_id, token: null }; }
  if (/^IDS-REC-/.test(ref)) { const r = await one("SELECT * FROM recoveries WHERE ref = ?", [ref]); return r && { type: "rec", row: r, userId: r.user_id, token: r.access_token }; }
  if (/^IDS-TRO-/.test(ref)) { const r = await one("SELECT * FROM found_reports WHERE ref = ?", [ref]); return r && { type: "found", row: r, userId: r.reporter_user_id, token: r.access_token }; }
  return null;
}
async function dossierFor(req, ref) {
  const d = await resolveDossier(ref);
  if (!d) fail(404, "Dossier introuvable.");
  const okUser = req.user && d.userId === req.user.id;
  const okToken = d.token && req.get("x-access-token") === d.token;
  if (!okUser && !okToken) fail(403, "Accès refusé à ce dossier.");
  return d;
}
module.exports = { resolveDossier, dossierFor };
