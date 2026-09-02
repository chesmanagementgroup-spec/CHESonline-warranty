'use strict';

const { toIsoDate } = require('./dates');

// Line descriptions that are charges, not machines. These still come through
// so staff can see the whole invoice, but arrive unticked.
const NON_EQUIPMENT = [
  'freight', 'delivery', 'shipping', 'cartage', 'transport',
  'install', 'installation', 'commission', 'labour', 'labor',
  'deposit', 'balance', 'discount', 'rounding', 'surcharge',
  'warranty extension', 'service fee', 'admin fee', 'gst',
  'less deposit', 'progress payment',
];

// Brands CHES commonly resells — used to pre-fill the manufacturer field.
// Stored in their canonical display spelling; matched case-insensitively on a
// word boundary so "SEAL" in a description does not become "Blue Seal".
const KNOWN_BRANDS = [
  'SIMCO', 'Waldorf', 'Turbofan', 'Blue Seal', 'Blueseal', 'Roband', 'Anvil',
  'Williams', 'Skope', 'Bromic', 'FED', 'Furnotel', 'Thermaline', 'Garland',
  'RATIONAL', 'UNOX', 'Convotherm', 'Hoshizaki', 'Bravilor', 'Animo', 'Hallde',
  'Robot Coupe', 'Hobart', 'Winterhalter', 'Moffat', 'Goldstein', 'Cookon',
  'Luus', 'True', 'Polar', 'Buffalo', 'Bonn', 'Birko', 'Zip', 'Semak',
  'Menumaster', 'Panasonic', 'Sharp', 'Sammic', 'Electrolux', 'Woodson',
  'Austheat', 'Trumake', 'Nuova Simonelli', 'La Marzocco', 'Mazzer',
];

const BRAND_ALIASES = { BLUESEAL: 'Blue Seal' };

/**
 * Split raw PDF text into trimmed, non-empty lines.
 */
