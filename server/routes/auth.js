'use strict';

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const v = require('../lib/validate');
const { sendMail } = require('../mailer');
const templates = require('../lib/templates');
const { customerByEmail } = require('../lib/models');

const router = express.Router();

// Staff sign-in is password-based, so it needs a brake on guessing. Codes are
// throttled per address inside auth.js; this covers the password endpoint.
const STAFF_ATTEMPT_LIMIT = 10;
const STAFF_WINDOW_MS = 15 * 60 * 1000;
const staffAttempts = new Map();

function staffThrottled(key) {
  const now = Date.now();
  const entry = staffAttempts.get(key);
  if (!entry || now - entry.first > STAFF_WINDOW_MS) return false;
  return entry.count >= STAFF_ATTEMPT_LIMIT;
}

function noteStaffFailure(key) {
  const now = Date.now();
  const entry = staffAttempts.get(key);
  if (!entry || now - entry.first > STAFF_WINDOW_MS) staffAttempts.set(key, { first: now, count: 1 });
  else entry.count += 1;
}

// Keep the map from growing without bound on a long-running server.
setInterval(() => {
  const cutoff = Date.now() - STAFF_WINDOW_MS;
  for (const [key, entry] of staffAttempts) if (entry.first < cutoff) staffAttempts.delete(key);
}, STAFF_WINDOW_MS).unref();


/**
 * Step 1 of customer sign-in: email a 6-digit code.
 *
 * Always answers 200 with the same shape, whether or not the address is on
 * file — otherwise this endpoint would tell anyone which businesses buy from
 * CHES.  In development the code comes back in the response so the flow can
 * be exercised without a mailbox.
 */
router.post('/request-code', async (req, res) => {
  const email = v.email(req.body.email);
  if (!v.isEmail(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const customer = customerByEmail(email);
  const response = { ok: true, sent: true, email };

  if (customer) {
    const issued = auth.issueLoginCode(email);
    if (issued.throttled) {
      return res.status(429).json({ error: 'too_many_requests' });
    }
    const msg = templates.loginCode({ code: issued.code, minutes: issued.minutes });
    await sendMail({
      to: email,
      subject: msg.subject,
      text: msg.text,
      template: 'login_code',
      relatedType: 'customer',
      relatedId: customer.id,
    });
    if (!config.isProd) response.dev_code = issued.code;
  } else {
    // Burn roughly the same amount of time so the response cannot be timed.
    auth.issueLoginCode(email);
    db.prepare("DELETE FROM login_codes WHERE lower(email) = lower(?)").run(email);
  }

  res.json(response);
});

/** Step 2: exchange the code for a session. */
router.post('/verify-code', (req, res) => {
  const email = v.email(req.body.email);
  const code = v.str(req.body.code, 10);
  if (!v.isEmail(email) || !code) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const customer = customerByEmail(email);
  const result = auth.verifyLoginCode(email, code);
  if (!result.ok || !customer) {
    return res.status(401).json({ error: result.reason || 'invalid' });
  }

  auth.createSession(res, 'customer', customer.id);
  res.json({ ok: true, customer_id: customer.id, company_name: customer.company_name });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res, 'customer');
  res.json({ ok: true });
});

/** Staff sign-in with email + password. */
router.post('/staff/login', (req, res) => {
  const email = v.email(req.body.email);
  const password = String(req.body.password || '');
  const key = `${req.ip}|${email}`;

  if (staffThrottled(key)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const staff = db.prepare('SELECT * FROM staff_users WHERE lower(email) = lower(?) AND active = 1').get(email);

  if (!staff || !auth.checkPassword(password, staff.password_hash)) {
    noteStaffFailure(key);
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  staffAttempts.delete(key);
  db.prepare("UPDATE staff_users SET last_login_at = datetime('now') WHERE id = ?").run(staff.id);
  auth.createSession(res, 'staff', staff.id);
  res.json({ ok: true, name: staff.name, email: staff.email, role: staff.role });
});

router.post('/staff/logout', (req, res) => {
  auth.destroySession(req, res, 'staff');
  res.json({ ok: true });
});

/** Who am I — drives which UI the browser shows. */
router.get('/session', (req, res) => {
  res.json({
    customer: req.customer
      ? { id: req.customer.id, company_name: req.customer.company_name, email: req.customer.email }
      : null,
    staff: req.staff
      ? { id: req.staff.id, name: req.staff.name, email: req.staff.email, role: req.staff.role }
      : null,
  });
});

module.exports = router;
