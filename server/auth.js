'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db } = require('./db');

const CUSTOMER_COOKIE = 'ches_customer';
const STAFF_COOKIE = 'ches_staff';

// Two separate cookies so a CHES staff member can be signed into the admin
// console and a test customer account in the same browser.
const COOKIE_FOR = { customer: CUSTOMER_COOKIE, staff: STAFF_COOKIE };

function hashToken(token) {
  return crypto.createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateLoginCode() {
  // 6 digits, uniform, no modulo bias.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function isoPlusDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

function isoPlusMinutes(minutes) {
  return new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function createSession(res, subjectType, subjectId) {
  const token = randomToken();
  db.prepare(`
    INSERT INTO sessions (token_hash, subject_type, subject_id, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashToken(token), subjectType, subjectId, isoPlusDays(config.sessionTtlDays));

  res.cookie(COOKIE_FOR[subjectType], token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.sessionTtlDays * 86400000,
    path: '/',
  });
  return token;
}

function destroySession(req, res, subjectType) {
  const token = req.cookies[COOKIE_FOR[subjectType]];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE_FOR[subjectType], { path: '/' });
}

function readSession(req, subjectType) {
  const token = req.cookies[COOKIE_FOR[subjectType]];
  if (!token) return null;
  const row = db.prepare(`
    SELECT * FROM sessions
    WHERE token_hash = ? AND subject_type = ? AND expires_at > datetime('now')
  `).get(hashToken(token), subjectType);
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ?").run(row.token_hash);
  return row;
}

/** Populates req.customer / req.staff when a valid session cookie is present. */
function attachIdentity(req, res, next) {
  const customerSession = readSession(req, 'customer');
  if (customerSession) {
    req.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerSession.subject_id) || null;
  }
  const staffSession = readSession(req, 'staff');
  if (staffSession) {
    const staff = db.prepare('SELECT * FROM staff_users WHERE id = ? AND active = 1').get(staffSession.subject_id);
    req.staff = staff || null;
  }
  next();
}

function requireCustomer(req, res, next) {
  if (!req.customer) return res.status(401).json({ error: 'not_signed_in' });
  next();
}

function requireStaff(req, res, next) {
  if (!req.staff) return res.status(401).json({ error: 'not_signed_in' });
  next();
}

// --- Login codes -----------------------------------------------------------

const CODE_REQUEST_LIMIT = 5;        // per email per hour
const CODE_ATTEMPT_LIMIT = 5;        // wrong guesses before a code is burned

function recentCodeRequests(email) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM login_codes
    WHERE lower(email) = lower(?) AND created_at > datetime('now', '-1 hour')
  `).get(email).n;
}

function issueLoginCode(email) {
  if (recentCodeRequests(email) >= CODE_REQUEST_LIMIT) {
    return { throttled: true };
  }
  // Any earlier unused code for this address stops working.
  db.prepare("UPDATE login_codes SET consumed_at = datetime('now') WHERE lower(email) = lower(?) AND consumed_at IS NULL")
    .run(email);

  const code = generateLoginCode();
  db.prepare(`
    INSERT INTO login_codes (email, code_hash, expires_at) VALUES (?, ?, ?)
  `).run(email.toLowerCase(), bcrypt.hashSync(code, 10), isoPlusMinutes(config.loginCodeTtlMinutes));

  return { throttled: false, code, minutes: config.loginCodeTtlMinutes };
}

function verifyLoginCode(email, code) {
  const row = db.prepare(`
    SELECT * FROM login_codes
    WHERE lower(email) = lower(?) AND consumed_at IS NULL AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(email);

  if (!row) return { ok: false, reason: 'expired' };
  if (row.attempts >= CODE_ATTEMPT_LIMIT) {
    db.prepare("UPDATE login_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (!bcrypt.compareSync(String(code || '').trim(), row.code_hash)) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, reason: 'invalid' };
  }
  db.prepare("UPDATE login_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
  return { ok: true };
}

// --- Staff passwords -------------------------------------------------------

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

function checkPassword(plain, hash) {
  return bcrypt.compareSync(String(plain || ''), String(hash || ''));
}

/** Remove expired sessions and login codes. Called on boot and hourly. */
function pruneExpired() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.prepare("DELETE FROM login_codes WHERE created_at <= datetime('now', '-7 days')").run();
}

module.exports = {
  attachIdentity,
  requireCustomer,
  requireStaff,
  createSession,
  destroySession,
  issueLoginCode,
  verifyLoginCode,
  hashPassword,
  checkPassword,
  pruneExpired,
  nowSql,
  CUSTOMER_COOKIE,
  STAFF_COOKIE,
};
