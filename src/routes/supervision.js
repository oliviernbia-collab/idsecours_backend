/* Super Admin — indicateur d'état du système (§6), tableau de bord filtrable par période / agence / ville (§60),
   sauvegardes (§56) */
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const { q, one } = require("../config/db");
const U = require("../lib/util");
const B = require("../lib/backup");
const { requireStaff, can } = require("../middleware/auth");
const { h, fail, str } = U;

router.use(requireStaff);

/* état du système : calculé à partir des signaux réels (base, incidents, SOS, sauvegardes, agences) */
router.get("/system-status", h(async (req, res) => {
  const reasons = [];
  let level = "OPERATIONNEL";
  const bump = (l, why) => { reasons.push(why); if (l === "INCIDENT_MAJEUR" || level === "OPERATIONNEL") level = l; };
  const [crit, sos, bk, ag, pay] = await Promise.all([
    one("SELECT COUNT(*) n FROM ops_incidents WHERE priorite = 'CRITIQUE' AND statut IN ('OUVERT','EN COURS')"),
    one("SELECT COUNT(*) n FROM sos_incidents WHERE closed = 0 AND is_test = 0 AND status NOT IN ('PRIS_EN_CHARGE','INTERVENTION_EN_COURS') AND created_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)"),
    one("SELECT status, created_at FROM backups ORDER BY id DESC LIMIT 1"),
    one("SELECT SUM(status <> 'ACTIVE') n, COUNT(*) t FROM agencies"),
    one("SELECT COUNT(*) n FROM payments WHERE status = 'EN ATTENTE' AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)")
  ]);
  if (crit.n) bump("INCIDENT_MAJEUR", `${crit.n} incident(s) critique(s) ouvert(s)`);
  if (sos.n) bump("INCIDENT_MAJEUR", `${sos.n} alerte(s) SOS sans prise en charge`);
  const bkH = +(await U.setting("backup_auto_h", 24));
  if (!bk) bump("PERTURBE", "Aucune sauvegarde réalisée");
  else if (bk.status === "ECHEC") bump("PERTURBE", "Échec de la dernière sauvegarde");
  else if (bkH && Date.now() - new Date(bk.created_at) > 2 * bkH * 3600e3) bump("PERTURBE", "Dernière sauvegarde trop ancienne");
  if (+ag.n) bump("PERTURBE", `${ag.n} agence(s) indisponible(s) ou suspendue(s) sur ${ag.t}`);
  if (pay.n) bump("PERTURBE", `${pay.n} paiement(s) en attente depuis plus de 2 h (passerelle ?)`);
  res.json({ level, reasons, details: req.staff.perms.includes("system.view") || req.staff.perms.includes("staff.manage") });
}));

/* activité sur une période, filtrable par agence ou par ville (commune) */
router.get("/dashboard/period", can("dashboard.view"), h(async (req, res) => {
  const d = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null;
  const from = d(req.query.from) || "1970-01-01", to = d(req.query.to) || "2999-12-31";
  const ag = +req.query.agency || null, commune = str(req.query.commune, 40) || null;
  const agencies = ag ? [ag] : commune ? (await q("SELECT id FROM agencies WHERE commune = ?", [commune])).map(a => a.id) : null;
  if (agencies && !agencies.length) agencies.push(0);
  const inAg = col => agencies ? ` AND ${col} IN (${agencies.map(Number).join(",")})` : "";
  const per = col => ` AND DATE(${col}) BETWEEN ? AND ?`;
  const [users, prots, decl, found, recv, rest, rev, incidents] = await Promise.all([
    one(`SELECT COUNT(*) n FROM users WHERE 1${per("created_at")}${commune && !ag ? " AND commune = ?" : ""}`, commune && !ag ? [from, to, commune] : [from, to]),
    one(`SELECT COUNT(*) n FROM protections WHERE 1${per("created_at")}`, [from, to]),
    one(`SELECT COUNT(*) n FROM loss_declarations WHERE 1${per("created_at")}${commune ? " AND commune = ?" : ""}`, commune ? [from, to, commune] : [from, to]),
    one(`SELECT COUNT(*) n FROM found_reports WHERE 1${per("created_at")}${agencies ? inAg("agency_id") : ""}`, [from, to]),
    one(`SELECT COUNT(*) n FROM held_documents WHERE 1${per("received_at")}${inAg("agency_id")}`, [from, to]),
    one(`SELECT COUNT(*) n FROM recoveries r JOIN held_documents h ON h.id = r.held_id WHERE r.done_at IS NOT NULL${per("r.done_at")}${inAg("h.agency_id")}`, [from, to]),
    one(`SELECT COALESCE(SUM(amount), 0) n FROM payments WHERE status = 'RÉUSSI'${per("created_at")}${agencies ? inAg("agency_id") : ""}`, [from, to]),
    one(`SELECT COUNT(*) n FROM ops_incidents WHERE 1${per("created_at")}${inAg("agency_id")}`, [from, to])
  ]);
  res.json({
    filters: { from, to, agency: ag, commune },
    kpi: { inscriptions: users.n, protections: prots.n, declarations: decl.n, signalements: found.n, receptions: recv.n, restitutions: rest.n, incidents: incidents.n,
      revenus: req.staff.perms.includes("finance.view") ? +rev.n : null, revenusAgence: !!agencies }
  });
}));

/* ---------- sauvegardes ---------- */
router.get("/backups", can("backups.manage"), h(async (req, res) => {
  res.json({
    items: await q("SELECT b.*, CONCAT(s.prenom, ' ', s.nom) agent FROM backups b LEFT JOIN staff s ON s.id = b.staff_id ORDER BY b.id DESC LIMIT 60"),
    autoH: +(await U.setting("backup_auto_h", 24)), keep: +(await U.setting("backup_keep", 14)), canDownload: req.staff.perms.includes("staff.manage")
  });
}));
router.post("/backups", can("backups.manage"), h(async (req, res) => {
  const r = await B.run("MANUELLE", req.staff.id);
  U.audit(req, "BACKUP_CREATED", "backup", r.file, `${r.tables} tables · ${r.rows} lignes · ${r.kb} Ko`);
  res.status(201).json(r);
}));
/* téléchargement réservé au Super Admin : la sauvegarde contient des données personnelles (journalisé) */
router.get("/backups/:id/download", can("staff.manage"), h(async (req, res) => {
  const b = await one("SELECT * FROM backups WHERE id = ? AND status = 'REUSSIE'", [req.params.id]);
  if (!b || !b.file || !fs.existsSync(path.join(B.DIR, b.file))) fail(404, "Fichier de sauvegarde indisponible (supprimé par la rotation).");
  U.audit(req, "BACKUP_DOWNLOADED", "backup", b.file);
  res.download(path.join(B.DIR, b.file), b.file);
}));

module.exports = router;
