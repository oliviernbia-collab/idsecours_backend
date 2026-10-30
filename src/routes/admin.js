/* Back-office ID SECOURS — Super Admin, Direction, Finance, Opérations, Commercial, Support,
   Collecte & Livraison, Vérification & Contrôle, Réception & Restitution (cahiers des charges des modules internes) */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");
const LOC = require("../lib/locations");
const RNW = require("../lib/renewals");
const { q, one, tx } = require("../config/db");
const U = require("../lib/util");
const D = require("../lib/domain");
const { signStaff, requireStaff, can } = require("../middleware/auth");
const { matchHeldForDoc } = require("./documents");
const REC = require("../lib/recovery");
const { upload, fileUrl } = require("../middleware/upload");
const M = require("../lib/match");
const { h, fail, str, fcfa } = U;

/* ---------- authentification interne ---------- */
router.post("/auth/login", rateLimit({ windowMs: 15 * 60e3, limit: 20, message: { error: "Trop de tentatives. Réessayez plus tard." } }), h(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const s = await one("SELECT * FROM staff WHERE email = ?", [email]);
  const ok = s && s.status === "ACTIVE" && await bcrypt.compare(String(req.body.password || ""), s.password_hash);
  await q("INSERT INTO staff_logins (staff_id, email, success, ip, user_agent) VALUES (?,?,?,?,?)", [s ? s.id : null, email, ok ? 1 : 0, req.ip, String(req.get("user-agent") || "").slice(0, 255)]);
  if (!ok) fail(401, "Identifiants incorrects ou compte suspendu.");
  /* authentification renforcée : code à usage unique envoyé au téléphone de l'agent */
  if (!s.tel && !U.DEV) fail(409, "Aucun numéro de téléphone pour ce compte : contactez le Super Admin.");
  const code = await U.createOtp("staff:" + s.id, "staff_login");
  if (s.tel) await U.sms(s.tel, `ID SECOURS · code de connexion agent : ${code}. Ne le communiquez à personne.`);
  const challenge = require("jsonwebtoken").sign({ sub: s.id, aud: "staff-otp" }, process.env.JWT_SECRET || "dev-secret", { expiresIn: "10m" });
  res.json({ otp: true, challenge, tel: s.tel ? "•• •• •• " + U.normTel(s.tel).slice(-4).replace(/(\d{2})(\d{2})/, "$1 $2") : null, ...(U.DEV ? { devCode: code } : {}) });
}));
router.post("/auth/otp", rateLimit({ windowMs: 15 * 60e3, limit: 20, message: { error: "Trop de tentatives. Réessayez plus tard." } }), h(async (req, res) => {
  let p; try { p = require("jsonwebtoken").verify(String(req.body.challenge || ""), process.env.JWT_SECRET || "dev-secret", { audience: "staff-otp" }); } catch { fail(401, "Session de connexion expirée. Recommencez."); }
  const s = await one("SELECT * FROM staff WHERE id = ? AND status = 'ACTIVE'", [p.sub]);
  if (!s) fail(401, "Compte inactif.");
  try { await U.checkOtp("staff:" + s.id, "staff_login", req.body.code); }
  catch (e) { await q("INSERT INTO staff_logins (staff_id, email, success, ip, user_agent) VALUES (?,?,0,?,?)", [s.id, s.email, req.ip, "OTP invalide"]); throw e; }
  await q("UPDATE staff SET last_login = NOW() WHERE id = ?", [s.id]);
  U.audit({ staff: s, ip: req.ip }, "STAFF_LOGIN", "staff", String(s.id));
  res.json({ token: signStaff(s) });
}));

router.use(requireStaff);
const staffView = s => ({ id: s.id, prenom: s.prenom, nom: s.nom, email: s.email, photo: s.photo, role: s.role_code, roleLabel: s.role_label, agency: s.agency_nom, perms: s.perms });
router.get("/me", h(async (req, res) => res.json({ staff: staffView(req.staff) })));
router.use("/profile", require("./staffProfile"));

const like = v => `%${String(v || "").trim()}%`;
const paging = req => ({ limit: Math.min(200, +req.query.limit || 50), offset: Math.max(0, +req.query.offset || 0) });

/* ---------- tableau de bord ---------- */
router.get("/dashboard", can("dashboard.view"), h(async (req, res) => {
  const fin = req.staff.perms.includes("finance.view");
  const [users, subs, docs, decl, held, rest, rev, months, byCat, bySt, lastUsers, lastDecl, recent, sosOpen, verifQ] = await Promise.all([
    one("SELECT COUNT(*) n, SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) m FROM users"),
    one("SELECT COUNT(*) n FROM protections WHERE suspended = 0 AND exp_at > NOW()"),
    one("SELECT COUNT(*) n FROM documents"),
    one("SELECT COUNT(*) n, SUM(closed = 0) open FROM loss_declarations"),
    one("SELECT COUNT(*) n, SUM(status IN ('RECU','CONSERVE')) stock FROM held_documents"),
    one("SELECT COUNT(*) n FROM recoveries WHERE done_at IS NOT NULL"),
    one("SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN amount END),0) m FROM payments WHERE status = 'RÉUSSI'"),
    q(`SELECT DATE_FORMAT(d, '%Y-%m') ym,
         (SELECT COUNT(*) FROM users WHERE DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(d, '%Y-%m')) inscriptions,
         (SELECT COUNT(*) FROM protections WHERE DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(d, '%Y-%m')) abonnements,
         (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'RÉUSSI' AND DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(d, '%Y-%m')) revenus
       FROM (SELECT LAST_DAY(NOW()) - INTERVAL n MONTH d FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) x) m ORDER BY ym`),
    q("SELECT c.short label, c.color, COUNT(d.id) n FROM doc_categories c LEFT JOIN documents d ON d.category_code = c.code GROUP BY c.code ORDER BY c.position"),
    q("SELECT status, COUNT(*) n FROM documents GROUP BY status"),
    q("SELECT id, prenom, nom, tel, commune, created_at FROM users ORDER BY id DESC LIMIT 6"),
    q(`SELECT l.ref, l.created_at, c.short cat, u.prenom, u.nom, l.commune, l.closed FROM loss_declarations l JOIN documents d ON d.id = l.document_id
       JOIN doc_categories c ON c.code = d.category_code JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 6`),
    q("SELECT action, entity_ref, details, actor_type, created_at FROM audit_logs ORDER BY id DESC LIMIT 10"),
    one("SELECT COUNT(*) n FROM sos_incidents WHERE closed = 0 AND is_test = 0"),
    one("SELECT COUNT(*) n FROM recoveries WHERE verif_status = 'EN VÉRIFICATION'")
  ]);
  /* circuit de l'organigramme : nombre de dossiers en attente à chaque étape */
  const fl = await one(`SELECT SUM(step <= 1) s1, SUM(step BETWEEN 2 AND 4) s2, SUM(step = 5) s3 FROM found_reports`);
  const s4 = await one("SELECT COUNT(*) n FROM held_documents WHERE status = 'A_CONTROLER'");
  const s6 = await one("SELECT SUM(done_at IS NULL AND status = 'RÉCUPÉRATION AUTORISÉE') auth, SUM(done_at IS NOT NULL) done FROM recoveries");
  const flux = [+fl.s1 || 0, +fl.s2 || 0, +fl.s3 || 0, s4.n, +s6.auth || 0, +s6.done || 0];
  res.json({
    flux,
    kpi: { users: users.n, usersMonth: +users.m || 0, subs: subs.n, docs: docs.n, decl: decl.n, declOpen: +decl.open || 0, found: held.n, stock: +held.stock || 0, restitutions: rest.n,
      revenue: fin ? +rev.total : null, revenueMonth: fin ? +rev.m : null, sosOpen: sosOpen.n, verifQueue: verifQ.n },
    months: months.map(m => ({ ...m, revenus: fin ? +m.revenus : null })), byCat, bySt, lastUsers, lastDecl, recent
  });
}));

