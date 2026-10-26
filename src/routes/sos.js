/* Module SOS — 4 niveaux, contacts, codes, Mode Protection, incidents (cahier SOS §1–§40) */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { q, one } = require("../config/db");
const U = require("../lib/util");
const { ilog, TRIG } = require("../lib/engine");
const { requireUser } = require("../middleware/auth");
const { h, fail, str } = U;

const DIAG_KEYS = ["app", "notif", "gps", "bg", "lock", "btn", "taps", "vocal", "bt", "sms"];
const compatOk = (diag, k) => diag && ["ok", "warn"].includes(diag[k]);

async function settings(uid) {
  let s = await one("SELECT * FROM sos_settings WHERE user_id = ?", [uid]);
  if (!s) { await q("INSERT INTO sos_settings (user_id) VALUES (?)", [uid]); s = await one("SELECT * FROM sos_settings WHERE user_id = ?", [uid]); }
  return s;
}
async function sosView(uid) {
  const s = await settings(uid);
  const [contacts, devices, n] = await Promise.all([
    q("SELECT id, prenom, nom, tel, relation rel, priorite prio, invitation inv, ready FROM sos_contacts WHERE user_id = ? ORDER BY priorite, id", [uid]),
    q("SELECT id, nom, modele, type, battery bat, statut, last_seen last, last_check `check` FROM sos_devices WHERE user_id = ?", [uid]),
    one("SELECT COUNT(*) n FROM sos_incidents WHERE user_id = ? AND NOT (duress = 1 AND closed = 0)", [uid])
  ]);
  const until = s.protection_until ? new Date(s.protection_until) : null;
  return {
    enabled: !!s.enabled, configured: !!s.configured, shareLoc: !!s.share_loc, ackTimeout: s.ack_timeout,
    seq: JSON.parse(s.seq), seqDelay: +s.seq_delay, seqEnabled: !!s.seq_enabled, tapsEnabled: !!s.taps_enabled, tapCount: s.tap_count,
    hasCodes: !!s.code_normal_hash, voice: { phrase: s.voice_phrase || "", trained: !!s.voice_trained, enabled: !!s.voice_enabled },
    diag: s.diag ? JSON.parse(s.diag) : null,
    protection: { active: !!until && until > new Date(), until: s.protection_until, start: s.protection_start },
    contacts: contacts.map(c => ({ ...c, ready: !!c.ready })), bt: devices, incidents: n.n
  };
}

