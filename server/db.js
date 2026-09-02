'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * Additive migrations for databases created before a column existed.
 * SQLite has no "ADD COLUMN IF NOT EXISTS", so each one is checked first.
 */
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('devices', 'site_id', 'INTEGER REFERENCES sites(id) ON DELETE SET NULL');
addColumn('claims', 'site_id', 'INTEGER REFERENCES sites(id) ON DELETE SET NULL');
addColumn('invoice_imports', 'site_id', 'INTEGER REFERENCES sites(id) ON DELETE SET NULL');
addColumn('invoice_imports', 'reference', "TEXT NOT NULL DEFAULT ''");

/**
 * Every customer needs at least one site, because equipment now hangs off a
 * site rather than off the customer record. Existing customers get one built
 * from the address already on file.
 */
const backfillSites = db.transaction(() => {
  const customers = db.prepare(`
    SELECT c.* FROM customers c
    WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.customer_id = c.id)
  `).all();

  const insertSite = db.prepare(`
    INSERT INTO sites (customer_id, name, address_line1, address_line2, suburb, state, postcode,
                       country, contact_name, contact_role, contact_phone, contact_email, is_default)
    VALUES (@customer_id, @name, @address_line1, @address_line2, @suburb, @state, @postcode,
            @country, @contact_name, @contact_role, @contact_phone, @contact_email, 1)
  `);

  for (const c of customers) {
    const info = insertSite.run({
      customer_id: c.id,
      name: c.suburb || c.company_name,
      address_line1: c.address_line1,
      address_line2: c.address_line2,
      suburb: c.suburb,
      state: c.state,
      postcode: c.postcode,
      country: c.country || 'Australia',
      contact_name: c.site_contact_name,
      contact_role: c.site_contact_role,
      contact_phone: c.site_contact_phone,
      contact_email: c.site_contact_email,
    });
    db.prepare('UPDATE devices SET site_id = ? WHERE customer_id = ? AND site_id IS NULL')
      .run(info.lastInsertRowid, c.id);
    db.prepare('UPDATE claims SET site_id = ? WHERE customer_id = ? AND site_id IS NULL')
      .run(info.lastInsertRowid, c.id);
  }
});
backfillSites();

// Registration by the customer is gone: a machine is live from the moment the
// invoice is imported, so the two old states collapse into one.
db.prepare("UPDATE devices SET status = 'active' WHERE status IN ('pending_registration','registered')").run();

/**
 * Allocate the next value of a named counter atomically.
 * Used for asset tags (CHES-000123) and claim references (WR-2026-0001).
 */
const nextCounter = db.transaction((name) => {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  return db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
});

function nextAssetTag() {
  return 'CHES-' + String(nextCounter('asset_tag')).padStart(6, '0');
}

function nextClaimReference(now = new Date()) {
  const year = now.getFullYear();
  return `WR-${year}-` + String(nextCounter('claim_' + year)).padStart(4, '0');
}

module.exports = { db, nextCounter, nextAssetTag, nextClaimReference };
