'use strict';

/**
 * End-to-end test of the whole platform against a throwaway database:
 * staff sign-in, invoice import, customer sign-in, registration, a service
 * request, the system email to CHES, and the forward to the manufacturer.
 *
 * Run with:  npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the app at a temporary data directory before anything loads config.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ches-test-'));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-'.repeat(4);
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
    .run('Test Staff', 'staff@ches.test', auth.hashPassword('staff-password'), 'admin');
});

test.after(() => server && server.close());

/** Tiny fetch wrapper that keeps cookies per "browser". */
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
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

const SAMPLE_INVOICE_CSV = [
  '*ContactName,*InvoiceNumber,*InvoiceDate,Description,*Quantity,*UnitAmount',
  'Harbour Kitchen Pty Ltd,INV-90001,15/03/2026,SIMCO SD80 Underbench Dishwasher,2,3500.00',
  'Harbour Kitchen Pty Ltd,INV-90001,15/03/2026,Waldorf RN8610G-B Gas Oven Range,1,8250.00',
  'Harbour Kitchen Pty Ltd,INV-90001,15/03/2026,Freight to Sydney Metro,1,420.00',
].join('\n');

test('staff sign-in is required for the console', async () => {
  const anon = client();
  const res = await anon('GET', '/api/admin/stats');
  assert.strictEqual(res.status, 401);
});

test('bad staff password is rejected', async () => {
  const anon = client();
  const res = await anon('POST', '/api/auth/staff/login', { email: 'staff@ches.test', password: 'wrong' });
  assert.strictEqual(res.status, 401);
});

