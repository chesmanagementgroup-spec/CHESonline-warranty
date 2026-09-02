-- ---------------------------------------------------------------------------
-- CHES Online Warranty Platform — schema
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- Customers (venues / businesses that bought equipment from CHES) -----------
CREATE TABLE IF NOT EXISTS customers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name       TEXT    NOT NULL,
  contact_name       TEXT    NOT NULL DEFAULT '',
  email              TEXT    NOT NULL,
  phone              TEXT    NOT NULL DEFAULT '',
  address_line1      TEXT    NOT NULL DEFAULT '',
  address_line2      TEXT    NOT NULL DEFAULT '',
  suburb             TEXT    NOT NULL DEFAULT '',
  state              TEXT    NOT NULL DEFAULT '',
  postcode           TEXT    NOT NULL DEFAULT '',
  country            TEXT    NOT NULL DEFAULT 'Australia',
  site_contact_name  TEXT    NOT NULL DEFAULT '',
  site_contact_role  TEXT    NOT NULL DEFAULT '',
  site_contact_phone TEXT    NOT NULL DEFAULT '',
  site_contact_email TEXT    NOT NULL DEFAULT '',
  notes              TEXT    NOT NULL DEFAULT '',
  profile_completed_at TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (lower(email));

-- Manufacturers / suppliers that warranty jobs get forwarded to -------------
CREATE TABLE IF NOT EXISTS manufacturers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  service_email TEXT NOT NULL DEFAULT '',
  portal_url    TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturers_name ON manufacturers (lower(name));

-- Devices: one row per physical machine -------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  asset_tag        TEXT    NOT NULL,           -- CHES-000123, printable / QR-able
  invoice_number   TEXT    NOT NULL DEFAULT '',
  product_name     TEXT    NOT NULL,
  model_code       TEXT    NOT NULL DEFAULT '',
  brand            TEXT    NOT NULL DEFAULT '',
  manufacturer_id  INTEGER REFERENCES manufacturers(id) ON DELETE SET NULL,
  serial_number    TEXT    NOT NULL DEFAULT '',
  purchase_date    TEXT,                        -- invoice date (set by CHES)
  delivered_at     TEXT,                        -- date received on site (customer)
  warranty_months  INTEGER NOT NULL DEFAULT 12,
  warranty_start   TEXT,                        -- derived: delivered_at or purchase_date
  warranty_end     TEXT,
  location_note    TEXT    NOT NULL DEFAULT '', -- "kitchen line, under the pass"
  unit_price_ex_gst REAL,
  status           TEXT    NOT NULL DEFAULT 'pending_registration',
                            -- pending_registration | registered | decommissioned
  registered_at    TEXT,
  notes            TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_asset_tag ON devices (asset_tag);
CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);
CREATE INDEX IF NOT EXISTS idx_devices_invoice ON devices (invoice_number);
CREATE INDEX IF NOT EXISTS idx_devices_warranty_end ON devices (warranty_end);

-- Service / warranty requests ------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT    NOT NULL,           -- WR-2026-0001
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  device_id         INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  category          TEXT    NOT NULL,
  priority          TEXT    NOT NULL DEFAULT 'normal',   -- low | normal | urgent
  description       TEXT    NOT NULL,
  fault_started_on  TEXT,
  contact_name      TEXT    NOT NULL DEFAULT '',
  contact_phone     TEXT    NOT NULL DEFAULT '',
  contact_email     TEXT    NOT NULL DEFAULT '',
  site_address      TEXT    NOT NULL DEFAULT '',
  preferred_times   TEXT    NOT NULL DEFAULT '',
  under_warranty    INTEGER NOT NULL DEFAULT 0, -- snapshot at submission time
  status            TEXT    NOT NULL DEFAULT 'submitted',
                            -- submitted | acknowledged | sent_to_manufacturer
                            -- | awaiting_parts | scheduled | resolved | closed
  manufacturer_id   INTEGER REFERENCES manufacturers(id) ON DELETE SET NULL,
  manufacturer_ref  TEXT    NOT NULL DEFAULT '', -- factory job number, e.g. TJC-#####
  internal_notes    TEXT    NOT NULL DEFAULT '',
  forwarded_at      TEXT,
  resolved_at       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_reference ON claims (reference);
