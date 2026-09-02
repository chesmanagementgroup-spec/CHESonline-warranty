'use strict';

const express = require('express');
const config = require('../config');
const { db, nextAssetTag } = require('../db');
const { requireStaff } = require('../auth');
const auth = require('../auth');
const v = require('../lib/validate');
const asyncRoute = require('../lib/asyncRoute');
const { sendMail } = require('../mailer');
const templates = require('../lib/templates');
const { warrantyFor } = require('../lib/dates');
const {
  listSites,
  getSite,
  createSite,
  defaultSite,
  CLAIM_STATUSES,
  CLAIM_STATUS_LABELS,
  CLAIM_CATEGORIES,
  DEVICE_STATUSES,
  decorateDevice,
  decorateClaim,
  getDevice,
  getClaim,
  claimEvents,
  addClaimEvent,
  attachmentsFor,
  refreshWarranty,
  findOrCreateManufacturer,
  customerByEmail,
} = require('../lib/models');

const router = express.Router();
router.use(requireStaff);

const actor = (req) => `${req.staff.name} <${req.staff.email}>`;

// --- Dashboard -------------------------------------------------------------

router.get('/stats', (req, res) => {
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const devices = db.prepare('SELECT * FROM devices').all().map(decorateDevice);

  res.json({
    customers: one('SELECT COUNT(*) AS n FROM customers'),
    devices: devices.length,
    devices_in_warranty: devices.filter((d) => d.warranty_status === 'active' || d.warranty_status === 'expiring').length,
    devices_expiring_60d: devices.filter((d) => d.warranty_status === 'expiring').length,
    devices_expired: devices.filter((d) => d.warranty_status === 'expired').length,
    claims_open: one("SELECT COUNT(*) AS n FROM claims WHERE status NOT IN ('resolved','closed')"),
    claims_new: one("SELECT COUNT(*) AS n FROM claims WHERE status = 'submitted'"),
    claims_total: one('SELECT COUNT(*) AS n FROM claims'),
    smtp_configured: require('../mailer').isSmtpConfigured(),
    expiring_soon: devices
      .filter((d) => d.warranty_status === 'expiring')
      .sort((a, b) => String(a.warranty_end).localeCompare(String(b.warranty_end)))
      .slice(0, 20),
  });
});

router.get('/meta', (req, res) => {
  res.json({
    claim_statuses: CLAIM_STATUSES,
    claim_status_labels: CLAIM_STATUS_LABELS,
    claim_categories: CLAIM_CATEGORIES,
    device_statuses: DEVICE_STATUSES,
    default_warranty_months: config.defaultWarrantyMonths,
    manufacturers: db.prepare('SELECT * FROM manufacturers ORDER BY name COLLATE NOCASE').all(),
  });
});

// --- Customers -------------------------------------------------------------

