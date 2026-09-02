'use strict';

const express = require('express');
const config = require('../config');
const { db, nextClaimReference } = require('../db');
const auth = require('../auth');
const { requireCustomer } = require('../auth');
const v = require('../lib/validate');
const asyncRoute = require('../lib/asyncRoute');
const { mediaUpload, recordAttachments } = require('../lib/uploads');
const { sendMail } = require('../mailer');
const templates = require('../lib/templates');
const {
  CLAIM_CATEGORIES,
  listSites,
  getSite,
  defaultSite,
  siteAddress,
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
  res.json({
    customer: req.customer,
    sites: listSites(req.customer.id),
    categories: CLAIM_CATEGORIES,
  });
});

/**
 * The customer keeps their own account contact details current. The address
 * and the person a technician calls live on each site, below.
 */
router.put('/profile', (req, res) => {
  const b = req.body || {};
  const errors = v.requireFields([
    ['company_name', b.company_name, 'Business name is required'],
    ['contact_name', b.contact_name, 'Contact name is required'],
    ['phone', b.phone, 'Phone number is required'],
  ]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });

  db.prepare(`
    UPDATE customers SET
      company_name = @company_name, contact_name = @contact_name, phone = @phone,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: req.customer.id,
    company_name: v.str(b.company_name, 200),
    contact_name: v.str(b.contact_name, 120),
    phone: v.str(b.phone, 40),
  });

  res.json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id) });
});

// --- Sites ------------------------------------------------------------------

router.get('/sites', (req, res) => {
  res.json({ sites: listSites(req.customer.id) });
});

/**
 * A customer maintains each venue's address and its on-site after-sales
 * contact — the details that go to the manufacturer with every request.
 */
router.put('/sites/:id', (req, res) => {
  const site = getSite(v.int(req.params.id, { fallback: 0 }));
  if (!site || site.customer_id !== req.customer.id) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const errors = v.requireFields([
    ['name', b.name, 'Site name is required'],
    ['address_line1', b.address_line1, 'Street address is required'],
    ['suburb', b.suburb, 'Suburb is required'],
    ['state', b.state, 'State is required'],
    ['postcode', b.postcode, 'Postcode is required'],
    ['contact_name', b.contact_name, 'On-site contact name is required'],
    ['contact_phone', b.contact_phone, 'On-site contact phone is required'],
  ]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });
  if (b.contact_email && !v.isEmail(b.contact_email)) {
    return res.status(400).json({ error: 'validation', fields: { contact_email: 'Invalid email address' } });
  }

  db.prepare(`
    UPDATE sites SET
      name = @name, address_line1 = @address_line1, address_line2 = @address_line2,
      suburb = @suburb, state = @state, postcode = @postcode,
      contact_name = @contact_name, contact_role = @contact_role,
      contact_phone = @contact_phone, contact_email = @contact_email,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: site.id,
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
  });

  res.json({ ok: true, site: getSite(site.id) });
});

// --- Devices ---------------------------------------------------------------

router.get('/devices', (req, res) => {
  const devices = listDevicesForCustomer(req.customer.id);
  res.json({
    devices,
    sites: listSites(req.customer.id),
    summary: {
      total: devices.length,
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
  res.json({
    device,
    site: device.site_id ? getSite(device.site_id) : null,
    attachments: attachmentsFor({ deviceId: device.id }),
  });
});

/**
 * The only thing a customer changes on a machine is where it sits in the
 * venue, which is what a technician needs to find it. Everything else —
 * delivery date, serial, warranty — is set by CHES from the invoice.
 */
router.put('/devices/:id', (req, res) => {
  const device = ownedDevice(req, res);
  if (!device) return;
  db.prepare("UPDATE devices SET location_note = ?, updated_at = datetime('now') WHERE id = ?")
    .run(v.str(req.body && req.body.location_note, 200), device.id);
  res.json({ ok: true, device: getDevice(device.id) });
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
router.post('/claims', mediaUpload.array('files', config.upload.maxFilesPerRequest), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const customer = req.customer;

  const errors = v.requireFields([
    ['device_id', b.device_id, 'Select the machine that has the problem'],
    ['category', b.category, 'Select a fault category'],
    ['description', b.description, 'Describe the fault'],
    ['contact_name', b.contact_name, 'On-site contact name is required'],
    ['contact_phone', b.contact_phone, 'On-site contact phone is required'],
  ]);
  if (errors) return res.status(400).json({ error: 'validation', fields: errors });

  const device = getDevice(v.int(b.device_id, { fallback: 0 }));
  if (!device || device.customer_id !== customer.id) {
    return res.status(400).json({ error: 'validation', fields: { device_id: 'Unknown machine' } });
  }

  const warranty = warrantyFor(device);
  const reference = nextClaimReference();
  // The address and the person to call come from the machine's own site, so a
  // customer with several venues never sends a technician to the wrong one.
  const site = device.site_id ? getSite(device.site_id) : defaultSite(customer.id);

  const info = db.prepare(`
    INSERT INTO claims (reference, customer_id, device_id, site_id, category, priority, description,
                        fault_started_on, contact_name, contact_phone, contact_email,
                        site_address, preferred_times, under_warranty, manufacturer_id, status)
    VALUES (@reference, @customer_id, @device_id, @site_id, @category, @priority, @description,
            @fault_started_on, @contact_name, @contact_phone, @contact_email,
            @site_address, @preferred_times, @under_warranty, @manufacturer_id, 'submitted')
  `).run({
    reference,
    customer_id: customer.id,
    device_id: device.id,
    site_id: site ? site.id : null,
    category: v.str(b.category, 120),
    priority: v.oneOf(b.priority, ['low', 'normal', 'urgent'], 'normal'),
    description: v.str(b.description, 8000),
    fault_started_on: toIsoDate(b.fault_started_on),
    contact_name: v.str(b.contact_name, 120) || (site && site.contact_name) || '',
    contact_phone: v.str(b.contact_phone, 40) || (site && site.contact_phone) || '',
    contact_email: v.email(b.contact_email) || (site && site.contact_email) || customer.email,
    site_address: siteAddress(site),
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

  const receipt = templates.claimReceipt({
    claim, customer, device, portalUrl: auth.magicLinkUrl(customer.id),
  });
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
}));

module.exports = router;
