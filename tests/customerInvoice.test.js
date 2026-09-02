'use strict';

/**
 * A customer adding equipment from their own invoice. What matters here is
 * the boundary: the equipment is usable immediately, but it is the customer's
 * account of what they own until CHES has checked it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ches-cust-'));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'customer-invoice-secret-'.repeat(2);
process.env.SMTP_HOST = '';
process.env.PORT = '0';

const { app } = require('../server/index');
const { db } = require('../server/db');
const auth = require('../server/auth');

let baseUrl;
let server;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  db.prepare('INSERT INTO staff_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('Staff', 'staff@ches.test', auth.hashPassword('staff-pw'), 'admin');

  // The supplier desks exist in production, and the warranty a customer's
  // equipment gets comes from them rather than from the customer.
  const { SUPPLIERS } = require('../server/lib/suppliers');
  const insert = db.prepare(`
    INSERT INTO manufacturers (name, service_email, aliases, default_warranty_months)
    VALUES (?, ?, ?, ?)
  `);
  for (const s of SUPPLIERS) {
    insert.run(s.name, s.serviceEmail || '', (s.aliases || []).join(', '), s.defaultWarrantyMonths || null);
  }
});

test.after(() => server && server.close());

function client() {
  const jar = new Map();
  return async function call(method, url, body, { form = false } = {}) {
    const headers = {};
    if (jar.size) headers.Cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (form) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(baseUrl + url, { method, headers, body: payload });
    for (const cookie of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = cookie.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}

const CUSTOMER_INVOICE = [
  '*ContactName,*InvoiceNumber,*InvoiceDate,Description,*Quantity,*UnitAmount',
  'Bay Bistro,INV-77001,04/02/2026,Waldorf RN8610G-B Gas Oven Range,2,8250.00',
  'Bay Bistro,INV-77001,04/02/2026,Delivery,1,300.00',
].join('\n');

async function signedInCustomer(staff, email) {
  await staff('POST', '/api/admin/customers', {
    company_name: 'Bay Bistro', contact_name: 'Ali', email, phone: '03 9000 1111',
    address_line1: '1 Bay Road', suburb: 'St Kilda', state: 'VIC', postcode: '3182',
  });
  const customer = client();
  const code = await customer('POST', '/api/auth/request-code', { email });
  await customer('POST', '/api/auth/verify-code', { email, code: code.data.dev_code });
  return customer;
}

test('a customer adds equipment from their own invoice', async () => {
  const staff = client();
  await staff('POST', '/api/auth/staff/login', { email: 'staff@ches.test', password: 'staff-pw' });
  const customer = await signedInCustomer(staff, 'ali@baybistro.test');

  const form = new FormData();
  form.append('file', new Blob([CUSTOMER_INVOICE], { type: 'text/csv' }), 'INV-77001.csv');
  const upload = await customer('POST', '/api/portal/invoices/upload', form, { form: true });

  assert.strictEqual(upload.status, 201);
  assert.strictEqual(upload.data.invoice_number, 'INV-77001');
  assert.strictEqual(upload.data.lines.length, 1, 'delivery is a charge, not a machine, so it is not offered');
  assert.strictEqual(upload.data.lines[0].quantity, 2);
  assert.strictEqual(upload.data.sites.length, 1, 'they choose which of their sites it went to');

  const commit = await customer('POST', `/api/portal/invoices/${upload.data.import_id}/commit`, {
    site_id: upload.data.sites[0].id,
    lines: [{ ...upload.data.lines[0], serial_numbers: ['RN-0001', 'RN-0002'] }],
  });
  assert.strictEqual(commit.status, 201);
  assert.strictEqual(commit.data.devices_created, 2, 'quantity 2 is two machines here too');

  const serials = commit.data.devices.map((d) => d.serial_number).sort();
  assert.deepStrictEqual(serials, ['RN-0001', 'RN-0002'], 'one serial per machine');

  // Usable straight away, and honestly labelled.
  for (const device of commit.data.devices) {
    assert.strictEqual(device.source, 'customer');
    assert.strictEqual(device.awaiting_check, true, 'not confirmed cover until CHES looks at it');
    assert.strictEqual(device.status, 'active');
    assert.strictEqual(device.warranty_months, 24, "the supplier's term, not one the customer chose");
  }

  const listed = await customer('GET', '/api/portal/devices');
  assert.strictEqual(listed.data.devices.length, 2, 'it is on their list immediately');
});

test('CHES is told, and the notice says the record is unchecked', async () => {
  const mail = db.prepare("SELECT * FROM email_log WHERE template = 'customer_added_equipment' ORDER BY id DESC").get();
  assert.ok(mail, 'CHES is notified when a customer adds their own equipment');
  assert.match(mail.subject, /needs checking/i);
  assert.match(mail.body, /Bay Bistro/);
  assert.match(mail.body, /INV-77001/);
  assert.match(mail.body, /AWAITING CHECK/);
  assert.match(mail.body, /not cover CHES\s*\n?\s*has agreed to/i);
});

test('a fault on unchecked equipment warns before it reaches a manufacturer', async () => {
  const staff = client();
  await staff('POST', '/api/auth/staff/login', { email: 'staff@ches.test', password: 'staff-pw' });
  const customer = await signedInCustomer(staff, 'pat@baybistro2.test');

  const form = new FormData();
  form.append('file', new Blob([CUSTOMER_INVOICE], { type: 'text/csv' }), 'INV-77002.csv');
  const upload = await customer('POST', '/api/portal/invoices/upload', form, { form: true });
  const commit = await customer('POST', `/api/portal/invoices/${upload.data.import_id}/commit`, {
    site_id: upload.data.sites[0].id,
    lines: [{ ...upload.data.lines[0], quantity: 1, serial_numbers: ['RN-9999'] }],
  });
  const device = commit.data.devices[0];

  const claim = new FormData();
  claim.append('device_id', String(device.id));
  claim.append('category', 'Not heating / not cooling');
  claim.append('description', 'Oven will not reach temperature.');
  claim.append('contact_name', 'Pat');
  claim.append('contact_phone', '0400 000 000');
  const lodged = await customer('POST', '/api/portal/claims', claim, { form: true });
  assert.strictEqual(lodged.status, 201);

  const notice = db.prepare("SELECT * FROM email_log WHERE template = 'new_claim_to_ches' ORDER BY id DESC").get();
  assert.match(notice.body, /THE CUSTOMER, NOT YET CHECKED/,
    'staff must see this before lodging it with the manufacturer');

  // Once checked, the warning goes away.
  const verified = await staff('POST', `/api/admin/devices/${device.id}/verify`, {});
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.data.device.awaiting_check, false);
  assert.ok(verified.data.device.verified_at);
});

test('a customer cannot add equipment onto anyone else', async () => {
  const staff = client();
  await staff('POST', '/api/auth/staff/login', { email: 'staff@ches.test', password: 'staff-pw' });
  const mine = await signedInCustomer(staff, 'own@baybistro3.test');
  const theirs = await signedInCustomer(staff, 'other@rival.test');

  const form = new FormData();
  form.append('file', new Blob([CUSTOMER_INVOICE], { type: 'text/csv' }), 'INV-77003.csv');
  const upload = await mine('POST', '/api/portal/invoices/upload', form, { form: true });

  // Someone else's draft is not theirs to commit.
  const stolen = await theirs('POST', `/api/portal/invoices/${upload.data.import_id}/commit`, {
    lines: upload.data.lines,
  });
  assert.strictEqual(stolen.status, 404);

  // Nor can a site belonging to another customer be used.
  const theirSites = await theirs('GET', '/api/portal/sites');
  const wrongSite = await mine('POST', `/api/portal/invoices/${upload.data.import_id}/commit`, {
    site_id: theirSites.data.sites[0].id,
    lines: upload.data.lines,
  });
  assert.strictEqual(wrongSite.status, 201);
  const landed = wrongSite.data.devices[0];
  assert.notStrictEqual(landed.site_id, theirSites.data.sites[0].id,
    'it falls back to their own site rather than filing onto another customer');
});
