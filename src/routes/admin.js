const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const h = require('../helpers');
const { dashboardData } = require('../metrics');
const cx = require('../crypto');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const STATUSES = ['pending', 'active', 'suspended', 'closed'];
const KYC = ['not_submitted', 'pending', 'verified', 'rejected'];
const TX_TYPES = ['deposit', 'withdrawal', 'profit', 'loss', 'fee'];
const TX_STATUS = ['pending', 'completed', 'rejected'];
const TIERS = (process.env.ACCOUNT_TIERS || 'Starter,Standard,Professional,VIP').split(',').map((s) => s.trim()).filter(Boolean);
const CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN'];

router.use(h.requireAdmin);
router.use((req, res, next) => {
  Object.assign(res.locals, { STATUSES, KYC, TX_TYPES, TX_STATUS, TIERS, CURRENCIES, adminArea: true });
  next();
});

const BAL_SQL = `
  COALESCE(SUM(CASE WHEN t.status='completed' THEN CASE t.type WHEN 'deposit' THEN t.amount WHEN 'withdrawal' THEN -t.amount ELSE 0 END END),0) AS invested,
  COALESCE(SUM(CASE WHEN t.status='completed' THEN CASE t.type WHEN 'deposit' THEN t.amount WHEN 'profit' THEN t.amount ELSE -t.amount END END),0) AS balance,
  COUNT(t.id) FILTER (WHERE t.status='pending') AS pending_count`;

async function getClient(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const { rows } = await query("SELECT * FROM users WHERE id=$1 AND role='client'", [n]);
  return rows[0] || null;
}
async function newAccountNo() {
  for (let i = 0; i < 10; i++) {
    const no = 'AM' + String(crypto.randomInt(100000, 999999));
    const { rows } = await query('SELECT 1 FROM users WHERE account_no=$1', [no]);
    if (!rows.length) return no;
  }
  return 'AM' + Date.now();
}
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That record does not exist.' });

