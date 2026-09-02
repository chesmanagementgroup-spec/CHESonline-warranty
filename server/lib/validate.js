'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Trim, collapse non-breaking spaces, and cap length. */
function str(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/ /g, ' ').trim().slice(0, max);
}

function isEmail(v) {
  return EMAIL_RE.test(String(v || '').trim());
}

function email(v) {
  return String(v || '').trim().toLowerCase().slice(0, 254);
}

function int(v, { min = -Infinity, max = Infinity, fallback = null } = {}) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function money(v) {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function oneOf(v, allowed, fallback) {
  const s = String(v || '').trim();
  return allowed.includes(s) ? s : fallback;
}

/** Collect field errors; returns null when everything passed. */
function requireFields(fields) {
  const errors = {};
  for (const [name, value, message] of fields) {
    if (!String(value === undefined || value === null ? '' : value).trim()) {
      errors[name] = message || 'Required';
    }
  }
  return Object.keys(errors).length ? errors : null;
}

module.exports = { str, isEmail, email, int, money, oneOf, requireFields };
