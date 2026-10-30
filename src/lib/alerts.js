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
  { id: "sla", perms: ["collectes.manage", "performance.view"], link: "partners", title: "SLA partenaire dépassé", priority: "HAUTE",
    sql: () => ["SELECT f.ref k, CONCAT(p.nom, ' · mission ', f.mission_ref, ' · affectée il y a ', TIMESTAMPDIFF(HOUR, f.assigned_at, NOW()), ' h (délai convenu ', p.sla_collecte_h, ' h)') b FROM found_reports f JOIN partners p ON p.id = f.partner_id WHERE f.step BETWEEN 2 AND 4 AND f.assigned_at < DATE_SUB(NOW(), INTERVAL p.sla_collecte_h HOUR)", []] },
  { id: "contrat", perms: ["partners.manage", "collectes.manage"], link: "partners", title: "Contrat partenaire expiré ou expirant",
    sql: () => ["SELECT id k, CONCAT(nom, ' · fin de contrat le ', DATE_FORMAT(contrat_fin, '%d/%m/%Y')) b FROM partners WHERE status = 'ACTIF' AND contrat_fin IS NOT NULL AND contrat_fin < DATE_ADD(CURDATE(), INTERVAL 15 DAY)", []] },
  { id: "cash", perms: ["finance.view"], link: "cash", title: "Clôture de caisse à contrôler",
    sql: () => ["SELECT c.ref k, CONCAT(c.ref, ' · ', a.nom, ' · écart ', COALESCE(c.ecart, 0), ' FCFA') b FROM cash_sessions c JOIN agencies a ON a.id = c.agency_id WHERE c.status IN ('A_CONTROLER','ECART_A_JUSTIFIER')", []] },
  { id: "trf", perms: ["stock.transfer.authorize"], link: "stock-ops", title: "Transfert entre agences à autoriser",
    sql: () => ["SELECT t.ref k, CONCAT(t.ref, ' · ', h.reception_ref, ' · ', t.motif) b FROM stock_transfers t JOIN held_documents h ON h.id = t.held_id WHERE t.status = 'DEMANDE'", []] },
  { id: "transit48", perms: ["reception.manage", "performance.view"], link: "stock-ops", title: "Document en transit entre agences depuis plus de 48 h", priority: "HAUTE",
    sql: () => ["SELECT ref k, CONCAT(ref, ' · parti le ', DATE_FORMAT(sent_at, '%d/%m %H:%i'), ', non réceptionné') b FROM stock_transfers WHERE status = 'EN_TRANSIT' AND sent_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)", []] },
  { id: "cmp", perms: ["campaigns.validate"], link: "campaigns", title: "Campagne commerciale à valider",
    sql: () => ["SELECT ref k, CONCAT(ref, ' · ', nom) b FROM campaigns WHERE statut = 'A_VALIDER'", []] },
  { id: "opp", perms: ["prospects.manage"], link: "opportunities", title: "Opportunité sans activité depuis 10 jours",
    sql: () => ["SELECT ref k, CONCAT(ref, ' · ', titre) b FROM opportunities WHERE statut NOT IN ('CONVERTI','PERDU') AND updated_at < DATE_SUB(NOW(), INTERVAL 10 DAY)", []] },
  { id: "prospect", perms: ["prospects.manage"], link: "commercial", title: "Prospect non contacté depuis 48 h",
    sql: () => ["SELECT id k, CONCAT(nom, COALESCE(CONCAT(' · ', tel), '')) b FROM prospects WHERE statut = 'NOUVEAU' AND created_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)", []] },
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