// ---------------- Clients list ----------------
router.get('/', wrap(async (req, res) => {
  const q = h.str(req.query.q, 100);
  const status = h.oneOf(req.query.status, STATUSES, null);
  const params = [];
  const where = ["u.role='client'"];
  if (q) { params.push(`%${q}%`); where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.account_no ILIKE $${params.length})`); }
  if (status) { params.push(status); where.push(`u.status=$${params.length}`); }
  const { rows: clients } = await query(
    `SELECT u.*, ${BAL_SQL} FROM users u LEFT JOIN transactions t ON t.user_id=u.id
     WHERE ${where.join(' AND ')} GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`, params);
  const { rows: [stats] } = await query(
    `SELECT COUNT(DISTINCT u.id)::int AS clients,
            COUNT(DISTINCT u.id) FILTER (WHERE u.status='active')::int AS active,
            ${BAL_SQL}
     FROM users u LEFT JOIN transactions t ON t.user_id=u.id WHERE u.role='client'`);
  const { rows: pending } = await query(
    `SELECT t.*, u.full_name, u.account_no, u.base_currency FROM transactions t JOIN users u ON u.id=t.user_id
     WHERE t.status='pending' ORDER BY t.tx_date, t.id LIMIT 20`);
  const { rows: pendingWallets } = await query(
    `SELECT w.*, u.full_name, u.account_no FROM client_wallets w JOIN users u ON u.id=w.user_id
     WHERE w.status='pending' ORDER BY w.created_at LIMIT 20`);
  res.render('admin/clients', { title: 'Clients', clients, stats, pending, pendingWallets, q, status });
}));

// ---------------- Create user ----------------
router.get('/clients/new', (req, res) => {
  res.render('admin/client-new', { title: 'New client', error: null, form: {}, created: null });
});

router.post('/clients', wrap(async (req, res) => {
  const b = req.body;
  const role = h.oneOf(b.role, ['client', 'admin'], 'client');
  const form = {
    full_name: h.str(b.full_name, 120), email: h.str(b.email, 200).toLowerCase(), phone: h.optStr(b.phone, 40),
    country: h.optStr(b.country, 80), tier: h.oneOf(b.tier, TIERS, TIERS[0]), base_currency: h.oneOf(b.base_currency, CURRENCIES, 'USD'),
    plan_name: h.optStr(b.plan_name, 120), account_manager: h.optStr(b.account_manager, 120),
    account_no: h.optStr(b.account_no, 30), opened_on: h.isoDate(b.opened_on), role,
  };
  const fail = (error) => res.status(400).render('admin/client-new', { title: 'New client', error, form, created: null });
  if (!form.full_name) return fail('Full name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return fail('Enter a valid email address.');
  const { rows: dupe } = await query('SELECT 1 FROM users WHERE email=$1', [form.email]);
  if (dupe.length) return fail('A user with that email already exists.');
  if (form.account_no) {
    const { rows: d2 } = await query('SELECT 1 FROM users WHERE account_no=$1', [form.account_no]);
    if (d2.length) return fail('That account number is already in use.');
  }
  const temp = h.tempPassword();
  const hash = await bcrypt.hash(temp, 12);
  const accountNo = role === 'client' ? (form.account_no || (await newAccountNo())) : null;
  const { rows: [u] } = await query(
    `INSERT INTO users (role, email, password_hash, full_name, phone, country, account_no, tier, base_currency,
       plan_name, account_manager, opened_on, status, kyc_status, must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::date, CURRENT_DATE),$13,$14,TRUE) RETURNING *`,
    [role, form.email, hash, form.full_name, form.phone, form.country, accountNo, form.tier, form.base_currency,
     form.plan_name, form.account_manager, form.opened_on, 'active', role === 'admin' ? 'verified' : 'pending']);
  await h.audit(req, role === 'admin' ? 'admin_created' : 'client_created', u.id, { email: u.email });
  res.render('admin/client-new', { title: 'New client', error: null, form: {}, created: { user: u, password: temp } });
}));

// ---------------- Client detail ----------------
router.get('/clients/:id', wrap(async (req, res) => {
  const client = await getClient(req.params.id);
  if (!client) return notFound(res);
  const data = await dashboardData(client, 'ALL');
  const { rows: clientNotices } = await query('SELECT * FROM notices WHERE user_id=$1 ORDER BY created_at DESC', [client.id]);
  const { rows: log } = await query('SELECT * FROM audit_log WHERE target_user_id=$1 ORDER BY created_at DESC LIMIT 25', [client.id]);
  const { rows: clientWallets } = await query('SELECT * FROM client_wallets WHERE user_id=$1 ORDER BY created_at DESC', [client.id]);
  const { rows: depositWallets } = await query('SELECT * FROM firm_wallets WHERE user_id=$1 ORDER BY created_at DESC', [client.id]);
  res.render('admin/client', { title: client.full_name, client, ...data, clientNotices, log, clientWallets, depositWallets, tempPassword: req.session.tempPassword || null, today: new Date().toISOString().slice(0, 10) });
  delete req.session.tempPassword;
}));

router.get('/clients/:id/preview', wrap(async (req, res) => {
  const client = await getClient(req.params.id);
  if (!client) return notFound(res);
  const data = await dashboardData(client, h.str(req.query.range, 4));
  res.render('client/dashboard', { title: `Preview · ${client.full_name}`, client, preview: true, ...data });
}));

router.post('/clients/:id/profile', wrap(async (req, res) => {
  const c = await getClient(req.params.id);
  if (!c) return notFound(res);
  const b = req.body;
  const email = h.str(b.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { h.flash(req, 'error', 'Enter a valid email address.'); return res.redirect(`/admin/clients/${c.id}`); }
  const { rows: dupe } = await query('SELECT 1 FROM users WHERE email=$1 AND id<>$2', [email, c.id]);
  if (dupe.length) { h.flash(req, 'error', 'Another user already has that email.'); return res.redirect(`/admin/clients/${c.id}`); }
  const accountNo = h.optStr(b.account_no, 30) || c.account_no;
  const { rows: d2 } = await query('SELECT 1 FROM users WHERE account_no=$1 AND id<>$2', [accountNo, c.id]);
  if (d2.length) { h.flash(req, 'error', 'That account number is already in use.'); return res.redirect(`/admin/clients/${c.id}`); }
  const kyc = h.oneOf(b.kyc_status, KYC, c.kyc_status);
  const v = {
    full_name: h.str(b.full_name, 120) || c.full_name, email, phone: h.optStr(b.phone, 40), country: h.optStr(b.country, 80),
    account_no: accountNo, status: h.oneOf(b.status, STATUSES, c.status), tier: h.oneOf(b.tier, TIERS, c.tier), kyc_status: kyc,
    kyc_verified_on: kyc === 'verified' ? (h.isoDate(b.kyc_verified_on) || c.kyc_verified_on || new Date().toISOString().slice(0, 10)) : null,
    risk_profile: h.optStr(b.risk_profile, 80), plan_name: h.optStr(b.plan_name, 120), account_manager: h.optStr(b.account_manager, 120),
    base_currency: h.oneOf(b.base_currency, CURRENCIES, c.base_currency), opened_on: h.isoDate(b.opened_on) || c.opened_on,
  };
  await query(
    `UPDATE users SET full_name=$1,email=$2,phone=$3,country=$4,account_no=$5,status=$6,tier=$7,kyc_status=$8,kyc_verified_on=$9,
       risk_profile=$10,plan_name=$11,account_manager=$12,base_currency=$13,opened_on=$14,updated_at=NOW() WHERE id=$15`,
    [v.full_name, v.email, v.phone, v.country, v.account_no, v.status, v.tier, v.kyc_status, v.kyc_verified_on,
     v.risk_profile, v.plan_name, v.account_manager, v.base_currency, v.opened_on, c.id]);
  const changed = {};
  for (const k of Object.keys(v)) if (String(v[k] ?? '') !== String(c[k] ?? '')) changed[k] = { from: c[k], to: v[k] };
  await h.audit(req, 'client_updated', c.id, changed);
  if (v.status === 'closed' || v.status === 'suspended') {
    if (v.status === 'closed') await query("DELETE FROM session WHERE (sess->>'userId')::int = $1", [c.id]).catch(() => {});
  }
  h.flash(req, 'success', 'Client details saved.');
  res.redirect(`/admin/clients/${c.id}`);
}));

router.post('/clients/:id/upgrade', wrap(async (req, res) => {
  const c = await getClient(req.params.id);
  if (!c) return notFound(res);
  const b = req.body;
  const url = h.safeUrl(b.upgrade_cta_url);
  if (b.upgrade_cta_url && !url) { h.flash(req, 'error', 'The button link must start with https://'); return res.redirect(`/admin/clients/${c.id}#upgrade`); }
  const v = [b.upgrade_active === 'on', h.optStr(b.upgrade_target_tier, 60), h.optStr(b.upgrade_title, 160),
    h.optStr(b.upgrade_message, 2000), h.optStr(b.upgrade_cta_label, 40), url, c.id];
  await query(`UPDATE users SET upgrade_active=$1, upgrade_target_tier=$2, upgrade_title=$3, upgrade_message=$4,
    upgrade_cta_label=$5, upgrade_cta_url=$6, updated_at=NOW() WHERE id=$7`, v);
  await h.audit(req, 'upgrade_notice_updated', c.id, { active: v[0], target: v[1], title: v[2] });
  h.flash(req, 'success', v[0] ? 'Upgrade notice is now showing on the client dashboard.' : 'Upgrade notice saved (hidden).');
  res.redirect(`/admin/clients/${c.id}#upgrade`);
}));