CREATE INDEX IF NOT EXISTS idx_claims_customer ON claims (customer_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims (status);

-- Audit trail / timeline shown on a claim ------------------------------------
CREATE TABLE IF NOT EXISTS claim_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id    INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  actor_type  TEXT    NOT NULL,      -- customer | staff | system
  actor_label TEXT    NOT NULL DEFAULT '',
  type        TEXT    NOT NULL,      -- created | status | note | email | attachment
  message     TEXT    NOT NULL DEFAULT '',
  visible_to_customer INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claim_events_claim ON claim_events (claim_id);

-- Uploaded files (device label photos, fault photos/videos, invoices) --------
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id      INTEGER REFERENCES claims(id) ON DELETE CASCADE,
  device_id     INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL DEFAULT 'other', -- serial_label | fault | invoice | other
  original_name TEXT    NOT NULL,
  stored_name   TEXT    NOT NULL,
  mime_type     TEXT    NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  uploaded_by   TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_claim ON attachments (claim_id);
CREATE INDEX IF NOT EXISTS idx_attachments_device ON attachments (device_id);

-- CHES staff accounts --------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'admin',  -- admin | staff
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_email ON staff_users (lower(email));

-- Passwordless login codes for customers ------------------------------------
CREATE TABLE IF NOT EXISTS login_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  consumed_at TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (lower(email));

-- Sessions (customer + staff) ------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,     -- customer | staff
  subject_id   INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions (subject_type, subject_id);

-- Invoice imports: an uploaded INVOICE parsed into draft device rows --------
CREATE TABLE IF NOT EXISTS invoice_imports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name  TEXT    NOT NULL,
  stored_name    TEXT    NOT NULL DEFAULT '',
  source         TEXT    NOT NULL DEFAULT 'pdf',   -- pdf | csv
  status         TEXT    NOT NULL DEFAULT 'draft', -- draft | committed | discarded
  invoice_number TEXT    NOT NULL DEFAULT '',
  invoice_date   TEXT,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  detected_customer TEXT NOT NULL DEFAULT '',
  raw_text       TEXT    NOT NULL DEFAULT '',
  parsed_json    TEXT    NOT NULL DEFAULT '[]',
  devices_created INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  committed_at   TEXT
);

-- Every email the platform sends (or would have sent in dev mode) -----------
CREATE TABLE IF NOT EXISTS email_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr      TEXT NOT NULL,
  cc_addr      TEXT NOT NULL DEFAULT '',
  reply_to     TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  template     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'queued',   -- sent | failed | logged
  error        TEXT NOT NULL DEFAULT '',
  related_type TEXT NOT NULL DEFAULT '',
  related_id   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log (created_at DESC);


-- Sites: a customer can run several venues, and a machine lives at one of
-- them. The site carries the address and the person a technician calls, so a
-- service request from any machine already knows where to go and who to ask
-- for.
CREATE TABLE IF NOT EXISTS sites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  address_line1 TEXT    NOT NULL DEFAULT '',
  address_line2 TEXT    NOT NULL DEFAULT '',
  suburb        TEXT    NOT NULL DEFAULT '',
  state         TEXT    NOT NULL DEFAULT '',
  postcode      TEXT    NOT NULL DEFAULT '',
  country       TEXT    NOT NULL DEFAULT 'Australia',
  contact_name  TEXT    NOT NULL DEFAULT '',
  contact_role  TEXT    NOT NULL DEFAULT '',
  contact_phone TEXT    NOT NULL DEFAULT '',
  contact_email TEXT    NOT NULL DEFAULT '',
  notes         TEXT    NOT NULL DEFAULT '',
  is_default    INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sites_customer ON sites (customer_id);

-- One-click sign-in links emailed to a customer. A link is a bearer
-- credential, so it is stored hashed, scoped to one customer, and expires.
CREATE TABLE IF NOT EXISTS magic_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL,
  purpose     TEXT    NOT NULL DEFAULT 'portal',
  device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  expires_at  TEXT    NOT NULL,
  last_used_at TEXT,
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_token ON magic_links (token_hash);

-- Simple counters for human-readable references ------------------------------
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
