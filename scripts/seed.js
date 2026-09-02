#!/usr/bin/env node
'use strict';

/**
 * Seed the database.
 *
 *   npm run seed                       -- staff account + manufacturer list
 *   npm run seed -- --demo             -- also add a demo customer and devices
 *   npm run seed -- --email a@b.com --password 'secret' --name 'Rita'
 *
 * Safe to re-run: nothing is duplicated.
 */

const config = require('../server/config');
const { db, nextAssetTag } = require('../server/db');
const auth = require('../server/auth');
const { refreshWarranty } = require('../server/lib/models');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes('--' + name);

// --- Staff accounts ---------------------------------------------------------
// Everyone who works a request gets their own login, so the timeline records
// who changed a status and who sent a job to a supplier.

function upsertStaff(staffName, staffEmail, staffPassword) {
  const clean = String(staffEmail || '').trim().toLowerCase();
  if (!clean || !staffPassword) return false;
  const existing = db.prepare('SELECT * FROM staff_users WHERE lower(email) = lower(?)').get(clean);
  if (existing) {
    db.prepare('UPDATE staff_users SET password_hash = ?, name = ?, active = 1 WHERE id = ?')
      .run(auth.hashPassword(staffPassword), staffName, existing.id);
    console.log(`Updated staff account ${clean}`);
  } else {
    db.prepare('INSERT INTO staff_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(staffName, clean, auth.hashPassword(staffPassword), 'admin');
    console.log(`Created staff account ${clean}`);
  }
  return true;
}

const madeStaff = [
  upsertStaff(
    arg('name', config.admin.name),
    arg('email', config.admin.email),
    arg('password', config.admin.password)
  ),
  // A second account from the environment, so both people exist on first boot.
  upsertStaff(
    process.env.STAFF2_NAME || 'Cristina',
    process.env.STAFF2_EMAIL || '',
    process.env.STAFF2_PASSWORD || ''
  ),
].filter(Boolean).length;

if (!madeStaff) {
  console.log('No staff account created — pass --email and --password, or set '
    + 'ADMIN_EMAIL / ADMIN_PASSWORD (and STAFF2_EMAIL / STAFF2_PASSWORD) in .env');
}

// --- Supplier service desks -------------------------------------------------
// Seeded from server/lib/suppliers.js. Existing rows are filled in where a
// field is still blank but never overwritten, so a correction made in the
// console survives the next seed.

const { SUPPLIERS } = require('../server/lib/suppliers');

const insertManufacturer = db.prepare(`
  INSERT INTO manufacturers (name, service_email, cc_email, portal_url, phone, aliases,
                             default_warranty_months, warranty_notes, notes)
  VALUES (@name, @service_email, @cc_email, @portal_url, @phone, @aliases,
          @default_warranty_months, @warranty_notes, @notes)
`);

let added = 0;
let filled = 0;

for (const supplier of SUPPLIERS) {
  const row = {
    name: supplier.name,
    service_email: supplier.serviceEmail || '',
    cc_email: supplier.ccEmail || '',
    portal_url: supplier.portalUrl || '',
    phone: supplier.phone || '',
    aliases: (supplier.aliases || []).join(', '),
    default_warranty_months: supplier.defaultWarrantyMonths || null,
    warranty_notes: supplier.warrantyNotes || '',
    notes: supplier.notes || '',
  };

  const existing = db.prepare('SELECT * FROM manufacturers WHERE lower(name) = lower(?)').get(supplier.name);
  if (!existing) {
    insertManufacturer.run(row);
    added++;
    continue;
  }

  const patch = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'name' || !value) continue;
    const current = existing[key];
    if (current === null || current === undefined || current === '') patch[key] = value;
  }
  if (Object.keys(patch).length) {
    const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE manufacturers SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...patch, id: existing.id });
    filled++;
  }
}

console.log(`Supplier desks: ${added} added, ${filled} updated where fields were blank, `
  + `${SUPPLIERS.length - added - filled} already complete`);

const noTerm = SUPPLIERS.filter((s) => !s.defaultWarrantyMonths).length;
console.log(`  ${SUPPLIERS.length - noTerm} have a standard warranty term applied on import; `
  + `${noTerm} vary by model and are left for the invoice or a person to set.`);

// --- Demo data -------------------------------------------------------------

if (has('demo')) {
  const demoEmail = 'demo@sunrisecafe.com.au';
  let customer = db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?)').get(demoEmail);

  if (!customer) {
    const info = db.prepare(`
      INSERT INTO customers (company_name, contact_name, email, phone, address_line1, suburb, state, postcode,
                             site_contact_name, site_contact_role, site_contact_phone, site_contact_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Sunrise Cafe Pty Ltd', 'Anna Nguyen', demoEmail, '03 9000 1122',
      '88 Chapel Street', 'Windsor', 'VIC', '3181',
      'Sam Lee', 'Head chef', '0400 111 222', 'sam@sunrisecafe.com.au'
    );
    customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    console.log(`Created demo customer ${demoEmail}`);
  }

  const demoDevices = [
    ['SIMCO SD80 Underbench Dishwasher', 'SIMCO', 'SD80', 'INV-23568', '2025-08-15', '2025-08-28', 12],
    ['Waldorf RN8610G-B 900mm Gas Oven Range', 'Waldorf', 'RN8610G-B', 'INV-23568', '2025-08-15', '2025-08-28', 24],
    ['Skope BME1200-A 2 Door Underbench Fridge', 'Skope', 'BME1200-A', 'INV-23568', '2025-08-15', null, 24],
  ];

  const insertDevice = db.prepare(`
    INSERT INTO devices (customer_id, site_id, asset_tag, invoice_number, product_name, model_code, brand,
                         manufacturer_id, purchase_date, delivered_at, warranty_months, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [product, brand, model, invoice, purchased, delivered, months] of demoDevices) {
    const exists = db.prepare('SELECT id FROM devices WHERE customer_id = ? AND product_name = ?').get(customer.id, product);
    if (exists) continue;
    const mfr = db.prepare('SELECT id FROM manufacturers WHERE lower(name) = lower(?)').get(brand);
    const info = insertDevice.run(
      customer.id, (require('../server/lib/models').defaultSite(customer.id) || {}).id || null,
      nextAssetTag(), invoice, product, model, brand,
      mfr ? mfr.id : null, purchased, delivered, months,
      'active'
    );
    refreshWarranty(info.lastInsertRowid);
  }
  console.log(`Demo equipment ready for ${customer.company_name}`);
  console.log(`Sign in at / with ${demoEmail} (the code is printed to the server log in dev mode)`);
}

console.log('Done.');
