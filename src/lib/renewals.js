/* Renouvellements (Commercial §25–§28) : échéances J-30 / J-15 / J-7 / J-3 / aujourd'hui / expiré,
   message paramétrable (setting renew_message), relances automatiques et historique de chaque envoi */
const { q, one } = require("../config/db");
const U = require("./util");

const DAY = 86400000;
/* jours calendaires restants avant l'expiration (0 = expire aujourd'hui) */
const daysLeft = exp => Math.round((new Date(exp).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
const echeances = async () => String(await U.setting("renew_echeances", "30,15,7,3,0")).split(",").map(x => parseInt(x, 10)).filter(x => x >= 0).sort((a, b) => b - a);

/* libellé d'échéance (§26) : la plus petite échéance configurée encore atteinte */
function bucket(d, list) {
  if (d < 0) return { k: -1, l: "Expiré", c: "red" };
  if (d === 0) return { k: 0, l: "Aujourd’hui", c: "red" };
  const e = [...list].sort((a, b) => a - b).find(x => x > 0 && d <= x);
  return e == null ? null : { k: e, l: `Dans ${e} jours`, c: e <= 3 ? "red" : e <= 7 ? "orange" : "blue", d };
}

async function message(p) {
  const tpl = await U.setting("renew_message", "Bonjour {prenom}, votre abonnement ID SECOURS arrive à expiration le {date}.");
  return tpl.replace(/\{prenom\}/g, p.prenom || "").replace(/\{nom\}/g, p.nom || "").replace(/\{formule\}/g, p.label || "").replace(/\{date\}/g, U.fmtD(p.exp_at)).slice(0, 480);
}

/* envoi (notification + SMS) et inscription dans l'historique ; autoKey empêche les doublons automatiques */
async function send(p, { staffId = null, echeance = null, autoKey = null, campaignRef = null } = {}) {
  const body = await message(p);
  if (autoKey) {
    const r = await q("INSERT IGNORE INTO renewal_reminders (protection_id, user_id, echeance, channel, message, result, auto_key) VALUES (?,?,?,?,?,?,?)",
      [p.id, p.user_id, echeance, "Notification + SMS", body, "En cours", autoKey]);
    if (!r.affectedRows) return false;
    await deliver(p, body);
    await q("UPDATE renewal_reminders SET result = ? WHERE id = ?", [p.tel ? "Envoyé" : "Notification seule (pas de numéro)", r.insertId]);
    return true;
  }
  await deliver(p, body);
  await q("INSERT INTO renewal_reminders (protection_id, user_id, echeance, channel, campaign_ref, message, result, staff_id) VALUES (?,?,?,?,?,?,?,?)",
    [p.id, p.user_id, echeance, "Notification + SMS", campaignRef, body, p.tel ? "Envoyé" : "Notification seule (pas de numéro)", staffId]);
  return true;
}
async function deliver(p, body) {
  await U.notify(p.user_id, "Pensez à renouveler votre protection", body, "protections");
  if (p.tel) await U.sms(p.tel, `ID SECOURS : ${body}`);
}

const PROT_SQL = `SELECT p.id, p.user_id, p.label, p.exp_at, u.prenom, u.nom, u.tel FROM protections p JOIN users u ON u.id = p.user_id`;

/* relances automatiques : une seule par protection, par échéance et par date d'expiration */
async function autoTick() {
  if ((await U.setting("renew_auto", "1")) !== "1") return 0;
  const list = await echeances(); if (!list.length) return 0;
  const rows = await q(`${PROT_SQL} WHERE p.suspended = 0 AND p.exp_at >= CURDATE() AND p.exp_at < DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [Math.max(...list) + 1]);
  let n = 0;
  for (const p of rows) {
    const b = bucket(daysLeft(p.exp_at), list); if (!b || b.k < 0 || !list.includes(b.k)) continue;
    if (await send(p, { echeance: b.k, autoKey: `${p.id}:${b.k}:${new Date(p.exp_at).toISOString().slice(0, 10)}` })) n++;
  }
  if (n) U.audit(null, "RENEWAL_AUTO", "protection", null, `${n} relance(s) automatique(s)`);
  return n;
}

/* statut de portefeuille (Commercial §17) */
const portfolio = (active, total) => active > 0 ? "CLIENT" : total > 0 ? "ANCIEN_CLIENT" : "PROSPECT";
const PORTFOLIO_SQL = `(SELECT CASE WHEN SUM(p.exp_at > NOW() AND p.suspended = 0) > 0 THEN 'CLIENT' WHEN COUNT(*) > 0 THEN 'ANCIEN_CLIENT' ELSE 'PROSPECT' END FROM protections p WHERE p.user_id = u.id)`;

module.exports = { daysLeft, echeances, bucket, message, send, autoTick, portfolio, PORTFOLIO_SQL, PROT_SQL };
