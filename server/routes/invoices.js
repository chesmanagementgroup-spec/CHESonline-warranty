'use strict';

const fs = require('fs');
const express = require('express');
const config = require('../config');
const { db, nextAssetTag } = require('../db');
const { requireStaff } = require('../auth');
const v = require('../lib/validate');
const asyncRoute = require('../lib/asyncRoute');
const { documentUpload, attachmentPath } = require('../lib/uploads');
const { parseInvoiceText, parseInvoiceCsv } = require('../lib/invoiceParser');
const { toIsoDate } = require('../lib/dates');
const { refreshWarranty, findOrCreateManufacturer, getDevice, decorateDevice,
        listSites, getSite, createSite, defaultSite } = require('../lib/models');
const { sendMail } = require('../mailer');
const auth = require('../auth');
const templates = require('../lib/templates');

const router = express.Router();
router.use(requireStaff);

/** Suggest which customer on file this invoice belongs to. */
function guessCustomer(detectedName) {
  const name = String(detectedName || '').trim();
  if (!name) return null;
  const exact = db.prepare('SELECT * FROM customers WHERE lower(company_name) = lower(?)').get(name);
  if (exact) return exact;
  // Fall back to a loose match ignoring the usual company suffixes.
  const core = name.replace(/\b(pty|ltd|limited|inc|co|company|group|holdings|t\/a)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
  if (core.length < 3) return null;
  return db.prepare("SELECT * FROM customers WHERE company_name LIKE ? COLLATE NOCASE").get(`%${core}%`) || null;
}

/**
 * Step 1: upload an INVOICE (Xero PDF, or a CSV export) and get back draft
 * device lines.  Nothing is created yet — the draft is stored so staff can
 * correct it and then commit.
 */
router.post('/upload', documentUpload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const filePath = attachmentPath(req.file.filename);
  const isCsv = /csv|excel|text\/plain/i.test(req.file.mimetype) || /\.csv$/i.test(req.file.originalname);

  let parsed;
  let rawText = '';
  try {
    if (isCsv) {
      rawText = fs.readFileSync(filePath, 'utf8');
      parsed = parseInvoiceCsv(rawText);
    } else {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(filePath));
      rawText = data.text || '';
      parsed = parseInvoiceText(rawText);
    }
  } catch (err) {
    fs.rm(filePath, { force: true }, () => {});
    return res.status(400).json({ error: 'unreadable_file', message: err.message });
  }

  const suggested = guessCustomer(parsed.detected_customer)
    || (parsed.customer_details && parsed.customer_details.email
      ? db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?)').get(parsed.customer_details.email)
      : null);

  const info = db.prepare(`
    INSERT INTO invoice_imports (original_name, stored_name, source, status, invoice_number, invoice_date,
                                 customer_id, detected_customer, raw_text, parsed_json, created_by)
    VALUES (@original_name, @stored_name, @source, 'draft', @invoice_number, @invoice_date,
            @customer_id, @detected_customer, @raw_text, @parsed_json, @created_by)
  `).run({
    original_name: req.file.originalname,
    stored_name: req.file.filename,
    source: isCsv ? 'csv' : 'pdf',
    invoice_number: parsed.invoice_number || '',
    invoice_date: parsed.delivery_date || parsed.invoice_date || null,
    customer_id: suggested ? suggested.id : null,
    detected_customer: parsed.detected_customer || '',
    raw_text: rawText.slice(0, 200000),
    parsed_json: JSON.stringify(parsed.lines || []),
    created_by: `${req.staff.name} <${req.staff.email}>`,
  });

  res.status(201).json({
    ok: true,
    import_id: info.lastInsertRowid,
    invoice_number: parsed.invoice_number || '',
    invoice_date: parsed.invoice_date || null,
    delivery_date: parsed.delivery_date || null,
    detected_customer: parsed.detected_customer || '',
    suggested_customer: suggested || null,
    sites: suggested ? listSites(suggested.id) : [],
    customer_details: parsed.customer_details || null,
    reference: parsed.reference || '',
    lines: parsed.lines || [],
    line_count: (parsed.lines || []).length,
    warning: (parsed.lines || []).length ? null : 'no_lines_found',
    source: isCsv ? 'csv' : 'pdf',
  });
}));

router.get('/', (req, res) => {
  res.json({
    imports: db.prepare(`
      SELECT i.id, i.original_name, i.source, i.status, i.invoice_number, i.invoice_date,
             i.detected_customer, i.devices_created, i.created_by, i.created_at, i.committed_at,
             c.company_name AS customer_name
      FROM invoice_imports i
      LEFT JOIN customers c ON c.id = i.customer_id
      ORDER BY i.id DESC LIMIT 100
    `).all(),
  });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(v.int(req.params.id, { fallback: 0 }));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({
    import: { ...row, lines: JSON.parse(row.parsed_json || '[]') },
    customer: row.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(row.customer_id) : null,
    devices: db.prepare('SELECT * FROM devices WHERE invoice_number = ? AND invoice_number != ""').all(row.invoice_number).map(decorateDevice),
  });
});

/** The raw extracted text, so staff can check anything the parser missed. */
router.get('/:id/text', (req, res) => {
  const row = db.prepare('SELECT raw_text FROM invoice_imports WHERE id = ?').get(v.int(req.params.id, { fallback: 0 }));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.type('text/plain').send(row.raw_text || '');
});

/**
 * Step 2: commit the (corrected) draft.  A line with quantity 3 becomes three
 * separate device records, because warranty and faults are tracked per
 * machine, not per invoice line.
 */
