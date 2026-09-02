'use strict';

const express = require('express');
const config = require('../config');
const { db, nextClaimReference, nextAssetTag } = require('../db');
const { requireCustomer } = require('../auth');
const v = require('../lib/validate');
const { mediaUpload, recordAttachments } = require('../lib/uploads');
const { sendMail } = require('../mailer');
const templates = require('../lib/templates');
const {
  CLAIM_CATEGORIES,
  listDevicesForCustomer,
  getDevice,
  getClaim,
  decorateClaim,
  claimEvents,
  addClaimEvent,
  attachmentsFor,
  refreshWarranty,
  findOrCreateManufacturer,
  touch,
  toIsoDate,
} = require('../lib/models');
const { warrantyFor } = require('../lib/dates');

const router = express.Router();
router.use(requireCustomer);

// --- Profile ---------------------------------------------------------------

router.get('/profile', (req, res) => {
  res.json({ customer: req.customer, categories: CLAIM_CATEGORIES });
});

/**
 * The customer maintains their own delivery address, phone and — the field
 * that actually matters when a machine breaks — the on-site after-sales
 * contact.  Email is deliberately not editable here: it is the login
 * identity, so changing it goes through CHES.
 */
router.put('/profile', (req, res) => {
  const b = req.body || {};
  const errors = v.requireFields([
    ['company_name', b.company_name, 'Business name is required'],
    ['contact_name', b.contact_name, 'Contact name is required'],
    ['phone', b.phone, 'Phone number is required'],
    ['address_line1', b.address_line1, 'Street address is required'],
    ['suburb', b.suburb, 'Suburb is required'],
    ['state', b.state, 'State is required'],
    ['postcode', b.postcode, 'Postcode is required'],
    ['site_contact_name', b.site_contact_name, 'On-site contact name is required'],
    ['site_contact_phone', b.site_contact_phone, 'On-site contact phone is required'],
  ]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });

  if (b.site_contact_email && !v.isEmail(b.site_contact_email)) {
    return res.status(400).json({ error: 'validation', fields: { site_contact_email: 'Invalid email address' } });
  }

  db.prepare(`
    UPDATE customers SET
      company_name = @company_name, contact_name = @contact_name, phone = @phone,
      address_line1 = @address_line1, address_line2 = @address_line2,
      suburb = @suburb, state = @state, postcode = @postcode, country = @country,
      site_contact_name = @site_contact_name, site_contact_role = @site_contact_role,
      site_contact_phone = @site_contact_phone, site_contact_email = @site_contact_email,
      profile_completed_at = COALESCE(profile_completed_at, datetime('now')),
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: req.customer.id,
    company_name: v.str(b.company_name, 200),
    contact_name: v.str(b.contact_name, 120),
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
  });

  res.json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id) });
});

// --- Devices ---------------------------------------------------------------

router.get('/devices', (req, res) => {
  const devices = listDevicesForCustomer(req.customer.id);
  res.json({
    devices,
    summary: {
      total: devices.length,
      pending: devices.filter((d) => d.needs_registration).length,
      in_warranty: devices.filter((d) => d.warranty_status === 'active' || d.warranty_status === 'expiring').length,
      expiring: devices.filter((d) => d.warranty_status === 'expiring').length,
      expired: devices.filter((d) => d.warranty_status === 'expired').length,
    },
  });
});

function ownedDevice(req, res) {
  const device = getDevice(v.int(req.params.id, { fallback: 0 }));
  if (!device || device.customer_id !== req.customer.id) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return device;
}

router.get('/devices/:id', (req, res) => {
  const device = ownedDevice(req, res);
  if (!device) return;
  res.json({ device, attachments: attachmentsFor({ deviceId: device.id }) });
});

/**
 * Registration: the customer confirms the machine arrived, on what date,
 * where it sits in the venue, and its serial number off the rating plate.
 * Confirming the delivery date is what starts the warranty clock.
 */
router.put('/devices/:id', (req, res) => {
  const device = ownedDevice(req, res);
  if (!device) return;

  const b = req.body || {};
  const deliveredAt = toIsoDate(b.delivered_at);
  if (b.delivered_at && !deliveredAt) {
    return res.status(400).json({ error: 'validation', fields: { delivered_at: 'Use the date picker (YYYY-MM-DD)' } });
  }
  if (deliveredAt && deliveredAt > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'validation', fields: { delivered_at: 'Delivery date cannot be in the future' } });
  }

  const registering = Boolean(deliveredAt);
  db.prepare(`
    UPDATE devices SET
      delivered_at = @delivered_at,
      serial_number = @serial_number,
      location_note = @location_note,
      notes = @notes,
      status = CASE WHEN @registering = 1 AND status = 'pending_registration' THEN 'registered' ELSE status END,
      registered_at = CASE WHEN @registering = 1 THEN COALESCE(registered_at, datetime('now')) ELSE registered_at END,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: device.id,
    delivered_at: deliveredAt,
    serial_number: v.str(b.serial_number, 120),
    location_note: v.str(b.location_note, 200),
    notes: v.str(b.notes, 2000),
    registering: registering ? 1 : 0,
  });

  refreshWarranty(device.id);
  res.json({ ok: true, device: getDevice(device.id) });
});

