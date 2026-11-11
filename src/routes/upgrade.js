const express = require('express');
const { query } = require('../db');
const h = require('../helpers');
const U = require('../upgrades');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
router.use(h.requireLogin);
router.use((req, res, next) => (req.user.role === 'client' ? next() : res.redirect('/admin/tiers')));

router.get('/', wrap(async (req, res) => {
  const { current, offers } = await U.offersFor(req.user);
  const open = await U.openRequest(req.user.id);
  res.render('client/upgrade', { title: 'Upgrade your account', current, offers, open });
}));

router.post('/:tid/choose', wrap(async (req, res) => {
  const u = req.user;
  if (u.status !== 'active') { h.flash(req, 'error', 'Upgrades are available on active accounts only.'); return res.redirect('/upgrade'); }
  const { offers } = await U.offersFor(u);
  const tier = offers.find((t) => String(t.id) === String(req.params.tid));
  if (!tier) { h.flash(req, 'error', 'That upgrade is not available for your account.'); return res.redirect('/upgrade'); }
  // One open request at a time: choosing again replaces an unpaid one
  await query("UPDATE upgrade_requests SET status='cancelled' WHERE user_id=$1 AND status='awaiting_deposit'", [u.id]);
  const open = await U.openRequest(u.id);
  if (open) { h.flash(req, 'error', 'You already have an upgrade deposit being confirmed. We’ll update your account as soon as it’s approved.'); return res.redirect('/upgrade'); }
  const { rows: [r] } = await query(
    'INSERT INTO upgrade_requests (user_id, tier_id, from_tier, target_tier, amount) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [u.id, tier.id, u.tier, tier.name, tier.upgrade_amount]);
  await h.audit(req, 'upgrade_requested', u.id, { request: r.id, target: tier.name, amount: tier.upgrade_amount });
  res.redirect(`/funds/deposit?upgrade=${r.id}`);
}));

router.post('/cancel', wrap(async (req, res) => {
  const { rows } = await query(
    "UPDATE upgrade_requests SET status='cancelled' WHERE user_id=$1 AND status='awaiting_deposit' RETURNING id", [req.user.id]);
  if (rows.length) await h.audit(req, 'upgrade_request_cancelled', req.user.id, { ids: rows.map((r) => r.id) });
  h.flash(req, 'success', 'Upgrade request cancelled.');
  res.redirect('/upgrade');
}));

module.exports = router;
