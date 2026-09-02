'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseLineItem, parseInvoiceText, detectBrand, detectModelCode } = require('../server/lib/invoiceParser');

test('reads a spaced invoice line', () => {
  assert.deepStrictEqual(
    parseLineItem('SIMCO SD80 Underbench Dishwasher 2 3,500.00 10% 7,000.00'),
    { description: 'SIMCO SD80 Underbench Dishwasher', quantity: 2, unitPrice: 3500, amount: 7000 }
  );
});

test('reads a line whose columns were run together by PDF extraction', () => {
  // This is what pdf-parse produces from a table: no separators at all.
  assert.deepStrictEqual(
    parseLineItem('SIMCO SD80 Underbench Dishwasher23,500.0010%7,000.00'),
    { description: 'SIMCO SD80 Underbench Dishwasher', quantity: 2, unitPrice: 3500, amount: 7000 }
  );
  assert.deepStrictEqual(
    parseLineItem('Turbofan E32D4 Digital Convection Oven34,950.0010%14,850.00'),
    { description: 'Turbofan E32D4 Digital Convection Oven', quantity: 3, unitPrice: 4950, amount: 14850 }
  );
});

test('an explicit quantity of 1 does not end up in the product name', () => {
  const line = parseLineItem('Waldorf RN8610G-B 900mm Gas Oven Range 1 8,250.00 10% 8,250.00');
  assert.strictEqual(line.description, 'Waldorf RN8610G-B 900mm Gas Oven Range');
  assert.strictEqual(line.quantity, 1);
});

test('digits that are part of the description are left alone', () => {
  assert.deepStrictEqual(
    parseLineItem('Stainless bench 1800x700 4 450.00 10% 1,800.00'),
    { description: 'Stainless bench 1800x700', quantity: 4, unitPrice: 450, amount: 1800 }
  );
  assert.deepStrictEqual(
    parseLineItem('Model X200 1,500.00 1,500.00'),
    { description: 'Model X200', quantity: 1, unitPrice: 1500, amount: 1500 }
  );
});

test('works without a GST column', () => {
  assert.deepStrictEqual(
    parseLineItem('Roband GSA815 Grill Station 3 1,890.00 5,670.00'),
    { description: 'Roband GSA815 Grill Station', quantity: 3, unitPrice: 1890, amount: 5670 }
  );
});

test('totals and stray numbers are not mistaken for equipment', () => {
  assert.strictEqual(parseLineItem('Subtotal 30,520.00'), null);
  assert.strictEqual(parseLineItem('Bank details BSB 083-004 Account 12 345 6789'), null);
  // Arithmetic that does not hold means the columns were misread, so no guess.
  assert.strictEqual(parseLineItem('Some line 2 100.00 999.00'), null);
});

test('pulls the header fields off a whole invoice', () => {
  const text = [
    'TAX INVOICE',
    'CHES Management Group Pty Ltd',
    'Bill To:',
    'Harbour Kitchen Pty Ltd',
    '5 Wharf Road',
    'Invoice Number: INV-77123',
    'Invoice Date: 4 Feb 2026',
    'Description Quantity Unit Price GST Amount AUD',
    'SIMCO SD80 Underbench Dishwasher 2 3,500.00 10% 7,000.00',
    'Freight to Sydney Metro 1 420.00 10% 420.00',
    'TOTAL AUD 8,162.00',
  ].join('\n');

  const parsed = parseInvoiceText(text);
  assert.strictEqual(parsed.invoice_number, 'INV-77123');
  assert.strictEqual(parsed.invoice_date, '2026-02-04');
  assert.strictEqual(parsed.detected_customer, 'Harbour Kitchen Pty Ltd');
  assert.strictEqual(parsed.lines.length, 2);
  assert.strictEqual(parsed.lines[0].include, true);
  assert.strictEqual(parsed.lines[1].include, false, 'freight is a charge, not a machine');
});

test('recognises the brands CHES resells', () => {
  assert.strictEqual(detectBrand('SIMCO SD80 Underbench Dishwasher'), 'SIMCO');
  assert.strictEqual(detectBrand('Blueseal G56D Gas Cooktop'), 'Blue Seal');
  assert.strictEqual(detectBrand('Robot Coupe R301 Ultra'), 'Robot Coupe');
  assert.strictEqual(detectBrand('Stainless steel bench 1800mm'), '');
});

test('picks a model code out of a description', () => {
  assert.strictEqual(detectModelCode('Waldorf RN8610G-B 900mm Gas Oven Range'), 'RN8610G-B');
  assert.strictEqual(detectModelCode('Stainless bench 600mm wide'), '');
});