/* ---------- tableaux de bord spécialisés par service (chaque cahier « Tableau de bord / KPI ») ---------- */
const last7 = async (sql) => {
  const rows = await q(sql); const m = Object.fromEntries(rows.map(r => [r.d, +r.n]));
  return [...Array(7)].map((_, i) => { const d = new Date(Date.now() - (6 - i) * 864e5), k = d.toISOString().slice(0, 10); return { l: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`, v: m[k] || 0 }; });
};
router.get("/dashboard/service", can("dashboard.view"), h(async (req, res) => {
  const role = req.staff.role_code, K = (ic, l, v, c = "blue") => ({ ic, l, v, c });
  if (role === "RECEPTION") {
    const k = await one(`SELECT (SELECT COUNT(*) FROM held_documents WHERE DATE(received_at) = CURDATE()) today, (SELECT COUNT(*) FROM held_documents) total,
      (SELECT COUNT(*) FROM held_documents WHERE status = 'A_CONTROLER') attente, (SELECT COUNT(*) FROM held_documents WHERE status IN ('RECU','CONSERVE','QUARANTAINE','A_CONTROLER')) stock,
      (SELECT COUNT(*) FROM held_documents WHERE emplacement IS NULL AND status IN ('RECU','A_CONTROLER')) sans_emp, (SELECT COUNT(*) FROM recoveries WHERE done_at IS NOT NULL) restit,
      (SELECT COUNT(*) FROM found_reports WHERE step = 5) transit`);
    return res.json({ title: "Réception & Restitution", kpis: [K("warehouse", "Documents reçus aujourd’hui", k.today, "green"), K("doc", "Documents enregistrés", k.total), K("clock", "En attente de contrôle", k.attente, "orange"), K("lock", "Stock sécurisé", k.stock), K("truck", "Attendus (en transit)", k.transit, "orange"), K("hand", "Restitutions effectuées", k.restit, "green"), K("alert", "Documents sans emplacement", k.sans_emp, "red")],
      series: { title: "Documents reçus (7 jours)", data: await last7("SELECT DATE(received_at) d, COUNT(*) n FROM held_documents WHERE received_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY d") },
      bars: { title: "Stock par type de document", data: (await q("SELECT c.short l, COUNT(h.id) v FROM doc_categories c LEFT JOIN held_documents h ON h.category_code = c.code AND h.status IN ('RECU','CONSERVE','A_CONTROLER','QUARANTAINE') GROUP BY c.code ORDER BY c.position")).map(x => ({ l: x.l, v: +x.v })) },
      links: [["reception", "Réception & stock"], ["restitutions", "Restitutions"]] });
  }
  if (role === "VERIFICATION") {
    const k = await one(`SELECT (SELECT COUNT(*) FROM held_documents WHERE status = 'A_CONTROLER') docs, (SELECT COUNT(*) FROM recoveries WHERE verif_status = 'EN VÉRIFICATION') identite,
      (SELECT COUNT(*) FROM held_documents WHERE status = 'QUARANTAINE') suspects, (SELECT COUNT(*) FROM recoveries WHERE verif_status = 'PROPRIÉTAIRE CONFIRMÉ') valides,
      (SELECT COUNT(*) FROM official_declarations WHERE status = 'EN VÉRIFICATION') offi, (SELECT COUNT(*) FROM publications WHERE status = 'EN VALIDATION') pubs,
      (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, created_at, verified_at)) / 60, 1) FROM recoveries WHERE verified_at IS NOT NULL) delai,
      (SELECT SUM(verif_status = 'PROPRIÉTAIRE CONFIRMÉ') * 100 DIV GREATEST(1, COUNT(*)) FROM recoveries WHERE verif_status IN ('PROPRIÉTAIRE CONFIRMÉ','VÉRIFICATION ÉCHOUÉE')) taux`);
    return res.json({ title: "Vérification & Contrôle", kpis: [K("magnify", "Documents à contrôler", k.docs, "orange"), K("userShield", "Vérifications d’identité", k.identite, "orange"), K("alert", "Suspicions (quarantaine)", k.suspects, "red"), K("check", "Propriétaires validés", k.valides, "green"), K("file", "Déclarations officielles à contrôler", k.offi), K("mega", "Publications à valider", k.pubs), K("clock", "Délai moyen de vérification", k.delai == null ? "—" : k.delai + " h"), K("chartUp", "Taux de validation", (k.taux || 0) + " %", "green")],
      series: { title: "Contrôles réalisés (7 jours)", data: await last7("SELECT DATE(verif_at) d, COUNT(*) n FROM held_documents WHERE verif_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY d") },
      bars: { title: "Décisions de vérification", data: (await q("SELECT COALESCE(verif_status, 'En attente du demandeur') l, COUNT(*) v FROM recoveries GROUP BY verif_status")).map(x => ({ l: x.l, v: +x.v })) },
      links: [["found-checks", "Contrôle des documents"], ["verifications", "Vérification des propriétaires"]] });
  }
  if (role === "COLLECTE") {
    const k = await one(`SELECT (SELECT COUNT(*) FROM found_reports WHERE step <= 1) demandes, (SELECT COUNT(*) FROM found_reports WHERE step BETWEEN 2 AND 4) missions,
      (SELECT COUNT(*) FROM found_reports WHERE DATE(handed_at) = CURDATE()) collectees, (SELECT COUNT(*) FROM deliveries WHERE status = 'A_PLANIFIER') a_planifier,
      (SELECT COUNT(*) FROM deliveries WHERE status IN ('PLANIFIEE','EN_LIVRAISON')) livraisons, (SELECT COUNT(*) FROM deliveries WHERE status IN ('ECHEC','REMISE_BLOQUEE')) echecs,
      (SELECT COUNT(*) FROM partners WHERE status = 'ACTIF') partenaires`);
    return res.json({ title: "Collecte & Livraison", kpis: [K("hand", "Demandes de collecte", k.demandes, "orange"), K("moto", "Missions en cours", k.missions), K("check", "Collectés aujourd’hui", k.collectees, "green"), K("truck", "Livraisons à planifier", k.a_planifier, "orange"), K("truck", "Livraisons en cours", k.livraisons), K("alert", "Échecs · retours attendus", k.echecs, "red"), K("handshake", "Partenaires actifs", k.partenaires, "green")],
      series: { title: "Collectes réalisées (7 jours)", data: await last7("SELECT DATE(handed_at) d, COUNT(*) n FROM found_reports WHERE handed_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY d") },
      bars: { title: "Missions par partenaire", data: (await q("SELECT p.nom l, COUNT(f.id) v FROM partners p LEFT JOIN found_reports f ON f.partner_id = p.id GROUP BY p.id")).map(x => ({ l: x.l, v: +x.v })) },
      links: [["founds", "Collectes"], ["deliveries", "Livraisons"], ["partners", "Partenaires"]] });
  }
  if (role === "FINANCE") {
    const k = await one(`SELECT COALESCE(SUM(CASE WHEN status = 'RÉUSSI' THEN amount END),0) total, COALESCE(SUM(CASE WHEN status = 'RÉUSSI' AND kind IN ('indiv','pack','formule','renew') THEN amount END),0) abos,
      COALESCE(SUM(CASE WHEN status = 'RÉUSSI' AND kind IN ('frais','livraison') THEN amount END),0) frais, SUM(status = 'RÉUSSI') recus, COALESCE(SUM(refunded_amount),0) rembourse,
      SUM(status = 'RÉUSSI' AND (reconciled IS NULL OR reconciled = 'À RAPPROCHER')) a_rapprocher FROM payments`);
    return res.json({ title: "Direction financière & comptabilité", kpis: [K("money", "Revenus totaux", fcfa(+k.total), "green"), K("crown", "Revenus des abonnements", fcfa(+k.abos), "blue"), K("receipt", "Frais de récupération & livraison", fcfa(+k.frais), "orange"), K("check", "Paiements reçus", +k.recus || 0, "violet"), K("refresh", "Remboursements", fcfa(+k.rembourse), "red"), K("list", "Transactions à rapprocher", +k.a_rapprocher || 0, "teal")],
      series: { title: "Transactions encaissées (7 jours)", data: await last7("SELECT DATE(created_at) d, COUNT(*) n FROM payments WHERE status = 'RÉUSSI' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY d") },
      bars: { title: "Revenus par moyen de paiement (FCFA)", data: (await q("SELECT m.label l, COALESCE(SUM(p.amount),0) v FROM pay_methods m LEFT JOIN payments p ON p.method = m.code AND p.status = 'RÉUSSI' GROUP BY m.code ORDER BY m.position")).map(x => ({ l: x.l, v: +x.v })) },
      links: [["finance", "Paiements, factures & rapports"]] });
  }
  if (role === "COMMERCIAL") {
    const k = await one(`SELECT (SELECT COUNT(DISTINCT user_id) FROM protections WHERE exp_at > NOW() AND suspended = 0) clients, (SELECT COUNT(*) FROM users WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) nouveaux,
      (SELECT COUNT(*) FROM prospects WHERE statut IN ('NOUVEAU','CONTACTÉ','INTÉRESSÉ')) prospects, (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'RÉUSSI' AND kind IN ('indiv','pack','formule','renew')) ca,
      (SELECT COUNT(*) FROM payments WHERE status = 'RÉUSSI' AND kind = 'renew') renouv, (SELECT COUNT(*) FROM protections WHERE exp_at < DATE_ADD(NOW(), INTERVAL 45 DAY) AND exp_at > DATE_SUB(NOW(), INTERVAL 365 DAY)) echeances,
      (SELECT COUNT(*) FROM protections WHERE exp_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 45 DAY)) a_renouveler`);
    return res.json({ title: "Service commercial", kpis: [K("users", "Clients actifs", k.clients, "green"), K("user", "Nouveaux inscrits (30 j)", k.nouveaux), K("refresh", "Taux de renouvellement", (k.echeances ? Math.round(k.renouv * 100 / k.echeances) : 0) + " %"), K("money", "Chiffre d’affaires commercial", fcfa(+k.ca), "green"), K("handshake", "Prospects actifs", k.prospects, "orange"), K("clock", "Abonnements à renouveler (45 j)", k.a_renouveler, "orange")],
      series: { title: "Nouvelles protections (7 jours)", data: await last7("SELECT DATE(created_at) d, COUNT(*) n FROM protections WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY d") },
      bars: { title: "Répartition par formule", data: (await q("SELECT CASE kind WHEN 'INDIV' THEN 'Individuelle' WHEN 'PACK' THEN 'Pack' ELSE CONCAT('Formule ', formule_code) END l, COUNT(*) v FROM protections WHERE exp_at > NOW() GROUP BY l")).map(x => ({ l: x.l, v: +x.v })) },
      links: [["commercial", "Abonnements & prospects"], ["com-partners", "Partenariats"]] });
  }
  if (role === "SUPPORT") {
    const k = await one(`SELECT (SELECT COUNT(*) FROM messages WHERE sender = 'USER' AND read_by_agent = 0) msgs, (SELECT COUNT(*) FROM sos_incidents WHERE closed = 0 AND is_test = 0) sos,
      (SELECT COUNT(*) FROM ops_incidents WHERE statut IN ('OUVERT','EN COURS')) incidents, (SELECT COUNT(*) FROM ops_incidents WHERE statut IN ('OUVERT','EN COURS') AND priorite = 'CRITIQUE') critiques,
      (SELECT COUNT(*) FROM staff_logins WHERE success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)) echecs`);
    return res.json({ title: "Support technique", kpis: [K("msg", "Messages usagers non lus", k.msgs, "orange"), K("siren", "Alertes SOS en cours", k.sos, "red"), K("list", "Incidents ouverts", k.incidents, "orange"), K("alert", "Incidents critiques", k.critiques, "red"), K("lock", "Connexions échouées (24 h)", k.echecs)],
      series: { title: "Messages reçus des usagers (7 jours)", data: await last7("SELECT DATE(created_at) d, COUNT(*) n FROM messages WHERE sender = 'USER' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY d") },
      bars: { title: "Incidents par priorité", data: (await q("SELECT priorite l, COUNT(*) v FROM ops_incidents WHERE statut IN ('OUVERT','EN COURS') GROUP BY priorite")).map(x => ({ l: x.l, v: +x.v })) },
      links: [["messages", "Assistance utilisateurs"], ["sos", "Alertes SOS"], ["system", "Maintenance"]] });
  }
  res.json({ global: true });
}));

/* ---------- recherche globale ---------- */
router.get("/search", h(async (req, res) => {
  const v = String(req.query.q || "").trim(); if (v.length < 2) return res.json({ items: [] });
  const num = U.normNum(v);
  const items = [
    ...(await q("SELECT ref, 'Déclaration' type, created_at t FROM loss_declarations WHERE ref LIKE ? LIMIT 5", [like(v)])),
    ...(await q("SELECT ref, 'Récupération' type, created_at t FROM recoveries WHERE ref LIKE ? LIMIT 5", [like(v)])),
    ...(await q("SELECT ref, 'Signalement' type, created_at t FROM found_reports WHERE ref LIKE ? OR numero = ? LIMIT 5", [like(v), num])),
    ...(await q("SELECT reception_ref ref, 'Stock' type, received_at t FROM held_documents WHERE reception_ref LIKE ? OR numero = ? LIMIT 5", [like(v), num])),
    ...(req.staff.perms.includes("finance.view") ? await q("SELECT ref, 'Paiement' type, created_at t FROM payments WHERE ref LIKE ? LIMIT 5", [like(v)]) : [])
  ];
  res.json({ items });
}));

/* ---------- population ---------- */
router.get("/users", can("users.view"), h(async (req, res) => {
  const { limit, offset } = paging(req), s = req.query.q;
  const rows = await q(`SELECT u.id, u.prenom, u.nom, u.tel, u.email, u.commune, u.status, u.created_at,
      (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id) docs,
      (SELECT COUNT(*) FROM protections p WHERE p.user_id = u.id AND p.exp_at > NOW() AND p.suspended = 0) prots, ${RNW.PORTFOLIO_SQL} portefeuille
    FROM users u ${s ? "WHERE u.nom LIKE ? OR u.prenom LIKE ? OR u.tel LIKE ?" : ""} ORDER BY u.id DESC LIMIT ? OFFSET ?`, s ? [like(s), like(s), like(U.normTel(s) || s), limit, offset] : [limit, offset]);
  res.json({ items: rows });
}));
router.patch("/users/:id", can("staff.manage"), h(async (req, res) => {
  const st = req.body.status === "SUSPENDU" ? "SUSPENDU" : "ACTIF";
  await q("UPDATE users SET status = ? WHERE id = ?", [st, req.params.id]);
  U.audit(req, "USER_STATUS", "user", req.params.id, st);
  res.json({ ok: true });
}));

/* ---------- déclarations de perte ---------- */
router.get("/declarations", can("declarations.view"), h(async (req, res) => {
  const rows = await q(`SELECT l.ref, l.created_at, l.date_perte, l.circonstances, l.commune, l.closed, l.is_sensitive, d.id doc_id, d.status doc_status, d.numero, c.label cat, c.official,
      u.prenom, u.nom, u.tel, (SELECT status FROM official_declarations o WHERE o.declaration_id = l.id ORDER BY o.id DESC LIMIT 1) offi
    FROM loss_declarations l JOIN documents d ON d.id = l.document_id JOIN doc_categories c ON c.code = d.category_code JOIN users u ON u.id = l.user_id
    ${req.query.open ? "WHERE l.closed = 0" : ""} ORDER BY l.id DESC LIMIT 200`);
  res.json({ items: rows.map(r => ({ ...r, numero: U.maskNum(r.numero) })) });
}));
router.post("/declarations/:ref/status", can("declarations.manage"), h(async (req, res) => {
  const l = await one("SELECT * FROM loss_declarations WHERE ref = ?", [req.params.ref]); if (!l) fail(404, "Déclaration introuvable.");
  const st = req.body.status;
  if (st === "RECHERCHE") {
    await q("UPDATE documents SET status = 'RECHERCHE' WHERE id = ? AND status = 'PERDU'", [l.document_id]);
    await q("INSERT INTO document_history (document_id, label) VALUES (?, 'Recherche active')", [l.document_id]);
    await U.notify(l.user_id, "Recherche active", `Votre dossier ${l.ref} est en recherche active.`, "dossier|" + l.document_id);
  } else if (st === "SENSIBLE") await q("UPDATE loss_declarations SET is_sensitive = 1 - is_sensitive WHERE id = ?", [l.id]);
  else fail(400, "Action inconnue.");
  U.audit(req, "DECLARATION_" + st, "declaration", l.ref);
  res.json({ ok: true });
}));

/* ---------- collecte & livraison ---------- */
router.get("/founds", can("founds.view", "collectes.manage"), h(async (req, res) => {
  const rows = await q(`SELECT f.ref, f.created_at, f.category_code, c.short cat, f.numero, f.nom_visible, f.registered, f.commune, f.repere, f.slot, f.step, f.mission_ref, f.handed_at, f.received_at,
      f.assigned_at, f.courier_enroute_at, f.onsite_at, f.transit_at, f.cancelled_at, f.cancel_motif, a.nom agence,
      (SELECT COUNT(*) FROM ops_incidents i WHERE i.dossier_ref = f.ref AND i.statut IN ('OUVERT','EN COURS')) incident,
      p.nom partner, p.collecteur FROM found_reports f LEFT JOIN agencies a ON a.id = f.agency_id JOIN doc_categories c ON c.code = f.category_code LEFT JOIN partners p ON p.id = f.partner_id ORDER BY f.id DESC LIMIT 200`);
  res.json({ items: rows.map(r => ({ ...r, numero: r.numero ? U.maskNum(r.numero) : null, registered: !!r.registered })) });
}));
router.post("/founds/:ref/assign", can("collectes.manage"), h(async (req, res) => {
  const f = await one("SELECT * FROM found_reports WHERE ref = ?", [req.params.ref]); if (!f) fail(404, "Signalement introuvable.");
  const p = await one("SELECT * FROM partners WHERE id = ? AND status = 'ACTIF'", [req.body.partner]); if (!p) fail(400, "Partenaire indisponible.");
  if (f.step >= 5) fail(409, "Document déjà remis.");
  if (f.cancelled_at) fail(409, "Collecte annulée.");
  const mission = f.mission_ref || "MIS-" + (await U.nextRef("mis", "X")).split("-").pop().slice(-5);
  await q("UPDATE found_reports SET partner_id = ?, mission_ref = ?, step = GREATEST(step, 2), step_at = NOW(), assigned_at = NOW() WHERE id = ?", [p.id, mission, f.id]);
  U.audit(req, "COLLECT_ASSIGNED", "found", f.ref, `${p.nom} · ${mission}`);
  res.json({ ok: true });
}));
/* validation du code de remise par le collecteur (QR / code alternatif) — R50 */
/* annulation d'une collecte (Collecte §23 : ANNULÉE — mission annulée avec motif), avant la remise au livreur */
router.post("/founds/:ref/cancel", can("collectes.manage"), h(async (req, res) => {
  const f = await one("SELECT * FROM found_reports WHERE ref = ?", [req.params.ref]); if (!f) fail(404, "Signalement introuvable.");
  if (f.cancelled_at) fail(409, "Collecte déjà annulée.");
  if (f.step >= 5) fail(409, "Le document a déjà été remis au livreur : la collecte ne peut plus être annulée (suivre la réception en agence).");
  const motif = str(req.body.motif, 200); if (!motif) fail(400, "Motif d’annulation obligatoire.");
  await q("UPDATE found_reports SET cancelled_at = NOW(), cancel_motif = ? WHERE id = ?", [motif, f.id]);
  await U.notify(f.reporter_user_id, "Collecte annulée", `Signalement ${f.ref} : la collecte a été annulée (${motif}). ID SECOURS vous recontactera si nécessaire.`, "collecte|" + f.ref);
  U.audit(req, "COLLECT_CANCELLED", "found", f.ref, motif);
  res.json({ ok: true });
}));
router.post("/founds/:ref/handover", can("collectes.manage"), h(async (req, res) => {
  const f = await one("SELECT * FROM found_reports WHERE ref = ?", [req.params.ref]); if (!f) fail(404, "Signalement introuvable.");
  if (f.step < 3 || f.step >= 5 || f.cancelled_at) fail(409, "La mission n’est pas en attente de remise.");
  if (String(req.body.code || "").trim() !== f.collect_code) { U.audit(req, "COLLECT_CODE_KO", "found", f.ref); fail(400, "Code de collecte invalide."); }
  await q("UPDATE found_reports SET step = 5, step_at = NOW(), handed_at = NOW() WHERE id = ?", [f.id]);
  await U.notify(f.reporter_user_id, "Document collecté", `Mission ${f.mission_ref} · code invalidé.`, "collecte|" + f.ref);
  U.audit(req, "COLLECT_HANDOVER", "found", f.ref, f.mission_ref);
  res.json({ ok: true });
}));
/* ④ Vérification & Contrôle (cahier des charges, Vérification §4) : contrôle des documents reçus en agence —
   authenticité, identification et géolocalisation du propriétaire, décision. Tant qu'il n'est pas validé,
   le document n'est ni indexé (recherche publique), ni rapproché, ni restituable. */
const createIncident = async (req, titre, description, priorite, dossier) => {
  const ref = "INC-" + (await U.nextRef("inc", "X")).split("-").pop().replace(/^0+/, "");
  await q("INSERT INTO ops_incidents (ref, titre, description, priorite, dossier_ref, created_by, agency_id) VALUES (?,?,?,?,?,?,?)", [ref, titre, str(description, 1000), priorite, dossier, req.staff.id, req.staff.agency_id || null]);
  return ref;
};
router.get("/found-checks", can("foundcheck.manage"), h(async (req, res) => {
  const rows = await q(`SELECT h.id, h.reception_ref, h.category_code, c.label cat, h.numero, h.nom, h.dob, h.date_exp, h.etat_physique, h.etat_observation,
      h.photo_recto r_recto, h.photo_verso r_verso, h.photo_anomalie r_anom, h.anomalie, h.status, h.emplacement, h.received_at,
      h.verif_at, h.verif_note, a.nom agence, f.ref found_ref, f.photo_recto, f.photo_verso, f.commune, f.mission_ref, s.prenom rprenom, s.nom rnom
    FROM held_documents h JOIN doc_categories c ON c.code = h.category_code JOIN agencies a ON a.id = h.agency_id
    LEFT JOIN found_reports f ON f.id = h.found_id LEFT JOIN staff s ON s.id = h.received_by
    WHERE h.status = 'A_CONTROLER' OR h.verif_at > DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY (h.status = 'A_CONTROLER') DESC, h.received_at`);
  const R = await M.rules();
  for (const r of rows) {
    /* propriétaires enregistrés portant ce numéro, score de correspondance et lieu de la perte (aide à la décision, jamais automatique) */
    r.owners = await M.owners(r.numero);
    for (const o of r.owners) {
      o.match = M.score({ category_code: r.category_code, numero: r.numero, nom: r.nom, dob: r.dob, date_exp: r.date_exp }, o, R);
      const l = await one("SELECT ref, commune, date_perte FROM loss_declarations WHERE document_id = ? ORDER BY id DESC LIMIT 1", [o.id]);
      o.perte = l ? `${l.ref} · ${l.commune || "—"} · ${l.date_perte}` : null;
    }
    r.multiple = M.isMultiple(r.owners);
  }
  res.json({ items: rows });
}));
router.post("/found-checks/:id/decision", can("foundcheck.manage"), h(async (req, res) => {
  const hd = await one("SELECT * FROM held_documents WHERE id = ?", [req.params.id]); if (!hd) fail(404, "Document introuvable.");
  if (hd.status !== "A_CONTROLER") fail(409, "Ce document n’est pas en attente de contrôle.");
  /* séparation des pouvoirs (Vérification §3) : l'agent qui a réceptionné ne contrôle pas */
  if (hd.received_by === req.staff.id) fail(403, "Séparation des pouvoirs : vous avez réceptionné ce document, un autre agent doit le contrôler.");
  const b = req.body, f = hd.found_id ? await one("SELECT * FROM found_reports WHERE id = ?", [hd.found_id]) : null;
  if (b.decision === "AUTHENTIQUE") {
    const numero = U.normNum(b.numero) || hd.numero, nom = str(b.nom, 120) ? str(b.nom, 120).toUpperCase() : hd.nom;
    await q("UPDATE held_documents SET status = IF(emplacement IS NULL, 'RECU', 'CONSERVE'), numero = ?, nom = ?, dob = COALESCE(?, dob), date_exp = COALESCE(?, date_exp), verif_by = ?, verif_at = NOW(), verif_note = ? WHERE id = ?",
      [numero, nom, U.dateOrNull(b.dob), U.dateOrNull(b.exp), req.staff.id, str(b.note, 255), hd.id]);
    await q("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?,?,?)", [hd.id, "Contrôle Vérification & Contrôle : authentique · indexé", req.staff.id]);
    if (f) {
      await q("UPDATE found_reports SET step = 8, step_at = NOW(), verif_status = 'AUTHENTIQUE', verif_by = ?, verif_at = NOW() WHERE id = ?", [req.staff.id, f.id]);
      await U.notify(f.reporter_user_id, "Document contrôlé et conservé", `Signalement ${f.ref} : le document est authentifié, indexé et conservé par ID SECOURS. Merci pour votre geste !`, "collecte|" + f.ref);
    }
    /* rapprochement (§58, §59) seulement après contrôle : « BONNE NOUVELLE ! » aux propriétaires enregistrés */
    let matched = 0;
    if (numero) for (const d of await q("SELECT * FROM documents WHERE numero = ?", [numero])) if (await matchHeldForDoc(d)) matched++;
    U.audit(req, "DOCCHECK_VALIDATED", "held", hd.reception_ref, b.note);
    return res.json({ ok: true, matched });
  }
  if (b.decision === "SUSPECT") {
    if (!str(b.note)) fail(400, "Décrivez l’anomalie constatée.");
    await q("UPDATE held_documents SET status = 'QUARANTAINE', verif_by = ?, verif_at = NOW(), verif_note = ? WHERE id = ?", [req.staff.id, str(b.note, 255), hd.id]);
    await q("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?,?,?)", [hd.id, "Contrôle : document suspect · mis en quarantaine", req.staff.id]);
    if (f) await q("UPDATE found_reports SET verif_status = 'SUSPECT', verif_by = ?, verif_at = NOW(), verif_note = ? WHERE id = ?", [req.staff.id, str(b.note, 255), f.id]);
    const inc = await createIncident(req, "Document suspect au contrôle", b.note, "HAUTE", hd.reception_ref);
    U.audit(req, "DOCCHECK_SUSPECT", "held", hd.reception_ref, b.note);
    return res.json({ ok: true, incident: inc });
  }
  fail(400, "Décision inconnue.");
}));

const PARTNER_ST = ["ACTIF", "TEMPORAIREMENT_INDISPONIBLE", "SUSPENDU", "CONTRAT_EXPIRE", "EN_INTEGRATION", "RESILIE"];
const PARTNER_FIELDS = ["nom", "nom_commercial", "contact", "tel", "email", "zones", "horaires", "prestations", "date_debut", "contrat_fin", "conditions", "integration",
  "sla_prise_min", "sla_collecte_h", "sla_depot_h", "sla_livraison_h", "tarif_collecte", "tarif_livraison", "vehicule", "collecteur"];
router.get("/partners", can("founds.view", "collectes.manage", "partners.manage"), h(async (req, res) => {
  /* SLA (Collecte §51) : délais réels comparés aux délais contractuels */
  const rows = await q(`SELECT p.*, (SELECT COUNT(*) FROM found_reports f WHERE f.partner_id = p.id) missions,
    (SELECT COUNT(*) FROM found_reports f WHERE f.partner_id = p.id AND f.step >= 5) done,
    (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, f.assigned_at, f.courier_enroute_at))) FROM found_reports f WHERE f.partner_id = p.id AND f.courier_enroute_at IS NOT NULL) prise_min,
    (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, f.assigned_at, f.handed_at)) / 60, 1) FROM found_reports f WHERE f.partner_id = p.id AND f.handed_at IS NOT NULL) collecte_h,
    (SELECT COUNT(*) FROM found_reports f WHERE f.partner_id = p.id AND f.handed_at IS NOT NULL AND TIMESTAMPDIFF(MINUTE, f.assigned_at, f.handed_at) > p.sla_collecte_h * 60) collecte_hors_delai,
    (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, f.handed_at, f.received_at)) / 60, 1) FROM found_reports f WHERE f.partner_id = p.id AND f.received_at IS NOT NULL) depot_h,
    (SELECT COUNT(*) FROM found_reports f WHERE f.partner_id = p.id AND f.step BETWEEN 2 AND 4 AND f.assigned_at < DATE_SUB(NOW(), INTERVAL p.sla_collecte_h HOUR)) en_retard,
    (SELECT COUNT(*) FROM deliveries d WHERE d.partner_id = p.id) livraisons,
    (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, d.out_at, d.delivered_at)) / 60, 1) FROM deliveries d WHERE d.partner_id = p.id AND d.delivered_at IS NOT NULL) livraison_h,
    (SELECT COUNT(*) FROM deliveries d WHERE d.partner_id = p.id AND d.status IN ('ECHEC','REMISE_BLOQUEE','RETOURNEE')) echecs,
    (SELECT COUNT(*) FROM ops_incidents i JOIN found_reports f ON f.ref = i.dossier_ref WHERE f.partner_id = p.id) incidents,
    /* suivi des livreurs (Collecte §27) : état terrain de la mission en cours la plus avancée */
    (SELECT CASE WHEN SUM(f.step = 5 AND f.transit_at IS NOT NULL) > 0 THEN 'EN_TRANSIT' WHEN SUM(f.step = 4 AND f.onsite_at IS NOT NULL) > 0 THEN 'SUR_PLACE'
      WHEN SUM(f.step = 4) > 0 THEN 'EN_ROUTE' WHEN COUNT(*) > 0 THEN 'EN_MISSION' END FROM found_reports f WHERE f.partner_id = p.id AND f.step BETWEEN 2 AND 5 AND f.cancelled_at IS NULL) terrain,
    (SELECT f.mission_ref FROM found_reports f WHERE f.partner_id = p.id AND f.step BETWEEN 2 AND 5 AND f.cancelled_at IS NULL ORDER BY f.step DESC LIMIT 1) mission_actuelle,
    (SELECT COUNT(*) FROM deliveries d WHERE d.partner_id = p.id AND d.status = 'EN_LIVRAISON') livr_en_cours,
    (SELECT COUNT(*) FROM found_reports f WHERE f.partner_id = p.id AND DATE(f.assigned_at) = CURDATE()) + (SELECT COUNT(*) FROM deliveries d WHERE d.partner_id = p.id AND DATE(d.created_at) = CURDATE()) missions_jour
    FROM partners p ORDER BY p.id`);
  res.json({ items: rows.map(({ pin_hash, ...p }) => ({ ...p, contrat_expire: !!p.contrat_fin && new Date(p.contrat_fin) < new Date(),
    terrain: p.status !== "ACTIF" ? "INDISPONIBLE" : p.terrain || (p.livr_en_cours ? "EN_MISSION" : "DISPONIBLE") })) });
}));
router.post("/partners", can("partners.manage"), h(async (req, res) => {
  const b = req.body; if (!str(b.nom) || !str(b.collecteur)) fail(400, "Nom et collecteur obligatoires.");
  await q("INSERT INTO partners (nom, contact, tel, collecteur, collecteur_code, vehicule, zones) VALUES (?,?,?,?,?,?,?)",
    [str(b.nom, 100), str(b.contact, 80), str(b.tel, 30), str(b.collecteur, 60), str(b.collecteur_code, 20) || "COL-" + U.rnd(1000, 9999), str(b.vehicule, 60) || "Moto", str(b.zones, 255)]);
  U.audit(req, "PARTNER_CREATED", "partner", b.nom); res.json({ ok: true });
}));
router.patch("/partners/:id", can("partners.manage"), h(async (req, res) => {
  if (req.body.pin !== undefined) {
    if (!/^\d{4,6}$/.test(String(req.body.pin))) fail(400, "Le PIN doit comporter 4 à 6 chiffres.");
    await q("UPDATE partners SET pin_hash = ? WHERE id = ?", [await bcrypt.hash(String(req.body.pin), 10), req.params.id]);
    U.audit(req, "PARTNER_PIN_RESET", "partner", req.params.id); return res.json({ ok: true });
  }
  if (req.body.status !== undefined) {
    const st = req.body.status, motif = str(req.body.motif, 255);
    if (!PARTNER_ST.includes(st)) fail(400, "Statut inconnu.");
    if (["SUSPENDU", "RESILIE", "TEMPORAIREMENT_INDISPONIBLE"].includes(st) && !motif) fail(400, "Motif obligatoire pour ce statut.");
    await q("UPDATE partners SET status = ?, status_motif = ? WHERE id = ?", [st, motif || null, req.params.id]);
    U.audit(req, "PARTNER_STATUS", "partner", req.params.id, `${st}${motif ? " · " + motif : ""}`); return res.json({ ok: true });
  }
  /* contrat & SLA : toute modification est journalisée (ancienne → nouvelle valeur) */
  const cur = await one("SELECT * FROM partners WHERE id = ?", [req.params.id]); if (!cur) fail(404, "Partenaire introuvable.");
  const set = U.pick(req.body, PARTNER_FIELDS); const keys = Object.keys(set); if (!keys.length) fail(400, "Rien à modifier.");
  for (const k of keys) {
    if (/^(sla_|tarif_)/.test(k) && (!Number.isInteger(+set[k]) || +set[k] < 0)) fail(400, `Valeur invalide pour ${k}.`);
    if (/^(date_debut|contrat_fin)$/.test(k)) set[k] = U.dateOrNull(set[k]);
    else if (typeof set[k] === "string") set[k] = str(set[k], k === "conditions" ? 500 : 120);
  }
  if ("integration" in set && !["MANUEL", "PORTAIL", "API"].includes(set.integration)) fail(400, "Mode d’intégration invalide.");
  await q(`UPDATE partners SET ${keys.map(k => k + " = ?").join(", ")} WHERE id = ?`, [...keys.map(k => set[k]), cur.id]);
  U.audit(req, "PARTNER_CONTRACT", "partner", cur.nom, keys.map(k => `${k}: ${cur[k] instanceof Date ? cur[k].toISOString().slice(0, 10) : cur[k]} → ${set[k]}`).join(" ; "));
  res.json({ ok: true });
}));

/* ---------- réception & stock ---------- */
/* ③ documents remis aux livreurs, attendus à l'agence (Collecte §28 : réception physique par Réception & Restitution) */
router.get("/reception/pending", can("reception.manage"), h(async (req, res) => {
  res.json({ items: await q(`SELECT f.ref, f.category_code, c.short cat, f.numero, f.nom_visible, f.mission_ref, f.handed_at, p.nom partner, p.collecteur
    FROM found_reports f JOIN doc_categories c ON c.code = f.category_code LEFT JOIN partners p ON p.id = f.partner_id
    WHERE f.step = 5 AND f.cancelled_at IS NULL ORDER BY f.handed_at`) });
}));
const ANOMALIES = ["Document conforme", "Document endommagé", "Document différent", "Document absent", "Enveloppe/conditionnement endommagé", "Référence incorrecte", "Autre anomalie"];
const ETATS = ["Bon état", "État moyen", "Endommagé", "Très endommagé", "Illisible / à contrôler"];
router.post("/reception", can("reception.manage"), upload.fields([{ name: "recto", maxCount: 1 }, { name: "verso", maxCount: 1 }, { name: "anomaliePhoto", maxCount: 1 }]), h(async (req, res) => {
  const b = req.body, agency = req.staff.agency_id || +b.agency || 1, files = req.files || {};
  const anomalie = ANOMALIES.includes(b.anomalie) ? b.anomalie : "Document conforme";
  /* photos de l'état du document à la réception (§22–§23), protégées comme données sensibles */
  const photo = k => (files[k] || [])[0] ? fileUrl(files[k][0]) : null;
  if (anomalie !== "Document absent" && (await U.setting("reception_photos_obligatoires", "1")) === "1" && (!photo("recto") || !photo("verso"))) fail(400, "Photos recto et verso obligatoires pour documenter l’état du document.");
  if (b.etatPhysique && !ETATS.includes(b.etatPhysique)) fail(400, "État physique invalide.");
  let f = null, cat = b.cat, numero = U.normNum(b.numero) || null, nom = str(b.nom, 120);
  if (b.found) {
    f = await one("SELECT * FROM found_reports WHERE ref = ?", [b.found]); if (!f) fail(404, "Signalement introuvable.");
    if (f.step !== 5) fail(409, "Ce document n’a pas été remis au livreur ou a déjà été réceptionné.");
    cat = f.category_code; numero = U.normNum(b.numero) || f.numero; nom = str(b.nom, 120) || f.nom_visible;
  }
  if (!cat) fail(400, "Catégorie obligatoire.");
  /* anomalie à la réception (Collecte §30) : incident partenaire automatique */
  let incident = null;
  if (anomalie !== "Document conforme") incident = await createIncident(req, `Incident partenaire : ${anomalie.toLowerCase()}`, `${f ? `Mission ${f.mission_ref} · ` : ""}${str(b.motif, 500) || ""}`, "HAUTE", f ? f.ref : null);
  if (anomalie === "Document absent") { U.audit(req, "RECEPTION_ABSENT", "found", f && f.ref, incident); return res.status(201).json({ ref: null, incident }); }
  /* seuls les emplacements actifs, disponibles et compatibles sont acceptés (§29) */
  const loc = await LOC.pick(agency, b);
  const ref = await U.nextRef("rcp", "IDS-RCP");
  const r = await q(`INSERT INTO held_documents (reception_ref, found_id, category_code, numero, nom, etat_physique, etat_observation, etat, agency_id, emplacement, location_id, internal_qr, status, received_by, anomalie, photo_recto, photo_verso, photo_anomalie)
                     VALUES (?,?,?,?,?,?,?, 'Reçu par ID SECOURS', ?,?,?,?, 'A_CONTROLER', ?, ?, ?, ?, ?)`,
    [ref, f ? f.id : null, cat, numero, nom ? nom.toUpperCase() : null, b.etatPhysique || "Bon état", str(b.observation, 255), agency, loc ? loc.code : null, loc ? loc.id : null, U.token(8), req.staff.id,
     anomalie === "Document conforme" ? null : anomalie, photo("recto"), photo("verso"), photo("anomaliePhoto")]);
  await q("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?,?,?)", [r.insertId, `Réception ${ref}${f ? " · mission " + f.mission_ref : " · dépôt direct"}${loc ? " · emplacement affecté " + loc.code : ""} · en attente de contrôle`, req.staff.id]);
  if (f) {
    await q("UPDATE found_reports SET step = 6, step_at = NOW(), received_at = NOW(), agency_id = ? WHERE id = ?", [agency, f.id]);
    await U.notify(f.reporter_user_id, "Document reçu par ID SECOURS", `Signalement ${f.ref} : le document est arrivé en agence. Il est en cours de contrôle. Merci ! Donnez votre avis sur la collecte.`, "collecte|" + f.ref);
  }
  U.audit(req, "RECEPTION", "held", ref, f ? f.ref : "dépôt direct");
  res.status(201).json({ ref, id: r.insertId, emplacement: loc ? loc.code : null, located: !!(loc && loc.id), incident, qr: await QRCode.toDataURL(`IDSECOURS:INT:${ref}`, { margin: 1, width: 240 }) });
}));
router.get("/stock", can("stock.view", "reception.manage"), h(async (req, res) => {
  const rows = await q(`SELECT h.id, h.reception_ref, h.category_code, c.short cat, h.numero, h.nom, h.etat_physique, h.status, h.emplacement, h.location_id, h.stored_at, h.agency_id, h.received_at, a.nom agence
    FROM held_documents h JOIN doc_categories c ON c.code = h.category_code JOIN agencies a ON a.id = h.agency_id ORDER BY h.id DESC LIMIT 300`);
  res.json({ items: rows.map(r => ({ ...r, numero: r.numero ? U.maskNum(r.numero) : null })) });
}));
router.post("/stock/:id/move", can("reception.manage"), h(async (req, res) => {
  const hd = await one("SELECT * FROM held_documents WHERE id = ?", [req.params.id]); if (!hd) fail(404, "Document introuvable.");
  const st = req.body.status;
  const loc = await LOC.pick(hd.agency_id, req.body, hd.id), emp = loc ? loc.code : null;
  if (!emp && !st) fail(400, "Indiquez un emplacement ou un statut.");
  if (st && !["CONSERVE", "QUARANTAINE"].includes(st)) fail(400, "Statut non autorisé ici.");
  /* la Réception ne peut pas modifier une décision de contrôle (VC17) */
  if (st === "CONSERVE" && ["A_CONTROLER", "QUARANTAINE"].includes(hd.status)) fail(403, "Seul le service Vérification & Contrôle peut lever ce statut.");
  if (["EN_RESTITUTION", "RESTITUE"].includes(hd.status) && st) fail(409, "Document en cours de restitution.");
  /* tout déplacement impose une nouvelle confirmation du stockage (double scan) */
  await q(`UPDATE held_documents SET emplacement = COALESCE(?, emplacement), location_id = IF(? IS NULL, location_id, ?), stored_at = IF(? IS NULL, stored_at, NULL),
    status = COALESCE(?, IF(status = 'RECU' AND ? IS NOT NULL, 'CONSERVE', status)) WHERE id = ?`, [emp, emp, loc && loc.id, emp, st || null, emp, hd.id]);
  await q("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?,?,?)", [hd.id, `${emp ? "Déplacement vers " + emp : ""}${st ? " Statut " + st : ""}`.trim() + (req.body.motif ? ` · motif : ${str(req.body.motif, 120)}` : ""), req.staff.id]);
  U.audit(req, "STOCK_MOVE", "held", hd.reception_ref, emp || st); res.json({ ok: true });
}));

/* ---------- vérification & contrôle ---------- */
router.get("/verifications", can("verification.manage"), h(async (req, res) => {
  const rows = await q(`SELECT r.ref, r.created_at, r.category_code, c.label cat, r.verif_status, r.status, r.protected, r.selfie, r.justificatif, r.dob, r.lieu_naissance, r.tel, r.verif_tries, r.multi_resolved,
      h.numero, h.nom held_nom, h.reception_ref, h.dob held_dob, h.date_exp held_exp, h.category_code held_cat,
      d.category_code d_cat, d.numero d_num, d.nom d_nom, d.prenoms d_prenoms, d.dob doc_dob, d.date_exp d_exp, u.prenom, u.nom
    FROM recoveries r JOIN held_documents h ON h.id = r.held_id JOIN doc_categories c ON c.code = r.category_code
    LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN users u ON u.id = r.user_id
    WHERE r.done_at IS NULL ORDER BY (r.verif_status = 'EN VÉRIFICATION') DESC, r.id DESC LIMIT 200`);
  const R = await M.rules();
  for (const r of rows) {
    /* comparateur déclaré ↔ retrouvé : document enregistré s'il existe, sinon informations fournies par le demandeur */
    const held = { category_code: r.held_cat, numero: r.numero, nom: r.held_nom, dob: r.held_dob, date_exp: r.held_exp };
    const ref = r.d_num ? { category_code: r.d_cat, numero: r.d_num, nom: r.d_nom, prenoms: r.d_prenoms, dob: r.doc_dob, exp: r.d_exp }
      : { category_code: r.category_code, nom: r.nom, prenoms: r.prenom, dob: r.dob };
    r.declared = ref; r.match = M.score(held, ref, R);
    r.owners = await M.owners(r.numero); r.multiple = M.isMultiple(r.owners) && !r.multi_resolved;
    for (const k of ["held_cat", "d_cat", "d_num", "d_nom", "d_prenoms", "d_exp"]) delete r[k];
  }
  res.json({ items: rows.map(r => ({ ...r, protected: !!r.protected })) });
}));
router.post("/verifications/:ref/decision", can("verification.manage"), h(async (req, res) => {
  const r = await one("SELECT * FROM recoveries WHERE ref = ?", [req.params.ref]); if (!r) fail(404, "Dossier introuvable.");
  const map = { CONFIRM: "PROPRIÉTAIRE CONFIRMÉ", COMPLEMENT: "COMPLÉMENT REQUIS", REJECT: "VÉRIFICATION ÉCHOUÉE" }, st = map[req.body.decision];
  if (!st) fail(400, "Décision inconnue.");
  if (r.done_at) fail(409, "Dossier clôturé.");
  if (st !== "PROPRIÉTAIRE CONFIRMÉ" && !str(req.body.motif)) fail(400, "Tout rejet ou complément doit comporter un motif (VC04).");
  /* correspondances multiples (VC08) : la confirmation exige une résolution explicite et motivée */
  const held = await one("SELECT numero, nom, dob, date_exp, category_code FROM held_documents WHERE id = ?", [r.held_id]);
  const multiple = M.isMultiple(await M.owners(held.numero));
  if (st === "PROPRIÉTAIRE CONFIRMÉ" && multiple && !r.multi_resolved) {
    if (!req.body.resolveMultiple || !str(req.body.motif)) fail(409, "Correspondances multiples : indiquez le motif de la résolution et confirmez-la explicitement.");
    await q("UPDATE recoveries SET multi_resolved = 1 WHERE id = ?", [r.id]);
    U.audit(req, "MULTIPLE_RESOLVED", "recovery", r.ref, req.body.motif);
  }
  await q("UPDATE recoveries SET verif_status = ?, status = ?, verified_by = ?, verified_at = NOW(), match_pct = ? WHERE id = ?", [st, st, req.staff.id, req.body.matchPct != null ? Math.round(+req.body.matchPct) : null, r.id]);
  if (req.body.motif) await q("INSERT INTO messages (dossier_ref, sender, staff_id, body) VALUES (?, 'AGENT', ?, ?)", [r.ref, req.staff.id, str(req.body.motif, 1000)]);
  await U.notify(r.user_id, st === "PROPRIÉTAIRE CONFIRMÉ" ? "Propriété confirmée" : st === "COMPLÉMENT REQUIS" ? "Complément requis" : "Vérification échouée", `Dossier ${r.ref} : ${st.toLowerCase()}.`, "recDossier|" + r.ref);
  U.audit(req, "VERIFICATION_" + req.body.decision, "recovery", r.ref, req.body.motif);
  res.json({ ok: true });
}));
router.get("/official", can("official.manage"), h(async (req, res) => {
  res.json({ items: await q(`SELECT o.id, o.numero, o.date_decl, o.lieu, o.administration, o.file_url, o.status, o.motif, o.created_at, l.ref decl_ref, c.label cat, u.prenom, u.nom
    FROM official_declarations o JOIN loss_declarations l ON l.id = o.declaration_id JOIN documents d ON d.id = o.document_id JOIN doc_categories c ON c.code = d.category_code JOIN users u ON u.id = l.user_id
    ORDER BY (o.status = 'EN VÉRIFICATION') DESC, o.id DESC LIMIT 200`) });
}));
router.post("/official/:id/decision", can("official.manage"), h(async (req, res) => {
  const o = await one("SELECT o.*, l.user_id FROM official_declarations o JOIN loss_declarations l ON l.id = o.declaration_id WHERE o.id = ?", [req.params.id]); if (!o) fail(404, "Déclaration introuvable.");
  const st = req.body.status; if (!["VALIDÉE", "COMPLÉMENT REQUIS", "REJETÉE"].includes(st)) fail(400, "Décision inconnue.");
  if (st !== "VALIDÉE" && !str(req.body.motif)) fail(400, "Indiquez le motif.");
  await q("UPDATE official_declarations SET status = ?, motif = ?, reviewed_by = ? WHERE id = ?", [st, str(req.body.motif, 255), req.staff.id, o.id]);
  await q("INSERT INTO document_history (document_id, label) VALUES (?,?)", [o.document_id, "Déclaration officielle : " + st.toLowerCase()]);
  const ctx = await D.userCtx(o.user_id);
  await U.notify(o.user_id, st === "VALIDÉE" ? "Déclaration officielle validée" : st === "REJETÉE" ? "Déclaration officielle rejetée" : "Complément requis",
    st === "VALIDÉE" ? (D.vipActive(ctx) ? "Vous êtes éligible à la publication de perte." : "Votre dossier est complet.") : str(req.body.motif, 255), (st === "VALIDÉE" && D.vipActive(ctx) ? "vipPub|" : "offiDecl|") + o.document_id);
  U.audit(req, "OFFICIAL_" + st, "official", String(o.id), req.body.motif);
  res.json({ ok: true });
}));
router.get("/publications", can("publications.manage"), h(async (req, res) => {
  res.json({ items: await q(`SELECT p.ref, p.status, p.views, p.reports, p.live_at, p.created_at, c.label cat, d.nom, d.prenoms, d.numero, l.commune, l.ref decl_ref
    FROM publications p JOIN documents d ON d.id = p.document_id JOIN doc_categories c ON c.code = d.category_code JOIN loss_declarations l ON l.id = p.declaration_id
    ORDER BY (p.status = 'EN VALIDATION') DESC, p.id DESC LIMIT 200`).then(r => r.map(x => ({ ...x, titulaire: U.maskName(x.nom + " " + x.prenoms), numero: U.maskNum(x.numero) }))) });
}));
router.post("/publications/:ref/decision", can("publications.manage"), h(async (req, res) => {
  const p = await one("SELECT p.*, d.user_id FROM publications p JOIN documents d ON d.id = p.document_id WHERE p.ref = ?", [req.params.ref]); if (!p) fail(404, "Publication introuvable.");
  const a = req.body.action, hist = l => q("INSERT INTO publication_history (publication_id, label) VALUES (?,?)", [p.id, l]);
  if (a === "validate") {
    if (p.status !== "EN VALIDATION") fail(409, "Publication déjà traitée.");
    await q("UPDATE publications SET status = 'ACTIVE', live_at = NOW() WHERE id = ?", [p.id]); await hist("Publication validée"); await hist("Publication diffusée");
    await U.notify(p.user_id, "Publication diffusée", "Votre avis de perte est visible par la communauté ID SECOURS.", "vipPub|" + p.document_id);
  } else if (a === "reject") {
    await q("UPDATE publications SET status = 'REJETÉE' WHERE id = ?", [p.id]); await hist("Publication rejetée" + (req.body.motif ? " · " + str(req.body.motif, 200) : ""));
    await U.notify(p.user_id, "Publication refusée", str(req.body.motif, 200) || "Votre demande de publication n’a pas été validée.", "vipPub|" + p.document_id);
  } else if (a === "report") {
    if (p.status !== "ACTIVE") fail(409, "Publication non active.");
    await q("UPDATE publications SET reports = reports + 1 WHERE id = ?", [p.id]); await hist("Signalement reçu · transmis à Vérification & Contrôle");
    await U.notify(p.user_id, "Signalement reçu depuis une publication", "Un signalement est en cours de contrôle. Aucune restitution sans vérification.", "dossier|" + p.document_id);
  } else if (a === "close") {
    await q("UPDATE publications SET status = 'CLÔTURÉE', closed_at = NOW() WHERE id = ?", [p.id]); await hist("Publication clôturée");
  } else fail(400, "Action inconnue.");
  U.audit(req, "PUBLICATION_" + a.toUpperCase(), "publication", p.ref); res.json({ ok: true });
}));

/* ---------- restitution (séparation des pouvoirs : l'agent qui a vérifié ne restitue pas) ---------- */
router.get("/restitutions", can("restitution.manage"), h(async (req, res) => {
  const rows = await q(`SELECT r.*, c.label cat, h.reception_ref, h.emplacement, h.nom, a.nom agence, u.prenom, u.nom unom, u.tel utel,
      (SELECT CONCAT(dl.ref, '|', dl.status) FROM deliveries dl WHERE dl.recovery_id = r.id ORDER BY dl.id DESC LIMIT 1) livraison
    FROM recoveries r JOIN held_documents h ON h.id = r.held_id JOIN agencies a ON a.id = h.agency_id JOIN doc_categories c ON c.code = r.category_code LEFT JOIN users u ON u.id = r.user_id
    WHERE r.status IN ('RÉCUPÉRATION AUTORISÉE', 'RÉCUPÉRÉ') OR (r.verif_status = 'PROPRIÉTAIRE CONFIRMÉ' AND r.done_at IS NULL) ORDER BY (r.done_at IS NULL) DESC, r.id DESC LIMIT 200`);
  for (const r of rows) {
    r.conditions = r.done_at ? null : (await REC.conditions(r)).list;
    const [lref, lst] = (r.livraison || "").split("|"); r.livraison = lref ? { ref: lref, st: lst } : null;
    for (const k of ["withdrawal_code", "selfie", "justificatif", "access_token", "dob"]) delete r[k];
  }
  res.json({ items: rows.map(r => ({ ...r, tel: r.utel || r.tel })) });
}));
router.get("/restitutions/:ref/proof", can("restitution.manage", "verification.manage"), h(async (req, res) => {
  const p = await REC.proof(req.params.ref); if (!p) fail(404, "Aucune preuve : document non restitué.");
  res.json({ proof: p });
}));
router.post("/restitutions/:ref/complete", can("restitution.manage"), upload.single("signature"), h(async (req, res) => {
  const r = await one("SELECT * FROM recoveries WHERE ref = ?", [req.params.ref]); if (!r) fail(404, "Dossier introuvable.");
  if (r.done_at) fail(409, "Document déjà restitué.");
  const c = await REC.conditions(r);
  if (!c.ok) fail(409, "RESTITUTION IMPOSSIBLE : " + c.list.filter(x => !x.ok).map(x => x.motif).join(" · "));
  if (await one("SELECT id FROM deliveries WHERE recovery_id = ? AND status IN ('PLANIFIEE','EN_LIVRAISON','ECHEC')", [r.id])) fail(409, "Une livraison est en cours pour ce dossier.");
  if (r.verified_by && r.verified_by === req.staff.id) fail(403, "Séparation des pouvoirs : l’agent qui a vérifié le propriétaire ne peut pas restituer.");
  if (String(req.body.code || "").trim().replace(/^IDSECOURS:RET:[^:]+:/, "") !== r.withdrawal_code) { U.audit(req, "RESTITUTION_CODE_KO", "recovery", r.ref); fail(400, "Code de retrait invalide."); }
  /* confirmation de réception par le propriétaire : signature sur écran (§54) */
  if (!req.file) fail(400, "La signature du propriétaire est obligatoire.");
  const mode = /^IDSECOURS:RET:/.test(String(req.body.code || "")) ? "Comptoir · QR de récupération scanné" : "Comptoir · code de retrait";
  const proof = await REC.complete(r, { staffId: req.staff.id, label: `Restitution au comptoir · dossier ${r.ref}`, mode, signature: fileUrl(req.file) });
  U.audit(req, "RESTITUTION", "recovery", r.ref, proof); res.json({ ok: true, proof });
}));

/* ---------- livraison au propriétaire (Collecte §31–§47) ---------- */
const DELIV_SQL = `SELECT dl.*, r.ref rec_ref, r.category_code, c.label cat, h.reception_ref, h.emplacement, a.nom agence, p.nom partner, p.collecteur, p.collecteur_code,
    u.prenom, u.nom unom, u.tel utel FROM deliveries dl JOIN recoveries r ON r.id = dl.recovery_id JOIN held_documents h ON h.id = dl.held_id JOIN agencies a ON a.id = h.agency_id
    JOIN doc_categories c ON c.code = r.category_code LEFT JOIN partners p ON p.id = dl.partner_id LEFT JOIN users u ON u.id = dl.user_id`;
router.get("/deliveries", can("collectes.manage", "restitution.manage"), h(async (req, res) => {
  const rows = await q(`${DELIV_SQL} ORDER BY FIELD(dl.status,'ECHEC','REMISE_BLOQUEE','A_PLANIFIER','PLANIFIEE','EN_LIVRAISON','ATTENTE_PAIEMENT','LIVREE','RETOURNEE','ANNULEE'), dl.id DESC LIMIT 200`);
  for (const d of rows) d.conditions = ["A_PLANIFIER", "PLANIFIEE"].includes(d.status) ? (await REC.conditions(await one("SELECT * FROM recoveries WHERE id = ?", [d.recovery_id]))).list : null;
  res.json({ items: rows.map(d => ({ ...d, tel: d.utel ? U.fmtTel(d.utel) : null })) });
}));
const getDelivery = async ref => { const d = await one("SELECT * FROM deliveries WHERE ref = ?", [ref]); if (!d) fail(404, "Livraison introuvable."); return d; };
/* planification : le service Collecte lit l'autorisation système, il ne la décide pas (§32) */
router.post("/deliveries/:ref/plan", can("collectes.manage"), h(async (req, res) => {
  const d = await getDelivery(req.params.ref);
  if (!["A_PLANIFIER", "PLANIFIEE"].includes(d.status)) fail(409, "Livraison non planifiable à ce stade.");
  const c = await REC.conditions(await one("SELECT * FROM recoveries WHERE id = ?", [d.recovery_id]));
  if (!c.ok) fail(409, "LIVRAISON BLOQUÉE : " + c.list.filter(x => !x.ok).map(x => x.motif).join(" · "));
  const p = await one("SELECT * FROM partners WHERE id = ? AND status = 'ACTIF'", [req.body.partner]); if (!p) fail(400, "Partenaire indisponible.");
  await q("UPDATE deliveries SET status = 'PLANIFIEE', partner_id = ?, slot = COALESCE(?, slot), external_ref = ?, planned_by = ?, planned_at = NOW() WHERE id = ?", [p.id, str(req.body.slot, 60), str(req.body.externalRef, 40), req.staff.id, d.id]);
  U.audit(req, "DELIVERY_PLANNED", "delivery", d.ref, p.nom); res.json({ ok: true });
}));
/* sortie de l'agence : la Réception remet le document au coursier identifié (§37, §38) */
router.post("/deliveries/:ref/out", can("restitution.manage"), h(async (req, res) => {
  const d = await getDelivery(req.params.ref);
  if (d.status !== "PLANIFIEE") fail(409, "La mission doit être planifiée.");
  const p = await one("SELECT * FROM partners WHERE id = ?", [d.partner_id]);
  if (String(req.body.courier || "").trim().toUpperCase() !== p.collecteur_code) fail(400, "Coursier non reconnu pour cette mission.");
  const r = await one("SELECT * FROM recoveries WHERE id = ?", [d.recovery_id]);
  const c = await REC.conditions(r); if (!c.ok) fail(409, "LIVRAISON BLOQUÉE : " + c.list.filter(x => !x.ok).map(x => x.motif).join(" · "));
  await q("UPDATE deliveries SET status = 'EN_LIVRAISON', out_by = ?, out_at = NOW() WHERE id = ?", [req.staff.id, d.id]);
  await q("UPDATE held_documents SET status = 'EN_RESTITUTION' WHERE id = ?", [d.held_id]);
  await q("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?,?,?)", [d.held_id, `Sortie agence · livraison ${d.ref} · ${p.nom} · coursier ${p.collecteur_code}`, req.staff.id]);
  await U.notify(d.user_id, "Document en cours de livraison", "Votre document a été confié à notre partenaire de livraison et est en route vers le point que vous avez confirmé.", "recAuth|" + r.ref);
  U.audit(req, "DELIVERY_OUT", "delivery", d.ref, p.collecteur_code); res.json({ ok: true });
}));
/* retour en agence après échec (§46) */
router.post("/deliveries/:ref/return", can("restitution.manage"), h(async (req, res) => {
  const d = await getDelivery(req.params.ref);
  if (!["ECHEC", "REMISE_BLOQUEE"].includes(d.status)) fail(409, "Aucun retour attendu pour cette livraison.");
  await q("UPDATE deliveries SET status = 'RETOURNEE', return_by = ?, return_at = NOW() WHERE id = ?", [req.staff.id, d.id]);
  await q("UPDATE held_documents SET status = IF(emplacement IS NULL, 'RECU', 'CONSERVE') WHERE id = ?", [d.held_id]);
  await q("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?,?,?)", [d.held_id, `Retour confirmé · livraison ${d.ref} · ${str(req.body.note, 120) || "réintégré au stock sécurisé"}`, req.staff.id]);
  await q("UPDATE recoveries SET delivery = 0 WHERE id = ?", [d.recovery_id]);
  await U.notify(d.user_id, "Document de retour en agence", "La livraison n’a pas pu aboutir. Votre document est conservé en agence : vous pouvez le retirer au comptoir ou demander une nouvelle livraison.", "recAuth|" + (await one("SELECT ref FROM recoveries WHERE id = ?", [d.recovery_id])).ref);
  U.audit(req, "DELIVERY_RETURNED", "delivery", d.ref); res.json({ ok: true });
}));
router.post("/deliveries/:ref/cancel", can("collectes.manage"), h(async (req, res) => {
  const d = await getDelivery(req.params.ref);
  if (!["ATTENTE_PAIEMENT", "A_PLANIFIER", "PLANIFIEE"].includes(d.status)) fail(409, "Une livraison en cours ne peut pas être annulée : procédure de retour.");
  if (!str(req.body.motif)) fail(400, "Motif obligatoire.");
  await q("UPDATE deliveries SET status = 'ANNULEE', fail_reason = ? WHERE id = ?", [str(req.body.motif, 255), d.id]);
  await q("UPDATE recoveries SET delivery = 0 WHERE id = ?", [d.recovery_id]);
  U.audit(req, "DELIVERY_CANCELLED", "delivery", d.ref, req.body.motif); res.json({ ok: true });
}));

/* ---------- finance ---------- */
router.get("/finance", can("finance.view"), h(async (req, res) => {
  const from = req.query.from || "1970-01-01", to = req.query.to || "2999-12-31";
  const [rows, byKind, byMethod, tot] = await Promise.all([
    q(`SELECT p.ref, p.kind, p.label, p.amount, p.method, p.status, p.created_at, p.refunded_amount, p.reconciled, u.prenom, u.nom FROM payments p LEFT JOIN users u ON u.id = p.user_id
       WHERE DATE(p.created_at) BETWEEN ? AND ? ORDER BY p.id DESC LIMIT 300`, [from, to]),
    q("SELECT kind, COUNT(*) n, SUM(amount) total FROM payments WHERE status = 'RÉUSSI' AND DATE(created_at) BETWEEN ? AND ? GROUP BY kind", [from, to]),
    q("SELECT m.label, m.color, COUNT(p.id) n, COALESCE(SUM(p.amount),0) total FROM pay_methods m LEFT JOIN payments p ON p.method = m.code AND p.status = 'RÉUSSI' AND DATE(p.created_at) BETWEEN ? AND ? GROUP BY m.code ORDER BY m.position", [from, to]),
    one("SELECT COALESCE(SUM(CASE WHEN status='RÉUSSI' THEN amount END),0) ok, COALESCE(SUM(CASE WHEN status='REMBOURSÉ' THEN amount END),0) refunded, SUM(status='EN ATTENTE') pending FROM payments WHERE DATE(created_at) BETWEEN ? AND ?", [from, to])
  ]);
  res.json({ items: rows, byKind, byMethod: byMethod.map(m => ({ ...m, total: +m.total })), totals: { ok: +tot.ok, refunded: +tot.refunded, pending: +tot.pending || 0 } });
}));

/* ---------- commercial ---------- */
router.get("/commercial", can("commercial.view"), h(async (req, res) => {
  const [prots, renew, byKind] = await Promise.all([
    q(`SELECT p.id, p.kind, p.label, p.prix, p.start_at, p.exp_at, p.suspended, u.prenom, u.nom, u.tel FROM protections p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 200`),
    /* abonnements à renouveler (§25–§26) : échéances configurées + expirés depuis moins de 30 jours */
    q(`SELECT p.id, p.label, p.exp_at, u.prenom, u.nom, u.tel,
      (SELECT MAX(r.created_at) FROM renewal_reminders r WHERE r.protection_id = p.id) last_reminder, (SELECT COUNT(*) FROM renewal_reminders r WHERE r.protection_id = p.id) reminders
      FROM protections p JOIN users u ON u.id = p.user_id WHERE p.suspended = 0 AND p.exp_at BETWEEN DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND DATE_ADD(CURDATE(), INTERVAL 31 DAY) ORDER BY p.exp_at`),
    q("SELECT kind, COUNT(*) n FROM protections WHERE exp_at > NOW() AND suspended = 0 GROUP BY kind")
  ]);
  const list = await RNW.echeances();
  const portfolio = await one(`SELECT SUM(pf = 'PROSPECT') prospects, SUM(pf = 'CLIENT') clients, SUM(pf = 'ANCIEN_CLIENT') anciens FROM (SELECT ${RNW.PORTFOLIO_SQL} pf FROM users u) x`);
  const renewOut = renew.map(p => ({ ...p, bucket: RNW.bucket(RNW.daysLeft(p.exp_at), list) })).filter(p => p.bucket);
  res.json({ prots: prots.map(p => ({ ...p, status: D.protStatus(p) })), renew: renewOut, byKind, echeances: list,
    portfolio: { prospects: +portfolio.prospects || 0, clients: +portfolio.clients || 0, anciens: +portfolio.anciens || 0, prospectsFiches: (await one("SELECT COUNT(*) n FROM prospects WHERE statut NOT IN ('CONVERTI','PERDU')")).n },
    renewAuto: (await U.setting("renew_auto", "1")) === "1", renewMessage: await U.setting("renew_message", "") });
}));
router.post("/commercial/remind/:id", can("commercial.view"), h(async (req, res) => {
  const p = await one(`${RNW.PROT_SQL} WHERE p.id = ?`, [req.params.id]); if (!p) fail(404, "Protection introuvable.");
  const b = RNW.bucket(RNW.daysLeft(p.exp_at), await RNW.echeances());
  await RNW.send(p, { staffId: req.staff.id, echeance: b ? b.k : null });
  U.audit(req, "RENEWAL_REMINDER", "protection", String(p.id)); res.json({ ok: true });
}));
/* historique des relances (§28) : client, date, canal, campagne, message, résultat, agent ou automatisation */
router.get("/commercial/reminders", can("commercial.view"), h(async (req, res) => {
  const rows = await q(`SELECT r.id, r.created_at, r.echeance, r.channel, r.campaign_ref, r.message, r.result, r.auto_key IS NOT NULL auto, u.prenom, u.nom, s.prenom sprenom, s.nom snom
    FROM renewal_reminders r JOIN users u ON u.id = r.user_id LEFT JOIN staff s ON s.id = r.staff_id ORDER BY r.id DESC LIMIT 300`);
  res.json({ items: rows.map(r => ({ ...r, auto: !!r.auto, origine: r.auto ? "Automatisation" : r.sprenom ? `${r.sprenom} ${r.snom}` : r.campaign_ref ? "Campagne" : "—" })) });
}));
/* message de renouvellement paramétrable et relances automatiques (§27) */
router.put("/commercial/renew-settings", can("settings.manage", "prospects.manage"), h(async (req, res) => {
  const b = req.body;
  if (b.message !== undefined) {
    const m = str(b.message, 400); if (!m || !m.includes("{date}")) fail(400, "Le message doit contenir la variable {date} (date d’expiration).");
    await q("UPDATE settings SET v = ? WHERE k = 'renew_message'", [m]);
  }
  if (b.auto !== undefined) await q("UPDATE settings SET v = ? WHERE k = 'renew_auto'", [b.auto ? "1" : "0"]);
  U.audit(req, "RENEWAL_SETTINGS", "settings", "renew", JSON.stringify(b).slice(0, 300)); res.json({ ok: true });
}));
/* souscription assistée : le commercial crée le compte, l'utilisateur l'active (OTP + mot de passe), paie et enregistre
   lui-même ses documents (COM-01, COM-02, §14). Aucun accès commercial aux données documentaires (COM-11). */
router.post("/commercial/subscribers", can("prospects.manage"), h(async (req, res) => {
  const b = req.body, tel = U.normTel(b.tel);
  if (!str(b.nom) || !str(b.prenom) || tel.length < 8) fail(400, "Nom, prénom et téléphone valide obligatoires.");
  if (!b.consentCgu || !b.consentData) fail(400, "Les consentements de l’utilisateur sont obligatoires.");
  if (await one("SELECT id FROM users WHERE tel = ?", [tel])) fail(409, "Doublon : un compte existe déjà avec ce numéro (COM-06).");
  const f = b.formule ? await one("SELECT code, label FROM formules WHERE code = ?", [b.formule]) : null;
  const r = await q(`INSERT INTO users (prenom, nom, tel, email, password_hash, ville, commune, verified, status, acquisition_source, created_by_staff, formule_souhaitee, pos_commune)
                     VALUES (?,?,?,?,?, 'Abidjan', ?, 0, 'A_ACTIVER', ?, ?, ?, ?)`,
    [str(b.prenom, 60), str(b.nom, 60), tel, str(b.email, 120), await bcrypt.hash(U.token(16), 10), str(b.commune, 40) || "Cocody", str(b.source, 40) || "Terrain", req.staff.id, f ? f.code : null, str(b.commune, 40) || "Cocody"]);
  await q("INSERT INTO sos_settings (user_id) VALUES (?)", [r.insertId]);
  if (b.prospect) await q("UPDATE prospects SET statut = 'CONVERTI', user_id = ? WHERE id = ?", [r.insertId, +b.prospect]);
  await U.notify(r.insertId, "Bienvenue sur ID SECOURS", f ? `Votre conseiller vous recommande la formule ${f.label}. Choisissez et payez votre protection depuis l’application.` : "Choisissez votre protection depuis l’application.", "protChoice");
  await U.sms(tel, `ID SECOURS : ${str(b.prenom, 60)}, votre compte a été préparé par votre conseiller. Activez-le dans l’application : « Se connecter » › « Mot de passe oublié / activer mon compte » avec ce numéro.`);
  U.audit(req, "SUBSCRIBER_CREATED", "user", String(r.insertId), `${b.source || "Terrain"}${f ? " · formule souhaitée " + f.code : ""}`);
  res.status(201).json({ id: r.insertId });
}));
/* fiche commerciale : données limitées au nécessaire (§15, COM-11) */
router.get("/commercial/clients", can("commercial.view"), h(async (req, res) => {
  res.json({ items: await q(`SELECT u.id, CONCAT('CLI-', LPAD(u.id, 6, '0')) ref, u.prenom, u.nom, u.tel, u.commune, u.status, u.acquisition_source, u.formule_souhaitee, u.created_at,
      (SELECT GROUP_CONCAT(DISTINCT p.label SEPARATOR ', ') FROM protections p WHERE p.user_id = u.id AND p.exp_at > NOW()) protections,
      (SELECT MIN(p.exp_at) FROM protections p WHERE p.user_id = u.id AND p.exp_at > NOW()) prochaine_echeance,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE user_id = u.id AND status = 'RÉUSSI') ca
    FROM users u ORDER BY u.id DESC LIMIT 300`) });
}));

router.get("/prospects", can("prospects.manage"), h(async (req, res) => res.json({ items: await q("SELECT * FROM prospects ORDER BY id DESC") })));
router.post("/prospects", can("prospects.manage"), h(async (req, res) => {
  const b = req.body; if (!str(b.nom)) fail(400, "Nom obligatoire.");
  if (b.tel && await one("SELECT id FROM prospects WHERE tel = ?", [str(b.tel, 30)])) fail(409, "Un prospect avec ce numéro existe déjà.");
  await q("INSERT INTO prospects (nom, tel, email, source, notes, staff_id) VALUES (?,?,?,?,?,?)", [str(b.nom, 120), str(b.tel, 30), str(b.email, 120), str(b.source, 40) || "Terrain", str(b.notes, 500), req.staff.id]);
  res.json({ ok: true });
}));
router.patch("/prospects/:id", can("prospects.manage"), h(async (req, res) => {
  const st = req.body.statut; if (!["NOUVEAU", "CONTACTÉ", "INTÉRESSÉ", "CONVERTI", "PERDU"].includes(st)) fail(400, "Statut inconnu.");
  await q("UPDATE prospects SET statut = ? WHERE id = ?", [st, req.params.id]); res.json({ ok: true });
}));

/* ---------- support : messagerie, SOS, incidents ---------- */
router.get("/messages", can("support.messages"), h(async (req, res) => {
  res.json({ items: await q(`SELECT m.dossier_ref ref, MAX(m.id) last_id, MAX(m.created_at) t, SUM(m.sender = 'USER' AND m.read_by_agent = 0) unread,
      SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(m.body, m.file_name, 'Message vocal') ORDER BY m.id DESC SEPARATOR '\n'), '\n', 1) last
    FROM messages m GROUP BY m.dossier_ref ORDER BY last_id DESC LIMIT 200`) });
}));
router.get("/messages/:ref", can("support.messages"), h(async (req, res) => {
  await q("UPDATE messages SET read_by_agent = 1 WHERE dossier_ref = ? AND sender = 'USER'", [req.params.ref]);
  const rows = await q("SELECT m.*, s.prenom agent FROM messages m LEFT JOIN staff s ON s.id = m.staff_id WHERE m.dossier_ref = ? ORDER BY m.id", [req.params.ref]);
  U.audit(req, "DOSSIER_VIEW", "dossier", req.params.ref);
  res.json({ items: rows });
}));
router.post("/messages/:ref", can("support.messages"), h(async (req, res) => {
  if (!str(req.body.text)) fail(400, "Message vide.");
  const { resolveDossier } = require("../lib/dossiers");
  const d = await resolveDossier(req.params.ref); if (!d) fail(404, "Dossier introuvable.");
  await q("INSERT INTO messages (dossier_ref, sender, staff_id, body) VALUES (?, 'AGENT', ?, ?)", [req.params.ref, req.staff.id, str(req.body.text, 2000)]);
  await U.notify(d.userId, "Nouveau message d’ID SECOURS", `Dossier ${req.params.ref}`, "chat|" + req.params.ref);
  res.json({ ok: true });
}));
router.get("/sos", can("sos.monitor"), h(async (req, res) => {
  const rows = await q(`SELECT i.id, i.ref, i.type, i.status, i.is_test, i.duress, i.closed, i.created_at, i.battery, u.prenom, u.nom, u.tel,
      (SELECT CONCAT(commune, ' · ', lat, ', ', lng, ' (± ', accuracy, ' m)') FROM sos_positions p WHERE p.incident_id = i.id ORDER BY p.id DESC LIMIT 1) pos
    FROM sos_incidents i JOIN users u ON u.id = i.user_id WHERE i.is_test = 0 ORDER BY i.closed, i.id DESC LIMIT 100`);
  res.json({ items: rows });
}));
router.get("/sos/:ref", can("sos.monitor"), h(async (req, res) => {
  const i = await one("SELECT * FROM sos_incidents WHERE ref = ?", [req.params.ref]); if (!i) fail(404, "Incident introuvable.");
  const [log, contacts] = await Promise.all([q("SELECT label, created_at FROM sos_events WHERE incident_id = ? ORDER BY id", [i.id]), q("SELECT prenom, nom, relation, tel, status FROM sos_incident_contacts WHERE incident_id = ? ORDER BY position", [i.id])]);
  U.audit(req, "SOS_VIEW", "sos", i.ref);
  res.json({ log, contacts });
}));
router.get("/incidents", can("incidents.manage"), h(async (req, res) => res.json({ items: await q("SELECT o.*, s.prenom, s.nom, a.nom agence FROM ops_incidents o LEFT JOIN staff s ON s.id = o.created_by LEFT JOIN agencies a ON a.id = o.agency_id ORDER BY (o.statut IN ('OUVERT','EN COURS')) DESC, o.id DESC") })));
router.post("/incidents", can("incidents.manage"), h(async (req, res) => {
  const b = req.body; if (!str(b.titre)) fail(400, "Titre obligatoire.");
  const ref = "INC-" + (await U.nextRef("inc", "X")).split("-").pop().replace(/^0+/, "");
  await q("INSERT INTO ops_incidents (ref, titre, description, priorite, dossier_ref, created_by, agency_id) VALUES (?,?,?,?,?,?,?)", [ref, str(b.titre, 160), str(b.description, 1000), ["BASSE", "NORMALE", "HAUTE", "CRITIQUE"].includes(b.priorite) ? b.priorite : "NORMALE", str(b.dossier, 30), req.staff.id, +b.agency || null]);
  if (b.priorite === "CRITIQUE") await require("../lib/alerts").push("incident:" + ref, ["incidents.manage", "staff.manage"], "Incident critique ouvert", `${ref} · ${str(b.titre, 160)}`, "incidents", "CRITIQUE");
  U.audit(req, "INCIDENT_CREATED", "incident", ref); res.json({ ok: true });
}));
router.patch("/incidents/:ref", can("incidents.manage"), h(async (req, res) => {
  const inc = await one("SELECT * FROM ops_incidents WHERE ref = ?", [req.params.ref]); if (!inc) fail(404, "Incident introuvable.");
  const st = req.body.statut || inc.statut; if (!["OUVERT", "EN COURS", "RÉSOLU", "CLÔTURÉ"].includes(st)) fail(400, "Statut inconnu.");
  const rep = str(req.body.reponse, 600);
  await q("UPDATE ops_incidents SET statut = ?, reponse = COALESCE(?, reponse), repondu_at = IF(? IS NULL, repondu_at, NOW()), repondu_by = IF(? IS NULL, repondu_by, ?) WHERE id = ?", [st, rep, rep, rep, req.staff.id, inc.id]);
  /* l'agent qui a demandé l'assistance est prévenu de la réponse ou du changement de statut */
  if (inc.kind === "ASSISTANCE" && inc.created_by && (rep || st !== inc.statut))
    await require("../lib/alerts").push(`assist:${inc.ref}:${Date.now()}`, ["staff:" + inc.created_by], `Votre demande d’assistance ${inc.ref} · ${st.toLowerCase()}`, rep || `Statut : ${st}`, "assistance", "NORMALE");
  U.audit(req, "INCIDENT_" + st, "incident", req.params.ref, rep || undefined); res.json({ ok: true });
}));

/* ---------- Super Admin : utilisateurs internes, rôles, agences, paramètres, journaux ---------- */
router.get("/staff", can("staff.manage"), h(async (req, res) => {
  const [items, roles, agencies] = await Promise.all([
    q("SELECT s.id, s.prenom, s.nom, s.email, s.tel, s.status, s.last_login, s.created_at, r.code role, r.label role_label, a.nom agence, s.agency_id FROM staff s JOIN roles r ON r.id = s.role_id LEFT JOIN agencies a ON a.id = s.agency_id ORDER BY s.id"),
    q("SELECT id, code, label FROM roles ORDER BY id"), q("SELECT id, nom FROM agencies ORDER BY id")]);
  res.json({ items, roles, agencies });
}));
router.post("/staff", can("staff.manage"), h(async (req, res) => {
  const b = req.body, email = String(b.email || "").trim().toLowerCase();
  if (!str(b.prenom) || !str(b.nom) || !/^\S+@\S+\.\S+$/.test(email)) fail(400, "Prénom, nom et e-mail valide obligatoires.");
  if (String(b.password || "").length < 8) fail(400, "Mot de passe provisoire : 8 caractères minimum.");
  const role = await one("SELECT id FROM roles WHERE code = ?", [b.role]); if (!role) fail(400, "Rôle inconnu.");
  if (await one("SELECT id FROM staff WHERE email = ?", [email])) fail(409, "Cet e-mail est déjà utilisé.");
  await q("INSERT INTO staff (prenom, nom, email, tel, password_hash, role_id, agency_id) VALUES (?,?,?,?,?,?,?)", [str(b.prenom, 60), str(b.nom, 60), email, str(b.tel, 30), await bcrypt.hash(String(b.password), 10), role.id, +b.agency || null]);
  U.audit(req, "STAFF_CREATED", "staff", email, b.role); res.json({ ok: true });
}));
router.patch("/staff/:id", can("staff.manage"), h(async (req, res) => {
  const b = req.body, s = await one("SELECT * FROM staff WHERE id = ?", [req.params.id]); if (!s) fail(404, "Agent introuvable.");
  if (+req.params.id === req.staff.id && b.status === "SUSPENDU") fail(409, "Vous ne pouvez pas suspendre votre propre compte.");
  const role = b.role ? await one("SELECT id FROM roles WHERE code = ?", [b.role]) : null;
  await q("UPDATE staff SET status = COALESCE(?, status), role_id = COALESCE(?, role_id), agency_id = ? WHERE id = ?",
    [["ACTIVE", "SUSPENDU"].includes(b.status) ? b.status : null, role ? role.id : null, b.agency !== undefined ? (+b.agency || null) : s.agency_id, s.id]);
  if (b.password) { if (String(b.password).length < 8) fail(400, "Mot de passe : 8 caractères minimum."); await q("UPDATE staff SET password_hash = ? WHERE id = ?", [await bcrypt.hash(String(b.password), 10), s.id]); }
  U.audit(req, "STAFF_UPDATED", "staff", s.email, JSON.stringify(U.pick(b, ["status", "role", "agency"]))); res.json({ ok: true });
}));
router.get("/staff-logins", can("staff.manage", "audit.view"), h(async (req, res) => res.json({ items: await q("SELECT l.*, s.prenom, s.nom FROM staff_logins l LEFT JOIN staff s ON s.id = l.staff_id ORDER BY l.id DESC LIMIT 200") })));
router.get("/roles", can("roles.manage", "staff.manage"), h(async (req, res) => {
  const [roles, perms, rp] = await Promise.all([q("SELECT * FROM roles ORDER BY id"), q("SELECT * FROM permissions ORDER BY module, code"), q("SELECT * FROM role_permissions")]);
  res.json({ roles: roles.map(r => ({ ...r, perms: rp.filter(x => x.role_id === r.id).map(x => x.perm_code) })), perms });
}));
router.put("/roles/:id", can("roles.manage"), h(async (req, res) => {
  const r = await one("SELECT * FROM roles WHERE id = ?", [req.params.id]); if (!r) fail(404, "Rôle introuvable.");
  if (r.code === "SUPER_ADMIN") fail(409, "Les droits du Super Admin ne sont pas modifiables.");
  const perms = (Array.isArray(req.body.perms) ? req.body.perms : []).map(String);
  await tx(async c => { await c.query("DELETE FROM role_permissions WHERE role_id = ?", [r.id]); if (perms.length) await c.query("INSERT INTO role_permissions (role_id, perm_code) SELECT ?, code FROM permissions WHERE code IN (?)", [r.id, perms]); });
  U.audit(req, "ROLE_PERMS", "role", r.code, perms.join(",")); res.json({ ok: true });
}));
router.get("/agencies", can("agencies.manage", "dashboard.view"), h(async (req, res) => {
  res.json({ items: await q(`SELECT a.*, (SELECT COUNT(*) FROM held_documents h WHERE h.agency_id = a.id AND h.status IN ('A_CONTROLER','RECU','CONSERVE','QUARANTAINE','EN_RESTITUTION')) stock,
    (SELECT COUNT(*) FROM recoveries r JOIN held_documents h ON h.id = r.held_id WHERE h.agency_id = a.id AND r.done_at IS NOT NULL) restitues,
    (SELECT COUNT(*) FROM found_reports f WHERE f.agency_id = a.id) collectes,
    (SELECT COUNT(*) FROM ops_incidents i WHERE i.agency_id = a.id AND i.statut IN ('OUVERT','EN COURS')) incidents,
    (SELECT COUNT(*) FROM staff s WHERE s.agency_id = a.id) agents FROM agencies a ORDER BY a.id`) });
}));
router.post("/agencies", can("agencies.manage"), h(async (req, res) => {
  const b = req.body; if (!str(b.nom) || !str(b.commune) || !str(b.adresse)) fail(400, "Nom, commune et adresse obligatoires.");
  await q("INSERT INTO agencies (code, nom, commune, adresse, tel, horaires, lat, lng, email, responsable, capacite, services) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ["AG-" + U.normNum(b.commune).slice(0, 3) + U.rnd(10, 99), str(b.nom, 80), str(b.commune, 40), str(b.adresse, 160), str(b.tel, 30), str(b.horaires, 60) || "Lun–Sam · 8h–17h", +b.lat || null, +b.lng || null,
     str(b.email, 120), str(b.responsable, 80), +b.capacite > 0 ? Math.round(+b.capacite) : null, str(b.services, 160) || "Réception, conservation, restitution"]);
  U.audit(req, "AGENCY_CREATED", "agency", b.nom); res.json({ ok: true });
}));
router.patch("/agencies/:id", can("agencies.manage"), h(async (req, res) => {
  if (req.body.status !== undefined) {
    const st = req.body.status, motif = str(req.body.motif, 255);
    if (!["ACTIVE", "TEMPORAIREMENT_INDISPONIBLE", "SUSPENDUE"].includes(st)) fail(400, "Statut inconnu.");
    if (st !== "ACTIVE" && !motif) fail(400, "Le motif est obligatoire pour suspendre ou rendre indisponible une agence (§28).");
    await q("UPDATE agencies SET status = ?, status_motif = ? WHERE id = ?", [st, st === "ACTIVE" ? null : motif, req.params.id]);
    U.audit(req, "AGENCY_STATUS", "agency", req.params.id, `${st}${motif ? " · " + motif : ""}`); return res.json({ ok: true });
  }
  const cur = await one("SELECT * FROM agencies WHERE id = ?", [req.params.id]); if (!cur) fail(404, "Agence introuvable.");
  const set = U.pick(req.body, ["nom", "adresse", "tel", "email", "horaires", "responsable", "capacite", "services", "lat", "lng"]); const keys = Object.keys(set);
  if (!keys.length) fail(400, "Rien à modifier.");
  for (const k of keys) set[k] = ["capacite", "lat", "lng"].includes(k) ? (set[k] === "" || set[k] == null ? null : +set[k]) : str(set[k], 160);
  await q(`UPDATE agencies SET ${keys.map(k => k + " = ?").join(", ")} WHERE id = ?`, [...keys.map(k => set[k]), cur.id]);
  U.audit(req, "AGENCY_UPDATED", "agency", cur.code, keys.map(k => `${k}: ${cur[k]} → ${set[k]}`).join(" ; ")); res.json({ ok: true });
}));

/* paramètres : catégories, packs, formules, moyens de paiement, paramètres système (avec historique des tarifs) */
const EDITABLE = {
  categories: { table: "doc_categories", key: "code", fields: ["label", "prix", "frais", "official", "active", "num_required", "recto_required", "verso_required", "has_expiry", "has_issuer", "description"] },
  packs: { table: "packs", key: "code", fields: ["label", "prix", "quota500", "quota300", "description", "active"] },
  formules: { table: "formules", key: "code", fields: ["label", "prix", "max_docs", "collecte_label", "livraison_label", "collect_quota", "delivery_quota", "priorite", "publication", "active"] },
  paymethods: { table: "pay_methods", key: "code", fields: ["label", "active", "provider", "fee_pct", "fee_fixed", "env"] },
  settings: { table: "settings", key: "k", fields: ["v"] }
};
router.get("/settings", can("settings.manage", "finance.view", "commercial.view"), h(async (req, res) => {
  const out = {};
  for (const [k, e] of Object.entries(EDITABLE)) out[k] = await q(`SELECT * FROM ${e.table}`);
  out.history = await q("SELECT t.*, s.prenom, s.nom FROM tariff_history t LEFT JOIN staff s ON s.id = t.staff_id ORDER BY t.id DESC LIMIT 100");
  res.json(out);
}));
router.put("/settings/:entity/:code", can("settings.manage"), h(async (req, res) => {
  const e = EDITABLE[req.params.entity]; if (!e) fail(404, "Paramètre inconnu.");
  const cur = await one(`SELECT * FROM ${e.table} WHERE ${e.key} = ?`, [req.params.code]); if (!cur) fail(404, "Élément introuvable.");
  const set = U.pick(req.body, e.fields); const keys = Object.keys(set); if (!keys.length) fail(400, "Rien à modifier.");
  for (const k of keys) if (/prix|frais|quota|max_docs|fee_fixed/.test(k) && (!Number.isInteger(+set[k]) || +set[k] < -1)) fail(400, `Valeur invalide pour ${k}.`);
  if ("fee_pct" in set && !(+set.fee_pct >= 0 && +set.fee_pct <= 100)) fail(400, "Frais en % : valeur entre 0 et 100.");
  if ("env" in set && !["SIMULATION", "TEST", "PRODUCTION"].includes(set.env)) fail(400, "Environnement invalide.");
  await q(`UPDATE ${e.table} SET ${keys.map(k => k + " = ?").join(", ")} WHERE ${e.key} = ?`, [...keys.map(k => set[k]), req.params.code]);
  for (const k of keys) if (String(cur[k]) !== String(set[k])) await q("INSERT INTO tariff_history (entity, code, field, old_value, new_value, staff_id) VALUES (?,?,?,?,?,?)", [req.params.entity, req.params.code, k, String(cur[k]).slice(0, 60), String(set[k]).slice(0, 60), req.staff.id]);
  /* règles de correspondance versionnées (VC19) */
  if (req.params.entity === "settings" && /^match_(w_|forte|verifier)/.test(req.params.code)) await q("UPDATE settings SET v = CAST(v AS UNSIGNED) + 1 WHERE k = 'match_rules_version'");
  U.audit(req, "SETTINGS_UPDATED", req.params.entity, req.params.code, JSON.stringify(set)); res.json({ ok: true });
}));
/* création d'une catégorie de document (§35) : nouveaux types sans modifier l'application */
router.post("/settings/categories", can("settings.manage"), h(async (req, res) => {
  const b = req.body, code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (!code || !str(b.label) || !str(b.short)) fail(400, "Code, libellé et libellé court sont obligatoires.");
  if (await one("SELECT code FROM doc_categories WHERE code = ?", [code])) fail(409, "Ce code existe déjà.");
  for (const k of ["prix", "frais"]) if (!Number.isInteger(+b[k]) || +b[k] < 0) fail(400, `Valeur invalide pour ${k}.`);
  const pos = await one("SELECT COALESCE(MAX(position), 0) + 1 p FROM doc_categories");
  await q(`INSERT INTO doc_categories (code, label, short, prix, frais, icon, color, official, prefix, position, num_required, recto_required, verso_required, has_expiry, has_issuer, description)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [code, str(b.label, 80), str(b.short, 40), +b.prix, +b.frais, str(b.icon, 30) || "doc", /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#6A7570",
    b.official ? 1 : 0, str(b.prefix, 4) || "", pos.p, b.num_required === 0 ? 0 : 1, b.recto_required ? 1 : 0, b.verso_required ? 1 : 0, b.has_expiry === 0 ? 0 : 1, b.has_issuer === 0 ? 0 : 1, str(b.description, 255) || null]);
  await q("INSERT INTO tariff_history (entity, code, field, old_value, new_value, staff_id) VALUES ('categories', ?, 'création', '—', ?, ?)", [code, `${+b.prix} / ${+b.frais} FCFA`, req.staff.id]);
  U.audit(req, "CATEGORY_CREATED", "categories", code, str(b.label, 80));
  res.status(201).json({ ok: true, code });
}));
router.get("/audit", can("audit.view"), h(async (req, res) => {
  const { limit, offset } = paging(req);
  res.json({ items: await q(`SELECT a.*, s.prenom, s.nom FROM audit_logs a LEFT JOIN staff s ON a.actor_type = 'STAFF' AND s.id = a.actor_id
    ${req.query.q ? "WHERE a.action LIKE ? OR a.entity_ref LIKE ?" : ""} ORDER BY a.id DESC LIMIT ? OFFSET ?`, req.query.q ? [like(req.query.q), like(req.query.q), limit, offset] : [limit, offset]) });
}));
/* ---------- Direction des opérations : suivi des performances ---------- */
router.get("/performance", can("performance.view"), h(async (req, res) => {
  const [agencies, partners, services] = await Promise.all([
    q(`SELECT a.id, a.nom, a.status,
         (SELECT COUNT(*) FROM held_documents h WHERE h.agency_id = a.id) receptions,
         (SELECT COUNT(*) FROM held_documents h WHERE h.agency_id = a.id AND h.status IN ('A_CONTROLER','RECU','CONSERVE','QUARANTAINE','EN_RESTITUTION')) stock,
         (SELECT COUNT(*) FROM held_documents h WHERE h.agency_id = a.id AND h.emplacement IS NULL AND h.status = 'RECU') sans_emplacement,
         (SELECT COUNT(*) FROM recoveries r JOIN held_documents h ON h.id = r.held_id WHERE h.agency_id = a.id AND r.done_at IS NOT NULL) restitutions,
         (SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, r.created_at, r.done_at)), 1) FROM recoveries r JOIN held_documents h ON h.id = r.held_id WHERE h.agency_id = a.id AND r.done_at IS NOT NULL) delai_restitution_h
       FROM agencies a ORDER BY a.id`),
    q(`SELECT p.id, p.nom, p.status, COUNT(f.id) missions, SUM(f.step >= 5) collectees,
         ROUND(AVG(CASE WHEN f.handed_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, f.created_at, f.handed_at) END) / 60, 1) delai_collecte_h
       FROM partners p LEFT JOIN found_reports f ON f.partner_id = p.id GROUP BY p.id ORDER BY p.id`),
    one(`SELECT
         (SELECT COUNT(*) FROM loss_declarations WHERE closed = 0) declarations_ouvertes,
         (SELECT COUNT(*) FROM found_reports WHERE step BETWEEN 1 AND 4) collectes_en_cours,
         (SELECT COUNT(*) FROM held_documents WHERE status = 'A_CONTROLER') controles_en_attente,
         (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, received_at, verif_at)) / 60, 1) FROM held_documents WHERE verif_at IS NOT NULL) delai_controle_h,
         (SELECT COUNT(*) FROM recoveries WHERE verif_status = 'EN VÉRIFICATION') verifications_proprietaire,
         (SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, created_at, verified_at)) / 60, 1) FROM recoveries WHERE verified_at IS NOT NULL) delai_verification_h,
         (SELECT COUNT(*) FROM found_reports WHERE step = 5) receptions_en_attente,
         (SELECT COUNT(*) FROM recoveries WHERE status = 'RÉCUPÉRATION AUTORISÉE' AND done_at IS NULL) restitutions_en_attente,
         (SELECT COUNT(*) FROM ops_incidents WHERE statut IN ('OUVERT','EN COURS')) incidents_ouverts`)
  ]);
  res.json({ agencies, partners, services });
}));

