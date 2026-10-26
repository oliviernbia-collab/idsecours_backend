-- =====================================================================
-- ID SECOURS — schéma MySQL / MariaDB (base : db_idsecours)
-- =====================================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------- PARAMÉTRAGE (Super Admin) ----------
CREATE TABLE IF NOT EXISTS doc_categories (
  code        VARCHAR(10)  PRIMARY KEY,
  label       VARCHAR(80)  NOT NULL,
  short       VARCHAR(40)  NOT NULL,
  prix        INT          NOT NULL,          -- protection annuelle (FCFA)
  frais       INT          NOT NULL,          -- frais de récupération si non protégé
  icon        VARCHAR(30)  NOT NULL,
  color       VARCHAR(9)   NOT NULL,
  official    TINYINT(1)   NOT NULL DEFAULT 0, -- déclaration officielle exigée
  prefix      VARCHAR(4)   NOT NULL DEFAULT '',
  position    INT          NOT NULL DEFAULT 0,
  active      TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS packs (
  code        VARCHAR(10)  PRIMARY KEY,
  label       VARCHAR(80)  NOT NULL,
  prix        INT          NOT NULL,
  quota500    INT          NOT NULL DEFAULT 0,
  quota300    INT          NOT NULL DEFAULT 0,
  description VARCHAR(255) NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS formules (
  code            VARCHAR(12) PRIMARY KEY,
  label           VARCHAR(40) NOT NULL,
  prix            INT         NOT NULL,
  max_docs        INT         NOT NULL,       -- 0 = illimité
  collecte_label  VARCHAR(60) NOT NULL,
  livraison_label VARCHAR(60) NOT NULL,
  collect_quota   INT         NOT NULL DEFAULT 0, -- -1 = illimité
  delivery_quota  INT         NOT NULL DEFAULT 0, -- -1 = illimité
  priorite        VARCHAR(60) NOT NULL,
  publication     TINYINT(1)  NOT NULL DEFAULT 0,
  color           VARCHAR(9)  NOT NULL,
  position        INT         NOT NULL DEFAULT 0,
  active          TINYINT(1)  NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pay_methods (
  code    VARCHAR(10) PRIMARY KEY,
  label   VARCHAR(40) NOT NULL,
  color   VARCHAR(9)  NOT NULL,
  short   VARCHAR(4)  NOT NULL,
  dark    TINYINT(1)  NOT NULL DEFAULT 0,
  active  TINYINT(1)  NOT NULL DEFAULT 1,
  position INT        NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  k  VARCHAR(60) PRIMARY KEY,
  v  VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tariff_history (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  entity     VARCHAR(20) NOT NULL,
  code       VARCHAR(12) NOT NULL,
  field      VARCHAR(30) NOT NULL,
  old_value  VARCHAR(60),
  new_value  VARCHAR(60),
  staff_id   INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- ORGANISATION ----------
CREATE TABLE IF NOT EXISTS agencies (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  code      VARCHAR(12) NOT NULL UNIQUE,
  nom       VARCHAR(80) NOT NULL,
  commune   VARCHAR(40) NOT NULL,
  adresse   VARCHAR(160) NOT NULL,
  tel       VARCHAR(30),
  horaires  VARCHAR(60) NOT NULL DEFAULT 'Lun–Sam · 8h–17h',
  lat       DECIMAL(9,6),
  lng       DECIMAL(9,6),
  status    ENUM('ACTIVE','SUSPENDUE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roles (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  code   VARCHAR(30) NOT NULL UNIQUE,
  label  VARCHAR(80) NOT NULL,
  color  VARCHAR(9)  NOT NULL DEFAULT '#16201B'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS permissions (
  code   VARCHAR(40) PRIMARY KEY,
  module VARCHAR(40) NOT NULL,
  label  VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id   INT NOT NULL,
  perm_code VARCHAR(40) NOT NULL,
  PRIMARY KEY (role_id, perm_code),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (perm_code) REFERENCES permissions(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS staff (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  prenom        VARCHAR(60) NOT NULL,
  nom           VARCHAR(60) NOT NULL,
  email         VARCHAR(120) NOT NULL UNIQUE,
  tel           VARCHAR(30),
  password_hash VARCHAR(100) NOT NULL,
  role_id       INT NOT NULL,
  agency_id     INT,
  status        ENUM('ACTIVE','SUSPENDU') NOT NULL DEFAULT 'ACTIVE',
  last_login    DATETIME,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (agency_id) REFERENCES agencies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS staff_logins (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  staff_id   INT,
  email      VARCHAR(120),
  success    TINYINT(1) NOT NULL,
  ip         VARCHAR(60),
  user_agent VARCHAR(255),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS partners (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  nom              VARCHAR(100) NOT NULL,
  contact          VARCHAR(80),
  tel              VARCHAR(30),
  collecteur       VARCHAR(60) NOT NULL,
  collecteur_code  VARCHAR(20) NOT NULL,
  vehicule         VARCHAR(60) NOT NULL,
  zones            VARCHAR(255),
  status           ENUM('ACTIF','SUSPENDU') NOT NULL DEFAULT 'ACTIF',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- UTILISATEURS (grand public) ----------
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  prenom        VARCHAR(60) NOT NULL,
  nom           VARCHAR(60) NOT NULL,
  tel           VARCHAR(20) NOT NULL UNIQUE,   -- normalisé (chiffres seuls)
  email         VARCHAR(120),
  password_hash VARCHAR(100) NOT NULL,
  dob           DATE,
  ville         VARCHAR(60),
  commune       VARCHAR(40),
  avenue        VARCHAR(80),
  rue           VARCHAR(80),
  complement    VARCHAR(160),
  photo         VARCHAR(255),
  verified      TINYINT(1) NOT NULL DEFAULT 0,
  status        ENUM('ACTIF','SUSPENDU') NOT NULL DEFAULT 'ACTIF',
  pos_commune   VARCHAR(40),
  pos_lat       DECIMAL(9,6),
  pos_lng       DECIMAL(9,6),
  pos_acc       INT,
  pos_at        DATETIME,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS otp_codes (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  tel        VARCHAR(20) NOT NULL,
  purpose    VARCHAR(30) NOT NULL,
  ref        VARCHAR(40),
  code_hash  VARCHAR(100) NOT NULL,
  payload    TEXT,
  attempts   INT NOT NULL DEFAULT 0,
  used       TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (tel, purpose)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sms_outbox (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  tel        VARCHAR(20) NOT NULL,
  body       VARCHAR(500) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  title      VARCHAR(120) NOT NULL,
  body       VARCHAR(500) NOT NULL,
  link       VARCHAR(80),
  read_at    DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_activity (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  label      VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- PROTECTIONS & DOCUMENTS ----------
CREATE TABLE IF NOT EXISTS protections (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  kind          ENUM('INDIV','PACK','FORMULE') NOT NULL,
  category_code VARCHAR(10),
  pack_code     VARCHAR(10),
  formule_code  VARCHAR(12),
  label         VARCHAR(80) NOT NULL,
  prix          INT NOT NULL,
  quota500      INT NOT NULL DEFAULT 0,
  quota300      INT NOT NULL DEFAULT 0,
  start_at      DATETIME NOT NULL,
  exp_at        DATETIME NOT NULL,
  suspended     TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS documents (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  category_code VARCHAR(10) NOT NULL,
  numero        VARCHAR(40) NOT NULL,
  nom           VARCHAR(60) NOT NULL,
  prenoms       VARCHAR(80) NOT NULL,
  dob           DATE,
  organisme     VARCHAR(80),
  date_deliv    DATE,
  date_exp      DATE,
  protection_id INT,
  status        ENUM('PRESENT','PERDU','RECHERCHE','POT','RETROUVE','RECUP','RECUPERE') NOT NULL DEFAULT 'PRESENT',
  photo_recto   VARCHAR(255),
  photo_verso   VARCHAR(255),
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_num (user_id, numero),
  INDEX (numero),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (category_code) REFERENCES doc_categories(code),
  FOREIGN KEY (protection_id) REFERENCES protections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS document_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL,
  label       VARCHAR(255) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (document_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- PERTES / DÉCLARATIONS ----------
CREATE TABLE IF NOT EXISTS loss_declarations (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  ref           VARCHAR(30) NOT NULL UNIQUE,
  document_id   INT NOT NULL,
  user_id       INT NOT NULL,
  date_perte    DATE NOT NULL,
  circonstances VARCHAR(120) NOT NULL,
  observation   VARCHAR(500),
  lat           DECIMAL(9,6),
  lng           DECIMAL(9,6),
  accuracy      INT,
  commune       VARCHAR(40),
  closed        TINYINT(1) NOT NULL DEFAULT 0,
  is_sensitive  TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS official_declarations (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  declaration_id INT NOT NULL,             -- rattachée à UNE perte (pas réutilisable)
  document_id    INT NOT NULL,
  numero         VARCHAR(60) NOT NULL,
  date_decl      DATE NOT NULL,
  lieu           VARCHAR(80) NOT NULL,
  administration VARCHAR(60) NOT NULL,
  file_url       VARCHAR(255) NOT NULL,
  status         ENUM('TRANSMISE','EN VÉRIFICATION','VALIDÉE','COMPLÉMENT REQUIS','REJETÉE') NOT NULL DEFAULT 'TRANSMISE',
  motif          VARCHAR(255),
  reviewed_by    INT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (declaration_id) REFERENCES loss_declarations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS publications (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  ref            VARCHAR(30) NOT NULL UNIQUE,
  declaration_id INT NOT NULL,             -- une publication par perte
  document_id    INT NOT NULL,
  status         ENUM('EN VALIDATION','ACTIVE','REJETÉE','CLÔTURÉE') NOT NULL DEFAULT 'EN VALIDATION',
  views          INT NOT NULL DEFAULT 0,
  reports        INT NOT NULL DEFAULT 0,
  live_at        DATETIME,
  closed_at      DATETIME,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (declaration_id) REFERENCES loss_declarations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS publication_history (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  publication_id INT NOT NULL,
  label          VARCHAR(255) NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- DOCUMENTS TROUVÉS / COLLECTE ----------
CREATE TABLE IF NOT EXISTS found_reports (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  ref              VARCHAR(30) NOT NULL UNIQUE,
  reporter_user_id INT,
  reporter_tel     VARCHAR(20),
  access_token     VARCHAR(64) NOT NULL,     -- suivi anonyme
  category_code    VARCHAR(10) NOT NULL,
  numero           VARCHAR(40),
  nom_visible      VARCHAR(120),
  photo_recto      VARCHAR(255),
  photo_verso      VARCHAR(255),
  registered       TINYINT(1) NOT NULL DEFAULT 0,
  lat              DECIMAL(9,6),
  lng              DECIMAL(9,6),
  accuracy         INT,
  commune          VARCHAR(40),
  repere           VARCHAR(160),
  slot             VARCHAR(60),
  step             TINYINT NOT NULL DEFAULT 0, -- 0..6 (cf. COL_STEPS)
  step_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  collect_code     VARCHAR(10) NOT NULL,
  mission_ref      VARCHAR(20),
  partner_id       INT,
  agency_id        INT,
  handed_at        DATETIME,
  received_at      DATETIME,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id) REFERENCES partners(id),
  FOREIGN KEY (agency_id) REFERENCES agencies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- stock physique des documents détenus par ID SECOURS
CREATE TABLE IF NOT EXISTS held_documents (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  reception_ref VARCHAR(30) NOT NULL UNIQUE,
  found_id      INT,
  category_code VARCHAR(10) NOT NULL,
  numero        VARCHAR(40),
  nom           VARCHAR(120),
  etat_physique VARCHAR(40) NOT NULL DEFAULT 'Bon état',
  etat          VARCHAR(60) NOT NULL DEFAULT 'Reçu par ID SECOURS',
  agency_id     INT NOT NULL,
  emplacement   VARCHAR(40),
  internal_qr   VARCHAR(40) NOT NULL,
  status        ENUM('RECU','CONSERVE','QUARANTAINE','EN_RESTITUTION','RESTITUE','TRANSFERE') NOT NULL DEFAULT 'RECU',
  received_by   INT,
  received_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (numero),
  FOREIGN KEY (agency_id) REFERENCES agencies(id),
  FOREIGN KEY (found_id) REFERENCES found_reports(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_movements (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  held_id     INT NOT NULL,
  label       VARCHAR(255) NOT NULL,
  staff_id    INT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (held_id) REFERENCES held_documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- RÉCUPÉRATION ----------
CREATE TABLE IF NOT EXISTS recoveries (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  ref             VARCHAR(30) NOT NULL UNIQUE,
  user_id         INT,
  access_token    VARCHAR(64) NOT NULL,
  held_id         INT NOT NULL,
  document_id     INT,
  category_code   VARCHAR(10) NOT NULL,
  tel             VARCHAR(20),
  protected       TINYINT(1) NOT NULL DEFAULT 0,
  status          VARCHAR(40) NOT NULL DEFAULT 'PROPRIÉTÉ À VÉRIFIER',
  verif_status    VARCHAR(40),
  verif_tries     INT NOT NULL DEFAULT 0,
  selfie          VARCHAR(255),
  dob             DATE,
  lieu_naissance  VARCHAR(80),
  justificatif    VARCHAR(255),
  verified_by     INT,
  verified_at     DATETIME,
  fee_amount      INT NOT NULL DEFAULT 0,
  paid            TINYINT(1) NOT NULL DEFAULT 0,
  pay_ref         VARCHAR(30),
  delivery        TINYINT(1) NOT NULL DEFAULT 0,
  deliv_ref       VARCHAR(30),
  withdrawal_code VARCHAR(10),
  done_at         DATETIME,
  done_by         INT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (held_id) REFERENCES held_documents(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- PAIEMENTS ----------
CREATE TABLE IF NOT EXISTS payments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ref         VARCHAR(30) NOT NULL UNIQUE,
  user_id     INT,
  kind        ENUM('indiv','pack','formule','renew','frais','livraison') NOT NULL,
  label       VARCHAR(160) NOT NULL,
  amount      INT NOT NULL,
  method      VARCHAR(10) NOT NULL,
  phone       VARCHAR(20),
  status      ENUM('EN ATTENTE','RÉUSSI','ÉCHOUÉ','REMBOURSÉ') NOT NULL DEFAULT 'EN ATTENTE',
  detail_lines TEXT,
  meta        TEXT,
  agency_id   INT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- MESSAGERIE CONTEXTUELLE ----------
CREATE TABLE IF NOT EXISTS messages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  dossier_ref VARCHAR(30) NOT NULL,
  sender      ENUM('USER','AGENT','SYSTEM') NOT NULL,
  staff_id    INT,
  kind        ENUM('text','file','voice') NOT NULL DEFAULT 'text',
  body        VARCHAR(2000),
  file_url    VARCHAR(255),
  file_name   VARCHAR(160),
  duration    INT,
  read_by_agent TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (dossier_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- MODULE SOS ----------
CREATE TABLE IF NOT EXISTS sos_settings (
  user_id          INT PRIMARY KEY,
  enabled          TINYINT(1) NOT NULL DEFAULT 0,
  configured       TINYINT(1) NOT NULL DEFAULT 0,
  share_loc        TINYINT(1) NOT NULL DEFAULT 1,
  ack_timeout      INT NOT NULL DEFAULT 60,
  seq              VARCHAR(60) NOT NULL DEFAULT '["V+","V-","V+"]',
  seq_delay        DECIMAL(3,1) NOT NULL DEFAULT 2,
  seq_enabled      TINYINT(1) NOT NULL DEFAULT 0,
  taps_enabled     TINYINT(1) NOT NULL DEFAULT 0,
  tap_count        INT NOT NULL DEFAULT 3,
  code_normal_hash VARCHAR(100),
  code_duress_hash VARCHAR(100),
  voice_phrase     VARCHAR(120),
  voice_trained    TINYINT(1) NOT NULL DEFAULT 0,
  voice_enabled    TINYINT(1) NOT NULL DEFAULT 0,
  diag             VARCHAR(400),
  protection_start DATETIME,
  protection_until DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sos_contacts (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  prenom     VARCHAR(60) NOT NULL,
  nom        VARCHAR(60) NOT NULL,
  tel        VARCHAR(20) NOT NULL,
  relation   VARCHAR(30) NOT NULL,
  priorite   INT NOT NULL DEFAULT 1,
  invitation ENUM('ENVOYEE','ACCEPTEE','REFUSEE') NOT NULL DEFAULT 'ENVOYEE',
  ready      TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sos_devices (
  id          VARCHAR(20) NOT NULL,
  user_id     INT NOT NULL,
  nom         VARCHAR(60) NOT NULL,
  modele      VARCHAR(40) NOT NULL,
  type        VARCHAR(60) NOT NULL,
  battery     INT,
  statut      VARCHAR(20) NOT NULL DEFAULT 'Actif',
  last_seen   DATETIME,
  last_check  DATETIME,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sos_incidents (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ref         VARCHAR(20) NOT NULL UNIQUE,
  user_id     INT NOT NULL,
  type        VARCHAR(20) NOT NULL,
  status      VARCHAR(30) NOT NULL DEFAULT 'CRÉÉ',
  is_test     TINYINT(1) NOT NULL DEFAULT 0,
  duress      TINYINT(1) NOT NULL DEFAULT 0,
  battery     INT,
  network     VARCHAR(20),
  protection_mode TINYINT(1) NOT NULL DEFAULT 0,
  share_loc   TINYINT(1) NOT NULL DEFAULT 1,
  cur         INT NOT NULL DEFAULT -1,
  alert_at    DATETIME,
  fallback    TINYINT(1) NOT NULL DEFAULT 0,
  closed      TINYINT(1) NOT NULL DEFAULT 0,
  rev         INT NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at   DATETIME,
  INDEX (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sos_incident_contacts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,
  contact_id  INT,
  position    INT NOT NULL,
  prenom      VARCHAR(60) NOT NULL,
  nom         VARCHAR(60) NOT NULL,
  relation    VARCHAR(30) NOT NULL,
  tel         VARCHAR(20) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'ATTENTE',
  token       VARCHAR(64) NOT NULL UNIQUE,     -- lien d'alerte envoyé au contact
  status_at   DATETIME(3),
  FOREIGN KEY (incident_id) REFERENCES sos_incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sos_events (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,
  label       VARCHAR(255) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (incident_id) REFERENCES sos_incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sos_positions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  accuracy    INT,
  source      VARCHAR(20) NOT NULL DEFAULT 'GPS',
  commune     VARCHAR(40),
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (incident_id) REFERENCES sos_incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- BACK-OFFICE ----------
CREATE TABLE IF NOT EXISTS prospects (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  nom        VARCHAR(120) NOT NULL,
  tel        VARCHAR(30),
  email      VARCHAR(120),
  source     VARCHAR(40) NOT NULL DEFAULT 'Terrain',
  statut     ENUM('NOUVEAU','CONTACTÉ','INTÉRESSÉ','CONVERTI','PERDU') NOT NULL DEFAULT 'NOUVEAU',
  notes      VARCHAR(500),
  staff_id   INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ops_incidents (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ref         VARCHAR(20) NOT NULL UNIQUE,
  titre       VARCHAR(160) NOT NULL,
  description VARCHAR(1000),
  priorite    ENUM('BASSE','NORMALE','HAUTE','CRITIQUE') NOT NULL DEFAULT 'NORMALE',
  statut      ENUM('OUVERT','EN COURS','RÉSOLU','CLÔTURÉ') NOT NULL DEFAULT 'OUVERT',
  dossier_ref VARCHAR(30),
  created_by  INT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_type ENUM('USER','STAFF','SYSTEM','PUBLIC') NOT NULL,
  actor_id   INT,
  action     VARCHAR(80) NOT NULL,
  entity     VARCHAR(40),
  entity_ref VARCHAR(40),
  details    VARCHAR(500),
  ip         VARCHAR(60),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (actor_type, actor_id),
  INDEX (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sequences (
  k   VARCHAR(10) PRIMARY KEY,
  v   INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
