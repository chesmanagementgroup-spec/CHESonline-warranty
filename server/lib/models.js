'use strict';

const { db } = require('../db');
const { warrantyFor, toIsoDate } = require('./dates');

const CLAIM_STATUSES = [
  'submitted',
  'acknowledged',
  'sent_to_manufacturer',
  'awaiting_parts',
  'scheduled',
  'resolved',
  'closed',
];

const CLAIM_STATUS_LABELS = {
  submitted: 'Submitted',
  acknowledged: 'Acknowledged by CHES',
  sent_to_manufacturer: 'Sent to manufacturer',
  awaiting_parts: 'Awaiting parts',
  scheduled: 'Service scheduled',
  resolved: 'Resolved',
  closed: 'Closed',
};

const CLAIM_CATEGORIES = [
  'Not working / no power',
  'Not heating / not cooling',
  'Water leak',
  'Gas fault',
  'Noise or vibration',
  'Physical damage',
  'Missing parts or accessories',
  'Performance issue',
  'Installation / commissioning',
  'Other',
];

// A machine is live from the moment its invoice is imported; there is no
// customer-side registration step.
const DEVICE_STATUSES = ['active', 'decommissioned'];

/** Recompute and persist warranty_start / warranty_end for one device. */
function refreshWarranty(deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) return null;
  const w = warrantyFor(device);
  db.prepare('UPDATE devices SET warranty_start = ?, warranty_end = ? WHERE id = ?')
    .run(w.warranty_start, w.warranty_end, deviceId);
  return w;
}

/** Add computed warranty fields (never stored: days_remaining moves daily). */
function decorateDevice(device) {
  if (!device) return null;
  const w = warrantyFor(device);
  return {
    ...device,
    warranty_start: w.warranty_start,
    warranty_end: w.warranty_end,
    warranty_status: w.status,
    warranty_days_remaining: w.days_remaining,
    site_name: device.site_name || null,
  };
}

function getDevice(id) {
  return decorateDevice(db.prepare(`
    SELECT d.*, m.name AS manufacturer_name, m.service_email AS manufacturer_email,
           c.company_name AS customer_name, s.name AS site_name
    FROM devices d
    LEFT JOIN manufacturers m ON m.id = d.manufacturer_id
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.id = ?
  `).get(id));
}

function listDevicesForCustomer(customerId) {
  return db.prepare(`
    SELECT d.*, m.name AS manufacturer_name, s.name AS site_name
    FROM devices d
    LEFT JOIN manufacturers m ON m.id = d.manufacturer_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.customer_id = ?
    ORDER BY s.name COLLATE NOCASE, d.product_name COLLATE NOCASE, d.asset_tag
  `).all(customerId).map(decorateDevice);
}

// --- Sites ------------------------------------------------------------------

function listSites(customerId) {
  return db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM devices d WHERE d.site_id = s.id) AS device_count
    FROM sites s WHERE s.customer_id = ? AND s.archived = 0
    ORDER BY s.is_default DESC, s.name COLLATE NOCASE
  `).all(customerId);
}

function getSite(id) {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id) || null;
}

/** The site a customer's equipment defaults to when only one exists. */
function defaultSite(customerId) {
  return db.prepare(`
    SELECT * FROM sites WHERE customer_id = ? AND archived = 0
    ORDER BY is_default DESC, id LIMIT 1
  `).get(customerId) || null;
}

function siteAddress(site) {
  if (!site) return '';
  return [
    site.address_line1,
    site.address_line2,
    [site.suburb, site.state, site.postcode].filter(Boolean).join(' '),
  ].filter((p) => p && String(p).trim()).join(', ');
}

function createSite(customerId, fields) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE customer_id = ?').get(customerId).n;
  const info = db.prepare(`
    INSERT INTO sites (customer_id, name, address_line1, address_line2, suburb, state, postcode,
                       country, contact_name, contact_role, contact_phone, contact_email, notes, is_default)
    VALUES (@customer_id, @name, @address_line1, @address_line2, @suburb, @state, @postcode,
            @country, @contact_name, @contact_role, @contact_phone, @contact_email, @notes, @is_default)
  `).run({
    customer_id: customerId,
    name: fields.name || 'Main site',
    address_line1: fields.address_line1 || '',
    address_line2: fields.address_line2 || '',
    suburb: fields.suburb || '',
    state: fields.state || '',
    postcode: fields.postcode || '',
    country: fields.country || 'Australia',
    contact_name: fields.contact_name || '',
    contact_role: fields.contact_role || '',
    contact_phone: fields.contact_phone || '',
    contact_email: fields.contact_email || '',
    notes: fields.notes || '',
    is_default: existing === 0 ? 1 : 0,
  });
  return getSite(info.lastInsertRowid);
}

function attachmentsFor({ claimId, deviceId }) {
  if (claimId) {
    return db.prepare('SELECT * FROM attachments WHERE claim_id = ? ORDER BY id').all(claimId);
  }
  if (deviceId) {
    return db.prepare('SELECT * FROM attachments WHERE device_id = ? ORDER BY id').all(deviceId);
  }
  return [];
}

function decorateClaim(claim) {
  if (!claim) return null;
  return {
    ...claim,
    status_label: CLAIM_STATUS_LABELS[claim.status] || claim.status,
    under_warranty: Boolean(claim.under_warranty),
  };
}

function getClaim(id) {
  return decorateClaim(db.prepare(`
    SELECT cl.*, c.company_name AS customer_name, c.email AS customer_email,
           d.product_name AS device_name, d.asset_tag, d.serial_number, d.model_code, d.brand,
           m.name AS manufacturer_name, m.service_email AS manufacturer_email
    FROM claims cl
    JOIN customers c ON c.id = cl.customer_id
    LEFT JOIN devices d ON d.id = cl.device_id
    LEFT JOIN manufacturers m ON m.id = cl.manufacturer_id
    WHERE cl.id = ?
  `).get(id));
}

function claimEvents(claimId, { customerVisibleOnly = false } = {}) {
  const sql = customerVisibleOnly
    ? 'SELECT * FROM claim_events WHERE claim_id = ? AND visible_to_customer = 1 ORDER BY id'
    : 'SELECT * FROM claim_events WHERE claim_id = ? ORDER BY id';
  return db.prepare(sql).all(claimId);
}

function addClaimEvent(claimId, { actorType, actorLabel = '', type, message = '', visibleToCustomer = true }) {
  return db.prepare(`
    INSERT INTO claim_events (claim_id, actor_type, actor_label, type, message, visible_to_customer)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(claimId, actorType, actorLabel, type, message, visibleToCustomer ? 1 : 0);
}

function findOrCreateManufacturer(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const existing = db.prepare('SELECT * FROM manufacturers WHERE lower(name) = lower(?)').get(clean);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO manufacturers (name) VALUES (?)').run(clean);
  return db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(info.lastInsertRowid);
}

function customerByEmail(email) {
  return db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?)').get(String(email || '').trim());
}

function touch(table, id) {
  db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

module.exports = {
  listSites,
  getSite,
  defaultSite,
  createSite,
  siteAddress,
  CLAIM_STATUSES,
  CLAIM_STATUS_LABELS,
  CLAIM_CATEGORIES,
  DEVICE_STATUSES,
  refreshWarranty,
  decorateDevice,
  decorateClaim,
  getDevice,
  getClaim,
  listDevicesForCustomer,
  attachmentsFor,
  claimEvents,
  addClaimEvent,
  findOrCreateManufacturer,
  customerByEmail,
  touch,
  toIsoDate,
};