test('full lifecycle: import invoice, register, lodge a claim, forward it', async () => {
  const staff = client();
  const customer = client();

  // 1. Staff signs in.
  const login = await staff('POST', '/api/auth/staff/login', { email: 'staff@ches.test', password: 'staff-password' });
  assert.strictEqual(login.status, 200);

  // 2. Create the customer account.
  const created = await staff('POST', '/api/admin/customers', {
    company_name: 'Harbour Kitchen Pty Ltd',
    contact_name: 'Jo Tan',
    email: 'jo@harbourkitchen.test',
    phone: '02 9000 0000',
    address_line1: '5 Wharf Road',
    suburb: 'Pyrmont',
    state: 'NSW',
    postcode: '2009',
  });
  assert.strictEqual(created.status, 201);
  const customerId = created.data.customer.id;

  // 3. Upload the invoice.
  const form = new FormData();
  form.append('file', new Blob([SAMPLE_INVOICE_CSV], { type: 'text/csv' }), 'INV-90001.csv');
  const upload = await staff('POST', '/api/admin/invoices/upload', form, { form: true });
  assert.strictEqual(upload.status, 201);
  assert.strictEqual(upload.data.invoice_number, 'INV-90001');
  assert.strictEqual(upload.data.lines.length, 3);

  // Freight is detected as a charge, not a machine, so it arrives unticked.
  const freight = upload.data.lines.find((l) => /Freight/i.test(l.description));
  assert.strictEqual(freight.include, false);
  const dishwasher = upload.data.lines.find((l) => /SD80/.test(l.description));
  assert.strictEqual(dishwasher.brand, 'SIMCO');
  assert.strictEqual(dishwasher.model_code, 'SD80');
  assert.strictEqual(dishwasher.quantity, 2);

  // The invoice matched the customer we just created.
  assert.ok(upload.data.suggested_customer);
  assert.strictEqual(upload.data.suggested_customer.id, customerId);

  // 4. Commit: quantity 2 must become two separately tracked machines.
  const commit = await staff('POST', `/api/admin/invoices/${upload.data.import_id}/commit`, {
    customer_id: customerId,
    lines: upload.data.lines,
    send_invite: true,
  });
  assert.strictEqual(commit.status, 201);
  assert.strictEqual(commit.data.devices_created, 3, 'two dishwashers plus one oven, freight excluded');

  const tags = new Set(commit.data.devices.map((d) => d.asset_tag));
  assert.strictEqual(tags.size, 3, 'every machine gets its own asset tag');
  assert.ok(commit.data.devices.every((d) => d.status === 'pending_registration'));
  assert.ok(commit.data.devices.every((d) => d.purchase_date === '2026-03-15'));

  // Committing twice must not duplicate the equipment.
  const recommit = await staff('POST', `/api/admin/invoices/${upload.data.import_id}/commit`, { customer_id: customerId });
  assert.strictEqual(recommit.status, 409);

  // 5. The customer signs in with a code.
  const codeReq = await customer('POST', '/api/auth/request-code', { email: 'jo@harbourkitchen.test' });
  assert.strictEqual(codeReq.status, 200);
  assert.ok(codeReq.data.dev_code, 'dev mode returns the code');

  const wrongCode = await customer('POST', '/api/auth/verify-code', { email: 'jo@harbourkitchen.test', code: '000000' });
  assert.strictEqual(wrongCode.status, 401);

  const verify = await customer('POST', '/api/auth/verify-code', {
    email: 'jo@harbourkitchen.test',
    code: codeReq.data.dev_code,
  });
  assert.strictEqual(verify.status, 200);

  // A used code cannot be replayed.
  const replay = await client()('POST', '/api/auth/verify-code', {
    email: 'jo@harbourkitchen.test',
    code: codeReq.data.dev_code,
  });
  assert.strictEqual(replay.status, 401);

  // 6. Customer sees their equipment, all awaiting registration.
  const devices = await customer('GET', '/api/portal/devices');
  assert.strictEqual(devices.status, 200);
  assert.strictEqual(devices.data.devices.length, 3);
  assert.strictEqual(devices.data.summary.pending, 3);

  // 7. Update the profile including the on-site after-sales contact.
  const profile = await customer('PUT', '/api/portal/profile', {
    company_name: 'Harbour Kitchen Pty Ltd',
    contact_name: 'Jo Tan',
    phone: '02 9000 0000',
    address_line1: '5 Wharf Road',
    suburb: 'Pyrmont',
    state: 'NSW',
    postcode: '2009',
    site_contact_name: 'Mo Diallo',
    site_contact_role: 'Head chef',
    site_contact_phone: '0400 555 666',
    site_contact_email: 'mo@harbourkitchen.test',
  });
  assert.strictEqual(profile.status, 200);
  assert.strictEqual(profile.data.customer.site_contact_name, 'Mo Diallo');

  // An incomplete profile is rejected.
  const badProfile = await customer('PUT', '/api/portal/profile', { company_name: 'Harbour Kitchen Pty Ltd' });
  assert.strictEqual(badProfile.status, 400);
  assert.ok(badProfile.data.fields.site_contact_name);

  // 8. Register a machine — this starts the warranty clock.
  const target = devices.data.devices.find((d) => /SD80/.test(d.product_name));
  const register = await customer('PUT', `/api/portal/devices/${target.id}`, {
    delivered_at: '2026-03-20',
    serial_number: 'SN-TEST-0001',
    location_note: 'Kitchen line, under the pass',
  });
  assert.strictEqual(register.status, 200);
  assert.strictEqual(register.data.device.status, 'registered');
  assert.strictEqual(register.data.device.warranty_start, '2026-03-20');
  assert.strictEqual(register.data.device.warranty_end, '2027-03-20', 'delivery date + 12 months');

  // A future delivery date is refused.
  const future = await customer('PUT', `/api/portal/devices/${target.id}`, { delivered_at: '2099-01-01' });
  assert.strictEqual(future.status, 400);

  // 9. Lodge a service request against that machine.
  const claimForm = new FormData();
  claimForm.append('device_id', String(target.id));
  claimForm.append('category', 'Not working / no power');
  claimForm.append('priority', 'urgent');
  claimForm.append('description', 'Will not fill. Error E4 on the display.');
  claimForm.append('contact_name', 'Mo Diallo');
  claimForm.append('contact_phone', '0400 555 666');
  claimForm.append('files', new Blob([Buffer.from('fake-jpeg')], { type: 'image/jpeg' }), 'fault.jpg');

  const claim = await customer('POST', '/api/portal/claims', claimForm, { form: true });
  assert.strictEqual(claim.status, 201);
  assert.match(claim.data.reference, /^WR-\d{4}-\d{4}$/);
  assert.strictEqual(claim.data.claim.under_warranty, true);

  // 10. The system email reached the CHES inbox with the details that matter.
  const chesMail = db.prepare("SELECT * FROM email_log WHERE template = 'new_claim_to_ches' ORDER BY id DESC").get();
  assert.ok(chesMail, 'CHES is notified of every new request');
  assert.match(chesMail.subject, /URGENT/);
  assert.match(chesMail.body, /Mo Diallo/, 'on-site contact is in the email');
  assert.match(chesMail.body, /0400 555 666/);
  assert.match(chesMail.body, /SN-TEST-0001/, 'serial number is in the email');
  assert.match(chesMail.body, /IN WARRANTY/);
  assert.match(chesMail.body, /5 Wharf Road/, 'site address is in the email');
  assert.match(chesMail.body, /fault\.jpg/, 'attachment is linked');

  // And the customer got their receipt.
  const receipt = db.prepare("SELECT * FROM email_log WHERE template = 'claim_receipt' ORDER BY id DESC").get();
  assert.ok(receipt);
  assert.match(receipt.to_addr, /harbourkitchen\.test/);

  // 11. Staff forwards it to the manufacturer.
  const mfr = await staff('POST', '/api/admin/manufacturers', {
    name: 'SIMCO Test Service',
    service_email: 'service@simco.test',
  });
  assert.strictEqual(mfr.status, 201);

  const claimId = claim.data.claim.id;
  const draft = await staff('GET', `/api/admin/claims/${claimId}/forward?manufacturer_id=${mfr.data.manufacturer.id}`);
  assert.strictEqual(draft.status, 200);
  assert.strictEqual(draft.data.to, 'service@simco.test');
  assert.match(draft.data.body, /SN-TEST-0001/);
  assert.match(draft.data.body, /Error E4/);

  const sent = await staff('POST', `/api/admin/claims/${claimId}/forward`, {
    manufacturer_id: mfr.data.manufacturer.id,
    to: 'service@simco.test',
    subject: draft.data.subject,
    body: draft.data.body,
    notify_customer: true,
  });
  assert.strictEqual(sent.status, 200);
  assert.strictEqual(sent.data.claim.status, 'sent_to_manufacturer');

  const forwarded = db.prepare("SELECT * FROM email_log WHERE template = 'forward_to_manufacturer' ORDER BY id DESC").get();
  assert.strictEqual(forwarded.to_addr, 'service@simco.test');

  // 12. The customer can see the request and its history.
  const myClaims = await customer('GET', '/api/portal/claims');
  assert.strictEqual(myClaims.data.claims.length, 1);
  assert.strictEqual(myClaims.data.claims[0].status, 'sent_to_manufacturer');
});