router.get('/customers', (req, res) => {
  const q = `%${v.str(req.query.q, 80)}%`;
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM devices d WHERE d.customer_id = c.id) AS device_count,
      (SELECT COUNT(*) FROM sites st WHERE st.customer_id = c.id AND st.archived = 0) AS site_count,
      (SELECT COUNT(*) FROM claims cl WHERE cl.customer_id = c.id AND cl.status NOT IN ('resolved','closed')) AS open_claims
    FROM customers c
    WHERE (@blank = 1
       OR c.company_name LIKE @q COLLATE NOCASE
       OR c.email LIKE @q COLLATE NOCASE
       OR c.contact_name LIKE @q COLLATE NOCASE
       OR c.suburb LIKE @q COLLATE NOCASE)
    ORDER BY c.company_name COLLATE NOCASE
  `).all({ q, blank: v.str(req.query.q) ? 0 : 1 });
  res.json({ customers: rows });
});

router.get('/customers/:id', (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'not_found' });
  res.json({
    customer,
    sites: listSites(id),
    devices: db.prepare(`
      SELECT d.*, s.name AS site_name FROM devices d
      LEFT JOIN sites s ON s.id = d.site_id
      WHERE d.customer_id = ? ORDER BY s.name COLLATE NOCASE, d.asset_tag
    `).all(id).map(decorateDevice),
    claims: db.prepare(`
      SELECT cl.*, d.product_name AS device_name, d.asset_tag
      FROM claims cl LEFT JOIN devices d ON d.id = cl.device_id
      WHERE cl.customer_id = ? ORDER BY cl.id DESC
    `).all(id).map(decorateClaim),
  });
});

function customerFields(b) {
  return {
    company_name: v.str(b.company_name, 200),
    contact_name: v.str(b.contact_name, 120),
    email: v.email(b.email),
    phone: v.str(b.phone, 40),
    address_line1: v.str(b.address_line1, 200),
    address_line2: v.str(b.address_line2, 200),
    suburb: v.str(b.suburb, 100),
    state: v.str(b.state, 40),
    postcode: v.str(b.postcode, 16),
    country: v.str(b.country, 60) || 'Australia',
    site_contact_name: v.str(b.site_contact_name, 120),
    site_contact_role: v.str(b.site_contact_role, 120),
    site_contact_phone: v.str(b.site_contact_phone, 40),
    site_contact_email: v.email(b.site_contact_email),
    notes: v.str(b.notes, 4000),
  };
}

router.post('/customers', (req, res) => {
  const b = req.body || {};
  const errors = v.requireFields([
    ['company_name', b.company_name, 'Business name is required'],
    ['email', b.email, 'Email is required — it is how the customer signs in'],
  ]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });
  if (!v.isEmail(b.email)) return res.status(400).json({ error: 'validation', fields: { email: 'Invalid email address' } });
  if (customerByEmail(b.email)) {
    return res.status(409).json({ error: 'validation', fields: { email: 'A customer with this email already exists' } });
  }

  const fields = customerFields(b);
  const info = db.prepare(`
    INSERT INTO customers (company_name, contact_name, email, phone, address_line1, address_line2,
                           suburb, state, postcode, country, site_contact_name, site_contact_role,
                           site_contact_phone, site_contact_email, notes)
    VALUES (@company_name, @contact_name, @email, @phone, @address_line1, @address_line2,
            @suburb, @state, @postcode, @country, @site_contact_name, @site_contact_role,
            @site_contact_phone, @site_contact_email, @notes)
  `).run(fields);

  // Every customer starts with one site; equipment hangs off a site, not off
  // the customer, so there has to be somewhere for it to land.
  createSite(info.lastInsertRowid, {
    name: v.str(b.site_name, 120) || fields.suburb || fields.company_name,
    address_line1: fields.address_line1,
    address_line2: fields.address_line2,
    suburb: fields.suburb,
    state: fields.state,
    postcode: fields.postcode,
    country: fields.country,
    contact_name: fields.site_contact_name || fields.contact_name,
    contact_role: fields.site_contact_role,
    contact_phone: fields.site_contact_phone || fields.phone,
    contact_email: fields.site_contact_email,
  });

  res.status(201).json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/customers/:id', (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  if (!v.str(b.company_name)) {
    return res.status(400).json({ error: 'validation', fields: { company_name: 'Business name is required' } });
  }
  const email = v.email(b.email) || existing.email;
  if (!v.isEmail(email)) return res.status(400).json({ error: 'validation', fields: { email: 'Invalid email address' } });
  const clash = customerByEmail(email);
  if (clash && clash.id !== id) {
    return res.status(409).json({ error: 'validation', fields: { email: 'Another customer already uses this email' } });
  }

  db.prepare(`
    UPDATE customers SET
      company_name = @company_name, contact_name = @contact_name, email = @email, phone = @phone,
      address_line1 = @address_line1, address_line2 = @address_line2, suburb = @suburb,
      state = @state, postcode = @postcode, country = @country,
      site_contact_name = @site_contact_name, site_contact_role = @site_contact_role,
      site_contact_phone = @site_contact_phone, site_contact_email = @site_contact_email,
      notes = @notes, updated_at = datetime('now')
    WHERE id = @id
  `).run({ ...customerFields(b), email, id });

  res.json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(id) });
});

/** Nudge a customer to register the equipment we have on file for them. */
router.post('/customers/:id/invite', asyncRoute(async (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'not_found' });

  const devices = db.prepare('SELECT * FROM devices WHERE customer_id = ? ORDER BY asset_tag').all(id);
  if (!devices.length) return res.status(400).json({ error: 'no_devices' });

  const msg = templates.equipmentHandover({
    customer,
    devices: devices.map(decorateDevice),
    invoiceNumber: v.str(req.body && req.body.invoice_number, 60),
    site: defaultSite(customer.id),
    portalUrl: auth.magicLinkUrl(customer.id),
  });
  const result = await sendMail({
    to: customer.email,
    subject: msg.subject,
    text: msg.text,
    template: 'equipment_handover',
    relatedType: 'customer',
    relatedId: id,
  });
  res.json({ ok: result.ok, status: result.status });
}));

// --- Sites ------------------------------------------------------------------

router.get('/customers/:id/sites', (req, res) => {
  res.json({ sites: listSites(v.int(req.params.id, { fallback: 0 })) });
});

router.post('/customers/:id/sites', (req, res) => {
  const customerId = v.int(req.params.id, { fallback: 0 });
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) {
    return res.status(404).json({ error: 'not_found' });
  }
  const b = req.body || {};
  if (!v.str(b.name)) return res.status(400).json({ error: 'validation', fields: { name: 'Site name is required' } });
  res.status(201).json({
    ok: true,
    site: createSite(customerId, {
      name: v.str(b.name, 120),
      address_line1: v.str(b.address_line1, 200),
      address_line2: v.str(b.address_line2, 200),
      suburb: v.str(b.suburb, 100),
      state: v.str(b.state, 40),
      postcode: v.str(b.postcode, 16),
      contact_name: v.str(b.contact_name, 120),
      contact_role: v.str(b.contact_role, 120),
      contact_phone: v.str(b.contact_phone, 40),
      contact_email: v.email(b.contact_email),
      notes: v.str(b.notes, 2000),
    }),
  });
});

router.put('/sites/:id', (req, res) => {
  const site = getSite(v.int(req.params.id, { fallback: 0 }));
  if (!site) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE sites SET name = @name, address_line1 = @address_line1, address_line2 = @address_line2,
      suburb = @suburb, state = @state, postcode = @postcode,
      contact_name = @contact_name, contact_role = @contact_role,
      contact_phone = @contact_phone, contact_email = @contact_email,
      notes = @notes, updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: site.id,
    name: v.str(b.name, 120) || site.name,
    address_line1: v.str(b.address_line1, 200),
    address_line2: v.str(b.address_line2, 200),
    suburb: v.str(b.suburb, 100),
    state: v.str(b.state, 40),
    postcode: v.str(b.postcode, 16),
    contact_name: v.str(b.contact_name, 120),
    contact_role: v.str(b.contact_role, 120),
    contact_phone: v.str(b.contact_phone, 40),
    contact_email: v.email(b.contact_email),
    notes: v.str(b.notes, 2000),
  });
  res.json({ ok: true, site: getSite(site.id) });
});

// --- Devices ---------------------------------------------------------------

router.get('/devices', (req, res) => {
  const q = `%${v.str(req.query.q, 80)}%`;
  const blank = v.str(req.query.q) ? 0 : 1;
  const customerId = v.int(req.query.customer_id, { fallback: 0 });
  const rows = db.prepare(`
    SELECT d.*, c.company_name AS customer_name, c.email AS customer_email,
           m.name AS manufacturer_name, s.name AS site_name
    FROM devices d
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN manufacturers m ON m.id = d.manufacturer_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE (@customer_id = 0 OR d.customer_id = @customer_id)
      AND (@blank = 1
        OR d.product_name LIKE @q COLLATE NOCASE
        OR d.model_code LIKE @q COLLATE NOCASE
        OR d.serial_number LIKE @q COLLATE NOCASE
        OR d.asset_tag LIKE @q COLLATE NOCASE
        OR d.invoice_number LIKE @q COLLATE NOCASE
        OR s.name LIKE @q COLLATE NOCASE
        OR c.company_name LIKE @q COLLATE NOCASE)
    ORDER BY d.id DESC
    LIMIT 500
  `).all({ q, blank, customer_id: customerId });
  res.json({ devices: rows.map(decorateDevice) });
});

router.get('/devices/:id', (req, res) => {
  const device = getDevice(v.int(req.params.id, { fallback: 0 }));
  if (!device) return res.status(404).json({ error: 'not_found' });
  res.json({ device, attachments: attachmentsFor({ deviceId: device.id }) });
});

/** CHES can create or correct any field on a device. */
router.post('/devices', (req, res) => {
  const b = req.body || {};
  const errors = v.requireFields([
    ['customer_id', b.customer_id, 'Choose a customer'],
    ['product_name', b.product_name, 'Product name is required'],
  ]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });

  const customerId = v.int(b.customer_id, { fallback: 0 });
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) {
    return res.status(400).json({ error: 'validation', fields: { customer_id: 'Unknown customer' } });
  }

  const manufacturer = b.brand ? findOrCreateManufacturer(b.brand) : null;
  const deliveredAt = require('../lib/dates').toIsoDate(b.delivered_at);
  const info = db.prepare(`
    INSERT INTO devices (customer_id, site_id, asset_tag, invoice_number, product_name, model_code, brand,
                         manufacturer_id, serial_number, purchase_date, delivered_at, warranty_months,
                         location_note, unit_price_ex_gst, status, notes)
    VALUES (@customer_id, @site_id, @asset_tag, @invoice_number, @product_name, @model_code, @brand,
            @manufacturer_id, @serial_number, @purchase_date, @delivered_at, @warranty_months,
            @location_note, @unit_price_ex_gst, @status, @notes)
  `).run({
    customer_id: customerId,
    site_id: v.int(b.site_id, { fallback: null }) || (defaultSite(customerId) || {}).id || null,
    asset_tag: v.str(b.asset_tag, 40) || nextAssetTag(),
    invoice_number: v.str(b.invoice_number, 60).toUpperCase(),
    product_name: v.str(b.product_name, 200),
    model_code: v.str(b.model_code, 80),
    brand: v.str(b.brand, 80),
    manufacturer_id: manufacturer ? manufacturer.id : null,
    serial_number: v.str(b.serial_number, 120),
    purchase_date: require('../lib/dates').toIsoDate(b.purchase_date),
    delivered_at: deliveredAt,
    warranty_months: v.int(b.warranty_months, { min: 0, max: 240, fallback: config.defaultWarrantyMonths }),
    location_note: v.str(b.location_note, 200),
    unit_price_ex_gst: v.money(b.unit_price_ex_gst),
    status: 'active',
    notes: v.str(b.notes, 4000),
  });

  refreshWarranty(info.lastInsertRowid);
  res.status(201).json({ ok: true, device: getDevice(info.lastInsertRowid) });
});

router.put('/devices/:id', (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const { toIsoDate } = require('../lib/dates');
  const manufacturer = b.brand ? findOrCreateManufacturer(b.brand) : null;

  db.prepare(`
    UPDATE devices SET
      customer_id = @customer_id, site_id = @site_id, invoice_number = @invoice_number, product_name = @product_name,
      model_code = @model_code, brand = @brand, manufacturer_id = @manufacturer_id,
      serial_number = @serial_number, purchase_date = @purchase_date, delivered_at = @delivered_at,
      warranty_months = @warranty_months, location_note = @location_note,
      unit_price_ex_gst = @unit_price_ex_gst, status = @status, notes = @notes,
      registered_at = CASE WHEN @delivered_at IS NOT NULL THEN COALESCE(registered_at, datetime('now')) ELSE registered_at END,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id,
    customer_id: v.int(b.customer_id, { fallback: existing.customer_id }),
    site_id: v.int(b.site_id, { fallback: existing.site_id }),
    invoice_number: v.str(b.invoice_number, 60).toUpperCase(),
    product_name: v.str(b.product_name, 200) || existing.product_name,
    model_code: v.str(b.model_code, 80),
    brand: v.str(b.brand, 80),
    manufacturer_id: manufacturer ? manufacturer.id : existing.manufacturer_id,
    serial_number: v.str(b.serial_number, 120),
    purchase_date: toIsoDate(b.purchase_date),
    delivered_at: toIsoDate(b.delivered_at),
    warranty_months: v.int(b.warranty_months, { min: 0, max: 240, fallback: existing.warranty_months }),
    location_note: v.str(b.location_note, 200),
    unit_price_ex_gst: v.money(b.unit_price_ex_gst),
    status: v.oneOf(b.status, DEVICE_STATUSES, existing.status),
    notes: v.str(b.notes, 4000),
  });

  refreshWarranty(id);
  res.json({ ok: true, device: getDevice(id) });
});

