'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('./config');
const { db } = require('./db');

let transporter = null;
if (config.smtp.enabled) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

const fromHeader = `"${config.ches.fromName}" <${config.ches.fromEmail}>`;

function safeSlug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').slice(0, 60).replace(/^-|-$/g, '');
}

/**
 * Send an email and record it in email_log.
 *
 * When SMTP is not configured (SMTP_HOST blank) nothing is transmitted: the
 * message is written to data/outbox/*.eml and logged with status 'logged'.
 * That keeps the whole flow testable without wiring up a mailbox, and means a
 * misconfigured server never silently drops a warranty claim — it is always
 * recoverable from the log.
 */
async function sendMail({ to, cc, replyTo, subject, text, template = '', relatedType = '', relatedId = null }) {
  const toAddr = Array.isArray(to) ? to.filter(Boolean).join(', ') : String(to || '').trim();
  const ccAddr = Array.isArray(cc) ? cc.filter(Boolean).join(', ') : String(cc || '').trim();
  const body = String(text || '');

  if (!toAddr) {
    return { ok: false, status: 'failed', error: 'no recipient' };
  }

  const insert = db.prepare(`
    INSERT INTO email_log (to_addr, cc_addr, reply_to, subject, body, template, status, error, related_type, related_id)
    VALUES (@to_addr, @cc_addr, @reply_to, @subject, @body, @template, @status, @error, @related_type, @related_id)
  `);

  if (!transporter) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.outboxDir, `${stamp}-${safeSlug(subject) || 'message'}.eml`);
    const eml = [
      `From: ${fromHeader}`,
      `To: ${toAddr}`,
      ccAddr ? `Cc: ${ccAddr}` : null,
      replyTo ? `Reply-To: ${replyTo}` : null,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      '',
      body,
    ].filter((l) => l !== null).join('\n');
    fs.writeFileSync(file, eml, 'utf8');
    const info = insert.run({
      to_addr: toAddr, cc_addr: ccAddr, reply_to: replyTo || '', subject, body,
      template, status: 'logged', error: '', related_type: relatedType, related_id: relatedId,
    });
    console.log(`[mail:dev] "${subject}" -> ${toAddr}  (written to ${path.relative(config.rootDir, file)})`);
    return { ok: true, status: 'logged', id: info.lastInsertRowid, file };
  }

  try {
    await transporter.sendMail({
      from: fromHeader,
      to: toAddr,
      cc: ccAddr || undefined,
      replyTo: replyTo || config.ches.serviceEmail,
      subject,
      text: body,
    });
    const info = insert.run({
      to_addr: toAddr, cc_addr: ccAddr, reply_to: replyTo || '', subject, body,
      template, status: 'sent', error: '', related_type: relatedType, related_id: relatedId,
    });
    return { ok: true, status: 'sent', id: info.lastInsertRowid };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const info = insert.run({
      to_addr: toAddr, cc_addr: ccAddr, reply_to: replyTo || '', subject, body,
      template, status: 'failed', error: message, related_type: relatedType, related_id: relatedId,
    });
    console.error(`[mail:error] "${subject}" -> ${toAddr}: ${message}`);
    return { ok: false, status: 'failed', error: message, id: info.lastInsertRowid };
  }
}

async function verifyTransport() {
  if (!transporter) return { configured: false, ok: true, mode: 'outbox' };
  try {
    await transporter.verify();
    return { configured: true, ok: true, mode: 'smtp' };
  } catch (err) {
    return { configured: true, ok: false, mode: 'smtp', error: err.message };
  }
}

module.exports = { sendMail, verifyTransport, isSmtpConfigured: () => Boolean(transporter) };