/* ---------- Support technique : maintenance du système ---------- */
router.get("/system", can("system.view"), h(async (req, res) => {
  const fs = require("fs"), path = require("path");
  const dir = path.join(__dirname, "..", "..", "uploads");
  let files = 0, bytes = 0; try { for (const f of fs.readdirSync(dir)) { files++; bytes += fs.statSync(path.join(dir, f)).size; } } catch { /* dossier absent */ }
  const [ver, counts, logins, sms, otp] = await Promise.all([
    one("SELECT VERSION() v"),
    q(`SELECT TABLE_NAME t, TABLE_ROWS n, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024) kb FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC LIMIT 12`),
    one("SELECT SUM(success = 0) ko, COUNT(*) n FROM staff_logins WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)"),
    one("SELECT COUNT(*) n FROM sms_outbox WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)"),
    one("SELECT COUNT(*) n FROM otp_codes WHERE used = 1 OR expires_at < NOW()")
  ]);
  res.json({ api: { uptime_s: Math.round(process.uptime()), node: process.version, memoire_mo: Math.round(process.memoryUsage().rss / 1048576), env: process.env.NODE_ENV || "development",
    paiement: process.env.PAYMENT_MODE || "simulation", sms: process.env.SMS_MODE || "simulation" },
    db: { version: ver.v, tables: counts }, uploads: { files, mo: Math.round(bytes / 10485.76) / 100 },
    securite: { connexions_24h: logins.n, echecs_24h: +logins.ko || 0 }, sms_24h: sms.n, otp_purgeables: otp.n });
}));
router.post("/system/purge", can("system.view"), h(async (req, res) => {
  const r = await q("DELETE FROM otp_codes WHERE (used = 1 OR expires_at < NOW()) AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)");
  U.audit(req, "SYSTEM_PURGE_OTP", "system", null, `${r.affectedRows} codes`);
  res.json({ ok: true, deleted: r.affectedRows });
}));