/* ---------- vue publique du contact d'urgence (lien reçu par SMS) — §22 à §24 ---------- */
const pub = require("express").Router();
async function alertCtx(token) {
  const c = await one("SELECT * FROM sos_incident_contacts WHERE token = ?", [token]);
  if (!c) fail(404, "Alerte introuvable ou expirée.");
  const inc = await one("SELECT * FROM sos_incidents WHERE id = ?", [c.incident_id]);
  return { c, inc };
}
pub.get("/:token", h(async (req, res) => {
  const { c, inc } = await alertCtx(req.params.token);
  if (["ENVOYEE", "LIVREE"].includes(c.status) && !inc.closed) {
    await q("UPDATE sos_incident_contacts SET status = 'OUVERTE', status_at = NOW(3) WHERE id = ?", [c.id]);
    await ilog(inc.id, `${c.prenom} a ouvert l’alerte`); c.status = "OUVERTE";
  }
  const u = await one("SELECT prenom, nom, tel FROM users WHERE id = ?", [inc.user_id]);
  const track = inc.share_loc ? await q("SELECT lat, lng, accuracy acc, source src, commune, created_at t FROM sos_positions WHERE incident_id = ? ORDER BY id", [inc.id]) : [];
  res.json({
    alert: {
      ref: inc.ref, t: inc.created_at, test: !!inc.is_test, duress: !!inc.duress, closed: !!inc.closed, st: inc.status, battery: inc.battery,
      user: { prenom: u.prenom, nom: u.nom, tel: U.fmtTel(u.tel) }, me: { prenom: c.prenom, nom: `${c.prenom} ${c.nom}`, rel: c.relation, st: c.status, current: c.position === inc.cur },
      loc: track[track.length - 1] || null, track
    }
  });
}));
pub.post("/:token/:action", h(async (req, res) => {
  const { c, inc } = await alertCtx(req.params.token), a = req.params.action;
  if (inc.closed) fail(409, "Alerte terminée.");
  if (a === "take") {
    await q("UPDATE sos_incident_contacts SET status = 'PRIS', status_at = NOW(3) WHERE id = ?", [c.id]);
    await q("UPDATE sos_incidents SET status = 'PRIS_EN_CHARGE', cur = ? WHERE id = ?", [c.position, inc.id]);
    await ilog(inc.id, `${c.prenom} prend en charge`);
    if (!inc.duress) await U.notify(inc.user_id, "Votre alerte est prise en charge", `${c.prenom} (${c.relation}) s’occupe de vous.`, "incident|" + inc.ref);
  } else if (a === "inter") {
    await q("UPDATE sos_incidents SET status = 'INTERVENTION_EN_COURS' WHERE id = ?", [inc.id]);
    await ilog(inc.id, `${c.prenom} : intervention en cours`);
  } else if (a === "no") {
    await q("UPDATE sos_incident_contacts SET status = 'REFUSEE', status_at = NOW(3) WHERE id = ?", [c.id]);
    await ilog(inc.id, `${c.prenom} n’est pas disponible — escalade`);
    if (c.position === inc.cur) { await q("UPDATE sos_incidents SET status = 'ESCALADE' WHERE id = ?", [inc.id]); await require("../lib/engine").alertNext(await one("SELECT * FROM sos_incidents WHERE id = ?", [inc.id])); }
  } else if (a === "call") await ilog(inc.id, `${c.prenom} appelle l’utilisateur`);
  else if (a === "urgences") await ilog(inc.id, `${c.prenom} consulte les numéros des services d’urgence`);
  else fail(400, "Action inconnue.");
  res.json({ ok: true });
}));

/* ---------- utilisateur ---------- */
router.use(requireUser);

router.get("/", h(async (req, res) => res.json({ sos: await sosView(req.user.id) })));

router.patch("/", h(async (req, res) => {
  const s = await settings(req.user.id), b = req.body, diag = s.diag ? JSON.parse(s.diag) : null, set = {};
  if (b.enabled !== undefined) { if (b.enabled && !s.configured) fail(409, "Terminez l’assistant de configuration."); set.enabled = b.enabled ? 1 : 0; }
  if (b.configured !== undefined) set.configured = b.configured ? 1 : 0;
  if (b.shareLoc !== undefined) set.share_loc = b.shareLoc ? 1 : 0;
  if (b.ackTimeout !== undefined) { if (![10, 20, 30, 60, 120].includes(+b.ackTimeout)) fail(400, "Délai invalide."); set.ack_timeout = +b.ackTimeout; }
  if (b.seq !== undefined) { if (!Array.isArray(b.seq) || b.seq.length > 5 || b.seq.some(k => !["V+", "V-", "P"].includes(k))) fail(400, "Séquence invalide."); set.seq = JSON.stringify(b.seq); }
  if (b.seqDelay !== undefined) set.seq_delay = Math.min(5, Math.max(0.5, +b.seqDelay));
  if (b.seqEnabled !== undefined) { if (b.seqEnabled && !compatOk(diag, "btn")) fail(409, "Diagnostic requis avant activation."); set.seq_enabled = b.seqEnabled ? 1 : 0; }
  if (b.tapsEnabled !== undefined) { if (b.tapsEnabled && !compatOk(diag, "taps")) fail(409, "Non disponible sur cet appareil."); set.taps_enabled = b.tapsEnabled ? 1 : 0; }
  if (b.tapCount !== undefined) set.tap_count = Math.min(5, Math.max(3, +b.tapCount));
  if (b.voicePhrase !== undefined) { const p = str(b.voicePhrase, 120) || ""; if (p.length < 6) fail(400, "Choisissez une phrase d’au moins 6 caractères."); if (p !== s.voice_phrase) { set.voice_phrase = p; set.voice_trained = 0; } }
  if (b.voiceTrained !== undefined) set.voice_trained = b.voiceTrained ? 1 : 0;
  if (b.voiceEnabled !== undefined) set.voice_enabled = b.voiceEnabled && compatOk(diag, "vocal") ? 1 : 0;
  if (b.diag !== undefined) {
    if (typeof b.diag !== "object" || DIAG_KEYS.some(k => !["ok", "warn", "ko"].includes(b.diag[k]))) fail(400, "Diagnostic invalide.");
    set.diag = JSON.stringify(U.pick(b.diag, DIAG_KEYS));
    if (b.diag.btn === "ko") set.seq_enabled = 0; if (b.diag.taps === "ko") set.taps_enabled = 0; if (b.diag.vocal === "ko") set.voice_enabled = 0;
  }
  const keys = Object.keys(set);
  if (keys.length) await q(`UPDATE sos_settings SET ${keys.map(k => k + " = ?").join(", ")} WHERE user_id = ?`, [...keys.map(k => set[k]), req.user.id]);
  if (set.enabled !== undefined) await U.activity(req.user.id, "SOS " + (set.enabled ? "activé" : "désactivé"));
  res.json({ sos: await sosView(req.user.id) });
}));