/** A machine that never made it onto an invoice import can be added by hand. */
router.post('/devices', (req, res) => {
  const b = req.body || {};
  const errors = v.requireFields([['product_name', b.product_name, 'Product name is required']]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });

  const manufacturer = b.brand ? findOrCreateManufacturer(b.brand) : null;
  const deliveredAt = toIsoDate(b.delivered_at);
  const info = db.prepare(`
    INSERT INTO devices (customer_id, asset_tag, invoice_number, product_name, model_code, brand,
                         manufacturer_id, serial_number, purchase_date, delivered_at, warranty_months,
                         location_note, status, registered_at, notes)
    VALUES (@customer_id, @asset_tag, @invoice_number, @product_name, @model_code, @brand,
            @manufacturer_id, @serial_number, @purchase_date, @delivered_at, @warranty_months,
            @location_note, @status, @registered_at, @notes)
  `).run({
    customer_id: req.customer.id,
    asset_tag: nextAssetTag(),
    invoice_number: v.str(b.invoice_number, 60).toUpperCase(),
    product_name: v.str(b.product_name, 200),
    model_code: v.str(b.model_code, 80),
    brand: v.str(b.brand, 80),
    manufacturer_id: manufacturer ? manufacturer.id : null,
    serial_number: v.str(b.serial_number, 120),
    purchase_date: toIsoDate(b.purchase_date),
    delivered_at: deliveredAt,
    warranty_months: v.int(b.warranty_months, { min: 0, max: 240, fallback: config.defaultWarrantyMonths }),
    location_note: v.str(b.location_note, 200),
    status: deliveredAt ? 'registered' : 'pending_registration',
    registered_at: deliveredAt ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    notes: v.str(b.notes, 2000),
  });

  refreshWarranty(info.lastInsertRowid);
  res.status(201).json({ ok: true, device: getDevice(info.lastInsertRowid) });
});

/** Photos of the rating plate / serial label, kept against the device. */
router.post('/devices/:id/photos', mediaUpload.array('files', config.upload.maxFilesPerRequest), (req, res) => {
  const device = ownedDevice(req, res);
  if (!device) return;
  const ids = recordAttachments(req.files, {
    deviceId: device.id,
    customerId: req.customer.id,
    kind: 'serial_label',
    uploadedBy: `customer:${req.customer.email}`,
  });
  res.json({ ok: true, attachment_ids: ids, attachments: attachmentsFor({ deviceId: device.id }) });
});

// --- Service requests ------------------------------------------------------

router.get('/claims', (req, res) => {
  const claims = db.prepare(`
    SELECT cl.*, d.product_name AS device_name, d.asset_tag
    FROM claims cl
    LEFT JOIN devices d ON d.id = cl.device_id
    WHERE cl.customer_id = ?
    ORDER BY cl.id DESC
  `).all(req.customer.id).map(decorateClaim);
  res.json({ claims });
});

router.get('/claims/:id', (req, res) => {
  const claim = getClaim(v.int(req.params.id, { fallback: 0 }));
  if (!claim || claim.customer_id !== req.customer.id) return res.status(404).json({ error: 'not_found' });
  res.json({
    claim,
    events: claimEvents(claim.id, { customerVisibleOnly: true }),
    attachments: attachmentsFor({ claimId: claim.id }),
  });
});

