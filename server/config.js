'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config();

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};
const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');
const uploadDir = path.join(dataDir, 'uploads');
const outboxDir = path.join(dataDir, 'outbox');

for (const dir of [dataDir, uploadDir, outboxDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const isProd = process.env.NODE_ENV === 'production';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'change-me-to-a-long-random-string') {
  if (isProd) {
    throw new Error(
      'SESSION_SECRET must be set to a long random value in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  // Dev convenience: persist a generated secret so sessions survive restarts.
  const devSecretFile = path.join(dataDir, '.dev-session-secret');
  if (fs.existsSync(devSecretFile)) {
    sessionSecret = fs.readFileSync(devSecretFile, 'utf8').trim();
  } else {
    sessionSecret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(devSecretFile, sessionSecret, { mode: 0o600 });
  }
}

const smtpHost = (process.env.SMTP_HOST || '').trim();

const config = {
  isProd,
  rootDir,
  dataDir,
  uploadDir,
  outboxDir,
  dbFile: path.join(dataDir, 'warranty.db'),
  port: int(process.env.PORT, 3000),
  baseUrl: (process.env.APP_BASE_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  sessionSecret,
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  loginCodeTtlMinutes: int(process.env.LOGIN_CODE_TTL_MINUTES, 15),
  defaultWarrantyMonths: int(process.env.DEFAULT_WARRANTY_MONTHS, 12),
  ches: {
    serviceEmail: (process.env.CHES_SERVICE_EMAIL || 'chesmanagementgroup@gmail.com').trim(),
    fromName: (process.env.CHES_FROM_NAME || 'CHES Online').trim(),
    fromEmail: (process.env.CHES_FROM_EMAIL || 'chesmanagementgroup@gmail.com').trim(),
  },
  smtp: {
    enabled: Boolean(smtpHost),
    host: smtpHost,
    port: int(process.env.SMTP_PORT, 465),
    secure: bool(process.env.SMTP_SECURE, int(process.env.SMTP_PORT, 465) === 465),
    user: (process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
  },
  admin: {
    name: (process.env.ADMIN_NAME || 'CHES Admin').trim(),
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
  },
  upload: {
    maxFileBytes: 25 * 1024 * 1024,
    maxFilesPerRequest: 10,
  },
};

module.exports = config;