router.delete('/devices/:id', (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const linked = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE device_id = ?').get(id).n;
  if (linked) {
    return res.status(409).json({ error: 'has_claims', message: 'This machine has service history. Mark it decommissioned instead.' });
  }
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Claims ----------------------------------------------------------------

router.get('/claims', (req, res) => {
  const status = v.str(req.query.status, 40);
  const q = `%${v.str(req.query.q, 80)}%`;
  const rows = db.prepare(`
    SELECT cl.*, c.company_name AS customer_name, c.email AS customer_email,
           d.product_name AS device_name, d.asset_tag, d.serial_number, d.brand, d.model_code,
           m.name AS manufacturer_name
    FROM claims cl
    JOIN customers c ON c.id = cl.customer_id
    LEFT JOIN devices d ON d.id = cl.device_id
    LEFT JOIN manufacturers m ON m.id = cl.manufacturer_id
    WHERE (@status = '' OR cl.status = @status
           OR (@status = 'open' AND cl.status NOT IN ('resolved','closed')))
      AND (@blank = 1
        OR cl.reference LIKE @q COLLATE NOCASE
        OR c.company_name LIKE @q COLLATE NOCASE
        OR d.product_name LIKE @q COLLATE NOCASE
        OR cl.manufacturer_ref LIKE @q COLLATE NOCASE)
    ORDER BY cl.id DESC
    LIMIT 500
  `).all({ status, q, blank: v.str(req.query.q) ? 0 : 1 });
  res.json({ claims: rows.map(decorateClaim) });
});

router.get('/claims/:id', (req, res) => {
  const claim = getClaim(v.int(req.params.id, { fallback: 0 }));
  if (!claim) return res.status(404).json({ error: 'not_found' });
  const device = claim.device_id ? getDevice(claim.device_id) : null;
  res.json({
    claim,
    device,
    customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(claim.customer_id),
    events: claimEvents(claim.id),
    attachments: attachmentsFor({ claimId: claim.id }),
  });
});

/** Change status, record the factory job number, add internal notes. */
router.put('/claims/:id', asyncRoute(async (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const existing = getClaim(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const status = v.oneOf(b.status, CLAIM_STATUSES, existing.status);
  const manufacturerId = b.manufacturer_id === undefined
    ? existing.manufacturer_id
    : v.int(b.manufacturer_id, { fallback: null });

  db.prepare(`
    UPDATE claims SET
      status = @status, priority = @priority, manufacturer_id = @manufacturer_id,
      manufacturer_ref = @manufacturer_ref, internal_notes = @internal_notes,
      resolved_at = CASE WHEN @status IN ('resolved','closed') THEN COALESCE(resolved_at, datetime('now')) ELSE NULL END,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id,
    status,
    priority: v.oneOf(b.priority, ['low', 'normal', 'urgent'], existing.priority),
    manufacturer_id: manufacturerId,
    manufacturer_ref: v.str(b.manufacturer_ref, 80),
    internal_notes: v.str(b.internal_notes, 8000),
  });

  if (status !== existing.status) {
    addClaimEvent(id, {
      actorType: 'staff',
      actorLabel: actor(req),
      type: 'status',
      message: `Status changed from "${CLAIM_STATUS_LABELS[existing.status] || existing.status}" to "${CLAIM_STATUS_LABELS[status] || status}".`,
    });

    if (b.notify_customer) {
      const claim = getClaim(id);
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(claim.customer_id);
      const device = claim.device_id ? getDevice(claim.device_id) : null;
      const msg = templates.claimStatusUpdate({
        claim,
        customer,
        device,
        statusLabel: CLAIM_STATUS_LABELS[status] || status,
        note: v.str(b.customer_note, 2000),
        portalUrl: auth.magicLinkUrl(customer.id),
      });
      const result = await sendMail({
        to: claim.contact_email || customer.email,
        subject: msg.subject,
        text: msg.text,
        template: 'claim_status_update',
        relatedType: 'claim',
        relatedId: id,
      });
      addClaimEvent(id, {
        actorType: 'system',
        type: 'email',
        message: `Status update ${result.status} to ${claim.contact_email || customer.email}.`,
      });
    }
  }

  res.json({ ok: true, claim: getClaim(id), events: claimEvents(id) });
}));

router.post('/claims/:id/notes', (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  if (!getClaim(id)) return res.status(404).json({ error: 'not_found' });
  const message = v.str(req.body.message, 4000);
  if (!message) return res.status(400).json({ error: 'validation', fields: { message: 'Note is empty' } });

  addClaimEvent(id, {
    actorType: 'staff',
    actorLabel: actor(req),
    type: 'note',
    message,
    visibleToCustomer: Boolean(req.body.visible_to_customer),
  });
  res.json({ ok: true, events: claimEvents(id) });
});

/**
 * Build the manufacturer email for a claim. GET returns the draft so staff
 * can read it before anything leaves the building; POST sends it.
 */
function buildForward(req, claim) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(claim.customer_id);
  const device = claim.device_id ? getDevice(claim.device_id) : null;
  const manufacturerId = v.int((req.body && req.body.manufacturer_id) || (req.query && req.query.manufacturer_id), {
    fallback: claim.manufacturer_id,
  });
  const manufacturer = manufacturerId
    ? db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(manufacturerId)
    : null;

  const msg = templates.forwardToManufacturer({
    claim,
    customer,
    device,
    manufacturer,
    warranty: device ? warrantyFor(device) : null,
    attachments: attachmentsFor({ claimId: claim.id }),
    extraNote: v.str((req.body && req.body.note) || (req.query && req.query.note), 4000),
  });
  return { msg, manufacturer, customer, device };
}

router.get('/claims/:id/forward', (req, res) => {
  const claim = getClaim(v.int(req.params.id, { fallback: 0 }));
  if (!claim) return res.status(404).json({ error: 'not_found' });
  const { msg, manufacturer } = buildForward(req, claim);
  res.json({
    to: (manufacturer && manufacturer.service_email) || '',
    manufacturer,
    subject: msg.subject,
    body: msg.text,
    portal_url: (manufacturer && manufacturer.portal_url) || '',
  });
});

router.post('/claims/:id/forward', asyncRoute(async (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const claim = getClaim(id);
  if (!claim) return res.status(404).json({ error: 'not_found' });

  const { msg, manufacturer, customer } = buildForward(req, claim);
  const to = v.email(req.body.to) || (manufacturer && manufacturer.service_email);
  if (!v.isEmail(to)) {
    return res.status(400).json({ error: 'validation', fields: { to: 'A manufacturer service email is required' } });
  }

  const subject = v.str(req.body.subject, 300) || msg.subject;
  const body = v.str(req.body.body, 40000) || msg.text;

  const result = await sendMail({
    to,
    cc: v.email(req.body.cc),
    replyTo: config.ches.serviceEmail,
    subject,
    text: body,
    template: 'forward_to_manufacturer',
    relatedType: 'claim',
    relatedId: id,
  });

  db.prepare(`
    UPDATE claims SET
      status = CASE WHEN status IN ('submitted','acknowledged') THEN 'sent_to_manufacturer' ELSE status END,
      manufacturer_id = COALESCE(@manufacturer_id, manufacturer_id),
      forwarded_at = datetime('now'), updated_at = datetime('now')
    WHERE id = @id
  `).run({ id, manufacturer_id: manufacturer ? manufacturer.id : null });

  addClaimEvent(id, {
    actorType: 'staff',
    actorLabel: actor(req),
    type: 'email',
    message: `Forwarded to ${manufacturer ? manufacturer.name : to} (${to}) — ${result.status}.`,
  });

  if (req.body.notify_customer) {
    const fresh = getClaim(id);
    const device = fresh.device_id ? getDevice(fresh.device_id) : null;
    const note = templates.claimStatusUpdate({
      claim: fresh,
      customer,
      device,
      statusLabel: CLAIM_STATUS_LABELS.sent_to_manufacturer,
      note: `We have lodged this with ${manufacturer ? manufacturer.name : 'the manufacturer'} on your behalf.`,
      portalUrl: auth.magicLinkUrl(customer.id),
    });
    await sendMail({
      to: fresh.contact_email || customer.email,
      subject: note.subject,
      text: note.text,
      template: 'claim_status_update',
      relatedType: 'claim',
      relatedId: id,
    });
  }

  res.json({ ok: result.ok, status: result.status, error: result.error || '', claim: getClaim(id), events: claimEvents(id) });
}));

// --- Manufacturers ---------------------------------------------------------

router.get('/manufacturers', (req, res) => {
  res.json({
    manufacturers: db.prepare(`
      SELECT m.*, (SELECT COUNT(*) FROM devices d WHERE d.manufacturer_id = m.id) AS device_count
      FROM manufacturers m ORDER BY m.name COLLATE NOCASE
    `).all(),
  });
});

router.post('/manufacturers', (req, res) => {
  const b = req.body || {};
  if (!v.str(b.name)) return res.status(400).json({ error: 'validation', fields: { name: 'Name is required' } });
  if (b.service_email && !v.isEmail(b.service_email)) {
    return res.status(400).json({ error: 'validation', fields: { service_email: 'Invalid email address' } });
  }
  const existing = db.prepare('SELECT id FROM manufacturers WHERE lower(name) = lower(?)').get(v.str(b.name, 120));
  if (existing) return res.status(409).json({ error: 'validation', fields: { name: 'Already on the list' } });

  const info = db.prepare(`
    INSERT INTO manufacturers (name, service_email, portal_url, phone, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(v.str(b.name, 120), v.email(b.service_email), v.str(b.portal_url, 300), v.str(b.phone, 40), v.str(b.notes, 2000));
  res.status(201).json({ ok: true, manufacturer: db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/manufacturers/:id', (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const existing = db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  if (b.service_email && !v.isEmail(b.service_email)) {
    return res.status(400).json({ error: 'validation', fields: { service_email: 'Invalid email address' } });
  }
  db.prepare(`
    UPDATE manufacturers SET name = ?, service_email = ?, portal_url = ?, phone = ?, notes = ?,
      updated_at = datetime('now') WHERE id = ?
  `).run(
    v.str(b.name, 120) || existing.name,
    v.email(b.service_email),
    v.str(b.portal_url, 300),
    v.str(b.phone, 40),
    v.str(b.notes, 2000),
    id
  );
  res.json({ ok: true, manufacturer: db.prepare('SELECT * FROM manufacturers WHERE id = ?').get(id) });
});

// --- Email log -------------------------------------------------------------

router.get('/emails', (req, res) => {
  res.json({
    emails: db.prepare(`
      SELECT id, to_addr, cc_addr, subject, template, status, error, related_type, related_id, created_at
      FROM email_log ORDER BY id DESC LIMIT 200
    `).all(),
    smtp_configured: require('../mailer').isSmtpConfigured(),
  });
});

router.get('/emails/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM email_log WHERE id = ?').get(v.int(req.params.id, { fallback: 0 }));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ email: row });
});

module.exports = router;