router.post('/clients/:id/reset-password', wrap(async (req, res) => {
  const c = await getClient(req.params.id);
  if (!c) return notFound(res);
  const temp = h.tempPassword();
  await query('UPDATE users SET password_hash=$1, must_change_password=TRUE, failed_logins=0, locked_until=NULL WHERE id=$2', [await bcrypt.hash(temp, 12), c.id]);
  await query("DELETE FROM session WHERE (sess->>'userId')::int = $1", [c.id]).catch(() => {});
  await h.audit(req, 'password_reset', c.id);
  req.session.tempPassword = temp;
  res.redirect(`/admin/clients/${c.id}#security`);
}));

// ---------------- Transactions ----------------
function readTx(b) {
  const network = h.oneOf(b.network, Object.keys(cx.NETWORKS), null);
  return {
    type: h.oneOf(b.type, TX_TYPES, null), amount: h.amount(b.amount), status: h.oneOf(b.status, TX_STATUS, 'completed'),
    tx_date: h.isoDate(b.tx_date), reference: h.optStr(b.reference, 80), description: h.optStr(b.description, 300),
    asset: network ? h.oneOf(b.asset, cx.ASSETS, null) : null, network,
    wallet_address: network ? h.optStr(b.wallet_address, 120) : null, tx_hash: h.optStr(b.tx_hash, 120),
  };
}
function txWalletError(t) {
  if (t.wallet_address && !cx.validAddress(t.network, t.wallet_address)) return `The wallet address is not a valid ${cx.networkName(t.network)} address.`;
  if (t.tx_hash && t.network && !cx.validHash(t.network, t.tx_hash)) return `The transaction hash is not valid for ${cx.networkName(t.network)}.`;
  return null;
}
async function hashTaken(hash, exceptId) {
  if (!hash) return false;
  const { rows } = await query('SELECT 1 FROM transactions WHERE lower(tx_hash)=lower($1) AND id<>$2', [hash, exceptId || 0]);
  return rows.length > 0;
}