function toLines(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/ /g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function num(s) {
  if (s === undefined || s === null) return null;
  return toNumber(s);
}

function isNonEquipment(desc) {
  const d = String(desc).toLowerCase();
  return NON_EQUIPMENT.some((w) => d.includes(w));
}

function detectBrand(desc) {
  const text = String(desc || '');
  let best = '';
  for (const brand of KNOWN_BRANDS) {
    const re = new RegExp(String.raw`(^|[^A-Za-z0-9])${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
    if (re.test(text) && brand.length > best.length) best = brand;
  }
  if (!best) return '';
  return BRAND_ALIASES[best.toUpperCase()] || best;
}

/**
 * Pull a model code out of a description, e.g.
 *   "SIMCO SD80 Underbench Dishwasher"  -> SD80
 *   "Waldorf RN8610G-B Gas Oven Range"  -> RN8610G-B
 * Heuristic: an alphanumeric token containing at least one digit and one
 * letter, at least 3 chars, not a pure measurement.
 */
function detectModelCode(desc) {
  const tokens = String(desc).split(/[\s,()/]+/).filter(Boolean);
  for (const raw of tokens) {
    const t = raw.replace(/[.,;:]+$/, '');
    if (t.length < 3 || t.length > 24) continue;
    if (!/[A-Za-z]/.test(t) || !/\d/.test(t)) continue;
    if (/^\d+(mm|cm|m|kg|l|lt|w|kw|v|amp|a|hz|ph)$/i.test(t)) continue;   // 600mm, 15kW
    if (/^\d+x\d+$/i.test(t)) continue;                                   // 600x700
    if (/^(gn)?\d\/\d$/i.test(t)) continue;                               // 1/1, GN1/1
    if (/^\d{4}$/.test(t)) continue;                                      // a bare year
    return t.toUpperCase();
  }
  return '';
}

function findInvoiceNumber(lines) {
  const joined = lines.join('\n');
  let m = joined.match(/Invoice\s*(?:Number|No\.?|#)\s*[:\-]?\s*(INV[-\s]?[\w-]+|[\w-]{3,})/i);
  if (m) return m[1].replace(/\s+/g, '').toUpperCase();
  m = joined.match(/\b(INV-\d{3,})\b/i);
  return m ? m[1].toUpperCase() : '';
}

function findInvoiceDate(lines) {
  const joined = lines.join('\n');
  const m = joined.match(/Invoice\s*Date\s*[:\-]?\s*([0-9A-Za-z ,./-]{6,20})/i);
  if (m) {
    const iso = toIsoDate(m[1].trim());
    if (iso) return iso;
  }
  const m2 = joined.match(/\b(\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})\b/);
  return m2 ? toIsoDate(m2[1]) : null;
}

/**
 * Best-effort guess at who the invoice is billed to. Xero puts the contact
 * name in the top block, above the invoice metadata.
 */
function findCustomer(lines) {
  const stopWords = /^(tax invoice|invoice|ches|abn|acn|phone|email|www|attention|attn|bill to|to:?|invoice number|invoice date|due date|reference|payment|p\.?o\.? box)/i;
  const head = lines.slice(0, 25);
  const labelled = head.findIndex((l) => /^(bill(ed)? to|to|customer|client)\s*:?$/i.test(l) || /^(bill(ed)? to|customer)\s*:/i.test(l));
  if (labelled >= 0) {
    const inline = head[labelled].split(':').slice(1).join(':').trim();
    if (inline) return inline;
    for (let i = labelled + 1; i < Math.min(labelled + 4, head.length); i++) {
      if (!stopWords.test(head[i])) return head[i];
    }
  }
  for (const l of head) {
    if (stopWords.test(l)) continue;
    if (/^[\d\s$.,%-]+$/.test(l)) continue;
    if (l.length < 3 || l.length > 80) continue;
    return l;
  }
  return '';
}

const MONEY_RE = /\$?\d[\d,]*\.\d{2}/g;
const GST_GAP_RE = /^\s*(?:\d{1,3}(?:\.\d+)?\s*%|GST[A-Za-z ]*|Free|Exempt|No GST)?\s*$/i;
const TOTALS_LINE = /^(sub\s*total|total|amount due|gst|includes gst|total gst|balance|paid|less|deposit paid|amount paid|due date|invoice total)\b/i;

const toNumber = (s) => {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull one line item out of a single line of invoice text.
 *
 * Two layouts have to work. Text extracted from a PDF table usually arrives
 * with the cells run together and no separators at all —
 *
 *   "SIMCO SD80 Underbench Dishwasher23,500.0010%7,000.00"
 *
 * — while a plain-text or well-spaced invoice keeps them apart:
 *
 *   "SIMCO SD80 Underbench Dishwasher 2 3,500.00 10% 7,000.00"
 *
 * Rather than guess where the columns start, we locate the money amounts,
 * take the last two as unit price and line total, and then work out which
 * digits in between belong to the quantity by checking the arithmetic:
 * quantity x unit price must equal the line total. That check is what makes
 * the run-together case unambiguous.
 */
function parseLineItem(line) {
  MONEY_RE.lastIndex = 0;
  const money = [];
  let m;
  while ((m = MONEY_RE.exec(line)) !== null) {
    money.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (money.length < 2) return null;

  const unitTok = money[money.length - 2];
  const amountTok = money[money.length - 1];

  // Whatever sits between the two amounts must be a GST column, or nothing.
  if (!GST_GAP_RE.test(line.slice(unitTok.end, amountTok.start))) return null;

  const amount = toNumber(amountTok.text);
  if (amount === null) return null;

  const prefix = line.slice(0, unitTok.start).replace(/\s+$/, '');
  const trailingDigits = (prefix.match(/\d+$/) || [''])[0];
  const unitRaw = unitTok.text.replace(/^\$/, '');

  const close = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.015);

  // `a` digits borrowed from the end of the description, `b` from the front of
  // the unit price. The first split whose arithmetic works is the right one.
  // `a` counts down so an explicit quantity is taken as the quantity rather
  // than left stuck on the description: "Gas Oven Range 1 8,250.00 8,250.00"
  // must not become a product called "Gas Oven Range 1".
  for (let a = trailingDigits.length; a >= 0; a--) {
    for (let b = 0; b <= 3; b++) {
      const unitStr = unitRaw.slice(b);
      if (!/^\d[\d,]*\.\d{2}$/.test(unitStr)) continue;

      const qtyStr = trailingDigits.slice(trailingDigits.length - a) + unitRaw.slice(0, b);
      const quantity = qtyStr === '' ? 1 : parseInt(qtyStr, 10);
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 500) continue;

      const unitPrice = toNumber(unitStr);
      if (unitPrice === null || !close(quantity * unitPrice, amount)) continue;

      const description = prefix.slice(0, prefix.length - a).replace(/[\s.:-]+$/, '').trim();
      if (!/[A-Za-z]{2}/.test(description)) continue;

      return { description, quantity, unitPrice, amount };
    }
  }
  return null;
}

/**
 * Parse the text of an invoice PDF into structured draft lines.
 * Everything is a best-effort guess — the admin UI always shows the result
 * for a human to correct before any device record is created.
 */
function parseInvoiceText(text) {
  const lines = toLines(text);
  const items = [];

  for (const line of lines) {
    if (TOTALS_LINE.test(line)) continue;
    if (/^(description|item|qty|quantity|unit price|amount)\b/i.test(line)) continue;

    const parsed = parseLineItem(line);
    if (!parsed) continue;
    if (TOTALS_LINE.test(parsed.description)) continue;

    items.push(buildLine({
      description: parsed.description,
      quantity: parsed.quantity,
      unitPrice: parsed.unitPrice,
      amount: parsed.amount,
    }));
  }

  return {
    invoice_number: findInvoiceNumber(lines),
    invoice_date: findInvoiceDate(lines),
    detected_customer: findCustomer(lines),
    lines: items,
  };
}

function buildLine({ description, quantity, unitPrice, amount, brand, model_code, warranty_months }) {
  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const equipment = !isNonEquipment(description);
  return {
    description: String(description).trim(),
    quantity: qty,
    unit_price_ex_gst: Number.isFinite(unitPrice) ? Number(unitPrice.toFixed(2)) : null,
    line_total: Number.isFinite(amount) ? Number(amount.toFixed(2)) : null,
    brand: brand || detectBrand(description),
    model_code: model_code || detectModelCode(description),
    warranty_months: Number.isFinite(warranty_months) ? warranty_months : null,
    is_equipment: equipment,
    include: equipment,
  };
}

/** Minimal RFC-4180 CSV reader (handles quotes and embedded newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// Column aliases. Headers are normalised (lowercased, non-alphanumerics
// stripped) before matching, so "*InvoiceNumber", "Invoice No." and
// "invoice_number" all land on the same field.
const CSV_ALIASES = {
  description: ['description', 'item', 'itemname', 'product', 'productname', 'details'],
  quantity: ['quantity', 'qty'],
  unit_price: ['unitamount', 'unitprice', 'price', 'rate'],
  invoice_number: ['invoiceno', 'invoicenumber', 'invoice', 'invoiceref'],
  invoice_date: ['invoicedate', 'date'],
  customer: ['contactname', 'customer', 'client', 'customername', 'billto'],
  serial: ['serial', 'serialnumber', 'serialno'],
  brand: ['brand', 'manufacturer', 'make', 'supplier'],
  model: ['model', 'modelcode', 'code', 'itemcode', 'sku'],
  warranty_months: ['warranty', 'warrantymonths'],
};

const normaliseHeader = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function headerIndex(headers) {
  const norm = headers.map(normaliseHeader);
  const map = {};
  for (const [key, aliases] of Object.entries(CSV_ALIASES)) {
    const idx = norm.findIndex((h) => aliases.includes(h));
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

/** Parse a CSV export (Xero invoice CSV, or a hand-made device list). */
function parseInvoiceCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { invoice_number: '', invoice_date: null, detected_customer: '', lines: [] };

  const map = headerIndex(rows[0]);
  if (map.description === undefined) {
    return { invoice_number: '', invoice_date: null, detected_customer: '', lines: [], error: 'no_description_column' };
  }

  const get = (row, key) => (map[key] === undefined ? '' : String(row[map[key]] ?? '').trim());
  const lines = [];
  let invoiceNumber = '';
  let invoiceDate = null;
  let customer = '';

  for (const row of rows.slice(1)) {
    const description = get(row, 'description');
    if (!description) continue;
    invoiceNumber = invoiceNumber || get(row, 'invoice_number').toUpperCase();
    invoiceDate = invoiceDate || toIsoDate(get(row, 'invoice_date'));
    customer = customer || get(row, 'customer');

    const quantity = num(get(row, 'quantity')) || 1;
    const unitPrice = num(get(row, 'unit_price'));
    const line = buildLine({
      description,
      quantity,
      unitPrice,
      amount: Number.isFinite(unitPrice) ? unitPrice * quantity : null,
      brand: get(row, 'brand'),
      model_code: get(row, 'model'),
      warranty_months: num(get(row, 'warranty_months')),
    });
    const serial = get(row, 'serial');
    if (serial) line.serial_numbers = [serial];
    lines.push(line);
  }

  return { invoice_number: invoiceNumber, invoice_date: invoiceDate, detected_customer: customer, lines };
}

module.exports = {
  parseInvoiceText,
  parseLineItem,
  parseInvoiceCsv,
  parseCsv,
  detectBrand,
  detectModelCode,
  isNonEquipment,
  KNOWN_BRANDS,
};
