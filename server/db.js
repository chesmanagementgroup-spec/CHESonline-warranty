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