router.post('/clients/:id/transactions', wrap(async (req, res) => {
  const c = await getClient(req.params.id);
  if (!c) return notFound(res);
  const t = readTx(req.body);
  if (!t.type || !t.amount || !t.tx_date) { h.flash(req, 'error', 'Choose a type and enter a valid amount and date.'); return res.redirect(`/admin/clients/${c.id}#transactions`); }
  const we = txWalletError(t);
  if (we) { h.flash(req, 'error', we); return res.redirect(`/admin/clients/${c.id}#transactions`); }
  if (await hashTaken(t.tx_hash)) { h.flash(req, 'error', 'That transaction hash is already recorded on another transaction.'); return res.redirect(`/admin/clients/${c.id}#transactions`); }
  const { rows: [row] } = await query(
    `INSERT INTO transactions (user_id,type,amount,status,tx_date,reference,description,created_by,asset,network,wallet_address,tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [c.id, t.type, t.amount, t.status, t.tx_date, t.reference, t.description, req.user.id, t.asset, t.network, t.wallet_address, t.tx_hash]);
  await h.audit(req, 'transaction_added', c.id, { id: row.id, ...t });
  h.flash(req, 'success', `${h.titleCase(t.type)} of ${h.money(t.amount, c.base_currency)} recorded.`);
  res.redirect(`/admin/clients/${c.id}#transactions`);
}));

async function getTx(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const { rows } = await query('SELECT t.*, u.full_name, u.base_currency FROM transactions t JOIN users u ON u.id=t.user_id WHERE t.id=$1', [n]);
  return rows[0] || null;
}

router.get('/transactions/:tid/edit', wrap(async (req, res) => {
  const t = await getTx(req.params.tid);
  if (!t) return notFound(res);
  res.render('admin/transaction-edit', { title: 'Edit transaction', t });
}));

router.post('/transactions/:tid', wrap(async (req, res) => {
  const old = await getTx(req.params.tid);
  if (!old) return notFound(res);
  const t = readTx(req.body);
  if (!t.type || !t.amount || !t.tx_date) { h.flash(req, 'error', 'Choose a type and enter a valid amount and date.'); return res.redirect(`/admin/transactions/${old.id}/edit`); }
  const we = txWalletError(t);
  if (we) { h.flash(req, 'error', we); return res.redirect(`/admin/transactions/${old.id}/edit`); }
  if (await hashTaken(t.tx_hash, old.id)) { h.flash(req, 'error', 'That transaction hash is already recorded on another transaction.'); return res.redirect(`/admin/transactions/${old.id}/edit`); }
  await query(`UPDATE transactions SET type=$1,amount=$2,status=$3,tx_date=$4,reference=$5,description=$6,
      asset=$7,network=$8,wallet_address=$9,tx_hash=$10,updated_at=NOW() WHERE id=$11`,
    [t.type, t.amount, t.status, t.tx_date, t.reference, t.description, t.asset, t.network, t.wallet_address, t.tx_hash, old.id]);
  await h.audit(req, 'transaction_updated', old.user_id, { id: old.id, from: { type: old.type, amount: old.amount, status: old.status, tx_date: old.tx_date, tx_hash: old.tx_hash, wallet_address: old.wallet_address }, to: t });
  h.flash(req, 'success', 'Transaction updated.');
  res.redirect(`/admin/clients/${old.user_id}#transactions`);
}));

router.post('/transactions/:tid/status', wrap(async (req, res) => {
  const old = await getTx(req.params.tid);
  if (!old) return notFound(res);
  const status = h.oneOf(req.body.status, TX_STATUS, null);
  const back = req.body.back === 'dashboard' ? '/admin' : `/admin/clients/${old.user_id}#transactions`;
  const hash = h.optStr(req.body.tx_hash, 120);
  if (hash) {
    if (old.network && !cx.validHash(old.network, hash)) { h.flash(req, 'error', `That is not a valid ${cx.networkName(old.network)} transaction hash.`); return res.redirect(back); }
    if (await hashTaken(hash, old.id)) { h.flash(req, 'error', 'That transaction hash is already recorded on another transaction.'); return res.redirect(back); }
  }
  if (status) {
    await query('UPDATE transactions SET status=$1, tx_hash=COALESCE($2, tx_hash), updated_at=NOW() WHERE id=$3', [status, hash, old.id]);
    await h.audit(req, 'transaction_status', old.user_id, { id: old.id, from: old.status, to: status, tx_hash: hash || undefined });
    h.flash(req, 'success', `Transaction marked ${status === 'completed' && old.type === 'withdrawal' ? 'paid' : status}.`);
  }
  res.redirect(back);
}));

router.post('/transactions/:tid/delete', wrap(async (req, res) => {
  const old = await getTx(req.params.tid);
  if (!old) return notFound(res);
  await query('DELETE FROM transactions WHERE id=$1', [old.id]);
  await h.audit(req, 'transaction_deleted', old.user_id, { id: old.id, type: old.type, amount: old.amount, tx_date: old.tx_date, status: old.status });
  h.flash(req, 'success', 'Transaction deleted.');
  res.redirect(`/admin/clients/${old.user_id}#transactions`);
}));

// ---------------- Holdings ----------------
router.post('/clients/:id/holdings', wrap(async (req, res) => {
  const c = await getClient(req.params.id);
  if (!c) return notFound(res);
  const b = req.body;
  const name = h.str(b.name, 120), cls = h.str(b.asset_class, 60);
  const amountIn = h.nonNeg(b.amount_in), value = h.nonNeg(b.current_value);
  if (!name || !cls || amountIn === null || value === null) { h.flash(req, 'error', 'Enter a name, asset class and valid amounts.'); return res.redirect(`/admin/clients/${c.id}#holdings`); }
  await query('INSERT INTO holdings (user_id,name,asset_class,amount_in,current_value,notes) VALUES ($1,$2,$3,$4,$5,$6)',
    [c.id, name, cls, amountIn, value, h.optStr(b.notes, 200)]);
  await h.audit(req, 'holding_added', c.id, { name, asset_class: cls, amount_in: amountIn, current_value: value });
  h.flash(req, 'success', 'Holding added.');
  res.redirect(`/admin/clients/${c.id}#holdings`);
}));

router.post('/holdings/:hid', wrap(async (req, res) => {
  const { rows: [old] } = await query('SELECT * FROM holdings WHERE id=$1', [Number(req.params.hid) || 0]);
  if (!old) return notFound(res);
  const amountIn = h.nonNeg(req.body.amount_in), value = h.nonNeg(req.body.current_value);
  if (amountIn === null || value === null) { h.flash(req, 'error', 'Enter valid amounts.'); return res.redirect(`/admin/clients/${old.user_id}#holdings`); }
  await query('UPDATE holdings SET amount_in=$1, current_value=$2, updated_at=NOW() WHERE id=$3', [amountIn, value, old.id]);
  await h.audit(req, 'holding_updated', old.user_id, { id: old.id, name: old.name, from: [old.amount_in, old.current_value], to: [amountIn, value] });
  h.flash(req, 'success', `${old.name} updated.`);
  res.redirect(`/admin/clients/${old.user_id}#holdings`);
}));

router.post('/holdings/:hid/delete', wrap(async (req, res) => {
  const { rows: [old] } = await query('SELECT * FROM holdings WHERE id=$1', [Number(req.params.hid) || 0]);
  if (!old) return notFound(res);
  await query('DELETE FROM holdings WHERE id=$1', [old.id]);
  await h.audit(req, 'holding_deleted', old.user_id, { name: old.name });
  h.flash(req, 'success', 'Holding removed.');
  res.redirect(`/admin/clients/${old.user_id}#holdings`);
}));

// ---------------- Documents ----------------
router.post('/clients/:id/documents', wrap(async (req, res) => {
  const c = await getClient(req.params.id);
  if (!c) return notFound(res);
  const title = h.str(req.body.title, 160), url = h.safeUrl(req.body.url), issued = h.isoDate(req.body.issued_on);
  if (!title || !url) { h.flash(req, 'error', 'Enter a title and a link starting with https://'); return res.redirect(`/admin/clients/${c.id}#documents`); }
  await query('INSERT INTO documents (user_id,title,url,issued_on) VALUES ($1,$2,$3,COALESCE($4::date,CURRENT_DATE))', [c.id, title, url, issued]);
  await h.audit(req, 'document_added', c.id, { title });
  h.flash(req, 'success', 'Document added.');
  res.redirect(`/admin/clients/${c.id}#documents`);
}));

router.post('/documents/:did/delete', wrap(async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM documents WHERE id=$1', [Number(req.params.did) || 0]);
  if (!d) return notFound(res);
  await query('DELETE FROM documents WHERE id=$1', [d.id]);
  await h.audit(req, 'document_deleted', d.user_id, { title: d.title });
  h.flash(req, 'success', 'Document removed.');
  res.redirect(`/admin/clients/${d.user_id}#documents`);
}));