router.put("/codes", h(async (req, res) => {
  const { normal, duress } = req.body;
  if (!/^\d{4}$/.test(normal || "") || !/^\d{4}$/.test(duress || "")) fail(400, "Les codes doivent comporter 4 chiffres.");
  if (normal === duress) fail(400, "Les deux codes doivent être différents.");
  await settings(req.user.id);
  await q("UPDATE sos_settings SET code_normal_hash = ?, code_duress_hash = ? WHERE user_id = ?", [await bcrypt.hash(normal, 10), await bcrypt.hash(duress, 10), req.user.id]);
  await U.activity(req.user.id, "Codes de sécurité modifiés");
  res.json({ ok: true });
}));

/* contrôle d'un code : normal → ok ; contrainte → ok aussi, mais incident silencieux */
async function checkCode(uid, code) {
  const s = await settings(uid);
  if (!s.code_normal_hash) fail(409, "Définissez d’abord vos codes de sécurité.");
  if (await bcrypt.compare(String(code || ""), s.code_normal_hash)) return "normal";
  if (s.code_duress_hash && await bcrypt.compare(String(code || ""), s.code_duress_hash)) return "duress";
  return null;
}
router.post("/unlock", h(async (req, res) => {
  const k = await checkCode(req.user.id, req.body.code);
  if (!k) fail(401, "Code incorrect.");
  if (k === "duress") await createIncident(req.user, "contrainte", { loc: req.body.loc, battery: req.body.battery });
  else await U.activity(req.user.id, "Déverrouillage · code normal");
  res.json({ ok: true }); // réponse identique dans les deux cas
}));