/**
 * Lodge a service request against one of the customer's own machines.
 * On success CHES receives the system email, and the customer gets a receipt.
 */
router.post('/claims', mediaUpload.array('files', config.upload.maxFilesPerRequest), async (req, res) => {
  const b = req.body || {};
  const customer = req.customer;

  const errors = v.requireFields([
    ['device_id', b.device_id, 'Select the machine that has the problem'],
    ['category', b.category, 'Select a fault category'],
    ['description', b.description, 'Describe the fault'],
    ['contact_name', b.contact_name || customer.site_contact_name, 'On-site contact name is required'],
    ['contact_phone', b.contact_phone || customer.site_contact_phone, 'On-site contact phone is required'],
  ]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });

  const device = getDevice(v.int(b.device_id, { fallback: 0 }));
  if (!device || device.customer_id !== customer.id) {
    return res.status(400).json({ error: 'validation', fields: { device_id: 'Unknown machine' } });
  }

  const warranty = warrantyFor(device);
  const reference = nextClaimReference();
  const siteAddress = [
    customer.address_line1, customer.address_line2,
    [customer.suburb, customer.state, customer.postcode].filter(Boolean).join(' '),
  ].filter((p) => p && p.trim()).join(', ');

  const info = db.prepare(`
    INSERT INTO claims (reference, customer_id, device_id, category, priority, description,
                        fault_started_on, contact_name, contact_phone, contact_email,
                        site_address, preferred_times, under_warranty, manufacturer_id, status)
    VALUES (@reference, @customer_id, @device_id, @category, @priority, @description,
            @fault_started_on, @contact_name, @contact_phone, @contact_email,
            @site_address, @preferred_times, @under_warranty, @manufacturer_id, 'submitted')
  `).run({
    reference,
    customer_id: customer.id,
    device_id: device.id,
    category: v.str(b.category, 120),
    priority: v.oneOf(b.priority, ['low', 'normal', 'urgent'], 'normal'),
    description: v.str(b.description, 8000),
    fault_started_on: toIsoDate(b.fault_started_on),
    contact_name: v.str(b.contact_name, 120) || customer.site_contact_name,
    contact_phone: v.str(b.contact_phone, 40) || customer.site_contact_phone,
    contact_email: v.email(b.contact_email) || customer.site_contact_email || customer.email,
    site_address: siteAddress,
    preferred_times: v.str(b.preferred_times, 200),
    under_warranty: warranty.status === 'active' || warranty.status === 'expiring' ? 1 : 0,
    manufacturer_id: device.manufacturer_id || null,
  });

  const claimId = info.lastInsertRowid;
  recordAttachments(req.files, {
    claimId,
    customerId: customer.id,
    kind: 'fault',
    uploadedBy: `customer:${customer.email}`,
  });

  const claim = getClaim(claimId);
  const attachments = attachmentsFor({ claimId });

  addClaimEvent(claimId, {
    actorType: 'customer',
    actorLabel: claim.contact_name || customer.company_name,
    type: 'created',
    message: `Request lodged for ${device.product_name} (${device.asset_tag}).`,
  });

  // The system email Rita asked for: lands in the CHES inbox, ready to forward.
  const toChes = templates.newClaimToChes({ claim, customer, device, warranty, attachments });
  const chesResult = await sendMail({
    to: config.ches.serviceEmail,
    replyTo: claim.contact_email || customer.email,
    subject: toChes.subject,
    text: toChes.text,
    template: 'new_claim_to_ches',
    relatedType: 'claim',
    relatedId: claimId,
  });
  addClaimEvent(claimId, {
    actorType: 'system',
    type: 'email',
    message: `Notification ${chesResult.status} to CHES (${config.ches.serviceEmail}).`,
    visibleToCustomer: false,
  });

  const receipt = templates.claimReceipt({ claim, customer, device });
  await sendMail({
    to: claim.contact_email || customer.email,
    cc: claim.contact_email && claim.contact_email !== customer.email ? customer.email : '',
    subject: receipt.subject,
    text: receipt.text,
    template: 'claim_receipt',
    relatedType: 'claim',
    relatedId: claimId,
  });

  touch('claims', claimId);
  res.status(201).json({ ok: true, claim: getClaim(claimId), reference });
});

module.exports = router;