test('a customer cannot read another customer data', async () => {
  const staff = client();
  await staff('POST', '/api/auth/staff/login', { email: 'staff@ches.test', password: 'staff-password' });

  const other = await staff('POST', '/api/admin/customers', {
    company_name: 'Rival Bistro', email: 'rival@bistro.test',
  });
  const device = await staff('POST', '/api/admin/devices', {
    customer_id: other.data.customer.id, product_name: 'Rival fryer',
  });

  const intruder = client();
  const code = await intruder('POST', '/api/auth/request-code', { email: 'jo@harbourkitchen.test' });
  await intruder('POST', '/api/auth/verify-code', { email: 'jo@harbourkitchen.test', code: code.data.dev_code });

  const peek = await intruder('GET', `/api/portal/devices/${device.data.device.id}`);
  assert.strictEqual(peek.status, 404, 'another customer machine is not visible');

  const edit = await intruder('PUT', `/api/portal/devices/${device.data.device.id}`, { delivered_at: '2026-01-01' });
  assert.strictEqual(edit.status, 404);

  const claimAttempt = new FormData();
  claimAttempt.append('device_id', String(device.data.device.id));
  claimAttempt.append('category', 'Other');
  claimAttempt.append('description', 'Trying to claim on someone else machine');
  claimAttempt.append('contact_name', 'X');
  claimAttempt.append('contact_phone', '0400 000 000');
  const lodged = await intruder('POST', '/api/portal/claims', claimAttempt, { form: true });
  assert.strictEqual(lodged.status, 400);
});

test('an unknown email does not reveal whether the account exists', async () => {
  const anon = client();
  const res = await anon('POST', '/api/auth/request-code', { email: 'nobody@nowhere.test' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.sent, true);
  assert.strictEqual(res.data.dev_code, undefined, 'no code is issued for an unknown address');

  const verify = await anon('POST', '/api/auth/verify-code', { email: 'nobody@nowhere.test', code: '123456' });
  assert.strictEqual(verify.status, 401);
});

test('warranty status is derived from the delivery date', async () => {
  const { warrantyFor } = require('../server/lib/dates');

  const fresh = warrantyFor({ delivered_at: new Date().toISOString().slice(0, 10), warranty_months: 12 });
  assert.strictEqual(fresh.status, 'active');

  const old = warrantyFor({ delivered_at: '2020-01-01', warranty_months: 12 });
  assert.strictEqual(old.status, 'expired');

  const soon = new Date(Date.now() - 335 * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(warrantyFor({ delivered_at: soon, warranty_months: 12 }).status, 'expiring');

  // Falls back to the invoice date until the customer confirms delivery.
  const notYetRegistered = warrantyFor({ delivered_at: null, purchase_date: '2026-01-15', warranty_months: 24 });
  assert.strictEqual(notYetRegistered.warranty_start, '2026-01-15');
  assert.strictEqual(notYetRegistered.warranty_end, '2028-01-15');
});