// ---------------- Notices ----------------
router.get('/notices', wrap(async (req, res) => {
  const { rows } = await query('SELECT n.*, u.full_name FROM notices n LEFT JOIN users u ON u.id=n.user_id ORDER BY n.created_at DESC LIMIT 200');
  res.render('admin/notices', { title: 'Announcements', notices: rows });
}));

router.post('/notices', wrap(async (req, res) => {
  const title = h.str(req.body.title, 160), body = h.str(req.body.body, 2000);
  const level = h.oneOf(req.body.level, ['info', 'warning', 'success'], 'info');
  let userId = null;
  if (req.body.user_id) {
    const c = await getClient(req.body.user_id);
    if (!c) return notFound(res);
    userId = c.id;
  }
  const back = userId ? `/admin/clients/${userId}#notices` : '/admin/notices';
  if (!title || !body) { h.flash(req, 'error', 'Enter a title and a message.'); return res.redirect(back); }
  await query('INSERT INTO notices (user_id,title,body,level) VALUES ($1,$2,$3,$4)', [userId, title, body, level]);
  await h.audit(req, 'notice_posted', userId, { title, level, audience: userId ? 'client' : 'all' });
  h.flash(req, 'success', 'Notice posted.');
  res.redirect(back);
}));

router.post('/notices/:nid/toggle', wrap(async (req, res) => {
  const { rows: [n] } = await query('UPDATE notices SET active = NOT active WHERE id=$1 RETURNING *', [Number(req.params.nid) || 0]);
  if (!n) return notFound(res);
  await h.audit(req, 'notice_toggled', n.user_id, { id: n.id, active: n.active });
  res.redirect(n.user_id ? `/admin/clients/${n.user_id}#notices` : '/admin/notices');
}));

