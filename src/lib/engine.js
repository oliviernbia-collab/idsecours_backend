/* Moteurs de fond : chaîne d'alerte SOS (cahier SOS §18–§35) et simulation de l'intégration partenaires de collecte */
const { q, one } = require("../config/db");
const U = require("./util");

const TRIG = { immediat: "SOS immédiat (bouton)", invisible: "SOS invisible (boutons physiques)", taps: "SOS invisible (tapotements)", vocal: "Code vocal (Mode Protection)", bluetooth: "Déclencheur Bluetooth", contrainte: "Code sous contrainte", test: "Test du SOS" };

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
      const pos = await one("SELECT accuracy FROM sos_positions WHERE incident_id = ? ORDER BY id DESC LIMIT 1", [inc.id]);
      await ilog(inc.id, pos ? `GPS obtenu — précision ${pos.accuracy} m` : "Position non partagée (paramètre)");
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
  const rows = await q("SELECT f.id, f.reporter_user_id, f.ref, f.mission_ref, p.nom pnom FROM found_reports f JOIN partners p ON p.id = f.partner_id WHERE f.step = 2 AND TIMESTAMPDIFF(SECOND, f.step_at, NOW()) >= 3");
  for (const f of rows) {
    await q("UPDATE found_reports SET step = 3, step_at = NOW() WHERE id = ? AND step = 2", [f.id]);
    await U.notify(f.reporter_user_id, "Mission transmise au livreur", `${f.pnom} a reçu la mission ${f.mission_ref}.`, "collecte|" + f.ref);
  }
}

let busy = false;
function start() {
  const alerts = require("./alerts");
  const runAlerts = () => alerts.tick().catch(e => console.error("[alertes]", e.message));
  setTimeout(runAlerts, 5000); setInterval(runAlerts, 60000);
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await sosTick(); await collectTick(); } catch (e) { console.error("[engine]", e.message); } finally { busy = false; }
  }, 1000);
}

module.exports = { start, ilog, alertNext, TRIG };
