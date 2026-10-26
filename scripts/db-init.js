/* Initialise db_idsecours : création de la base, du schéma et des données de démonstration.
   Usage : npm run db:init   (n'écrase rien si la base est déjà remplie)
           npm run db:reset  (supprime puis recrée la base) */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const DB = process.env.DB_NAME || "db_idsecours";
const reset = process.argv.includes("--reset");
const tok = () => crypto.randomBytes(24).toString("hex");

const PERMISSIONS = [
  ["dashboard.view", "Tableau de bord", "Voir le tableau de bord"],
  ["staff.manage", "Super Admin", "Gérer les utilisateurs internes"],
  ["roles.manage", "Super Admin", "Modifier les rôles et permissions"],
  ["agencies.manage", "Super Admin", "Gérer les agences"],
  ["settings.manage", "Super Admin", "Modifier tarifs, formules, catégories et moyens de paiement"],
  ["audit.view", "Super Admin", "Consulter les journaux d'activité"],
  ["users.view", "Population", "Consulter les utilisateurs (population)"],
  ["declarations.view", "Opérations", "Voir les déclarations de perte"],
  ["declarations.manage", "Opérations", "Traiter les déclarations de perte"],
  ["founds.view", "Collecte & Livraison", "Voir les signalements de documents trouvés"],
  ["collectes.manage", "Collecte & Livraison", "Planifier et suivre les collectes"],
  ["partners.manage", "Collecte & Livraison", "Gérer les partenaires de livraison"],
  ["reception.manage", "Réception & Restitution", "Enregistrer une réception, générer le QR interne, affecter un emplacement"],
  ["stock.view", "Réception & Restitution", "Consulter le stock sécurisé"],
  ["restitution.manage", "Réception & Restitution", "Confirmer une remise autorisée"],
  ["verification.manage", "Vérification & Contrôle", "Vérifier les propriétaires et valider les dossiers"],
  ["official.manage", "Vérification & Contrôle", "Contrôler les déclarations officielles"],
  ["publications.manage", "Vérification & Contrôle", "Valider les publications de perte VIP"],
  ["finance.view", "Finance", "Voir les transactions et revenus"],
  ["finance.refund", "Finance", "Rembourser une transaction"],
  ["commercial.view", "Commercial", "Voir les abonnements et renouvellements"],
  ["prospects.manage", "Commercial", "Gérer les prospects"],
  ["support.messages", "Support", "Répondre aux messages des dossiers"],
  ["sos.monitor", "Support", "Superviser les alertes SOS"],
  ["incidents.manage", "Support", "Créer et traiter les incidents"]
];
const ALL = PERMISSIONS.map(p => p[0]);
const ROLES = [
  ["SUPER_ADMIN", "Super Admin", "#3B4742", ALL],
  ["DIRECTION", "Direction Générale", "#16365C", ALL.filter(p => !["staff.manage", "roles.manage", "settings.manage", "finance.refund"].includes(p))],
  ["FINANCE", "Direction Financière & Comptabilité", "#13A043", ["dashboard.view", "finance.view", "finance.refund", "commercial.view", "audit.view"]],
  ["OPERATIONS", "Direction des Opérations", "#F28C12", ["dashboard.view", "declarations.view", "declarations.manage", "founds.view", "collectes.manage", "partners.manage", "stock.view", "users.view", "incidents.manage", "sos.monitor", "support.messages"]],
  ["COMMERCIAL", "Service Commercial", "#7C3AED", ["dashboard.view", "commercial.view", "prospects.manage", "users.view"]],
  ["SUPPORT", "Support Technique", "#6A7570", ["dashboard.view", "support.messages", "sos.monitor", "incidents.manage", "users.view"]],
  ["COLLECTE", "Service Collecte & Livraison", "#0B7A32", ["dashboard.view", "founds.view", "collectes.manage", "partners.manage", "support.messages"]],
  ["VERIFICATION", "Service Vérification & Contrôle", "#1A7EE0", ["dashboard.view", "declarations.view", "verification.manage", "official.manage", "publications.manage", "stock.view", "support.messages"]],
  ["RECEPTION", "Service Réception & Restitution", "#E3141B", ["dashboard.view", "reception.manage", "stock.view", "restitution.manage", "founds.view"]]
];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1", port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "", multipleStatements: true
  });
  if (reset) { await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``); console.log(`Base ${DB} supprimée.`); }
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${DB}\``);
  await conn.query(fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8"));
  console.log("Schéma appliqué.");

  const [[{ n }]] = await conn.query("SELECT COUNT(*) n FROM doc_categories");
  if (n > 0) { console.log("Données déjà présentes — rien à insérer (utilisez npm run db:reset pour repartir de zéro)."); await runMigrations(); return conn.end(); }

  const q = (sql, params) => conn.query(sql, params);
  const ins = async (table, rows) => { if (!rows.length) return; const cols = Object.keys(rows[0]); await q(`INSERT INTO ${table} (${cols.join(",")}) VALUES ?`, [rows.map(r => cols.map(c => r[c]))]); };

  /* ---------- paramétrage ---------- */
  await ins("doc_categories", [
    { code: "CNI", label: "Carte Nationale d’Identité", short: "CNI", prix: 500, frais: 2000, icon: "idcard", color: "#1A7EE0", official: 1, prefix: "CI", position: 1 },
    { code: "PASS", label: "Passeport", short: "Passeport", prix: 500, frais: 5000, icon: "passport", color: "#16365C", official: 1, prefix: "P", position: 2 },
    { code: "PERMIS", label: "Permis de conduire", short: "Permis", prix: 500, frais: 3000, icon: "car", color: "#13A043", official: 1, prefix: "PC", position: 3 },
    { code: "PRO", label: "Carte professionnelle", short: "Carte pro", prix: 300, frais: 1500, icon: "brief", color: "#16201B", official: 0, prefix: "CP", position: 4 },
    { code: "ETU", label: "Carte étudiante", short: "Carte étudiante", prix: 300, frais: 1000, icon: "grad", color: "#7C3AED", official: 0, prefix: "ET", position: 5 },
    { code: "SCO", label: "Carte scolaire", short: "Carte scolaire", prix: 300, frais: 1000, icon: "grad", color: "#0EA5A4", official: 0, prefix: "SC", position: 6 },
    { code: "ASS", label: "Carte d’assurance", short: "Assurance", prix: 300, frais: 1500, icon: "umbrella", color: "#F28C12", official: 0, prefix: "AS", position: 7 },
    { code: "MUT", label: "Carte de mutuelle", short: "Mutuelle", prix: 300, frais: 1500, icon: "cross", color: "#E3141B", official: 0, prefix: "MU", position: 8 },
    { code: "AUT", label: "Autre document", short: "Autre", prix: 300, frais: 1500, icon: "doc", color: "#6A7570", official: 0, prefix: "AU", position: 9 }
  ]);
  await ins("packs", [
    { code: "DUO", label: "Pack ID SECOURS", prix: 1000, quota500: 2, quota300: 1, description: "2 documents à 500 FCFA + 1 document à 300 FCFA" },
    { code: "FAM", label: "Pack Famille", prix: 2500, quota500: 5, quota300: 3, description: "5 documents à 500 FCFA + 3 documents à 300 FCFA" },
    { code: "ETU", label: "Pack Étudiant", prix: 700, quota500: 1, quota300: 2, description: "1 document à 500 FCFA + 2 documents à 300 FCFA" }
  ]);
  await ins("formules", [
    { code: "STANDARD", label: "Standard", prix: 2000, max_docs: 5, collecte_label: "Non incluse", livraison_label: "Non incluse", collect_quota: 0, delivery_quota: 0, priorite: "Normale", publication: 0, color: "#6A7570", position: 1 },
    { code: "ESSENTIEL", label: "Essentiel", prix: 5000, max_docs: 8, collecte_label: "1 collecte / an", livraison_label: "Non incluse", collect_quota: 1, delivery_quota: 0, priorite: "Renforcée", publication: 0, color: "#1A7EE0", position: 2 },
    { code: "VIP", label: "VIP", prix: 10000, max_docs: 12, collecte_label: "2 collectes / an", livraison_label: "2 livraisons / an", collect_quota: 2, delivery_quota: 2, priorite: "Prioritaire", publication: 1, color: "#C9A227", position: 3 },
    { code: "VVIP", label: "VVIP", prix: 25000, max_docs: 0, collecte_label: "Illimitée", livraison_label: "Illimitée", collect_quota: -1, delivery_quota: -1, priorite: "Maximale + conseiller dédié", publication: 1, color: "#16201B", position: 4 }
  ]);
  await ins("pay_methods", [
    { code: "OM", label: "Orange Money", color: "#FF7900", short: "OM", dark: 0, position: 1 },
    { code: "MTN", label: "MTN MoMo", color: "#FFCB05", short: "MTN", dark: 1, position: 2 },
    { code: "MOOV", label: "Moov Money", color: "#0066B3", short: "MV", dark: 0, position: 3 },
    { code: "WAVE", label: "Wave", color: "#1DC8F2", short: "W", dark: 0, position: 4 },
    { code: "CB", label: "Carte bancaire", color: "#16201B", short: "CB", dark: 0, position: 5 }
  ]);
  await ins("settings", [
    { k: "frais_service", v: "100" }, { k: "frais_livraison", v: "1500" }, { k: "otp_ttl_min", v: "10" },
    { k: "otp_max_attempts", v: "3" }, { k: "search_max_per_hour", v: "12" }, { k: "sos_rearm_s", v: "30" }
  ]);
  await ins("sequences", [
    { k: "per", v: 124 }, { k: "rec", v: 3317 }, { k: "tro", v: 457 }, { k: "sos", v: 7844 }, { k: "pay", v: 90211 },
    { k: "pub", v: 41 }, { k: "rcp", v: 1203 }, { k: "mis", v: 20114 }, { k: "inc", v: 88 }
  ]);

  /* ---------- organisation ---------- */
  await ins("agencies", [
    { code: "AG-PLT", nom: "Agence ID SECOURS Plateau", commune: "Plateau", adresse: "Immeuble Alpha 2000, Plateau", tel: "27 20 00 00 01", lat: 5.3197, lng: -4.0168 },
    { code: "AG-COC", nom: "Agence ID SECOURS Cocody", commune: "Cocody", adresse: "Boulevard Latrille, Cocody", tel: "27 22 00 00 02", lat: 5.3599, lng: -3.981 },
    { code: "AG-YOP", nom: "Agence ID SECOURS Yopougon", commune: "Yopougon", adresse: "Carrefour Siporex, Yopougon", tel: "27 23 00 00 03", lat: 5.3456, lng: -4.0892 }
  ]);
  await ins("permissions", PERMISSIONS.map(([code, module, label]) => ({ code, module, label })));
  await ins("roles", ROLES.map(([code, label, color]) => ({ code, label, color })));
  const [roles] = await q("SELECT id, code FROM roles");
  const rid = Object.fromEntries(roles.map(r => [r.code, r.id]));
  await ins("role_permissions", ROLES.flatMap(([code, , , perms]) => perms.map(p => ({ role_id: rid[code], perm_code: p }))));

  const staffPw = await bcrypt.hash("Admin@2026", 10);
  await ins("staff", [
    ["Aïcha", "Diallo", "admin@idsecours.ci", "SUPER_ADMIN", null],
    ["Jean-Marc", "Kouamé", "direction@idsecours.ci", "DIRECTION", null],
    ["Mariam", "Touré", "finance@idsecours.ci", "FINANCE", null],
    ["Serge", "Ahoussou", "operations@idsecours.ci", "OPERATIONS", null],
    ["Nadia", "Koné", "commercial@idsecours.ci", "COMMERCIAL", null],
    ["Didier", "Gnagne", "support@idsecours.ci", "SUPPORT", null],
    ["Ibrahim", "Coulibaly", "collecte@idsecours.ci", "COLLECTE", null],
    ["Esther", "Yao", "verification@idsecours.ci", "VERIFICATION", null],
    ["Paul", "N’Dri", "reception@idsecours.ci", "RECEPTION", 1]
  ].map(([prenom, nom, email, role, agency_id]) => ({ prenom, nom, email, tel: null, password_hash: staffPw, role_id: rid[role], agency_id })));

  await ins("partners", [
    { nom: "Coursier Express CI", contact: "M. Bamba", tel: "07 11 22 33 44", collecteur: "Ibrahim", collecteur_code: "COL-2231", vehicule: "Moto · 2214 AB 01", zones: "Cocody, Plateau, Marcory, Treichville" },
    { nom: "Abidjan Delivery", contact: "Mme Kassi", tel: "05 66 77 88 99", collecteur: "Moussa", collecteur_code: "COL-3307", vehicule: "Moto · 5532 BC 01", zones: "Yopougon, Abobo, Adjamé, Attécoubé" }
  ]);

  /* ---------- utilisateurs de démonstration ---------- */
  const userPw = await bcrypt.hash("secours2026", 10);
  const now = new Date();
  const ago = d => new Date(Date.now() - d * 864e5);
  await ins("users", [
    { prenom: "Koffi", nom: "Kouadio", tel: "0708451236", email: "koffi.kouadio@mail.ci", password_hash: userPw, dob: "1994-05-17", ville: "Abidjan", commune: "Cocody", avenue: "Boulevard Latrille", rue: "Rue J 45", complement: null, verified: 1, pos_commune: "Cocody", pos_lat: 5.3599, pos_lng: -3.981, pos_acc: 18, pos_at: now, created_at: ago(120) },
    { prenom: "Fatou", nom: "Bamba", tel: "0505050505", email: null, password_hash: userPw, dob: "1990-02-11", ville: "Abidjan", commune: "Marcory", avenue: null, rue: null, complement: null, verified: 1, pos_commune: "Marcory", pos_lat: 5.302, pos_lng: -3.9817, pos_acc: 20, pos_at: now, created_at: ago(60) }
  ]);
  const exp1 = new Date(2027, 8, 12), exp2 = new Date(2027, 2, 4);
  const yearBefore = d => new Date(d.getTime() - 365 * 864e5);
  await ins("protections", [
    { user_id: 1, kind: "PACK", category_code: null, pack_code: "DUO", formule_code: null, label: "Pack ID SECOURS", prix: 1000, quota500: 2, quota300: 1, start_at: yearBefore(exp1), exp_at: exp1 },
    { user_id: 1, kind: "INDIV", category_code: "PERMIS", pack_code: null, formule_code: null, label: "Protection individuelle", prix: 500, quota500: 0, quota300: 0, start_at: yearBefore(exp2), exp_at: exp2 },
    { user_id: 2, kind: "INDIV", category_code: "CNI", pack_code: null, formule_code: null, label: "Protection individuelle", prix: 500, quota500: 0, quota300: 0, start_at: ago(60), exp_at: new Date(Date.now() + 305 * 864e5) }
  ]);
  const reg = ago(120);
  await ins("documents", [
    { user_id: 1, category_code: "CNI", numero: "CI123456789", nom: "KOUADIO", prenoms: "Koffi Hervé", dob: "1994-05-17", organisme: "ONECI", date_deliv: "2021-03-10", date_exp: "2031-03-09", protection_id: 1, created_at: reg },
    { user_id: 1, category_code: "PASS", numero: "P12345678", nom: "KOUADIO", prenoms: "Koffi Hervé", dob: "1994-05-17", organisme: "DGDDI / ONECI", date_deliv: "2022-07-01", date_exp: "2027-06-30", protection_id: 1, created_at: reg },
    { user_id: 1, category_code: "PERMIS", numero: "PC12345678", nom: "KOUADIO", prenoms: "Koffi Hervé", dob: "1994-05-17", organisme: "Ministère des Transports", date_deliv: "2019-11-20", date_exp: "2029-11-19", protection_id: 2, created_at: reg },
    { user_id: 1, category_code: "PRO", numero: "CP12345678", nom: "KOUADIO", prenoms: "Koffi Hervé", dob: "1994-05-17", organisme: "PROSOFT ACADEMY", date_deliv: "2025-01-06", date_exp: "2027-01-05", protection_id: 1, created_at: reg },
    { user_id: 2, category_code: "CNI", numero: "CI0011223344", nom: "BAMBA", prenoms: "Fatou", dob: "1990-02-11", organisme: "ONECI", date_deliv: "2020-04-01", date_exp: "2030-03-31", protection_id: 3, created_at: ago(60) }
  ]);
  await ins("document_history", [1, 2, 3, 4, 5].map(id => ({ document_id: id, label: "Document enregistré", created_at: id === 5 ? ago(60) : reg })));
  await ins("notifications", [
    { user_id: 1, title: "Contact d’urgence prêt", body: "Adjoua Kouadio (Mère) a réussi le test d’alerte SOS.", link: "sosContacts", read_at: null, created_at: new Date(Date.now() - 2 * 36e5) },
    { user_id: 1, title: "Protection active", body: "Votre Pack ID SECOURS couvre 3 documents jusqu’au 12/09/2027.", link: "protections", read_at: null, created_at: new Date(Date.now() - 26 * 36e5) },
    { user_id: 1, title: "Bienvenue sur ID SECOURS", body: "Votre numéro est vérifié. Constituez votre dossier documentaire.", link: "docs", read_at: now, created_at: ago(5) }
  ]);
  await ins("sos_settings", [{
    user_id: 1, enabled: 1, configured: 1, share_loc: 1, ack_timeout: 60, seq: '["V+","V-","V+"]', seq_delay: 2, seq_enabled: 0, taps_enabled: 0, tap_count: 3,
    code_normal_hash: await bcrypt.hash("1234", 10), code_duress_hash: await bcrypt.hash("9999", 10),
    voice_phrase: "Le dossier rouge est arrivé", voice_trained: 1, voice_enabled: 1, diag: null
  }]);
  await ins("sos_contacts", [
    { user_id: 1, prenom: "Adjoua", nom: "Kouadio", tel: "0707112233", relation: "Mère", priorite: 1, invitation: "ACCEPTEE", ready: 1 },
    { user_id: 1, prenom: "Yao", nom: "Kouadio", tel: "0545667788", relation: "Frère", priorite: 2, invitation: "ACCEPTEE", ready: 0 },
    { user_id: 1, prenom: "Serge", nom: "Konan", tel: "0102334455", relation: "Ami", priorite: 3, invitation: "ENVOYEE", ready: 0 }
  ]);

  /* ---------- stock : documents détenus par ID SECOURS ---------- */
  await ins("held_documents", [
    { reception_ref: "IDS-RCP-2026-001198", category_code: "CNI", numero: "CI0098765432", nom: "KOUASSI AMANI JEAN", etat: "Conservé en agence", agency_id: 1, emplacement: "A-01-03", internal_qr: tok().slice(0, 16), status: "CONSERVE", received_at: ago(9) },
    { reception_ref: "IDS-RCP-2026-001201", category_code: "PASS", numero: "P00457812", nom: "TRAORE AWA", etat: "Reçu par ID SECOURS", agency_id: 2, emplacement: "B-02-01", internal_qr: tok().slice(0, 16), status: "CONSERVE", received_at: ago(4) },
    { reception_ref: "IDS-RCP-2026-001202", category_code: "PERMIS", numero: "PC7781245", nom: "YAO KONAN SERGE", etat: "Collecté par partenaire", agency_id: 3, emplacement: null, internal_qr: tok().slice(0, 16), status: "RECU", received_at: ago(1) }
  ]);
  await ins("prospects", [
    { nom: "Lycée Moderne de Cocody", tel: "27 22 44 55 66", email: "contact@lmc.ci", source: "Établissement scolaire", statut: "INTÉRESSÉ", notes: "Pack Étudiant pour 400 élèves", staff_id: 5 },
    { nom: "Transports SOTRA — CE", tel: "27 21 00 11 22", email: null, source: "Entreprise", statut: "CONTACTÉ", notes: "Pack Famille pour les agents", staff_id: 5 }
  ]);
  await ins("audit_logs", [{ actor_type: "SYSTEM", actor_id: null, action: "INIT", entity: "system", entity_ref: null, details: "Initialisation de la base de démonstration", ip: null }]);

  console.log("Données de démonstration insérées.");
  console.log("  Citoyen  : 07 08 45 12 36 / secours2026");
  console.log("  Staff    : admin@idsecours.ci (et finance@, operations@, commercial@, support@, collecte@, verification@, reception@, direction@) / Admin@2026");
  await runMigrations();
  console.log("  Livreurs : COL-2231 / PIN 2231 · COL-3307 / PIN 3307 (portail /livreur)");
  await conn.end();
}
async function runMigrations() {
  process.env.DB_NAME = DB;
  const { migrate } = require("../src/lib/migrate");
  await migrate();
  await require("../src/config/db").pool.end();
  console.log("Migrations appliquées.");
}
main().catch(e => { console.error(e); process.exit(1); });
