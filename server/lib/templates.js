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

/** Acknowledgement to the customer who lodged the request. */
function claimReceipt({ claim, customer, device }) {
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
      'What happens next\n'
      + '  1. Our team reviews the request and confirms your warranty status.\n'
      + '  2. Where the fault is covered by the manufacturer, we lodge the job\n'
      + '     with them on your behalf and send you their job number.\n'
      + '  3. The technician or manufacturer contacts your on-site person to\n'
      + '     arrange attendance.',
      `You can track this request at ${config.baseUrl}`,
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

/** Status change notification to the customer. */
function claimStatusUpdate({ claim, customer, device, statusLabel, note }) {
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
      `Track this request at ${config.baseUrl}`,
      RULE,
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

/** Invitation sent after CHES imports an invoice, asking the customer to register. */
function registrationInvite({ customer, devices, invoiceNumber }) {
  return {
    subject: `Register your new equipment with CHES Online${invoiceNumber ? ` — ${invoiceNumber}` : ''}`,
    text: joinBlocks([
      `Hi ${customer.contact_name || customer.company_name},`,
      `Your equipment from CHES Online${invoiceNumber ? ` (invoice ${invoiceNumber})` : ''} is now on your\n`
      + 'warranty portal. Once it arrives, please take two minutes to confirm the\n'
      + 'delivery date and your on-site contact — that starts your warranty cover\n'
      + 'and means a future service request takes about 30 seconds to lodge.',
      ['EQUIPMENT ON YOUR ACCOUNT (' + devices.length + ')',
        ...devices.slice(0, 30).map((d) => `  ${d.asset_tag}  ${d.product_name}`),
        devices.length > 30 ? `  … and ${devices.length - 30} more` : null,
      ].filter(Boolean).join('\n'),
      `Sign in with this email address — no password needed:\n  ${config.baseUrl}`,
      RULE,
      `CHES Online · ${config.ches.serviceEmail}`,
    ]),
  };
}

module.exports = {
  loginCode,
  newClaimToChes,
  claimReceipt,
  forwardToManufacturer,
  claimStatusUpdate,
  registrationInvite,
  addressOf,
};
