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
  // Supplier and brand names from the CHES supplier list, plus the brands that
  // turn up on CHES invoices.
  'B+S', 'Cookrite', 'Atosa', 'Jasper', 'Eswood', 'Meiko', 'UPster', 'Stoddart',
  'Woodson', 'TurboChef', 'Koldtech', 'Airex', 'Aristarco', 'Giorik', 'Synergy',
  'Adande', 'Comcater', 'Rational', 'Mareno', 'Tecnomac', 'Trueheat', 'Brema',
  'Comenda', 'PureVac', 'Mibrasa', 'Frymaster', 'Middleby', 'Moffat', 'Washtech',
  'Scotsman', 'Hussmann', 'Robalec', 'Dipo', 'Robatherm', 'Noaw', 'Uropa',
  'Nisbets', 'Apuro', 'Thor', 'Waring', 'Classeq', 'Winterhalter', 'Vitamix',
  'ITV', 'Irinox', 'ActiveCore', 'ProSpec', 'Scots Ice', 'Lancer',
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
  let best = null;
  for (const brand of KNOWN_BRANDS) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i');
    const m = re.exec(text);
    if (!m) continue;
    // Whichever brand is named first wins, so "MEIKO UPster H 500" is a Meiko
    // and not an UPster; a longer name breaks a tie at the same position.
    const at = m.index + m[1].length;
    if (!best || at < best.at || (at === best.at && brand.length > best.brand.length)) {
      best = { brand, at };
    }
  }
  if (!best) return '';
  return BRAND_ALIASES[best.brand.toUpperCase()] || best.brand;
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

/** Value of a field whose label sits on its own line, Xero's usual layout. */
function valueAfterLabel(lines, labelRe, { within = 3 } = {}) {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    const inline = lines[i].replace(labelRe, '').replace(/^[:\-\s]+/, '').trim();
    if (inline) return inline;
    for (let j = i + 1; j < Math.min(i + 1 + within, lines.length); j++) {
      if (lines[j].trim()) return lines[j].trim();
    }
  }
  return '';
}

function findInvoiceNumber(lines) {
  const labelled = valueAfterLabel(lines, /^invoice\s*(number|no\.?|#)\s*[:\-]?/i);
  // "INV-24971 - SilverChef" carries a suffix; the number is the useful part.
  const fromLabel = labelled.match(/\b(INV[-\s]?[A-Za-z0-9]+)/i);
  if (fromLabel) return fromLabel[1].replace(/\s+/g, '').toUpperCase();
  if (labelled && /^[\w-]{3,}$/.test(labelled)) return labelled.toUpperCase();

  const anywhere = lines.join('\n').match(/\b(INV-\d{3,})\b/i);
  return anywhere ? anywhere[1].toUpperCase() : '';
}

function findInvoiceDate(lines) {
  const labelled = valueAfterLabel(lines, /^(invoice|issue)\s*date\s*[:\-]?/i);
  const iso = toIsoDate(labelled);
  if (iso) return iso;
  const m = lines.join('\n').match(/\b(\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})\b/);
  return m ? toIsoDate(m[1]) : null;
}

/**
 * The delivery date CHES notes on the invoice. This is what the warranty runs
 * from, so it is looked for before falling back to the invoice date.
 */
function findDeliveryDate(lines) {
  const labelled = valueAfterLabel(lines, /^(delivery|delivered|dispatch|despatch|handover|install(ation)?)\s*date\s*[:\-]?/i);
  const iso = toIsoDate(labelled);
  if (iso) return iso;

  // Also accept it written inline anywhere, e.g. "Delivery date: 12 Sep 2026".
  const m = lines.join('\n').match(/(?:delivery|delivered|dispatch|handover|install(?:ation)?)\s*date\s*[:\-]?\s*([0-9A-Za-z ,.\/-]{6,20})/i);
  return m ? toIsoDate(m[1].trim()) : null;
}

/** The quote or project this invoice came from, e.g. "QU-23602: ...". */
function findReference(lines) {
  const value = valueAfterLabel(lines, /^reference\s*[:\-]?/i);
  if (value && !/^\$/.test(value)) return value;
  const m = lines.join('\n').match(/\b(QU-\d{3,}[^\n]{0,60})/i);
  return m ? m[1].trim() : '';
}

/**
 * On a rent-try-buy invoice the bill-to is the finance company, not the venue
 * that ends up with the machines. CHES writes the venue into the first line
 * item as a "Customer details" block, so that block — when present — is who
 * the equipment actually belongs to.
 */
function findCustomerDetails(lines) {
  const start = lines.findIndex((l) => /^customer\s*details\s*:?\s*$/i.test(l));
  if (start < 0) return null;

  const details = { company_name: '', contact_name: '', phone: '', email: '', address: '' };
  const addressParts = [];

  for (let i = start + 1; i < Math.min(start + 14, lines.length); i++) {
    const line = lines[i];
    if (/^\$?[\d,]+\.\d{2}/.test(line)) break;         // reached the amounts

    let m = line.match(/^(?:trading|business|venue|company)\s*name\s*[:\-]\s*(.+)$/i);
    if (m) { details.company_name = m[1].trim(); continue; }

    m = line.match(/^(?:applicant|contact|customer)\s*name\s*[:\-]\s*(.+)$/i);
    if (m) { details.contact_name = m[1].trim(); continue; }

    m = line.match(/^(?:phone|mobile|tel|telephone)\s*[:\-]\s*(.+)$/i);
    if (m) { details.phone = m[1].trim(); continue; }

    m = line.match(/^e-?mail\s*[:\-]\s*(.+)$/i);
    if (m) { details.email = m[1].trim(); continue; }

    // Anything left that is not a product code is part of the site address.
    if (/[A-Za-z]{3}/.test(line) && !ITEM_CODE.test(line)) addressParts.push(line.trim());
    else if (addressParts.length) break;
  }

  details.address = addressParts.join(' ').replace(/\s+/g, ' ').trim();
  Object.assign(details, splitAddress(details.address));
  return details.company_name || details.email ? details : null;
}

/** "Shop G41, 22 Lemon Tree Avenue, Melrose Park, NSW, 2114" -> parts. */
function splitAddress(address) {
  const out = { address_line1: '', suburb: '', state: '', postcode: '' };
  if (!address) return out;

  const postcode = address.match(/\b(\d{4})\b\s*$/);
  if (postcode) out.postcode = postcode[1];

  const state = address.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i);
  if (state) out.state = state[1].toUpperCase();

  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  const stateIdx = parts.findIndex((p) => /^(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)$/i.test(p));
  if (stateIdx > 0) {
    out.suburb = parts[stateIdx - 1];
    out.address_line1 = parts.slice(0, stateIdx - 1).join(', ');
  } else {
    out.address_line1 = parts.slice(0, -1).join(', ') || address;
  }
  return out;
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
function parseLineItem(line, { allowEmptyDescription = false } = {}) {
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
      if (!/[A-Za-z]{2}/.test(description)) {
        // A row that is nothing but numbers belongs to the layout where the
        // description sits in the lines above it; the caller supplies it.
        if (allowEmptyDescription && !description) return { description: '', quantity, unitPrice, amount };
        continue;
      }

      return { description, quantity, unitPrice, amount };
    }
  }
  return null;
}

