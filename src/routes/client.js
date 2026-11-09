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
  let sql = 'SELECT * FROM transactions WHERE user_id=$1';
  if (type) { params.push(type); sql += ' AND type=$2'; }
  sql += ' ORDER BY tx_date DESC, id DESC LIMIT 500';
  const { rows } = await query(sql, params);
  res.render('client/transactions', { title: 'Transactions', transactions: rows, type });
}));

router.get('/account', h.requireLogin, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/admin');
  res.render('client/account', { title: 'Account', client: req.user });
}));

module.exports = router;
