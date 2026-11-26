const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { query } = require('../db');
const h = require('../helpers');
const cx = require('../crypto');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } });
const statuses = ['approved', 'processing', 'halted', 'suspended', 'rejected', 'completed', 'cancelled'];
function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii',0,4) === 'RIFF' && buf.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return null;
}
router.use(h.requireAdmin);

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(`SELECT t.*, u.full_name, u.email, u.account_no, u.base_currency,
    (SELECT COUNT(*)::int FROM withdrawal_documents d WHERE d.transaction_id=t.id) AS document_count,
    (SELECT e.reason FROM withdrawal_events e WHERE e.transaction_id=t.id ORDER BY e.created_at DESC LIMIT 1) AS latest_reason
    FROM transactions t JOIN users u ON u.id=t.user_id WHERE t.type='withdrawal'
    ORDER BY CASE WHEN t.status IN ('pending','approved','processing','halted','suspended') THEN 0 ELSE 1 END, t.created_at DESC LIMIT 500`);
  res.render('admin/withdrawals', { title: 'Withdrawal management', withdrawals: rows, statuses });
}));

router.post('/:id/action', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [t] } = await query("SELECT * FROM transactions WHERE id=$1 AND type='withdrawal'", [id]);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'Withdrawal not found.' });
  const status = h.oneOf(req.body.status, statuses, null);
  const reason = h.str(req.body.reason, 2000);
  const hash = h.optStr(req.body.tx_hash, 120);
  if (!status || reason.length < 8) { h.flash(req, 'error', 'Choose an action and provide a clear reason (at least 8 characters).'); return res.redirect('/admin/withdrawals'); }
  if (status === 'completed' && t.network && !hash && !t.tx_hash) { h.flash(req, 'error', 'Enter the verified payout transaction hash before marking this withdrawal completed.'); return res.redirect('/admin/withdrawals'); }
  if (hash && t.network && !cx.validHash(t.network, hash)) { h.flash(req, 'error', `Enter a valid ${cx.networkName(t.network)} payout transaction hash.`); return res.redirect('/admin/withdrawals'); }
  if (hash) {
    const { rows: dupe } = await query('SELECT id FROM transactions WHERE lower(tx_hash)=lower($1) AND id<>$2', [hash, id]);
    if (dupe.length) { h.flash(req, 'error', 'That transaction hash is already recorded.'); return res.redirect('/admin/withdrawals'); }
  }
  await query('UPDATE transactions SET status=$1, tx_hash=COALESCE($2,tx_hash), updated_at=NOW() WHERE id=$3', [status, hash, id]);
  await query(`INSERT INTO withdrawal_events (transaction_id,user_id,actor_id,actor_role,from_status,to_status,reason)
    VALUES ($1,$2,$3,'admin',$4,$5,$6)`, [id, t.user_id, req.user.id, t.status, status, reason]);
  await h.audit(req, 'withdrawal_admin_action', t.user_id, { transaction_id: id, from: t.status, to: status, reason, tx_hash: hash || undefined });
  h.flash(req, 'success', `Withdrawal #${id} updated to ${h.titleCase(status)}.`);
  res.redirect('/admin/withdrawals');
}));

router.post('/:id/documents', (req, res, next) => upload.single('document')(req, res, (err) => {
  if (err) { h.flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Document must be 10 MB or smaller.' : 'Document upload failed.'); return res.redirect('/admin/withdrawals'); }
  next();
}), h.checkCsrf, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [t] } = await query("SELECT * FROM transactions WHERE id=$1 AND type='withdrawal'", [id]);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'Withdrawal not found.' });
  const f = req.file;
  const mime = f && sniff(f.buffer);
  const title = h.str(req.body.title, 160);
  if (!f || !mime || !title) { h.flash(req, 'error', 'Attach a valid PDF, PNG, JPG or WEBP file and enter a document title.'); return res.redirect('/admin/withdrawals'); }
  const visible = req.body.client_visible === 'on';
  const description = h.optStr(req.body.description, 500);
  const sha = crypto.createHash('sha256').update(f.buffer).digest('hex');
  await query(`INSERT INTO withdrawal_documents (transaction_id,user_id,uploaded_by,title,description,mime,size_bytes,sha256,original_name,data,client_visible)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,t.user_id,req.user.id,title,description,mime,f.size,sha,h.str(f.originalname,200),f.buffer,visible]);
  await h.audit(req, 'withdrawal_document_uploaded', t.user_id, { transaction_id:id, title, mime, size_bytes:f.size, client_visible:visible });
  h.flash(req, 'success', visible ? 'Document uploaded and shared with the client.' : 'Document uploaded privately for administrators.');
  res.redirect('/admin/withdrawals');
}));

module.exports = router;