/* ---------- contacts d'urgence ---------- */
router.post("/contacts", h(async (req, res) => {
  const b = req.body, tel = U.normTel(b.tel);
  if (!str(b.nom) || !str(b.prenom) || tel.length < 8) fail(400, "Nom, prénom et numéro valide sont obligatoires.");
  const n = await one("SELECT COUNT(*) n FROM sos_contacts WHERE user_id = ?", [req.user.id]);
  if (n.n >= 5) fail(409, "5 contacts d’urgence maximum.");
  await q("INSERT INTO sos_contacts (user_id, prenom, nom, tel, relation, priorite) VALUES (?,?,?,?,?,?)", [req.user.id, str(b.prenom, 60), str(b.nom, 60), tel, str(b.rel, 30) || "Autre", Math.min(5, Math.max(1, +b.prio || n.n + 1))]);
  await U.sms(tel, `${req.user.prenom} vous a désigné comme contact d’urgence sur ID SECOURS. Téléchargez ID SECOURS pour recevoir les alertes d’urgence sonores et sa position en cas de détresse.`);
  await U.activity(req.user.id, `Contact d’urgence ajouté : ${b.prenom} ${b.nom}`);
  res.status(201).json({ sos: await sosView(req.user.id) });
}));
const myContact = async (req) => { const c = await one("SELECT * FROM sos_contacts WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]); if (!c) fail(404, "Contact introuvable."); return c; };
/* simulation : le contact installe l'application (en production : confirmé par l'application du contact) */
router.post("/contacts/:id/install", h(async (req, res) => {
  if (process.env.SMS_MODE === "live") fail(403, "Indisponible en production.");
  const c = await myContact(req); await q("UPDATE sos_contacts SET invitation = 'ACCEPTEE' WHERE id = ?", [c.id]);
  res.json({ sos: await sosView(req.user.id) });
}));
router.post("/contacts/:id/test", h(async (req, res) => {
  const c = await myContact(req);
  if (c.invitation !== "ACCEPTEE") fail(409, "Le contact doit d’abord installer ID SECOURS.");
  await U.sms(c.tel, "TEST ID SECOURS — Ceci est un test. Aucune urgence réelle.");
  await q("UPDATE sos_contacts SET ready = 1 WHERE id = ?", [c.id]);
  await U.activity(req.user.id, `Test d’alerte réussi : ${c.prenom}`);
  res.json({ sos: await sosView(req.user.id) });
}));
router.delete("/contacts/:id", h(async (req, res) => {
  const c = await myContact(req); await q("DELETE FROM sos_contacts WHERE id = ?", [c.id]);
  await U.activity(req.user.id, `Contact révoqué : ${c.prenom} ${c.nom}`);
  res.json({ sos: await sosView(req.user.id) });
}));

/* ---------- accessoires Bluetooth ---------- */
router.post("/devices", h(async (req, res) => {
  const b = req.body; if (!str(b.id) || !str(b.nom)) fail(400, "Dispositif invalide.");
  await q("REPLACE INTO sos_devices (id, user_id, nom, modele, type, battery, statut, last_seen, last_check) VALUES (?,?,?,?,?,?, 'Actif', NOW(), NOW())",
    [str(b.id, 20), req.user.id, str(b.nom, 60), str(b.modele, 40) || "", str(b.type, 60) || "Dispositif BLE", Math.round(+b.bat || 0)]);
  await U.activity(req.user.id, "Accessoire Bluetooth activé " + b.id);
  res.json({ sos: await sosView(req.user.id) });
}));
router.delete("/devices/:id", h(async (req, res) => {
  await q("DELETE FROM sos_devices WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
  await U.activity(req.user.id, "Appareil Bluetooth révoqué " + req.params.id);
  res.json({ sos: await sosView(req.user.id) });
}));

/* ---------- Mode Protection ---------- */
router.post("/protection", h(async (req, res) => {
  const m = Math.min(720, Math.max(1, Math.round(+req.body.minutes || 30)));
  await settings(req.user.id);
  await q("UPDATE sos_settings SET protection_start = NOW(), protection_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE user_id = ?", [m, req.user.id]);
  await U.activity(req.user.id, `Mode Protection activé (${m} min)`);
  res.json({ sos: await sosView(req.user.id) });
}));
router.delete("/protection", h(async (req, res) => {
  await q("UPDATE sos_settings SET protection_until = NULL WHERE user_id = ?", [req.user.id]);
  await U.activity(req.user.id, "Mode Protection arrêté");
  res.json({ sos: await sosView(req.user.id) });
}));

/* ---------- incidents ---------- */
async function createIncident(user, type, o = {}) {
  const s = await settings(user.id);
  const test = type === "test", duress = type === "contrainte";
  const ref = "SOS-" + (await U.nextRef("sos", "X")).split("-").pop().replace(/^0+/, "");
  const prot = s.protection_until && new Date(s.protection_until) > new Date();
  const r = await q(`INSERT INTO sos_incidents (ref, user_id, type, is_test, duress, battery, network, protection_mode, share_loc) VALUES (?,?,?,?,?,?,?,?,?)`,
    [ref, user.id, type, test ? 1 : 0, duress ? 1 : 0, o.battery != null ? Math.round(o.battery) : null, str(o.network, 20) || "4G", prot ? 1 : 0, s.share_loc]);
  const id = r.insertId;
  const contacts = await q("SELECT * FROM sos_contacts WHERE user_id = ? AND invitation = 'ACCEPTEE' ORDER BY priorite, id", [user.id]);
  for (const [i, c] of contacts.entries())
    await q("INSERT INTO sos_incident_contacts (incident_id, contact_id, position, prenom, nom, relation, tel, token) VALUES (?,?,?,?,?,?,?,?)", [id, c.id, i, c.prenom, c.nom, c.relation, c.tel, U.token()]);
  /* le réglage « partage de localisation » est respecté pour tous les types d'alerte */
  const loc = o.loc && isFinite(o.loc.lat) && s.share_loc ? o.loc : null;
  if (loc) await q("INSERT INTO sos_positions (incident_id, lat, lng, accuracy, source, commune) VALUES (?,?,?,?,?,?)", [id, loc.lat, loc.lng, Math.round(loc.acc || 0), str(loc.src, 20) || "GPS", str(loc.commune, 40)]);
  await ilog(id, `SOS déclenché — ${TRIG[type]}`);
  /* l'incident sous contrainte n'apparaît pas dans le journal visible de l'utilisateur */
  if (!duress) await U.activity(user.id, `Incident ${ref} · ${TRIG[type]}`);
  U.audit({ user, ip: null }, "SOS_TRIGGERED", "sos", ref, type);
  return ref;
}
router.post("/incidents", h(async (req, res) => {
  const type = req.body.type;
  if (!TRIG[type] || type === "contrainte") fail(400, "Type d’alerte invalide.");
  const s = await settings(req.user.id);
  if (!s.enabled && type !== "test") fail(409, "SOS désactivé. Activez-le dans Profil › SOS & Protection.");
  if (type === "test" && !(await one("SELECT id FROM sos_contacts WHERE user_id = ? AND invitation = 'ACCEPTEE' LIMIT 1", [req.user.id]))) fail(409, "Ajoutez et confirmez au moins un contact.");
  const rearm = +(await U.setting("sos_rearm_s", 30));
  if (type !== "test" && await one("SELECT id FROM sos_incidents WHERE user_id = ? AND is_test = 0 AND created_at > DATE_SUB(NOW(3), INTERVAL ? SECOND) LIMIT 1", [req.user.id, rearm])) fail(429, "Réarmement en cours : SOS déjà déclenché.");
  res.status(201).json({ ref: await createIncident(req.user, type, req.body) });
}));

async function incidentView(inc) {
  const [contacts, log, track] = await Promise.all([
    q("SELECT position, prenom, nom, relation rel, status st FROM sos_incident_contacts WHERE incident_id = ? ORDER BY position", [inc.id]),
    q("SELECT label l, created_at t FROM sos_events WHERE incident_id = ? ORDER BY id", [inc.id]),
    q("SELECT lat, lng, accuracy acc, source src, commune, created_at t FROM sos_positions WHERE incident_id = ? ORDER BY id", [inc.id])
  ]);
  return { id: inc.ref, type: inc.type, t: inc.created_at, st: inc.status, test: !!inc.is_test, duress: !!inc.duress, closed: !!inc.closed, bat: inc.battery, net: inc.network, prot: !!inc.protection_mode, cur: inc.cur, rev: inc.rev,
    contacts: contacts.map(c => ({ ...c, nom: `${c.prenom} ${c.nom}` })), log, track: track.map(p => ({ ...p, lat: +p.lat, lng: +p.lng })), loc: track.length ? { ...track[track.length - 1], lat: +track[track.length - 1].lat, lng: +track[track.length - 1].lng } : null };
}
const myIncident = async (req) => {
  const inc = await one("SELECT * FROM sos_incidents WHERE ref = ? AND user_id = ?", [req.params.ref, req.user.id]);
  if (!inc || (inc.duress && !inc.closed)) fail(404, "Alerte introuvable."); // un incident sous contrainte reste invisible
  return inc;
};
router.get("/incidents", h(async (req, res) => {
  const rows = await q("SELECT * FROM sos_incidents WHERE user_id = ? AND NOT (duress = 1 AND closed = 0) ORDER BY id DESC LIMIT 50", [req.user.id]);
  res.json({ items: rows.map(i => ({ id: i.ref, type: i.type, t: i.created_at, st: i.status, test: !!i.is_test, duress: !!i.duress, closed: !!i.closed })) });
}));
router.get("/incidents/:ref", h(async (req, res) => res.json({ incident: await incidentView(await myIncident(req)) })));
router.post("/incidents/:ref/position", h(async (req, res) => {
  const inc = await one("SELECT * FROM sos_incidents WHERE ref = ? AND user_id = ? AND closed = 0", [req.params.ref, req.user.id]);
  if (!inc || !inc.share_loc) return res.json({ ok: false });
  const p = req.body; if (!isFinite(p.lat) || !isFinite(p.lng)) fail(400, "Position invalide.");
  await q("INSERT INTO sos_positions (incident_id, lat, lng, accuracy, source, commune) VALUES (?,?,?,?,?,?)", [inc.id, p.lat, p.lng, Math.round(p.acc || 0), str(p.src, 20) || "GPS", str(p.commune, 40)]);
  await ilog(inc.id, `Nouvelle position reçue (${p.src || "GPS"}, ± ${Math.round(p.acc || 0)} m)`);
  res.json({ ok: true });
}));
async function endWithCode(req, res, finalSt, msg) {
  const inc = await myIncident(req);
  if (inc.closed) fail(409, "Alerte déjà terminée.");
  const k = await checkCode(req.user.id, req.body.code);
  if (!k) fail(401, "Code incorrect.");
  if (k === "duress") {
    /* code sous contrainte : l'alerte continue discrètement, l'écran affiche une fin normale */
    await q("UPDATE sos_incidents SET duress = 1 WHERE id = ?", [inc.id]);
    await ilog(inc.id, "Code sous contrainte saisi à l’annulation — l’alerte continue discrètement");
    return res.json({ ok: true, ended: true });
  }
  await ilog(inc.id, msg);
  await q("UPDATE sos_incidents SET status = ?, closed = 1, closed_at = NOW() WHERE id = ?", [finalSt, inc.id]);
  if (finalSt === "CLÔTURÉ") await ilog(inc.id, "Incident clôturé");
  await ilog(inc.id, "Contacts notifiés : « Alerte terminée — utilisateur déclaré en sécurité. »");
  const cs = await q("SELECT tel FROM sos_incident_contacts WHERE incident_id = ? AND status <> 'ATTENTE'", [inc.id]);
  for (const c of cs) await U.sms(c.tel, `ID SECOURS : alerte terminée — ${req.user.prenom} est déclaré(e) en sécurité.`);
  await U.activity(req.user.id, `Incident ${inc.ref} : ${finalSt}`);
  res.json({ ok: true, ended: true });
}
router.post("/incidents/:ref/cancel", h(async (req, res) => {
  const mot = str(req.body.motif, 60);
  await endWithCode(req, res, mot === "Fausse alerte" || mot === "Déclenchement accidentel" ? "FAUSSE_ALERTE" : "ANNULÉ", `SOS annulé par l’utilisateur${mot ? " — motif : " + mot : ""}`);
}));
router.post("/incidents/:ref/safe", h(async (req, res) => endWithCode(req, res, "CLÔTURÉ", "Situation résolue — utilisateur déclaré en sécurité")));

module.exports = router;
module.exports.publicAlert = pub;
