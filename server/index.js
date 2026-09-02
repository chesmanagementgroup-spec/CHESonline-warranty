'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const { verifyTransport, isSmtpConfigured } = require('./mailer');
const { attachmentPath } = require('./lib/uploads');
const v = require('./lib/validate');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());
app.use(auth.attachIdentity);

// Basic hardening. The pages load their own CSS/JS only, plus Google Fonts.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
    + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    + "font-src 'self' https://fonts.gstatic.com; script-src 'self'; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/portal', require('./routes/portal'));
app.use('/api/admin/invoices', require('./routes/invoices'));
app.use('/api/admin', require('./routes/admin'));

/**
 * Uploaded files. Staff see everything; a customer sees only files attached to
 * their own devices and claims. Nothing is served straight off disk.
 */
app.get('/api/files/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(v.int(req.params.id, { fallback: 0 }));
  if (!row) return res.status(404).json({ error: 'not_found' });

  if (!req.staff) {
    if (!req.customer) return res.status(401).json({ error: 'not_signed_in' });
    const ownsIt = row.customer_id === req.customer.id
      || (row.claim_id && db.prepare('SELECT 1 AS ok FROM claims WHERE id = ? AND customer_id = ?').get(row.claim_id, req.customer.id))
      || (row.device_id && db.prepare('SELECT 1 AS ok FROM devices WHERE id = ? AND customer_id = ?').get(row.device_id, req.customer.id));
    if (!ownsIt) return res.status(403).json({ error: 'forbidden' });
  }

  const file = attachmentPath(row.stored_name);
  if (!fs.existsSync(file)) return res.status(410).json({ error: 'file_missing' });

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${row.original_name.replace(/["\\]/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(file).pipe(res);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    smtp: isSmtpConfigured() ? 'configured' : 'outbox-only',
    version: require('../package.json').version,
  });
});

// --- Static pages ----------------------------------------------------------

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));

app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(publicDir, 'portal.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// --- Errors ----------------------------------------------------------------

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: `Maximum ${Math.round(config.upload.maxFileBytes / 1048576)} MB per file.` });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: 'too_many_files', message: `Maximum ${config.upload.maxFilesPerRequest} files at a time.` });
  }
  if (err && err.code === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(415).json({ error: 'unsupported_file_type', message: 'That file type is not accepted here.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'server_error' });
});

// --- Boot ------------------------------------------------------------------

/** Create the first staff account so a fresh install can be signed into. */
function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM staff_users').get().n;
  if (count > 0) return;
  if (!config.admin.email || !config.admin.password) {
    console.warn(
      '\n[setup] No staff account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env\n'
      + '        and restart, or run:  npm run seed\n'
    );
    return;
  }
  db.prepare('INSERT INTO staff_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(config.admin.name, config.admin.email, auth.hashPassword(config.admin.password), 'admin');
  console.log(`[setup] Created staff account for ${config.admin.email}`);
}

async function start() {
  ensureAdmin();
  auth.pruneExpired();
  setInterval(auth.pruneExpired, 3600 * 1000).unref();

  const mail = await verifyTransport();
  if (!mail.configured) {
    console.log('[mail] SMTP not configured — emails are written to data/outbox/ and the email log.');
  } else if (!mail.ok) {
    console.warn(`[mail] SMTP configured but not reachable: ${mail.error}`);
  } else {
    console.log(`[mail] SMTP ready (${config.smtp.host}:${config.smtp.port})`);
  }

  app.listen(config.port, () => {
    console.log(`\nCHES Online warranty platform`);
    console.log(`  Customer portal  ${config.baseUrl}/`);
    console.log(`  CHES console     ${config.baseUrl}/admin\n`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