// Lines inside a description block that are specification key/values, bullets
// or serial numbers rather than the product name.
const SPEC_LINE = new RegExp(
  '^(?:more information|type|width|depth|height|weight|doors|burners?|burner output'
  + '|gas type|gas consumption|capacity|dimensions|packaging|refrigeration|ambient'
  + '|best suited|power|size|basket|cups?(?:/hr)?|coldwater|three-phase|voltage|amps?'
  + '|chimney burners|duckbill burners)',
  'i'
);
// Wrapped continuations of a warranty sentence, and parenthetical asides.
const CONTINUATION_LINE = /^(\(|\d+\s*mm\b|years?\b|months?\b|mos\b|registration with|warrant|installation\)|conditions)/i;
const BULLET_LINE = /^[•*–—-]\s?/;
const SERIAL_LABEL = /^s\s*\/\s*n\s*[:.]?\s*/i;
const SERIAL_VALUE = /^["']?[A-Za-z0-9][A-Za-z0-9\-\/]{4,}$/;
const ITEM_CODE = /^[A-Z0-9][A-Z0-9\-.\/+]{2,}$/;
const BOILERPLATE = /(invoice detail is for model reference|stock availability|qualified tradespeople|terms and conditions|please refer to the equipment specs|unpacking and positioning|delivery damages)/i;

/** Warranty stated in the item's own text: "18 MONTHS", "2 years", "12mos". */
function warrantyMonthsFrom(blockLines) {
  for (const line of blockLines) {
    if (!/warrant/i.test(line)) continue;
    const m = line.match(/(\d{1,3})\s*(years?|yrs?|months?|mos?)\b/i);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    return /^(y|yr)/i.test(m[2]) ? n * 12 : n;
  }
  return null;
}

/**
 * Serial numbers printed against the item. They appear either inline
 * ("S/N: KBT-3081Y") or as a bare "S/N:" followed by one line per unit, which
 * is how a quantity of two arrives with both machines' serials.
 */
function serialsFrom(blockLines) {
  const serials = [];
  for (let i = 0; i < blockLines.length; i++) {
    if (!SERIAL_LABEL.test(blockLines[i])) continue;
    const inline = blockLines[i].replace(SERIAL_LABEL, '').trim();
    if (inline) {
      serials.push(inline.replace(/^["']/, ''));
      continue;
    }
    for (let j = i + 1; j < blockLines.length && SERIAL_VALUE.test(blockLines[j]); j++) {
      serials.push(blockLines[j].replace(/^["']/, ''));
      i = j;
    }
  }
  return serials;
}

/**
 * Turn the text above a numbers-only row into a product name and model code.
 * These invoices lead with the supplier's item code on its own line, then the
 * product name (often wrapped over two lines), then specifications.
 */
function describeBlock(blockLines) {
  // A supplier's item code and a serial number are the same shape, so serials
  // are recognised by position — the lines following an "S/N:" label — rather
  // than by pattern, which would otherwise swallow the item code.
  const usable = [];
  let inSerials = false;
  for (const line of blockLines) {
    if (SERIAL_LABEL.test(line)) {
      inSerials = !line.replace(SERIAL_LABEL, '').trim();
      continue;
    }
    if (inSerials) {
      if (SERIAL_VALUE.test(line)) continue;
      inSerials = false;
    }
    if (SPEC_LINE.test(line) || BULLET_LINE.test(line) || CONTINUATION_LINE.test(line)
        || /warrant/i.test(line)) {
      continue;
    }
    usable.push(line);
  }

  let code = '';
  let rest = usable;
  if (usable.length && ITEM_CODE.test(usable[0]) && !/\s/.test(usable[0])) {
    code = usable[0];
    rest = usable.slice(1);
  }

  // The name can wrap; take consecutive lines until the text stops reading
  // like a continuation of it.
  const parts = [];
  for (const line of rest) {
    if (!/[A-Za-z]{2}/.test(line)) continue;
    parts.push(line.trim());
    if (parts.join(' ').length > 90) break;
    if (!/[,\-+&/]$|\s$/.test(line) && parts.length >= 2) break;
  }

  let name = parts.join(' ').replace(/\s+/g, ' ').replace(/[\s\-:：]+$/, '').trim();
  if (!name && code) name = code;
  return { name, code };
}

/**
 * Parse the text of an invoice PDF into structured draft lines.
 *
 * Two shapes are handled. In the flat shape every column sits on one line. In
 * the shape Xero produces for a detailed invoice, each item is a block — item
 * code, product name, specifications, serial numbers — closed by a row that is
 * only quantity, price, tax and amount. Everything here is a best-effort read
 * that the console shows for correction before any device record exists.
 */
function parseInvoiceText(text) {
  const lines = toLines(text);
  const items = [];
  let block = [];

  let inCustomerDetails = false;
  let detailLines = 0;

  for (const line of lines) {
    if (TOTALS_LINE.test(line) || /^(item)?description(quantity|price)/i.test(line)
        || /^(description|item|qty|quantity|unit price|amount)\b/i.test(line)) {
      // A column header starts a fresh page; nothing above it describes an item.
      block = [];
      continue;
    }
    if (/^customer\s*details\s*:?\s*$/i.test(line)) { inCustomerDetails = true; detailLines = 0; continue; }
    // The venue's details run for a few labelled lines; the next item code
    // ends them, so the first machine is not swallowed by the block.
    if (inCustomerDetails && (++detailLines > 10 || (ITEM_CODE.test(line) && !/\s/.test(line)))) {
      inCustomerDetails = false;
    }

    const flat = parseLineItem(line);
    const row = flat || parseLineItem(line, { allowEmptyDescription: true });

    if (!row) {
      if (!inCustomerDetails) block.push(line);
      if (block.length > 60) block.shift();
      continue;
    }
    inCustomerDetails = false;

    let description = row.description;
    let modelCode = '';
    let serials = [];
    let months = null;

    if (!description) {
      const described = describeBlock(block);
      description = described.name;
      modelCode = described.code;
      serials = serialsFrom(block);
      months = warrantyMonthsFrom(block);
    }
    block = [];

    if (!description || TOTALS_LINE.test(description)) continue;

    const item = buildLine({
      description,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      amount: row.amount,
      model_code: modelCode,
      warranty_months: months,
    });
    if (serials.length) item.serial_numbers = serials;
    // Long zero-value text is the invoice's own terms, not a machine.
    if (BOILERPLATE.test(description) || (!row.amount && description.length > 60)) {
      item.is_equipment = false;
      item.include = false;
    }
    items.push(item);
  }

  const details = findCustomerDetails(lines);
  return {
    invoice_number: findInvoiceNumber(lines),
    invoice_date: findInvoiceDate(lines),
    delivery_date: findDeliveryDate(lines),
    reference: findReference(lines),
    detected_customer: (details && details.company_name) || findCustomer(lines),
    customer_details: details,
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
  findCustomerDetails,
  findDeliveryDate,
  warrantyMonthsFrom,
  serialsFrom,
  parseInvoiceCsv,
  parseCsv,
  detectBrand,
  detectModelCode,
  isNonEquipment,
  KNOWN_BRANDS,
};
