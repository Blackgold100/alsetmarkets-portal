const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { query, pool } = require('../db');
const h = require('../helpers');

const admin = express.Router();
const client = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } });

function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function sendFile(res, doc, download = false) {
  const ext = doc.mime === 'application/pdf' ? 'pdf' : doc.mime.split('/')[1].replace('jpeg', 'jpg');
  const filename = `alsetmarkets-registration-certificate-${doc.id}.${ext}`;
  res.set({
    'Content-Type': doc.mime,
    'Content-Length': doc.size_bytes,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.send(doc.data);
}

// Administrator: publish or replace the platform's registration certificate.
admin.use(h.requireAdmin);
admin.get('/', wrap(async (req, res) => {
  const { rows: certificates } = await query(
    `SELECT id,title,registration_body,registration_number,issued_on,description,mime,size_bytes,original_name,
            uploaded_at,is_current,client_visible
     FROM platform_certificates ORDER BY uploaded_at DESC, id DESC LIMIT 50`
  );
  res.render('admin/certificate', { title: 'Platform certificate', certificates });
}));

admin.post('/upload', (req, res, next) => upload.single('certificate')(req, res, (err) => {
  if (err) {
    h.flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Certificate must be 10 MB or smaller.' : 'Certificate upload failed.');
    return res.redirect('/admin/certificate');
  }
  next();
}), h.checkCsrf, wrap(async (req, res) => {
  const f = req.file;
  const mime = f && sniff(f.buffer);
  const title = h.str(req.body.title, 160);
  const registrationBody = h.optStr(req.body.registration_body, 160);
  const registrationNumber = h.optStr(req.body.registration_number, 100);
  const issuedOn = h.isoDate(req.body.issued_on);
  const description = h.optStr(req.body.description, 1000);
  if (!f || !mime || !title || !registrationBody || !registrationNumber) {
    h.flash(req, 'error', 'Upload a valid PDF or image and provide the certificate title, registering authority and registration number.');
    return res.redirect('/admin/certificate');
  }
  const digest = crypto.createHash('sha256').update(f.buffer).digest('hex');
  const db = await pool.connect();
  let saved;
  try {
    await db.query('BEGIN');
    await db.query('UPDATE platform_certificates SET is_current=FALSE WHERE is_current=TRUE');
    const result = await db.query(
      `INSERT INTO platform_certificates
        (title,registration_body,registration_number,issued_on,description,mime,size_bytes,original_name,data,uploaded_by,is_current,client_visible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,TRUE) RETURNING id`,
      [title, registrationBody, registrationNumber, issuedOn, description, mime, f.size,
       path.basename(h.str(f.originalname, 200)), f.buffer, req.user.id]
    );
    saved = result.rows[0];
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
  await h.audit(req, 'platform_certificate_uploaded', null, {
    certificate_id: saved.id, title, registration_body: registrationBody,
    registration_number: registrationNumber, mime, size_bytes: f.size, sha256: digest,
  });
  h.flash(req, 'success', 'Platform certificate published to the client portal.');
  res.redirect('/admin/certificate');
}));

admin.post('/:id/visibility', h.checkCsrf, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).end();
  const { rows: [doc] } = await query('SELECT id,is_current,client_visible FROM platform_certificates WHERE id=$1', [id]);
  if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'Certificate not found.' });
  const visible = !doc.client_visible;
  await query('UPDATE platform_certificates SET client_visible=$1 WHERE id=$2', [visible, id]);
  await h.audit(req, 'platform_certificate_visibility_changed', null, { certificate_id: id, client_visible: visible });
  h.flash(req, 'success', visible ? 'Certificate is now visible to clients.' : 'Certificate is now hidden from clients.');
  res.redirect('/admin/certificate');
}));

admin.get('/:id/file', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).end();
  const { rows: [doc] } = await query('SELECT * FROM platform_certificates WHERE id=$1', [id]);
  if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'Certificate not found.' });
  sendFile(res, doc);
}));

// Client: only the current, explicitly published certificate is exposed.
client.get('/certificate', h.requireLogin, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin/certificate');
  const { rows: [certificate] } = await query(
    `SELECT id,title,registration_body,registration_number,issued_on,description,mime,size_bytes,uploaded_at
     FROM platform_certificates WHERE is_current=TRUE AND client_visible=TRUE ORDER BY uploaded_at DESC LIMIT 1`
  );
  res.render('client/certificate', { title: 'Company registration', certificate });
}));

client.get('/certificate/file', h.requireLogin, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin/certificate');
  const { rows: [doc] } = await query(
    'SELECT * FROM platform_certificates WHERE is_current=TRUE AND client_visible=TRUE ORDER BY uploaded_at DESC LIMIT 1'
  );
  if (!doc) return res.status(404).render('error', { title: 'Not available', message: 'The platform registration certificate has not been published.' });
  sendFile(res, doc, req.query.download === '1');
}));

module.exports = { admin, client };
