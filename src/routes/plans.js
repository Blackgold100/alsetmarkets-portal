const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const h = require('../helpers');
const P = require('../plans');
const { summarize } = require('../metrics');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const RISKS = ['Low', 'Medium', 'High', 'Very high'];

// ===================== Client =====================
const client = express.Router();
client.use(h.requireLogin);
client.use((req, res, next) => (req.user.role === 'client' ? next() : res.redirect('/admin/plans')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => { h.flash(req, 'error', 'Too many requests. Please wait a few minutes.'); res.redirect('/plans'); },
});

client.get('/', wrap(async (req, res) => {
  const [plans, positions, { rows: txs }] = await Promise.all([
    P.listPlans({ activeOnly: true }), P.userPositions(req.user.id),
    query('SELECT * FROM transactions WHERE user_id=$1', [req.user.id]),
  ]);
  const inPlans = positions.filter((p) => p.status === 'active').reduce((a, p) => a + p.value, 0);
  res.render('client/plans', { title: 'Investment plans', plans, positions, summary: summarize(txs, inPlans) });
}));

client.post('/:id/invest', limiter, wrap(async (req, res) => {
  const u = req.user;
  const plan = await P.getPlan(req.params.id);
  if (!plan || !plan.active) { h.flash(req, 'error', 'That plan is not available.'); return res.redirect('/plans'); }
  const back = `/plans#plan-${plan.slug}`;
  if (u.status !== 'active') { h.flash(req, 'error', 'Investing is available on active accounts only.'); return res.redirect(back); }
  const amount = h.amount(req.body.amount);
  if (!amount || amount < plan.min_amount) { h.flash(req, 'error', `The minimum for the ${plan.name} plan is ${h.money(plan.min_amount, u.base_currency)}.`); return res.redirect(back); }
  if (req.body.accept !== 'on') { h.flash(req, 'error', 'Please confirm you understand the risks and the lock-in period.'); return res.redirect(back); }
  if (!(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) { h.flash(req, 'error', 'Your password was incorrect. Nothing was invested.'); return res.redirect(back); }
  const r = await P.invest({ user: u, plan, amount, summarize });
  if (r.error) { h.flash(req, 'error', `You can invest up to ${h.money(r.available, u.base_currency)} from your available balance.`); return res.redirect(back); }
  await h.audit(req, 'plan_invested', u.id, { plan: plan.slug, amount, position: r.position.id, unlocks_on: r.position.unlocks_on });
  h.flash(req, 'success', `${h.money(amount, u.base_currency)} is now in the ${plan.name} plan. It is locked until ${h.date(r.position.unlocks_on)}.`);
  res.redirect('/plans#my-investments');
}));

client.post('/positions/:pid/redeem', limiter, wrap(async (req, res) => {
  const r = await P.redeem({ positionId: req.params.pid, userId: req.user.id, actorId: req.user.id });
  if (r.error) { h.flash(req, 'error', r.error); return res.redirect('/plans#my-investments'); }
  const { rows: [pos] } = await query('SELECT * FROM plan_positions WHERE id=$1', [r.position.id]);
  await h.audit(req, 'plan_redeemed', req.user.id, { position: pos.id, value: pos.value });
  h.flash(req, 'success', `${h.money(pos.value, req.user.base_currency)} has been moved back to your available balance.`);
  res.redirect('/plans#my-investments');
}));

// ===================== Admin =====================
const admin = express.Router();
admin.use(['/plans', '/plan-results', '/positions'], h.requireAdmin);

admin.get('/plans', wrap(async (req, res) => {
  res.render('admin/plans', { title: 'Investment plans', plans: await P.listPlans(), RISKS, adminArea: true });
}));

async function planPage(req, res, plan, extra = {}) {
  const [{ rows: results }, { rows: positions }, all] = await Promise.all([
    query('SELECT r.*, u.full_name AS posted_name FROM plan_results r LEFT JOIN users u ON u.id=r.posted_by WHERE plan_id=$1 ORDER BY period_start DESC LIMIT 104', [plan.id]),
    query(`SELECT x.*, u.full_name, u.account_no FROM plan_positions x JOIN users u ON u.id=x.user_id
           WHERE x.plan_id=$1 ORDER BY (x.status='active') DESC, x.value DESC LIMIT 500`, [plan.id]),
    P.listPlans(),
  ]);
  const stats = all.find((p) => p.id === plan.id);
  const lastEnd = results.length ? results[0].period_end : null;
  res.render('admin/plan', {
    title: `${plan.name} plan`, plan, stats, results, positions, RISKS, adminArea: true,
    suggest: P.nextPeriod(lastEnd), preview: null, form: {}, maxPct: P.MAX_WEEKLY_PCT, today: P.today(), ...extra,
  });
}

admin.get('/plans/:id', wrap(async (req, res) => {
  const plan = await P.getPlan(req.params.id);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'That plan does not exist.' });
  await planPage(req, res, plan);
}));