/* ---------- Service commercial : partenariats commerciaux ---------- */
router.get("/com-partners", can("commercial.view"), h(async (req, res) => res.json({ items: await q("SELECT * FROM com_partners ORDER BY id DESC") })));
router.post("/com-partners", can("prospects.manage"), h(async (req, res) => {
  const b = req.body; if (!str(b.nom)) fail(400, "Nom obligatoire.");
  await q("INSERT INTO com_partners (nom, type, contact, tel, email, commission, notes, staff_id) VALUES (?,?,?,?,?,?,?,?)",
    [str(b.nom, 120), str(b.type, 40) || "Revendeur", str(b.contact, 80), str(b.tel, 30), str(b.email, 120), Math.max(0, Math.min(100, +b.commission || 0)), str(b.notes, 500), req.staff.id]);
  U.audit(req, "COM_PARTNER_CREATED", "com_partner", b.nom); res.json({ ok: true });
}));
router.patch("/com-partners/:id", can("prospects.manage"), h(async (req, res) => {
  if (!["PROSPECT", "ACTIF", "SUSPENDU", "TERMINÉ"].includes(req.body.statut)) fail(400, "Statut inconnu.");
  await q("UPDATE com_partners SET statut = ? WHERE id = ?", [req.body.statut, req.params.id]); res.json({ ok: true });
}));

