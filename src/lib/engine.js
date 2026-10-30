/* Moteurs de fond : chaîne d'alerte SOS (cahier SOS §18–§35) et simulation de l'intégration partenaires de collecte */
const { q, one } = require("../config/db");
const U = require("./util");

const TRIG = { immediat: "SOS immédiat (bouton)", invisible: "SOS invisible (boutons physiques)", taps: "SOS invisible (tapotements)", vocal: "Code vocal (Mode Protection)", bluetooth: "Déclencheur Bluetooth", contrainte: "Code sous contrainte", test: "Test du SOS", silence: "Mode Protection · téléphone injoignable" };

async function ilog(incId, label) {
  await q("INSERT INTO sos_events (incident_id, label) VALUES (?,?)", [incId, label]);
  await q("UPDATE sos_incidents SET rev = rev + 1 WHERE id = ?", [incId]);
}
const alertLink = token => `${process.env.PUBLIC_WEB_URL || "http://localhost:5173"}/alerte/${token}`;

async function alertNext(inc) {
  const cs = await q("SELECT * FROM sos_incident_contacts WHERE incident_id = ? ORDER BY position", [inc.id]);
  const user = await one("SELECT prenom, nom FROM users WHERE id = ?", [inc.user_id]);
  let i = inc.cur + 1;
  while (i < cs.length && ["REFUSEE", "EXPIREE"].includes(cs[i].status)) i++;
  if (i >= cs.length) {
    if (!inc.fallback) {
      await q("UPDATE sos_incidents SET fallback = 1 WHERE id = ?", [inc.id]);
      const contacts = await q("SELECT tel FROM sos_contacts WHERE user_id = ?", [inc.user_id]);
      for (const c of contacts) await U.sms(c.tel, `ALERTE ID SECOURS : ${user.prenom} ${user.nom} a déclenché une alerte d’urgence. Essayez de le/la joindre.`);
      await ilog(inc.id, cs.length ? "Aucun contact disponible — canaux de repli autorisés : SMS de secours envoyé" : "Aucun contact confirmé — SMS de secours envoyé");
    }
    return;
  }
  const c = cs[i];
  await q("UPDATE sos_incidents SET cur = ?, alert_at = NOW(3) WHERE id = ?", [i, inc.id]);
  await q("UPDATE sos_incident_contacts SET status = 'ENVOYEE', status_at = NOW(3) WHERE id = ?", [c.id]);
  await U.sms(c.tel, `${inc.is_test ? "TEST ID SECOURS — aucune urgence réelle. " : "ALERTE SOS ID SECOURS : "}${user.prenom} ${user.nom} ${inc.is_test ? "teste son alerte" : "a déclenché une alerte d’urgence"}. ${alertLink(c.token)}`);
  await ilog(inc.id, `Contact ${i + 1} alerté — ${c.prenom} (${c.relation})${inc.duress ? " · mention contrainte" : ""}${inc.is_test ? " · TEST" : ""}`);
}

async function sosTick() {
  const open = await q("SELECT *, TIMESTAMPDIFF(MICROSECOND, created_at, NOW(3)) / 1000 AS el FROM sos_incidents WHERE closed = 0");
  for (const inc of open) {
    const el = +inc.el;
    if (inc.status === "CRÉÉ" && el > 600) { await q("UPDATE sos_incidents SET status = 'DÉCLENCHÉ' WHERE id = ?", [inc.id]); await ilog(inc.id, `Incident #${inc.ref} créé`); }
    else if (inc.status === "DÉCLENCHÉ" && el > 1600) {
      const pos = await one("SELECT accuracy, source FROM sos_positions WHERE incident_id = ? ORDER BY id DESC LIMIT 1", [inc.id]);
      await ilog(inc.id, !pos ? "Position non partagée (paramètre)" : pos.source === "Dernière connue" ? `Dernière position connue transmise (non actuelle) — précision ${pos.accuracy} m` : `${pos.source === "GPS" ? "GPS obtenu" : "Position obtenue (" + pos.source + ")"} — précision ${pos.accuracy} m`);
      await q("UPDATE sos_incidents SET status = 'TRANSMISSION_EN_COURS' WHERE id = ?", [inc.id]);
    } else if (inc.status === "TRANSMISSION_EN_COURS" && el > 2600) {
      await ilog(inc.id, "Incident transmis au serveur ID SECOURS");
      await q("UPDATE sos_incidents SET status = 'ALERTES_ENVOYÉES' WHERE id = ?", [inc.id]);
      await alertNext(inc);
    } else if (["ALERTES_ENVOYÉES", "ESCALADE"].includes(inc.status)) {
      if (inc.is_test) {
        const cs = await q("SELECT * FROM sos_incident_contacts WHERE incident_id = ? AND status IN ('ATTENTE','ENVOYEE')", [inc.id]);
        for (const c of cs) { await q("UPDATE sos_incident_contacts SET status = 'TEST_OK' WHERE id = ?", [c.id]); await ilog(inc.id, `${c.prenom} a reçu l’alerte de test`); }
        await q("UPDATE sos_incidents SET status = 'CLÔTURÉ', closed = 1, closed_at = NOW() WHERE id = ?", [inc.id]);
        await ilog(inc.id, "Test terminé — aucune urgence réelle");
        await U.notify(inc.user_id, "Test SOS réussi", `${cs.length} contact(s) ont reçu l’alerte TEST.`, "incident|" + inc.ref);
        continue;
      }
      const c = await one("SELECT *, TIMESTAMPDIFF(MICROSECOND, status_at, NOW(3)) / 1000 AS age FROM sos_incident_contacts WHERE incident_id = ? AND position = ?", [inc.id, inc.cur]);
      if (!c) continue;
      if (c.status === "ENVOYEE" && +c.age > 1000) { await q("UPDATE sos_incident_contacts SET status = 'LIVREE' WHERE id = ?", [c.id]); await ilog(inc.id, `Notification livrée à ${c.prenom}`); }
      const s = await one("SELECT ack_timeout FROM sos_settings WHERE user_id = ?", [inc.user_id]);
      const waited = await one("SELECT TIMESTAMPDIFF(SECOND, alert_at, NOW(3)) s FROM sos_incidents WHERE id = ?", [inc.id]);
      if (["ENVOYEE", "LIVREE", "OUVERTE"].includes(c.status) && waited.s > (s ? s.ack_timeout : 60)) {
        await q("UPDATE sos_incident_contacts SET status = 'EXPIREE', status_at = NOW(3) WHERE id = ?", [c.id]);
        await q("UPDATE sos_incidents SET status = 'ESCALADE' WHERE id = ?", [inc.id]);
        await ilog(inc.id, `${c.prenom} : aucune prise en charge après ${s ? s.ack_timeout : 60} s — escalade`);
        await alertNext(await one("SELECT * FROM sos_incidents WHERE id = ?", [inc.id]));
      }
    }
  }
}

