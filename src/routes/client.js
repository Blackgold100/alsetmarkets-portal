const express = require('express');
const { query } = require('../db');
const h = require('../helpers');
const { dashboardData } = require('../metrics');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', h.requireLogin, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin');
  const data = await dashboardData(req.user, h.str(req.query.range, 4));
  res.render('client/dashboard', { title: 'Overview', client: req.user, preview: false, ...data });
}));

router.get('/transactions', h.requireLogin, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin');
  const type = h.oneOf(req.query.type, ['deposit', 'withdrawal', 'profit', 'loss', 'fee'], null);
  const params = [req.user.id];
  let sql = 'SELECT t.*, EXISTS (SELECT 1 FROM deposit_proofs p WHERE p.transaction_id=t.id) AS has_proof FROM transactions t WHERE t.user_id=$1';
  if (type) { params.push(type); sql += ' AND t.type=$2'; }
  sql += ' ORDER BY t.tx_date DESC, t.id DESC LIMIT 500';
  const { rows } = await query(sql, params);
  res.render('client/transactions', { title: 'Transactions', transactions: rows, type });
}));

router.get('/account', h.requireLogin, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin');
  res.render('client/account', { title: 'Account', client: req.user });
}));

// Deposit proof screenshot: visible to the client who uploaded it and to admins only.
router.get('/proofs/:txId', h.requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.txId);
  if (!Number.isInteger(id)) return res.status(404).end();
  const { rows: [p] } = await query('SELECT * FROM deposit_proofs WHERE transaction_id=$1', [id]);
  if (!p || (req.user.role !== 'admin' && p.user_id !== req.user.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'That screenshot does not exist.' });
  }
  res.set({
    'Content-Type': p.mime, 'Content-Length': p.size_bytes, 'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'",
    'Content-Disposition': `inline; filename="deposit-${id}.${p.mime.split('/')[1]}"`,
  });
  res.send(p.data);
}));

module.exports = router;
