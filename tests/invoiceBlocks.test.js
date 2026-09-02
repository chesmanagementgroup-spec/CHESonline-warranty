'use strict';

/**
 * The detailed Xero layout CHES actually sends: each item is a block — supplier
 * code, product name, specifications, serial numbers — closed by a row that is
 * only quantity, price, tax and amount. On a rent-try-buy invoice the bill-to
 * is the finance company and the venue is named inside the first line item.
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseInvoiceText, warrantyMonthsFrom, serialsFrom, findCustomerDetails } = require('../server/lib/invoiceParser');

const INVOICE = [
  'Tax Invoice',
  'Bill to',
  'Attn: Silver Chef',
  'Silver Chef Rentals Pty Ltd',
  'Brisbane (Head Office)',
  'CHES ONLINE',
  'Invoice number',
  'INV-24971 - SilverChef',
  'Issue date',
  '2 Aug 2026',
  'Reference',
  'QU-23602: Thai Thae@ Melrose Park - Version 5',
  'ItemDescriptionQuantityPriceTaxAmount',
  'Customer details:',
  'Trading name: Thaithae Melrose Central',
  'Applicant name: Yi Ding',
  'Phone: +61433381817',
  'Email: dingyi78@hotmail.com',
  'Shop G41, 22 Lemon Tree Avenue, Melrose ',
  'Park, NSW, 2114',
  'UFWWK-2-NG',
  'E01 + E02A : Dimensions (L x W x H): ',
  '1200mm x 840mm x 1300mm',
  'WARRANTY: 18 MONTHS.',
  'S/N:',
  'UFWW-5179CS',
  'UFWW-4796',
  '24,777.5010%9,555.00',
  'KAWBT-SB2L',
  'E02B - B+S K+ 2 side burner LHS',
  'S/N: KBT-3081Y',
  '11,085.0010%1,085.00',
  'AT80G6G-F-NG',
  'E05 - Cookrite - 600MM HOTPLATE NG',
  'Width600',
  'Weight87.000000',
  'Gas TypeNatural Gas',
  '2 years warranty + 2 years extra in spares',
  'S/N: AT80G6G-FAAU100323121300Z90002',
  '11,712.7710%1,712.77',
  'Subtotal12,352.77',
  'Total GST 10%1,235.28',
  'Total13,588.05',
].join('\n');

test('reads the header fields when each label sits on its own line', () => {
  const parsed = parseInvoiceText(INVOICE);
  assert.strictEqual(parsed.invoice_number, 'INV-24971', 'the trailing " - SilverChef" is not part of the number');
  assert.strictEqual(parsed.invoice_date, '2026-08-02');
  assert.match(parsed.reference, /^QU-23602/);
});

test('takes the venue from the invoice, not the finance company it bills', () => {
  const parsed = parseInvoiceText(INVOICE);
  assert.strictEqual(parsed.detected_customer, 'Thaithae Melrose Central');
  const venue = parsed.customer_details;
  assert.strictEqual(venue.contact_name, 'Yi Ding');
  assert.strictEqual(venue.phone, '+61433381817');
  assert.strictEqual(venue.email, 'dingyi78@hotmail.com');
  assert.strictEqual(venue.suburb, 'Melrose Park');
  assert.strictEqual(venue.state, 'NSW');
  assert.strictEqual(venue.postcode, '2114');
  assert.strictEqual(venue.address_line1, 'Shop G41, 22 Lemon Tree Avenue');
});

test('builds each item from the block above its amounts row', () => {
  const parsed = parseInvoiceText(INVOICE);
  assert.strictEqual(parsed.lines.length, 3, 'three machines, and the totals are not items');

  const [first, second, third] = parsed.lines;

  assert.strictEqual(first.quantity, 2);
  assert.strictEqual(first.unit_price_ex_gst, 4777.5);
  assert.strictEqual(first.line_total, 9555);
  assert.strictEqual(first.warranty_months, 18, 'read from "WARRANTY: 18 MONTHS."');
  assert.deepStrictEqual(first.serial_numbers, ['UFWW-5179CS', 'UFWW-4796'],
    'a bare "S/N:" is followed by one serial per machine');

  assert.strictEqual(second.quantity, 1);
  assert.strictEqual(second.description, 'E02B - B+S K+ 2 side burner LHS');
  assert.deepStrictEqual(second.serial_numbers, ['KBT-3081Y'], 'an inline serial is read too');

  assert.strictEqual(third.description, 'E05 - Cookrite - 600MM HOTPLATE NG',
    'specifications glued to their values stay out of the product name');
  assert.strictEqual(third.warranty_months, 24, '"2 years warranty" becomes 24 months');
});

test('the line totals add up to the invoice subtotal', () => {
  const parsed = parseInvoiceText(INVOICE);
  const sum = parsed.lines.reduce((n, l) => n + (l.line_total || 0), 0);
  assert.strictEqual(Number(sum.toFixed(2)), 12352.77);
});

test('warranty wording is converted to months', () => {
  assert.strictEqual(warrantyMonthsFrom(['WARRANTY: 18 MONTHS.']), 18);
  assert.strictEqual(warrantyMonthsFrom(['2 years warranty + 2 years extra in spares']), 24);
  assert.strictEqual(warrantyMonthsFrom(['12mos warranty on parts and labour']), 12);
  assert.strictEqual(warrantyMonthsFrom(['Stainless steel bench']), null, 'no warranty wording, no guess');
});

test('serial numbers are read in both shapes', () => {
  assert.deepStrictEqual(serialsFrom(['S/N: ABC-123']), ['ABC-123']);
  assert.deepStrictEqual(serialsFrom(['S/N:', 'ABC-123', 'ABC-124', 'Warranty: 2 years']), ['ABC-123', 'ABC-124']);
  assert.deepStrictEqual(serialsFrom(['S/N: "MSF8303AAU2CPCB001']), ['MSF8303AAU2CPCB001'], 'a stray quote is dropped');
});

test('an invoice with no venue block is unaffected', () => {
  assert.strictEqual(findCustomerDetails(['Tax Invoice', 'Bill To:', 'Sunrise Cafe Pty Ltd']), null);
});