/* ---------- Direction financière : facture d'une transaction ---------- */
router.get("/finance/:ref/invoice", can("billing.view"), h(async (req, res) => {
  const p = await one(`SELECT p.*, u.prenom, u.nom, u.tel, u.email, u.commune, m.label methode FROM payments p LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN pay_methods m ON m.code = p.method WHERE p.ref = ?`, [req.params.ref]);
  if (!p) fail(404, "Transaction introuvable.");
  if (!["RÉUSSI", "REMBOURSÉ"].includes(p.status)) fail(409, "Une facture n’est émise que pour une transaction encaissée.");
  U.audit(req, "INVOICE_VIEW", "payment", p.ref);
  res.json({ invoice: { numero: "FAC-" + p.ref.replace(/^PAY-/, ""), date: p.created_at, ref: p.ref, objet: p.label, montant: p.amount, methode: p.methode, statut: p.status,
    lignes: JSON.parse(p.detail_lines || "[]"), client: p.prenom ? { nom: `${p.prenom} ${p.nom}`, tel: U.fmtTel(p.tel), email: p.email, commune: p.commune } : { nom: "Client sans compte", tel: U.fmtTel(p.phone) } } });
}));

router.use("/fin", require("./finance"));

/* notifications internes : alertes ciblées selon les permissions du rôle */
router.get("/notifications", h(async (req, res) => {
  const rows = await q(`SELECT n.*, r.read_at FROM staff_notifications n LEFT JOIN staff_notification_reads r ON r.notification_id = n.id AND r.staff_id = ?
    WHERE n.resolved = 0 OR n.created_at > DATE_SUB(NOW(), INTERVAL 2 DAY) ORDER BY n.resolved, FIELD(n.priority,'CRITIQUE','HAUTE','NORMALE'), n.id DESC LIMIT 300`, [req.staff.id]);
  /* ciblage par permission, ou nominatif (« staff:<id> ») */
  const mine = rows.filter(n => n.perms.split(",").some(p => req.staff.perms.includes(p) || p === "staff:" + req.staff.id)).slice(0, 60);
  res.json({ items: mine.map(n => ({ id: n.id, title: n.title, body: n.body, link: n.link, priority: n.priority, resolved: !!n.resolved, read: !!n.read_at, t: n.created_at })),
    unread: mine.filter(n => !n.read_at && !n.resolved).length });
}));
router.post("/notifications/read", h(async (req, res) => {
  const ids = req.body.id ? [+req.body.id] : (await q("SELECT id, perms FROM staff_notifications WHERE resolved = 0")).filter(n => n.perms.split(",").some(p => req.staff.perms.includes(p) || p === "staff:" + req.staff.id)).map(n => n.id);
  for (const id of ids) await q("INSERT IGNORE INTO staff_notification_reads (notification_id, staff_id) VALUES (?,?)", [id, req.staff.id]);
  res.json({ ok: true });
}));
/* exports journalisés (DF14, COM-12) */
router.post("/exports", h(async (req, res) => { U.audit(req, "EXPORT", "export", str(req.body.name, 40), `${+req.body.count || 0} lignes`); res.json({ ok: true }); }));

router.get("/sms", can("support.messages", "staff.manage"), h(async (req, res) => res.json({ items: await q("SELECT * FROM sms_outbox ORDER BY id DESC LIMIT 100") })));

module.exports = router;
