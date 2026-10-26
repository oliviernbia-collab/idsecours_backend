const jwt = require("jsonwebtoken");
const { one, q } = require("../config/db");
const { fail } = require("../lib/util");

const SECRET = () => process.env.JWT_SECRET || "dev-secret";
const signUser = u => jwt.sign({ sub: u.id, aud: "user" }, SECRET(), { expiresIn: process.env.JWT_USER_TTL || "30d" });
const signStaff = s => jwt.sign({ sub: s.id, aud: "staff" }, SECRET(), { expiresIn: process.env.JWT_STAFF_TTL || "12h" });

function bearer(req) { const a = req.headers.authorization || ""; return a.startsWith("Bearer ") ? a.slice(7) : null; }

async function loadUser(req) {
  const t = bearer(req); if (!t) return null;
  try {
    const p = jwt.verify(t, SECRET(), { audience: "user" });
    const u = await one("SELECT * FROM users WHERE id = ? AND status = 'ACTIF'", [p.sub]);
    return u || null;
  } catch { return null; }
}

/* utilisateur connecté obligatoire */
const requireUser = async (req, res, next) => {
  try { req.user = await loadUser(req); if (!req.user) return next(Object.assign(new Error("Session expirée. Reconnectez-vous."), { status: 401 })); next(); }
  catch (e) { next(e); }
};
/* utilisateur facultatif (recherche, « j'ai trouvé », récupération sans compte) */
const optionalUser = async (req, res, next) => { try { req.user = await loadUser(req); next(); } catch (e) { next(e); } };

const requireStaff = async (req, res, next) => {
  try {
    const t = bearer(req); if (!t) fail(401, "Authentification requise.");
    let p; try { p = jwt.verify(t, SECRET(), { audience: "staff" }); } catch { fail(401, "Session expirée. Reconnectez-vous."); }
    const s = await one(`SELECT s.*, r.code role_code, r.label role_label, a.nom agency_nom FROM staff s JOIN roles r ON r.id = s.role_id
                         LEFT JOIN agencies a ON a.id = s.agency_id WHERE s.id = ? AND s.status = 'ACTIVE'`, [p.sub]);
    if (!s) fail(401, "Compte interne inactif.");
    /* sessions fermées depuis le profil (changement de mot de passe, « déconnecter les autres appareils ») */
    if (s.sessions_revoked_at && p.iat < Math.floor(new Date(s.sessions_revoked_at).getTime() / 1000)) fail(401, "Session fermée. Reconnectez-vous.");
    s.perms = (await q("SELECT perm_code FROM role_permissions WHERE role_id = ?", [s.role_id])).map(r => r.perm_code);
    req.staff = s; next();
  } catch (e) { next(e); }
};
/* au moins une des permissions */
const can = (...perms) => (req, res, next) => {
  if (!req.staff || !perms.some(p => req.staff.perms.includes(p))) return next(Object.assign(new Error("Accès refusé pour votre rôle."), { status: 403 }));
  next();
};

module.exports = { signUser, signStaff, requireUser, optionalUser, requireStaff, can };