/* transmission de la mission au portail du livreur (② déploiement d'un livreur) ; la suite est faite par le livreur */
async function collectTick() {
  const rows = await q("SELECT f.id, f.reporter_user_id, f.ref, f.mission_ref, p.nom pnom FROM found_reports f JOIN partners p ON p.id = f.partner_id WHERE f.step = 2 AND f.cancelled_at IS NULL AND TIMESTAMPDIFF(SECOND, f.step_at, NOW()) >= 3");
  for (const f of rows) {
    await q("UPDATE found_reports SET step = 3, step_at = NOW() WHERE id = ? AND step = 2", [f.id]);
    await U.notify(f.reporter_user_id, "Mission transmise au livreur", `${f.pnom} a reçu la mission ${f.mission_ref}.`, "collecte|" + f.ref);
  }
}

/* Mode Protection (SOS §12) : sans signal du téléphone pendant le délai configuré, le serveur déclenche
   lui-même l'alerte avec la dernière position connue (téléphone éteint, batterie vide, réseau coupé) */
async function protectionTick() {
  const silence = +(await U.setting("sos_protection_silence_s", 300));
  const rows = await q(`SELECT s.*, u.prenom, u.nom FROM sos_settings s JOIN users u ON u.id = s.user_id
    WHERE s.enabled = 1 AND s.protection_until > NOW() AND s.prot_beat_at < DATE_SUB(NOW(), INTERVAL ? SECOND)`, [silence]);
  for (const s of rows) {
    /* une seule alerte par session : le mode est arrêté avant de créer l'incident */
    const r = await q("UPDATE sos_settings SET protection_until = NULL WHERE user_id = ? AND protection_until IS NOT NULL", [s.user_id]);
    if (!r.affectedRows) continue;
    const ref = await require("../routes/sos").createIncident({ id: s.user_id, prenom: s.prenom, nom: s.nom }, "silence", { battery: s.prot_battery, network: "Injoignable" });
    const inc = await one("SELECT id FROM sos_incidents WHERE ref = ?", [ref]);
    const beat = new Date(s.prot_beat_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    if (s.share_loc && s.prot_lat != null)
      await q("INSERT INTO sos_positions (incident_id, lat, lng, accuracy, source, commune, created_at) VALUES (?,?,?,?,?,?,?)", [inc.id, s.prot_lat, s.prot_lng, s.prot_acc || 0, "Dernière connue", s.prot_commune, s.prot_beat_at]);
    await ilog(inc.id, `Aucun signal du téléphone depuis ${beat} (${Math.round(silence / 60)} min) — alerte déclenchée par le serveur${s.prot_lat != null ? " avec la dernière position connue de " + beat : ""}`);
    await U.activity(s.user_id, `Mode Protection : téléphone injoignable depuis ${beat}, alerte ${ref} déclenchée`);
  }
}

let busy = false, protAt = 0;
function start() {
  const alerts = require("./alerts");
  const runAlerts = () => alerts.tick().catch(e => console.error("[alertes]", e.message));
  setTimeout(runAlerts, 5000); setInterval(runAlerts, 60000);
  /* sauvegarde automatique (périodicité : paramètre backup_auto_h) */
  const runBackup = () => require("./backup").autoTick().catch(e => console.error("[sauvegarde]", e.message));
  setTimeout(runBackup, 30000); setInterval(runBackup, 600000);
  /* relances de renouvellement automatiques (Commercial §25–§27) */
  const runRenew = () => require("./renewals").autoTick().catch(e => console.error("[relances]", e.message));
  setTimeout(runRenew, 20000); setInterval(runRenew, 600000);
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await sosTick(); await collectTick(); if (Date.now() - protAt > 10000) { protAt = Date.now(); await protectionTick(); } } catch (e) { console.error("[engine]", e.message); } finally { busy = false; }
  }, 1000);
}

module.exports = { start, ilog, alertNext, TRIG };
