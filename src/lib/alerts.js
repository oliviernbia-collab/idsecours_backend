/* Alertes automatiques du back-office : chaque règle produit une notification interne (dédoublonnée)
   adressée aux agents détenant l'une des permissions ciblées ; elle se résout d'elle-même quand la situation est réglée. */
const { q } = require("../config/db");
const U = require("./util");

/* notification ponctuelle (ex. incident critique créé) */
async function push(key, perms, title, body, link, priority = "NORMALE") {
  await q("INSERT IGNORE INTO staff_notifications (dedupe_key, perms, title, body, link, priority) VALUES (?,?,?,?,?,?)", [key, perms.join(","), title, body.slice(0, 500), link, priority]);
}

const RULES = [
  { id: "collect", perms: ["collectes.manage", "performance.view"], link: "founds", title: "Collecte en retard",
    sql: h => [`SELECT ref k, CONCAT('Signalement ', ref, ' · ', COALESCE(commune,'—'), ' · en attente depuis ', TIMESTAMPDIFF(HOUR, created_at, NOW()), ' h') b FROM found_reports WHERE step BETWEEN 1 AND 4 AND created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`, [h.alert_collect_h]] },
  { id: "transit", perms: ["reception.manage", "collectes.manage"], link: "reception", title: "Document collecté non reçu en agence", priority: "HAUTE",
    sql: h => [`SELECT ref k, CONCAT('Mission ', mission_ref, ' · collecté il y a ', TIMESTAMPDIFF(HOUR, handed_at, NOW()), ' h, toujours pas réceptionné') b FROM found_reports WHERE step = 5 AND handed_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`, [h.alert_transit_h]] },
  { id: "control", perms: ["foundcheck.manage", "performance.view"], link: "found-checks", title: "Contrôle de document hors délai",
    sql: h => [`SELECT reception_ref k, CONCAT(reception_ref, ' · à contrôler depuis ', TIMESTAMPDIFF(HOUR, received_at, NOW()), ' h') b FROM held_documents WHERE status = 'A_CONTROLER' AND received_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`, [h.alert_control_h]] },
  { id: "verif", perms: ["verification.manage", "performance.view"], link: "verifications", title: "Vérification du propriétaire hors délai",
    sql: h => [`SELECT ref k, CONCAT('Dossier ', ref, ' · en vérification depuis ', TIMESTAMPDIFF(HOUR, created_at, NOW()), ' h') b FROM recoveries WHERE verif_status = 'EN VÉRIFICATION' AND done_at IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`, [h.alert_verif_h]] },
  { id: "return", perms: ["restitution.manage", "performance.view"], link: "restitutions", title: "Document en attente de retour partenaire", priority: "HAUTE",
    sql: h => [`SELECT ref k, CONCAT('Livraison ', ref, ' · échec depuis ', TIMESTAMPDIFF(HOUR, fail_at, NOW()), ' h : ', COALESCE(fail_reason,'')) b FROM deliveries WHERE status IN ('ECHEC','REMISE_BLOQUEE') AND fail_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`, [h.alert_return_h]] },
  { id: "payment", perms: ["finance.view"], link: "finance", title: "Paiement en attente anormalement long",
    sql: h => [`SELECT ref k, CONCAT(ref, ' · ', label, ' · en attente depuis ', TIMESTAMPDIFF(MINUTE, created_at, NOW()), ' min') b FROM payments WHERE status = 'EN ATTENTE' AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [h.payment_pending_alert_min]] },
  { id: "gap", perms: ["finance.view"], link: "finance", title: "Écart de rapprochement",
    sql: () => ["SELECT ref k, CONCAT(ref, ' · ', type) b FROM finance_gaps WHERE status = 'NOUVEAU'", []] },
  { id: "sos", perms: ["sos.monitor", "staff.manage"], link: "sos", title: "Alerte SOS non prise en charge", priority: "CRITIQUE",
    sql: h => [`SELECT ref k, CONCAT('#', ref, ' · déclenchée il y a ', TIMESTAMPDIFF(MINUTE, created_at, NOW()), ' min, aucun contact n’a pris en charge') b FROM sos_incidents
      WHERE closed = 0 AND is_test = 0 AND status NOT IN ('PRIS_EN_CHARGE','INTERVENTION_EN_COURS') AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [h.alert_sos_min]] },
  { id: "incident", perms: ["incidents.manage", "staff.manage"], link: "incidents", title: "Incident critique ouvert", priority: "CRITIQUE",
    sql: () => ["SELECT ref k, CONCAT(ref, ' · ', titre) b FROM ops_incidents WHERE priorite = 'CRITIQUE' AND statut IN ('OUVERT','EN COURS')", []] }
];

async function tick() {
  const s = Object.fromEntries((await q("SELECT k, v FROM settings WHERE k LIKE 'alert_%' OR k = 'payment_pending_alert_min'")).map(x => [x.k, +x.v]));
  for (const r of RULES) {
    const [sql, params] = r.sql(s);
    const rows = await q(sql, params);
    const keys = rows.map(x => `${r.id}:${x.k}`);
    for (const x of rows) await push(`${r.id}:${x.k}`, r.perms, r.title, x.b, r.link, r.priority || "NORMALE");
    /* résolution automatique des alertes devenues sans objet */
    await q(`UPDATE staff_notifications SET resolved = 1 WHERE resolved = 0 AND dedupe_key LIKE ? ${keys.length ? "AND dedupe_key NOT IN (?)" : ""}`, keys.length ? [r.id + ":%", keys] : [r.id + ":%"]);
  }
}

module.exports = { tick, push };
