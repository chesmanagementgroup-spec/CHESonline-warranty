'use strict';

/** Normalise many human date formats to ISO `YYYY-MM-DD`, or null. */
function toIsoDate(input) {
  if (!input) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input.toISOString().slice(0, 10);
  }
  const s = String(input).trim();
  if (!s) return null;

  // Already ISO (possibly with a time component)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validParts(+m[1], +m[2], +m[3]);

  // 31/12/2025 or 31-12-2025 or 31.12.2025  (AU day-first)
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    y = +y;
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return validParts(y, +mo, +d);
  }

  // 31 Dec 2025 / 31 December 2025 / Dec 31, 2025
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\,?\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return validParts(+m[3], mi + 1, +m[1]);
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\,?\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return validParts(+m[3], mi + 1, +m[2]);
  }

  return null;
}

function validParts(y, mo, d) {
  if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Add whole months to an ISO date, clamping to the end of a shorter month. */
function addMonths(isoDate, months) {
  const iso = toIsoDate(isoDate);
  if (!iso || !Number.isFinite(months)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIsoStr) {
  const a = toIsoDate(fromIso);
  const b = toIsoDate(toIsoStr);
  if (!a || !b) return null;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * Warranty for a device.  Cover starts the day the machine is received on
 * site; if that has not been registered yet we fall back to the invoice date.
 */
function warrantyFor({ delivered_at, purchase_date, warranty_months }) {
  const start = toIsoDate(delivered_at) || toIsoDate(purchase_date);
  const months = Number.isFinite(warranty_months) ? warranty_months : parseInt(warranty_months, 10);
  if (!start || !Number.isFinite(months) || months <= 0) {
    return { warranty_start: start, warranty_end: null, status: 'unknown', days_remaining: null };
  }
  const end = addMonths(start, months);
  const remaining = daysBetween(today(), end);
  let status = 'active';
  if (remaining === null) status = 'unknown';
  else if (remaining < 0) status = 'expired';
  else if (remaining <= 60) status = 'expiring';
  return { warranty_start: start, warranty_end: end, status, days_remaining: remaining };
}

module.exports = { toIsoDate, addMonths, today, daysBetween, warrantyFor };
