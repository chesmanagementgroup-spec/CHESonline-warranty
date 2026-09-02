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

// --- Staff account ---------------------------------------------------------

const email = String(arg('email', config.admin.email) || '').toLowerCase();
const password = arg('password', config.admin.password);
const name = arg('name', config.admin.name);

if (email && password) {
  const existing = db.prepare('SELECT * FROM staff_users WHERE lower(email) = lower(?)').get(email);
  if (existing) {
    db.prepare('UPDATE staff_users SET password_hash = ?, name = ?, active = 1 WHERE id = ?')
      .run(auth.hashPassword(password), name, existing.id);
    console.log(`Updated staff account ${email}`);
  } else {
    db.prepare('INSERT INTO staff_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email, auth.hashPassword(password), 'admin');
    console.log(`Created staff account ${email}`);
  }
} else {
  console.log('No staff account created — pass --email and --password, or set ADMIN_EMAIL / ADMIN_PASSWORD in .env');
}

// --- Manufacturers ---------------------------------------------------------
// Service addresses are left blank on purpose: fill each one in from the
// supplier's current service contact before forwarding a job to them.

const MANUFACTURERS = [
  ['SIMCO', '', '', 'Refrigeration and dishwashing. Confirm the current service lodgement route before sending.'],
  ['Waldorf', '', '', 'Moffat brand — cooking equipment.'],
  ['Turbofan', '', '', 'Moffat brand — convection ovens.'],
  ['Blue Seal', '', '', ''],
  ['Skope', '', '', 'Commercial refrigeration.'],
  ['Williams', '', '', 'Commercial refrigeration.'],
  ['Roband', '', '', ''],
  ['Bromic', '', '', ''],
  ['Robot Coupe', '', '', 'Food preparation.'],
  ['Rational', '', '', 'Combi ovens.'],
  ['Hoshizaki', '', '', 'Ice machines.'],
  ['Winterhalter', '', '', 'Warewashing.'],
];

const insertManufacturer = db.prepare(`
  INSERT INTO manufacturers (name, service_email, portal_url, notes) VALUES (?, ?, ?, ?)
`);
let added = 0;
for (const [mName, mEmail, mPortal, mNotes] of MANUFACTURERS) {
  const exists = db.prepare('SELECT id FROM manufacturers WHERE lower(name) = lower(?)').get(mName);
  if (!exists) { insertManufacturer.run(mName, mEmail, mPortal, mNotes); added++; }
}
console.log(`Manufacturers: ${added} added, ${MANUFACTURERS.length - added} already present`);

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
    INSERT INTO devices (customer_id, asset_tag, invoice_number, product_name, model_code, brand,
                         manufacturer_id, purchase_date, delivered_at, warranty_months, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [product, brand, model, invoice, purchased, delivered, months] of demoDevices) {
    const exists = db.prepare('SELECT id FROM devices WHERE customer_id = ? AND product_name = ?').get(customer.id, product);
    if (exists) continue;
    const mfr = db.prepare('SELECT id FROM manufacturers WHERE lower(name) = lower(?)').get(brand);
    const info = insertDevice.run(
      customer.id, nextAssetTag(), invoice, product, model, brand,
      mfr ? mfr.id : null, purchased, delivered, months,
      delivered ? 'registered' : 'pending_registration'
    );
    refreshWarranty(info.lastInsertRowid);
  }
  console.log(`Demo equipment ready for ${customer.company_name}`);
  console.log(`Sign in at / with ${demoEmail} (the code is printed to the server log in dev mode)`);
}

console.log('Done.');