router.post('/notices/:nid/delete', wrap(async (req, res) => {
  const { rows: [n] } = await query('DELETE FROM notices WHERE id=$1 RETURNING *', [Number(req.params.nid) || 0]);
  if (!n) return notFound(res);
  await h.audit(req, 'notice_deleted', n.user_id, { title: n.title });
  res.redirect(n.user_id ? `/admin/clients/${n.user_id}#notices` : '/admin/notices');
}));

// ---------------- Crypto wallets ----------------
router.get('/wallets', wrap(async (req, res) => {
  const { rows: wallets } = await query(
    `SELECT w.*, u.full_name, u.account_no FROM firm_wallets w LEFT JOIN users u ON u.id=w.user_id
     ORDER BY (w.user_id IS NOT NULL), w.asset, w.network, w.created_at DESC`);
  const { rows: clientWallets } = await query(
    `SELECT w.*, u.full_name, u.account_no FROM client_wallets w JOIN users u ON u.id=w.user_id
     ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, w.created_at DESC LIMIT 300`);
  res.render('admin/wallets', { title: 'Wallets', wallets, clientWallets });
}));

router.post('/wallets', wrap(async (req, res) => {
  const b = req.body;
  let userId = null;
  if (b.user_id) {
    const c = await getClient(b.user_id);
    if (!c) return notFound(res);
    userId = c.id;
  }
  const back = userId ? `/admin/clients/${userId}#wallets` : '/admin/wallets';
  const asset = h.oneOf(b.asset, cx.ASSETS, null);
  const network = h.oneOf(b.network, Object.keys(cx.NETWORKS), null);
  const address = h.str(b.address, 120);
  if (!asset || !network) { h.flash(req, 'error', 'Choose a currency and network.'); return res.redirect(back); }
  if (!cx.validPair(asset, network)) { h.flash(req, 'error', `${asset} is not supported on ${cx.networkName(network)}.`); return res.redirect(back); }
  if (!cx.validAddress(network, address)) { h.flash(req, 'error', `That is not a valid ${cx.networkName(network)} address.`); return res.redirect(back); }
  if (b.confirm_address !== address) { h.flash(req, 'error', 'The two addresses do not match. Paste the address again in both fields.'); return res.redirect(back); }
  const { rows: [w] } = await query(
    'INSERT INTO firm_wallets (user_id,asset,network,address,memo,label) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [userId, asset, network, address, h.optStr(b.memo, 60), h.optStr(b.label, 80)]);
  await h.audit(req, 'deposit_wallet_added', userId, { id: w.id, asset, network, address, scope: userId ? 'client' : 'all' });
  h.flash(req, 'success', `${asset} (${cx.networkName(network)}) deposit address added.`);
  res.redirect(back);
}));

router.post('/wallets/:wid/toggle', wrap(async (req, res) => {
  const { rows: [w] } = await query('UPDATE firm_wallets SET active = NOT active WHERE id=$1 RETURNING *', [Number(req.params.wid) || 0]);
  if (!w) return notFound(res);
  await h.audit(req, 'deposit_wallet_toggled', w.user_id, { id: w.id, active: w.active, address: w.address });
  res.redirect(w.user_id ? `/admin/clients/${w.user_id}#wallets` : '/admin/wallets');
}));

router.post('/wallets/:wid/delete', wrap(async (req, res) => {
  const { rows: [w] } = await query('DELETE FROM firm_wallets WHERE id=$1 RETURNING *', [Number(req.params.wid) || 0]);
  if (!w) return notFound(res);
  await h.audit(req, 'deposit_wallet_deleted', w.user_id, { asset: w.asset, network: w.network, address: w.address });
  h.flash(req, 'success', 'Deposit address removed.');
  res.redirect(w.user_id ? `/admin/clients/${w.user_id}#wallets` : '/admin/wallets');
}));

router.post('/client-wallets/:wid/status', wrap(async (req, res) => {
  const status = h.oneOf(req.body.status, ['approved', 'rejected'], null);
  const { rows: [w] } = await query('SELECT * FROM client_wallets WHERE id=$1', [Number(req.params.wid) || 0]);
  if (!w || !status) return notFound(res);
  await query('UPDATE client_wallets SET status=$1, reviewed_by=$2, reviewed_at=NOW() WHERE id=$3', [status, req.user.id, w.id]);
  await h.audit(req, status === 'approved' ? 'withdrawal_wallet_approved' : 'withdrawal_wallet_rejected', w.user_id, { id: w.id, asset: w.asset, network: w.network, address: w.address });
  h.flash(req, 'success', `Withdrawal wallet ${status}.`);
  const back = req.body.back === 'dashboard' ? '/admin' : req.body.back === 'wallets' ? '/admin/wallets' : `/admin/clients/${w.user_id}#wallets`;
  res.redirect(back);
}));

router.post('/client-wallets/:wid/delete', wrap(async (req, res) => {
  const { rows: [w] } = await query('DELETE FROM client_wallets WHERE id=$1 RETURNING *', [Number(req.params.wid) || 0]);
  if (!w) return notFound(res);
  await h.audit(req, 'withdrawal_wallet_deleted', w.user_id, { asset: w.asset, network: w.network, address: w.address });
  h.flash(req, 'success', 'Withdrawal wallet removed.');
  res.redirect(`/admin/clients/${w.user_id}#wallets`);
}));

// ---------------- Team & audit ----------------
router.get('/team', wrap(async (req, res) => {
  const { rows } = await query("SELECT * FROM users WHERE role='admin' ORDER BY created_at");
  res.render('admin/team', { title: 'Team', admins: rows });
}));

router.get('/audit', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.full_name AS target_name FROM audit_log a LEFT JOIN users u ON u.id=a.target_user_id
     ORDER BY a.created_at DESC LIMIT 300`);
  res.render('admin/audit', { title: 'Audit log', log: rows });
}));

module.exports = router;