router.post('/:id/commit', asyncRoute(async (req, res) => {
  const importId = v.int(req.params.id, { fallback: 0 });
  const record = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(importId);
  if (!record) return res.status(404).json({ error: 'not_found' });
  if (record.status === 'committed') return res.status(409).json({ error: 'already_committed' });

  const b = req.body || {};
  const customerId = v.int(b.customer_id, { fallback: record.customer_id || 0 });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) {
    return res.status(400).json({ error: 'validation', fields: { customer_id: 'Choose which customer this invoice belongs to' } });
  }

  const invoiceNumber = (v.str(b.invoice_number, 60) || record.invoice_number || '').toUpperCase();
  const invoiceDate = toIsoDate(b.invoice_date) || record.invoice_date || null;
  // Warranty runs from delivery. The invoice states it; the invoice date is
  // only the fallback when it does not.
  const deliveryDate = toIsoDate(b.delivery_date) || invoiceDate;

  let site = v.int(b.site_id, { fallback: 0 }) ? getSite(v.int(b.site_id, { fallback: 0 })) : null;
  if (site && site.customer_id !== customer.id) site = null;
  if (!site && v.str(b.new_site_name)) {
    site = createSite(customer.id, {
      name: v.str(b.new_site_name, 120),
      address_line1: v.str(b.new_site_address_line1, 200),
      suburb: v.str(b.new_site_suburb, 100),
      state: v.str(b.new_site_state, 40),
      postcode: v.str(b.new_site_postcode, 16),
      contact_name: v.str(b.new_site_contact_name, 120),
      contact_phone: v.str(b.new_site_contact_phone, 40),
      contact_email: v.email(b.new_site_contact_email),
    });
  }
  if (!site) site = defaultSite(customer.id);
  const lines = Array.isArray(b.lines) ? b.lines : JSON.parse(record.parsed_json || '[]');
  const chosen = lines.filter((l) => l && l.include !== false && v.str(l.description));

  if (!chosen.length) {
    return res.status(400).json({ error: 'validation', fields: { lines: 'Tick at least one line to import' } });
  }

  const insertDevice = db.prepare(`
    INSERT INTO devices (customer_id, site_id, asset_tag, invoice_number, product_name, model_code, brand,
                         manufacturer_id, serial_number, purchase_date, delivered_at, warranty_months,
                         unit_price_ex_gst, status, notes)
    VALUES (@customer_id, @site_id, @asset_tag, @invoice_number, @product_name, @model_code, @brand,
            @manufacturer_id, @serial_number, @purchase_date, @delivered_at, @warranty_months,
            @unit_price_ex_gst, 'active', @notes)
  `);

  const createdIds = [];
  const commit = db.transaction(() => {
    for (const line of chosen) {
      const quantity = v.int(line.quantity, { min: 1, max: 200, fallback: 1 });
      const brand = v.str(line.brand, 80);
      const manufacturer = brand ? findOrCreateManufacturer(brand) : null;
      const serials = Array.isArray(line.serial_numbers) ? line.serial_numbers : [];

      for (let unit = 0; unit < quantity; unit++) {
        const info = insertDevice.run({
          customer_id: customerId,
          site_id: site ? site.id : null,
          asset_tag: nextAssetTag(),
          invoice_number: invoiceNumber,
          product_name: v.str(line.description, 200),
          model_code: v.str(line.model_code, 80),
          brand,
          manufacturer_id: manufacturer ? manufacturer.id : null,
          serial_number: v.str(serials[unit], 120),
          purchase_date: invoiceDate,
          delivered_at: deliveryDate,
          warranty_months: v.int(line.warranty_months, { min: 0, max: 240, fallback: config.defaultWarrantyMonths }),
          unit_price_ex_gst: v.money(line.unit_price_ex_gst),
          notes: quantity > 1 ? `Unit ${unit + 1} of ${quantity} on ${invoiceNumber || 'this invoice'}.` : '',
        });
        createdIds.push(info.lastInsertRowid);
      }
    }

    db.prepare(`
      UPDATE invoice_imports SET status = 'committed', customer_id = ?, site_id = ?, invoice_number = ?,
        invoice_date = ?, parsed_json = ?, devices_created = ?, committed_at = datetime('now')
      WHERE id = ?
    `).run(customerId, site ? site.id : null, invoiceNumber, invoiceDate,
           JSON.stringify(lines), createdIds.length, importId);
  });
  commit();

  for (const id of createdIds) refreshWarranty(id);
  const devices = createdIds.map(getDevice);

  let invite = null;
  if (b.send_invite) {
    const msg = templates.equipmentHandover({
      customer, devices, invoiceNumber, site,
      portalUrl: auth.magicLinkUrl(customer.id),
    });
    invite = await sendMail({
      to: (site && site.contact_email) || customer.email,
      cc: site && site.contact_email && site.contact_email !== customer.email ? customer.email : '',
      subject: msg.subject,
      text: msg.text,
      template: 'equipment_handover',
      relatedType: 'customer',
      relatedId: customer.id,
    });
  }

  res.status(201).json({
    ok: true,
    devices_created: createdIds.length,
    devices,
    invite_status: invite ? invite.status : null,
  });
}));

router.delete('/:id', (req, res) => {
  const id = v.int(req.params.id, { fallback: 0 });
  const row = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.status === 'committed') {
    return res.status(409).json({ error: 'already_committed', message: 'Committed imports are kept as a record.' });
  }
  if (row.stored_name) fs.rm(attachmentPath(row.stored_name), { force: true }, () => {});
  db.prepare("UPDATE invoice_imports SET status = 'discarded' WHERE id = ?").run(id);
  res.json({ ok: true });
});

module.exports = router;
