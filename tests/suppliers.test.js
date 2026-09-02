'use strict';

/**
 * The supplier desk list: brand routing, warranty defaults, and the
 * out-of-warranty message a customer is given.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ches-sup-'));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'supplier-secret-'.repeat(3);
process.env.SMTP_HOST = '';
process.env.CHES_SERVICE_EMAIL = 'RitaW@CHESonline.com.au, Service@CHESonline.com.au';
process.env.CHES_AFTERSALES_EMAIL = 'Service@CHESonline.com.au';

const config = require('../server/config');
const { db } = require('../server/db');
const { SUPPLIERS } = require('../server/lib/suppliers');
const { manufacturerForBrand, defaultWarrantyMonthsForBrand } = require('../server/lib/models');
const templates = require('../server/lib/templates');

test.before(() => {
  const insert = db.prepare(`
    INSERT INTO manufacturers (name, service_email, cc_email, portal_url, phone, aliases,
                               default_warranty_months, warranty_notes, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of SUPPLIERS) {
    insert.run(s.name, s.serviceEmail || '', s.ccEmail || '', s.portalUrl || '', s.phone || '',
      (s.aliases || []).join(', '), s.defaultWarrantyMonths || null,
      s.warrantyNotes || '', s.notes || '');
  }
});

test('the brand on the machine reaches the desk that services it', () => {
  // The name on the oven is not the name of the company that fixes it.
  const routes = [
    ['Waldorf', 'Moffat'],
    ['Turbofan', 'Moffat'],
    ['Washtech', 'Moffat'],
    ['Rational', 'Comcater'],
    ['Trueheat', 'Comcater'],
    ['Hallde', 'Roband'],
    ['Austheat', 'Roband'],
    ['Apuro', 'Uropa / Nisbets'],
    ['Polar', 'Uropa / Nisbets'],
    ['Adande', 'Stoddart'],
    ['Woodson', 'Stoddart'],
    ['Vitamix', 'Skope'],
    ['Classeq', 'Winterhalter / Classeq'],
    ['Zip', 'Birko / Zip'],
    ['SIMCO', 'SIMCO'],
  ];
  for (const [brand, desk] of routes) {
    const found = manufacturerForBrand(brand);
    assert.ok(found, `${brand} should route somewhere`);
    assert.strictEqual(found.name, desk, `${brand} should reach ${desk}`);
  }
});

test('every desk that routes anywhere has a service address', () => {
  for (const supplier of SUPPLIERS) {
    assert.ok(supplier.serviceEmail, `${supplier.name} needs a service email`);
    assert.match(supplier.serviceEmail, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, `${supplier.name} email looks wrong`);
  }
});

test('a standard warranty term is only applied where the supplier states one', () => {
  // Stated clearly by the supplier, so it can be applied on import.
  assert.strictEqual(defaultWarrantyMonthsForBrand('Waldorf'), 24, 'Moffat orders from Sep 2024 are 24 months');
  assert.strictEqual(defaultWarrantyMonthsForBrand('Roband'), 12);
  assert.strictEqual(defaultWarrantyMonthsForBrand('Unox'), 12);
  assert.strictEqual(defaultWarrantyMonthsForBrand('SIMCO'), 24, 'the labour-inclusive period, not the 48-month total');

  // Varies by model — guessing here would put a wrong expiry on real equipment.
  assert.strictEqual(defaultWarrantyMonthsForBrand('Skope'), null);
  assert.strictEqual(defaultWarrantyMonthsForBrand('Hoshizaki'), null);
  assert.strictEqual(defaultWarrantyMonthsForBrand('Bromic'), null);

  // A brand nobody services yet simply has no default.
  assert.strictEqual(defaultWarrantyMonthsForBrand('Cookrite'), null);
  assert.strictEqual(defaultWarrantyMonthsForBrand(''), null);
});

test('conditions that decide a claim are recorded against the desk', () => {
  assert.match(manufacturerForBrand('SIMCO').notes, /picking slip/i);
  assert.match(manufacturerForBrand('Stoddart').notes, /authorisation before/i);
  assert.match(manufacturerForBrand('Meiko').warranty_notes, /90 days/i);
  assert.match(manufacturerForBrand('Williams').warranty_notes, /remote/i);
  assert.match(manufacturerForBrand('Apuro').notes, /customer must submit/i);
});

test('both after-sales mailboxes are notified of a new request', () => {
  assert.match(config.ches.serviceEmail, /RitaW@CHESonline\.com\.au/);
  assert.match(config.ches.serviceEmail, /Service@CHESonline\.com\.au/);
  assert.strictEqual(config.ches.afterSalesEmail, 'Service@CHESonline.com.au',
    'the customer-facing address is the service inbox, not the whole team');
});

test('an out-of-warranty customer is told both of their options', () => {
  const note = templates.outOfWarrantyNote({ warranty_end: '2026-03-01' });
  assert.match(note, /OUT OF WARRANTY/);
  assert.match(note, /2026-03-01/);
  assert.match(note, /arrange your own repairer/i, 'they may fix it themselves');
  assert.match(note, /Service@CHESonline\.com\.au/, 'or ask CHES to coordinate one');
  assert.match(note, /chargeable/i, 'and the cost position is stated up front');
});

test('the receipt tells a covered customer what happens, and an uncovered one what it costs', () => {
  const customer = { company_name: 'Test Cafe', contact_name: 'Jo', email: 'jo@test.test' };
  const device = { product_name: 'Fryer', asset_tag: 'CHES-000001', warranty_end: '2026-03-01' };

  const covered = templates.claimReceipt({
    claim: { reference: 'WR-2026-0001', category: 'Gas fault', created_at: 'now', under_warranty: true, contact_name: 'Jo' },
    customer, device,
  });
  assert.match(covered.text, /we lodge the job/i);
  assert.doesNotMatch(covered.text, /OUT OF WARRANTY/);

  const uncovered = templates.claimReceipt({
    claim: { reference: 'WR-2026-0002', category: 'Gas fault', created_at: 'now', under_warranty: false, contact_name: 'Jo' },
    customer, device,
  });
  assert.match(uncovered.text, /OUT OF WARRANTY/);
  assert.match(uncovered.text, /Service@CHESonline\.com\.au/);
});