admin.post('/plans/:id/settings', wrap(async (req, res) => {
  const plan = await P.getPlan(req.params.id);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'That plan does not exist.' });
  const b = req.body;
  const v = {
    name: h.str(b.name, 60) || plan.name, summary: h.optStr(b.summary, 200), description: h.optStr(b.description, 2000),
    risk_level: h.oneOf(b.risk_level, RISKS, plan.risk_level), min_amount: h.nonNeg(b.min_amount) ?? plan.min_amount,
    lock_days: Math.max(0, Math.min(3650, parseInt(b.lock_days, 10) || 0)), active: b.active === 'on',
  };
  await query('UPDATE plans SET name=$1, summary=$2, description=$3, risk_level=$4, min_amount=$5, lock_days=$6, active=$7 WHERE id=$8',
    [v.name, v.summary, v.description, v.risk_level, v.min_amount, v.lock_days, v.active, plan.id]);
  await h.audit(req, 'plan_updated', null, { plan: plan.slug, ...v });
  h.flash(req, 'success', `${v.name} plan settings saved. A new lock-in period applies to new investments only.`);
  res.redirect(`/admin/plans/${plan.id}#settings`);
}));

function readResult(b) {
  const pct = Number(String(b.return_pct ?? '').replace(/[%\s,]/g, ''));
  return { start: h.isoDate(b.period_start), end: h.isoDate(b.period_end), pct: String(b.return_pct ?? '').trim() === '' ? NaN : pct, note: h.optStr(b.note, 300) };
}

admin.post('/plans/:id/preview', wrap(async (req, res) => {
  const plan = await P.getPlan(req.params.id);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'That plan does not exist.' });
  const f = readResult(req.body);
  const pv = await P.previewResult(plan, f.start, f.end, f.pct);
  await planPage(req, res, plan, { form: { period_start: f.start, period_end: f.end, return_pct: req.body.return_pct, note: f.note }, preview: pv.error ? null : { ...pv, ...f }, previewError: pv.error || null });
}));

admin.post('/plans/:id/results', wrap(async (req, res) => {
  const plan = await P.getPlan(req.params.id);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'That plan does not exist.' });
  const f = readResult(req.body);
  if (req.body.confirm !== 'yes') { h.flash(req, 'error', 'Preview the result and confirm before posting.'); return res.redirect(`/admin/plans/${plan.id}#post`); }
  const r = await P.postResult({ plan, start: f.start, end: f.end, pct: f.pct, note: f.note, actorId: req.user.id });
  if (r.error) { h.flash(req, 'error', r.error); return res.redirect(`/admin/plans/${plan.id}#post`); }
  await h.audit(req, 'plan_result_posted', null, { plan: plan.slug, result: r.result.id, period: [f.start, f.end], return_pct: f.pct, positions: r.count, total: r.total });
  h.flash(req, 'success', `${plan.name} result posted: ${f.pct >= 0 ? '+' : ''}${f.pct.toFixed(2)}% distributed to ${r.count} investment${r.count === 1 ? '' : 's'} (${h.signedMoney(r.total)} in total).`);
  res.redirect(`/admin/plans/${plan.id}#history`);
}));

admin.post('/plan-results/:rid/undo', wrap(async (req, res) => {
  const r = await P.reverseResult({ resultId: req.params.rid });
  if (r.error) { h.flash(req, 'error', r.error); return res.redirect('/admin/plans'); }
  await h.audit(req, 'plan_result_undone', null, { result: r.result.id, plan_id: r.result.plan_id, period: [r.result.period_start, r.result.period_end], return_pct: r.result.return_pct, reversed: r.reversed });
  h.flash(req, 'success', `Result for ${h.date(r.result.period_start)} to ${h.date(r.result.period_end)} undone. ${r.reversed} investor entr${r.reversed === 1 ? 'y was' : 'ies were'} reversed.`);
  res.redirect(`/admin/plans/${r.result.plan_id}#history`);
}));

admin.post('/positions/:pid/release', wrap(async (req, res) => {
  const r = await P.redeem({ positionId: req.params.pid, actorId: req.user.id, force: true });
  if (r.error) { h.flash(req, 'error', r.error); return res.redirect('/admin/plans'); }
  await h.audit(req, 'plan_position_released', r.position.user_id, { position: r.position.id, value: r.position.value, early: true });
  h.flash(req, 'success', 'Investment released back to the client’s available balance.');
  res.redirect(req.body.back === 'client' ? `/admin/clients/${r.position.user_id}#plans` : `/admin/plans/${r.position.plan_id}#investors`);
}));

module.exports = { client, admin };
