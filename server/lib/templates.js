'use strict';

const config = require('../config');

const RULE = '-'.repeat(64);

function pad(label, width = 18) {
  return (label + ':').padEnd(width, ' ');
}

function block(title, rows) {
  const body = rows
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => '  ' + pad(k) + String(v));
  if (!body.length) return null;
  return [title.toUpperCase(), ...body].join('\n');
}

function joinBlocks(parts) {
  return parts.filter(Boolean).join('\n\n');
}

function addressOf(customer) {
  return [
    customer.address_line1,
    customer.address_line2,
    [customer.suburb, customer.state, customer.postcode].filter(Boolean).join(' '),
    customer.country && customer.country !== 'Australia' ? customer.country : null,
  ].filter((p) => p && String(p).trim()).join(', ');
}

/**
 * Every message to a customer ends with the same one-click way back in, so
 * reaching their equipment never requires remembering anything.
 */
function signInBlock(portalUrl) {
  return portalUrl
    ? `See all your equipment and its warranty status:\n  ${portalUrl}`
    : `Portal: ${config.baseUrl}`;
}

/** 6-digit sign-in code sent to a customer. */
function loginCode({ code, minutes }) {
  return {
    subject: `${code} is your CHES Online sign-in code`,
    text: joinBlocks([
      'CHES ONLINE — EQUIPMENT & WARRANTY PORTAL',
      RULE,
      `Your sign-in code is:   ${code}`,
      `This code expires in ${minutes} minutes and can be used once.`,
      `Portal: ${config.baseUrl}`,
      RULE,
      'If you did not request this code you can ignore this email — no one can\n'
      + 'access your account without it.',
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

/** The "system email" that lands in the CHES inbox when a claim is lodged. */
function newClaimToChes({ claim, customer, device, warranty, attachments }) {
  const deviceRows = device
    ? block('Equipment', [
      ['Asset tag', device.asset_tag],
      ['Product', device.product_name],
      ['Brand', device.brand],
      ['Model', device.model_code],
      ['Serial', device.serial_number],
      ['Invoice', device.invoice_number],
      ['Purchased', device.purchase_date],
      ['Received on site', device.delivered_at],
      ['Warranty ends', warranty && warranty.warranty_end],
      ['Warranty status', warranty && warranty.status === 'expired'
        ? 'OUT OF WARRANTY'
        : warranty && warranty.days_remaining !== null
          ? `IN WARRANTY (${warranty.days_remaining} days remaining)`
          : 'Unknown — needs checking'],
      ['Record added by', device.source === 'customer'
        ? (device.verified_at
          ? 'the customer, checked by CHES'
          : 'THE CUSTOMER, NOT YET CHECKED — confirm cover before lodging with the manufacturer')
        : 'CHES, from the supplier invoice'],
      ['Location on site', device.location_note],
    ])
    : block('Equipment', [['Note', 'Customer did not select a registered device — see description.']]);

  return {
    subject: `[${claim.reference}] ${claim.priority === 'urgent' ? 'URGENT — ' : ''}Service request — ${customer.company_name} — ${device ? device.product_name : claim.category}`,
    text: joinBlocks([
      'NEW SERVICE / WARRANTY REQUEST',
      RULE,
      block('Request', [
        ['Reference', claim.reference],
        ['Lodged', claim.created_at + ' (server time)'],
        ['Priority', claim.priority],
        ['Category', claim.category],
        ['Fault started', claim.fault_started_on],
      ]),
      block('Customer', [
        ['Business', customer.company_name],
        ['Account contact', customer.contact_name],
        ['Account email', customer.email],
        ['Account phone', customer.phone],
        ['Site address', claim.site_address || addressOf(customer)],
      ]),
      block('On-site contact for this job', [
        ['Name', claim.contact_name || customer.site_contact_name],
        ['Role', customer.site_contact_role],
        ['Phone', claim.contact_phone || customer.site_contact_phone],
        ['Email', claim.contact_email || customer.site_contact_email],
        ['Best times', claim.preferred_times],
      ]),
      deviceRows,
      ['FAULT DESCRIPTION', ...String(claim.description).split('\n').map((l) => '  ' + l)].join('\n'),
      attachments && attachments.length
        ? ['ATTACHMENTS (' + attachments.length + ')',
          ...attachments.map((a) => `  ${a.original_name}  ${config.baseUrl}/api/files/${a.id}`)].join('\n')
        : 'ATTACHMENTS\n  None uploaded',
      RULE,
      `Open in the console:  ${config.baseUrl}/admin#claim-${claim.id}`,
      'Next step: check the warranty status above, then forward to the\n'
      + 'manufacturer from the console (Claim > Forward to manufacturer).',
    ]),
  };
}

/** What a customer is told when the machine is no longer covered. */
function outOfWarrantyNote(device) {
  return [
    'THIS MACHINE IS OUT OF WARRANTY',
    device && device.warranty_end ? `  Cover ended ${device.warranty_end}.` : null,
    '  You are free to arrange your own repairer for this one.',
    '  If you would rather we introduced a technician and helped coordinate the',
    `  repair, email ${config.ches.afterSalesEmail} and we will help.`,
    '  Any work on an out-of-warranty machine is chargeable, and we will confirm',
    '  the cost with you before anything goes ahead.',
  ].filter(Boolean).join('\n');
}

/** Acknowledgement to the customer who lodged the request. */
function claimReceipt({ claim, customer, device, portalUrl }) {
  return {
    subject: `We've received your service request — ${claim.reference}`,
    text: joinBlocks([
      `Hi ${claim.contact_name || customer.contact_name || customer.company_name},`,
      `Thank you — your service request has been logged with CHES Online.`,
      block('Your request', [
        ['Reference', claim.reference],
        ['Equipment', device ? `${device.product_name} (${device.asset_tag})` : claim.category],
        ['Category', claim.category],
        ['Lodged', claim.created_at],
      ]),
      claim.under_warranty
        ? 'What happens next\n'
          + '  1. Our team reviews the request and confirms your warranty status.\n'
          + '  2. Where the fault is covered by the manufacturer, we lodge the job\n'
          + '     with them on your behalf and send you their job number.\n'
          + '  3. The technician or manufacturer contacts your on-site person to\n'
          + '     arrange attendance.'
        : outOfWarrantyNote(device),
      signInBlock(portalUrl),
      `Please quote ${claim.reference} in any correspondence.`,
      RULE,
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

/** The request CHES sends on to the manufacturer / supplier. */
function forwardToManufacturer({ claim, customer, device, manufacturer, warranty, attachments, extraNote }) {
  const address = claim.site_address || addressOf(customer);
  return {
    subject: `Warranty service request — ${device ? `${device.brand || ''} ${device.model_code || device.product_name}`.trim() : claim.category} — ${customer.company_name} — our ref ${claim.reference}`,
    text: joinBlocks([
      `Hi ${manufacturer && manufacturer.name ? manufacturer.name + ' service team' : 'service team'},`,
      'We would like to lodge a warranty service request on behalf of our customer.\n'
      + 'Details are below; please confirm receipt and provide a job number.',
      block('Equipment', [
        ['Brand', device && device.brand],
        ['Model', device && device.model_code],
        ['Serial number', device && device.serial_number],
        ['Product', device && device.product_name],
        ['Purchase date', device && device.purchase_date],
        ['Date installed', device && device.delivered_at],
        ['Warranty expiry', warranty && warranty.warranty_end],
        ['Supplier invoice', device && device.invoice_number],
      ]),
      block('Site', [
        ['Business', customer.company_name],
        ['Address', address],
        ['Site contact', claim.contact_name || customer.site_contact_name],
        ['Phone', claim.contact_phone || customer.site_contact_phone],
        ['Email', claim.contact_email || customer.site_contact_email],
        ['Access / best times', claim.preferred_times],
      ]),
      ['FAULT REPORTED', ...String(claim.description).split('\n').map((l) => '  ' + l)].join('\n'),
      extraNote ? ['ADDITIONAL NOTES', ...String(extraNote).split('\n').map((l) => '  ' + l)].join('\n') : null,
      attachments && attachments.length
        ? ['PHOTOS / VIDEO OF THE FAULT',
          ...attachments.map((a) => `  ${a.original_name}  ${config.baseUrl}/api/files/${a.id}`)].join('\n')
        : null,
      block('Our reference', [
        ['CHES job', claim.reference],
        ['Raised by', `${config.ches.fromName}`],
        ['Reply to', config.ches.serviceEmail],
      ]),
      'Please reply to this email with your job number and expected attendance\n'
      + 'date so we can keep the customer informed.',
      'Kind regards,\n' + config.ches.fromName,
      RULE,
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

/**
 * Told to CHES when a customer adds equipment from their own invoice. This is
 * the customer's account of what they own — it needs checking before it is
 * treated as cover CHES has given.
 */
function customerAddedEquipment({ customer, site, devices, invoiceNumber, fileName }) {
  return {
    subject: `Equipment added by ${customer.company_name}${invoiceNumber ? ` — ${invoiceNumber}` : ''} — needs checking`,
    text: joinBlocks([
      'EQUIPMENT ADDED BY A CUSTOMER',
      RULE,
      block('Customer', [
        ['Business', customer.company_name],
        ['Contact', customer.contact_name],
        ['Email', customer.email],
        ['Phone', customer.phone],
        ['Site', site && site.name],
        ['Site address', site ? addressOf({
          address_line1: site.address_line1, address_line2: site.address_line2,
          suburb: site.suburb, state: site.state, postcode: site.postcode, country: site.country,
        }) : ''],
      ]),
      block('Invoice they uploaded', [
        ['Invoice number', invoiceNumber],
        ['File', fileName],
        ['Machines added', devices.length],
      ]),
      ['MACHINES', ...devices.map((d) => `  ${d.asset_tag}  ${d.product_name}`
        + `${d.serial_number ? `  S/N ${d.serial_number}` : ''}`
        + `${d.warranty_end ? `  (cover to ${d.warranty_end} if confirmed)` : ''}`)].join('\n'),
      'These machines are on the customer\'s account now and they can report a\n'
      + 'fault against them, but every one is flagged AWAITING CHECK until someone\n'
      + 'here confirms it. The warranty dates above are worked from the invoice\n'
      + 'they supplied and the supplier\'s standard term — they are not cover CHES\n'
      + 'has agreed to until you say so.',
      `Check them in the console:  ${config.baseUrl}/admin#devices`,
      RULE,
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

/** Status change notification to the customer. */
function claimStatusUpdate({ claim, customer, device, statusLabel, note, portalUrl }) {
  return {
    subject: `Update on ${claim.reference} — ${statusLabel}`,
    text: joinBlocks([
      `Hi ${claim.contact_name || customer.contact_name || customer.company_name},`,
      `There is an update on your service request ${claim.reference}.`,
      block('Update', [
        ['Reference', claim.reference],
        ['Equipment', device ? `${device.product_name} (${device.asset_tag})` : ''],
        ['New status', statusLabel],
        ['Manufacturer', claim.manufacturer_ref ? `job ${claim.manufacturer_ref}` : ''],
      ]),
      note ? ['NOTE FROM CHES', ...String(note).split('\n').map((l) => '  ' + l)].join('\n') : null,
      signInBlock(portalUrl),
      RULE,
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

/**
 * Sent once CHES has processed an invoice. There is nothing for the customer
 * to fill in — the equipment is already on their account and under warranty —
 * so this is a handover note plus the link that gets them back to it.
 */
function equipmentHandover({ customer, devices, invoiceNumber, site, portalUrl }) {
  const byWarranty = devices
    .slice(0, 40)
    .map((d) => `  ${d.asset_tag}  ${d.product_name}`
      + (d.warranty_end ? `\n${' '.repeat(4)}covered to ${d.warranty_end}` : ''));

  return {
    subject: `Your equipment and warranty details${invoiceNumber ? ` — ${invoiceNumber}` : ''}`,
    text: joinBlocks([
      `Hi ${customer.contact_name || customer.company_name},`,
      `Your equipment from CHES Online${invoiceNumber ? ` (invoice ${invoiceNumber})` : ''} is now on\n`
      + 'your warranty portal, with its serial numbers and warranty dates already\n'
      + 'recorded. There is nothing you need to fill in.',
      site ? block('Delivered to', [
        ['Site', site.name],
        ['Address', addressOf({
          address_line1: site.address_line1, address_line2: site.address_line2,
          suburb: site.suburb, state: site.state, postcode: site.postcode, country: site.country,
        })],
        ['On-site contact', site.contact_name],
      ]) : null,
      ['YOUR EQUIPMENT (' + devices.length + ')', ...byWarranty,
        devices.length > 40 ? `  … and ${devices.length - 40} more` : null].filter(Boolean).join('\n'),
      'If something goes wrong, open the link below, pick the machine and tell us\n'
      + 'what it is doing. We check the warranty and lodge it with the manufacturer\n'
      + 'for you.',
      signInBlock(portalUrl),
      RULE,
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

module.exports = {
  loginCode,
  newClaimToChes,
  claimReceipt,
  outOfWarrantyNote,
  forwardToManufacturer,
  claimStatusUpdate,
  equipmentHandover,
  customerAddedEquipment,
  signInBlock,
  addressOf,
};
