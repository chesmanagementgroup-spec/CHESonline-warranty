'use strict';

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db');

const MEDIA_MIME = /^(image\/(jpeg|png|gif|webp|heic|heif|avif)|video\/(mp4|quicktime|webm|x-m4v|3gpp))$/i;
const DOC_MIME = /^(application\/pdf|text\/csv|text\/plain|application\/vnd\.ms-excel)$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 12).replace(/[^.\w]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

function makeUploader(kind) {
  const allowed = kind === 'document' ? DOC_MIME : MEDIA_MIME;
  return multer({
    storage,
    limits: { fileSize: config.upload.maxFileBytes, files: config.upload.maxFilesPerRequest },
    fileFilter: (req, file, cb) => {
      if (allowed.test(file.mimetype)) return cb(null, true);
      cb(Object.assign(new Error('unsupported_file_type'), { code: 'UNSUPPORTED_FILE_TYPE' }));
    },
  });
}

const mediaUpload = makeUploader('media');
const documentUpload = makeUploader('document');

function recordAttachments(files, { claimId = null, deviceId = null, customerId = null, kind = 'other', uploadedBy = '' }) {
  const stmt = db.prepare(`
    INSERT INTO attachments (claim_id, device_id, customer_id, kind, original_name, stored_name, mime_type, size_bytes, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids = [];
  for (const f of files || []) {
    const info = stmt.run(claimId, deviceId, customerId, kind, f.originalname, f.filename, f.mimetype, f.size, uploadedBy);
    ids.push(info.lastInsertRowid);
  }
  return ids;
}

/** Delete the file on disk as well as the row. */
function deleteAttachment(id) {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!row) return false;
  const full = path.join(config.uploadDir, path.basename(row.stored_name));
  fs.rm(full, { force: true }, () => {});
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  return true;
}

function attachmentPath(storedName) {
  // basename() keeps a crafted stored_name from escaping the upload directory.
  return path.join(config.uploadDir, path.basename(storedName));
}

module.exports = { mediaUpload, documentUpload, recordAttachments, deleteAttachment, attachmentPath };
