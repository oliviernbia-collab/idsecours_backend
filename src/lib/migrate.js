/* Migrations idempotentes (exécutées au démarrage de l'API et par db:init) — alignement sur l'organigramme */
const bcrypt = require("bcryptjs");
const { q, one } = require("../config/db");

async function addCol(table, col, def) {
  const r = await one("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, col]);
  if (!r.n) await q(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

const NEW_PERMS = [
  ["performance.view", "Opérations", "Suivre les performances des services, agences et partenaires"],
  ["system.view", "Support", "Surveiller et maintenir le système"],
  ["foundcheck.manage", "Vérification & Contrôle", "Contrôler l’authenticité des documents collectés et identifier le propriétaire"],
  ["billing.view", "Finance", "Émettre les factures"]
];
const GRANTS = {
  SUPER_ADMIN: ["performance.view", "system.view", "foundcheck.manage", "billing.view"],
  DIRECTION: ["performance.view", "billing.view"],
  OPERATIONS: ["performance.view"],
  FINANCE: ["billing.view"],
  SUPPORT: ["system.view"],
  VERIFICATION: ["foundcheck.manage"],
  COMMERCIAL: ["support.messages"] // « Support aux utilisateurs » (organigramme)
};

async function migrate() {
  /* circuit du document : Collecte → Vérification & Contrôle → Réception & Restitution */
  await addCol("found_reports", "courier_enroute_at", "DATETIME NULL");
  await addCol("found_reports", "deposit_at", "DATETIME NULL");
  await addCol("found_reports", "deposit_by", "INT NULL");
  await addCol("found_reports", "verif_status", "VARCHAR(20) NULL");
  await addCol("found_reports", "verif_by", "INT NULL");
  await addCol("found_reports", "verif_at", "DATETIME NULL");
  await addCol("found_reports", "verif_note", "VARCHAR(255) NULL");
  await addCol("partners", "pin_hash", "VARCHAR(100) NULL");
  await addCol("ops_incidents", "agency_id", "INT NULL");
  await q(`CREATE TABLE IF NOT EXISTS com_partners (
    id INT AUTO_INCREMENT PRIMARY KEY, nom VARCHAR(120) NOT NULL, type VARCHAR(40) NOT NULL DEFAULT 'Revendeur',
    contact VARCHAR(80), tel VARCHAR(30), email VARCHAR(120), commission DECIMAL(5,2) NOT NULL DEFAULT 0,
    statut ENUM('PROSPECT','ACTIF','SUSPENDU','TERMINÉ') NOT NULL DEFAULT 'PROSPECT', notes VARCHAR(500), staff_id INT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* étapes : l'ancienne étape 6 « reçu » devient 8 (deux étapes insérées : dépôt Collecte, contrôle Vérification) */
  if (!(await one("SELECT v FROM settings WHERE k = 'migr_steps_v2'"))) {
    await q("UPDATE found_reports SET step = 8, verif_status = 'AUTHENTIQUE' WHERE step = 6");
    await q("INSERT INTO settings (k, v) VALUES ('migr_steps_v2', '1')");
  }

  /* v3 — ordre du cahier des charges : livreur → Réception (double confirmation) → Vérification → Réception restitue.
     Un document reçu reste « À CONTRÔLER » (ni recherchable ni restituable) jusqu'à la décision de Vérification & Contrôle. */
  await q("ALTER TABLE held_documents MODIFY COLUMN status ENUM('A_CONTROLER','RECU','CONSERVE','QUARANTAINE','EN_RESTITUTION','RESTITUE','TRANSFERE') NOT NULL DEFAULT 'A_CONTROLER'");
  await addCol("held_documents", "verif_by", "INT NULL");
  await addCol("held_documents", "verif_at", "DATETIME NULL");
  await addCol("held_documents", "verif_note", "VARCHAR(255) NULL");
  await addCol("held_documents", "anomalie", "VARCHAR(60) NULL");
  if (!(await one("SELECT v FROM settings WHERE k = 'migr_steps_v3'"))) {
    await q("UPDATE found_reports SET step = 5, verif_status = NULL WHERE step IN (6, 7)"); // remis au livreur, en attente de réception physique
    await q("INSERT INTO settings (k, v) VALUES ('migr_steps_v3', '1')");
  }
  /* livraison au propriétaire (Collecte §31–§47) */
  await q(`CREATE TABLE IF NOT EXISTS deliveries (
    id INT AUTO_INCREMENT PRIMARY KEY, ref VARCHAR(30) NOT NULL UNIQUE, recovery_id INT NOT NULL, held_id INT NOT NULL, user_id INT,
    status ENUM('ATTENTE_PAIEMENT','A_PLANIFIER','PLANIFIEE','EN_LIVRAISON','LIVREE','REMISE_BLOQUEE','ECHEC','RETOURNEE','ANNULEE') NOT NULL DEFAULT 'A_PLANIFIER',
    included TINYINT(1) NOT NULL DEFAULT 0, commune VARCHAR(40), lat DECIMAL(9,6), lng DECIMAL(9,6), repere VARCHAR(160), slot VARCHAR(60),
    partner_id INT, external_ref VARCHAR(40), planned_by INT, planned_at DATETIME, out_by INT, out_at DATETIME,
    delivered_at DATETIME, method VARCHAR(40), otp_fails INT NOT NULL DEFAULT 0, fail_reason VARCHAR(255), fail_at DATETIME,
    return_by INT, return_at DATETIME, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (recovery_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q("INSERT IGNORE INTO sequences (k, v) VALUES ('liv', 144)");

  /* correspondances (Vérification §17–§21) : identité visible relevée au contrôle, règles pondérées versionnées */
  await addCol("held_documents", "dob", "DATE NULL");
  await addCol("held_documents", "date_exp", "DATE NULL");
  await addCol("recoveries", "multi_resolved", "TINYINT(1) NOT NULL DEFAULT 0");
  await addCol("recoveries", "match_pct", "INT NULL");
  for (const [k, v] of Object.entries(require("./match").DEFAULTS)) await q("INSERT IGNORE INTO settings (k, v) VALUES (?,?)", [k, String(v)]);
  await q("INSERT IGNORE INTO settings (k, v) VALUES ('match_rules_version', '1')");

  /* photos de réception (Réception §22–§24) et preuve de restitution (§54–§55) */
  await addCol("held_documents", "photo_recto", "VARCHAR(255) NULL");
  await addCol("held_documents", "photo_verso", "VARCHAR(255) NULL");
  await addCol("held_documents", "photo_anomalie", "VARCHAR(255) NULL");
  await addCol("held_documents", "etat_observation", "VARCHAR(255) NULL");
  await addCol("recoveries", "proof_ref", "VARCHAR(30) NULL");
  await addCol("recoveries", "proof_mode", "VARCHAR(80) NULL");
  await addCol("recoveries", "signature", "VARCHAR(255) NULL");
  await q("INSERT IGNORE INTO sequences (k, v) VALUES ('res', 500)");
  await q("INSERT IGNORE INTO settings (k, v) VALUES ('reception_photos_obligatoires', '1')");

  /* finance (Finance §26–§38) : remboursements à double validation, rapprochements, écarts */
  await q(`CREATE TABLE IF NOT EXISTS refunds (
    id INT AUTO_INCREMENT PRIMARY KEY, ref VARCHAR(30) NOT NULL UNIQUE, payment_id INT NOT NULL, amount_original INT NOT NULL, amount INT NOT NULL,
    motif VARCHAR(500) NOT NULL, justificatif VARCHAR(255), status VARCHAR(40) NOT NULL DEFAULT 'EN ATTENTE D’ANALYSE',
    requested_by INT NOT NULL, validated_by INT, validated_at DATETIME, admin_by INT, admin_at DATETIME, decided_note VARCHAR(500),
    provider_ref VARCHAR(40), done_at DATETIME, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS refund_steps (id INT AUTO_INCREMENT PRIMARY KEY, refund_id INT NOT NULL, label VARCHAR(255) NOT NULL, staff_id INT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (refund_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS reconciliations (id INT AUTO_INCREMENT PRIMARY KEY, ref VARCHAR(30) NOT NULL UNIQUE, source VARCHAR(10) NOT NULL,
    date_from DATE, date_to DATE, lines_total INT NOT NULL DEFAULT 0, matched INT NOT NULL DEFAULT 0, pending INT NOT NULL DEFAULT 0, gaps INT NOT NULL DEFAULT 0,
    staff_id INT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS reconciliation_lines (id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, ext_ref VARCHAR(60), ids_ref VARCHAR(30),
    ext_amount INT, ext_date DATE, ext_status VARCHAR(30), payment_id INT, status ENUM('RAPPROCHÉ','À RAPPROCHER','ÉCART') NOT NULL, diff INT NOT NULL DEFAULT 0,
    note VARCHAR(255), INDEX (batch_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS finance_gaps (id INT AUTO_INCREMENT PRIMARY KEY, ref VARCHAR(30) NOT NULL UNIQUE, type VARCHAR(80) NOT NULL,
    payment_id INT, line_id INT, batch_id INT, amount_diff INT NOT NULL DEFAULT 0, status ENUM('NOUVEAU','EN ANALYSE','JUSTIFIÉ','CORRIGÉ','ESCALADÉ','CLÔTURÉ') NOT NULL DEFAULT 'NOUVEAU',
    note VARCHAR(500), closed_reason VARCHAR(500), updated_by INT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await addCol("payments", "reconciled", "VARCHAR(20) NULL");
  await addCol("payments", "refunded_amount", "INT NOT NULL DEFAULT 0");
  await addCol("payments", "provider_ref", "VARCHAR(60) NULL");
  for (const [k, v] of [["rmb", 100], ["rap", 10], ["eca", 10]]) await q("INSERT IGNORE INTO sequences (k, v) VALUES (?,?)", [k, v]);
  await q("INSERT IGNORE INTO settings (k, v) VALUES ('refund_double_seuil', '5000')");
  await q("INSERT IGNORE INTO settings (k, v) VALUES ('payment_pending_alert_min', '15')");

  /* responsable financier : valide les remboursements préparés par l'agent Finance (§29) */
  if (!(await one("SELECT id FROM staff WHERE email = 'finance2@idsecours.ci'"))) {
    const r = await one("SELECT id FROM roles WHERE code = 'FINANCE'");
    if (r) await q("INSERT INTO staff (prenom, nom, email, tel, password_hash, role_id) VALUES ('Koné', 'Adama', 'finance2@idsecours.ci', '0700000010', ?, ?)", [await bcrypt.hash("Admin@2026", 10), r.id]);
  }

  /* notifications internes et alertes automatiques (DO18–DO20, DF23, SA21, Collecte §47) */
  await q(`CREATE TABLE IF NOT EXISTS staff_notifications (id INT AUTO_INCREMENT PRIMARY KEY, dedupe_key VARCHAR(80) UNIQUE, perms VARCHAR(255) NOT NULL,
    title VARCHAR(160) NOT NULL, body VARCHAR(500) NOT NULL, link VARCHAR(80), priority ENUM('NORMALE','HAUTE','CRITIQUE') NOT NULL DEFAULT 'NORMALE',
    resolved TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (resolved)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS staff_notification_reads (notification_id INT NOT NULL, staff_id INT NOT NULL, read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (notification_id, staff_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const [k, v] of [["alert_collect_h", 24], ["alert_transit_h", 6], ["alert_control_h", 24], ["alert_verif_h", 48], ["alert_return_h", 24], ["alert_sos_min", 5]]) await q("INSERT IGNORE INTO settings (k, v) VALUES (?,?)", [k, String(v)]);

  /* souscription assistée (Commercial §13–§14) : compte « à activer » par l'utilisateur lui-même */
  await q("ALTER TABLE users MODIFY COLUMN status ENUM('ACTIF','SUSPENDU','A_ACTIVER') NOT NULL DEFAULT 'ACTIF'");
  await addCol("users", "acquisition_source", "VARCHAR(40) NULL");
  /* profil des agents : photo, changement de mot de passe, révocation des sessions ouvertes */
  await addCol("staff", "photo", "VARCHAR(255) NULL");
  await addCol("staff", "pw_changed_at", "DATETIME NULL");
  await addCol("staff", "sessions_revoked_at", "DATETIME NULL");
  await addCol("users", "created_by_staff", "INT NULL");
  await addCol("users", "formule_souhaitee", "VARCHAR(20) NULL");
  await addCol("prospects", "user_id", "INT NULL");

  /* téléphones des agents (OTP de connexion) */
  const tels = { "admin@idsecours.ci": "0700000001", "direction@idsecours.ci": "0700000002", "finance@idsecours.ci": "0700000003", "operations@idsecours.ci": "0700000004", "commercial@idsecours.ci": "0700000005", "support@idsecours.ci": "0700000006", "collecte@idsecours.ci": "0700000007", "verification@idsecours.ci": "0700000008", "reception@idsecours.ci": "0700000009" };
  for (const [e, t] of Object.entries(tels)) await q("UPDATE staff SET tel = ? WHERE email = ? AND tel IS NULL", [t, e]);

  for (const [code, module, label] of NEW_PERMS) await q("INSERT IGNORE INTO permissions (code, module, label) VALUES (?,?,?)", [code, module, label]);
  for (const [role, perms] of Object.entries(GRANTS))
    for (const p of perms) await q("INSERT IGNORE INTO role_permissions (role_id, perm_code) SELECT id, ? FROM roles WHERE code = ?", [p, role]);

  /* PIN des livreurs : par défaut les 4 derniers chiffres de leur code collecteur */
  for (const p of await q("SELECT id, collecteur_code FROM partners WHERE pin_hash IS NULL"))
    await q("UPDATE partners SET pin_hash = ? WHERE id = ?", [await bcrypt.hash(String(p.collecteur_code).replace(/\D/g, "").slice(-4) || "0000", 10), p.id]);

  if (!(await one("SELECT COUNT(*) n FROM com_partners")).n)
    await q(`INSERT INTO com_partners (nom, type, contact, tel, commission, statut, notes) VALUES
      ('Orange Côte d’Ivoire — boutiques', 'Distributeur', 'Direction partenariats', '27 20 00 10 10', 5, 'PROSPECT', 'Vente des packs en boutique'),
      ('Université Félix Houphouët-Boigny', 'Établissement', 'Service de la vie étudiante', '27 22 44 00 00', 0, 'ACTIF', 'Pack Étudiant pour les nouveaux inscrits')`);
}

module.exports = { migrate };
