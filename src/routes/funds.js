// Client-side crypto deposits and withdrawals.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query, pool } = require('../db');
const h = require('../helpers');
const cx = require('../crypto');
const { summarize } = require('../metrics');
const { inPlansValue } = require('../plans');
const U = require('../upgrades');

const crypto = require('crypto');
const multer = require('multer');

const MAX_PROOF_MB = 6;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PROOF_MB * 1024 * 1024, files: 1, fields: 20 } });
// Identify the image by its first bytes, not by the name or type the browser claims
function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function proofUpload(req, res, next) {
  upload.single('screenshot')(req, res, (err) => {
    if (!err) return next();
    h.flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? `The screenshot must be smaller than ${MAX_PROOF_MB} MB.` : 'The screenshot could not be uploaded. Please try again.');
    res.redirect('/funds/deposit');
  });
}

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const REQUIRE_KYC = (process.env.WITHDRAWAL_REQUIRES_KYC || 'true').toLowerCase() !== 'false';
const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL || 10);
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 10);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => { h.flash(req, 'error', 'Too many requests. Please wait a few minutes and try again.'); res.redirect(req.path === '/deposit' ? '/funds/deposit' : '/funds/withdraw'); },
});

router.use(h.requireLogin);
router.use((req, res, next) => {
  if (req.user.role !== 'client') return res.redirect('/admin');
  next();
});

async function depositWallets(userId) {
  const { rows } = await query(
    `SELECT * FROM firm_wallets WHERE active AND (user_id IS NULL OR user_id=$1)
     ORDER BY (user_id IS NULL), asset, network, id`, [userId]);
  // A client-specific address replaces the shared one for the same asset + network
  const seen = new Set();
  const out = [];
  for (const w of rows) {
    const key = w.asset + '|' + w.network;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  for (const w of out) w.qr = await cx.qrDataUri(w.address);
  return out;
}
async function balances(userId) {
  const { rows } = await query('SELECT * FROM transactions WHERE user_id=$1', [userId]);
  return summarize(rows, await inPlansValue(userId));
}

// ---------- Deposit ----------
router.get('/deposit', wrap(async (req, res) => {
  const wallets = await depositWallets(req.user.id);
  const { rows: recent } = await query(
    "SELECT t.*, EXISTS (SELECT 1 FROM deposit_proofs p WHERE p.transaction_id=t.id) AS has_proof FROM transactions t WHERE t.user_id=$1 AND t.type='deposit' ORDER BY t.created_at DESC LIMIT 10", [req.user.id]);
  // Coming from the upgrade page: show the upgrade and pre-fill its amount
  const open = await U.openRequest(req.user.id);
  const upgrade = open && open.status === 'awaiting_deposit' ? open : null;
  res.render('client/deposit', { title: 'Add funds', wallets, recent, minDeposit: MIN_DEPOSIT, form: {}, upgrade });
}));

router.post('/deposit', limiter, proofUpload, h.checkCsrf, wrap(async (req, res) => {
  const u = req.user;
  const back = '/funds/deposit';
  if (u.status === 'suspended' || u.status === 'closed') { h.flash(req, 'error', 'Deposits are unavailable while your account is ' + u.status + '.'); return res.redirect(back); }
  const wallets = await depositWallets(u.id);
  const w = wallets.find((x) => String(x.id) === String(req.body.wallet_id));
  const amount = h.amount(req.body.amount);
  const hash = h.optStr(req.body.tx_hash, 120);
  const file = req.file;
  const mime = file ? imageType(file.buffer) : null;
  if (!w) { h.flash(req, 'error', 'Choose the wallet you sent funds to.'); return res.redirect(back); }
  if (!amount || amount < MIN_DEPOSIT) { h.flash(req, 'error', `Enter the amount sent (minimum ${h.money(MIN_DEPOSIT, u.base_currency)}).`); return res.redirect(back); }
  if (!file) { h.flash(req, 'error', 'Attach a screenshot of the completed transaction from your wallet or exchange.'); return res.redirect(back); }
  if (!mime) { h.flash(req, 'error', 'The screenshot must be a PNG, JPG or WEBP image.'); return res.redirect(back); }
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const { rows: sameProof } = await query('SELECT 1 FROM deposit_proofs WHERE sha256=$1', [sha]);
  if (sameProof.length) { h.flash(req, 'error', 'This screenshot has already been submitted for another deposit.'); return res.redirect(back); }
  if (hash) {
    if (!cx.validHash(w.network, hash)) { h.flash(req, 'error', `That doesn't look like a valid ${cx.networkName(w.network)} transaction hash. Check it, or leave the field empty.`); return res.redirect(back); }
    const { rows: dupe } = await query('SELECT 1 FROM transactions WHERE lower(tx_hash)=lower($1)', [hash]);
    if (dupe.length) { h.flash(req, 'error', 'This transaction hash has already been submitted.'); return res.redirect(back); }
  }

  // Linked to an upgrade if the client ticked the box on the deposit form
  const open = req.body.upgrade_request_id ? await U.openRequest(u.id) : null;
  const upg = open && open.status === 'awaiting_deposit' && String(open.id) === String(req.body.upgrade_request_id) ? open : null;
  // Transaction, screenshot and upgrade link are saved together or not at all
  const db = await pool.connect();
  let t;
  try {
    await db.query('BEGIN');
    ({ rows: [t] } = await db.query(
    `INSERT INTO transactions (user_id,type,amount,status,tx_date,description,asset,network,wallet_address,wallet_memo,tx_hash,client_requested,upgrade_request_id)
     VALUES ($1,'deposit',$2,'pending',CURRENT_DATE,$3,$4,$5,$6,$7,$8,TRUE,$9) RETURNING id`,
    [u.id, amount, `Crypto deposit · ${w.asset} (${cx.networkName(w.network)})${upg ? ` · upgrade to ${upg.target_tier}` : ''}`, w.asset, w.network, w.address, w.memo, hash, upg ? upg.id : null]));
    await db.query(
    'INSERT INTO deposit_proofs (transaction_id, user_id, mime, size_bytes, sha256, original_name, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [t.id, u.id, mime, file.size, sha, h.optStr(file.originalname, 200), file.buffer]);
    if (upg) await db.query("UPDATE upgrade_requests SET status='deposit_submitted' WHERE id=$1", [upg.id]);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') { h.flash(req, 'error', 'This screenshot has already been submitted for another deposit.'); return res.redirect(back); }
    throw e;
  } finally {
    db.release();
  }
  await h.audit(req, 'deposit_submitted', u.id, { id: t.id, amount, asset: w.asset, network: w.network, tx_hash: hash || undefined, screenshot: sha.slice(0, 12), upgrade_request: upg ? upg.id : undefined });
  h.flash(req, 'success', `Deposit of ${h.money(amount, u.base_currency)} submitted. It will be credited once confirmed on the blockchain and approved by our team${upg ? (amount + 1e-9 >= upg.amount ? `, and your account will then move to ${upg.target_tier}` : `. This is less than the ${h.money(upg.amount, u.base_currency)} needed for ${upg.target_tier}, so our team will contact you`) : ''}.`);
  res.redirect(back);
}));

// ---------- Withdraw ----------
router.get('/withdraw', wrap(async (req, res) => {
  const u = req.user;
  const [{ rows: wallets }, s, { rows: recent }] = await Promise.all([
    query('SELECT * FROM client_wallets WHERE user_id=$1 ORDER BY created_at DESC', [u.id]),
    balances(u.id),
    query("SELECT * FROM transactions WHERE user_id=$1 AND type='withdrawal' ORDER BY created_at DESC LIMIT 10", [u.id]),
  ]);
  const blockers = [];
  if (u.status !== 'active') blockers.push(`Your account is ${u.status}. Withdrawals are available on active accounts only.`);
  if (REQUIRE_KYC && u.kyc_status !== 'verified') blockers.push('Identity verification (KYC) must be completed before you can withdraw.');
  res.render('client/withdraw', { title: 'Withdraw', wallets, summary: s, recent, blockers, minWithdrawal: MIN_WITHDRAWAL });
}));

router.post('/wallets', limiter, wrap(async (req, res) => {
  const u = req.user;
  const back = '/funds/withdraw#wallets';
  const asset = h.oneOf(req.body.asset, cx.ASSETS, null);
  const network = h.oneOf(req.body.network, Object.keys(cx.NETWORKS), null);
  const address = h.str(req.body.address, 120);
  const memo = h.optStr(req.body.memo, 60);
  const label = h.optStr(req.body.label, 60);
  if (!asset || !network) { h.flash(req, 'error', 'Choose a currency and network.'); return res.redirect(back); }
  if (!cx.validPair(asset, network)) { h.flash(req, 'error', `${asset} is not supported on ${cx.networkName(network)}. Check the network and try again.`); return res.redirect(back); }
  if (!cx.validAddress(network, address)) { h.flash(req, 'error', `That is not a valid ${cx.networkName(network)} address. Copy it directly from your wallet.`); return res.redirect(back); }
  if (!(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) { h.flash(req, 'error', 'Your password was incorrect. The wallet was not added.'); return res.redirect(back); }
  const { rows: count } = await query("SELECT COUNT(*)::int AS n FROM client_wallets WHERE user_id=$1 AND status<>'rejected'", [u.id]);
  if (count[0].n >= 10) { h.flash(req, 'error', 'You can save up to 10 withdrawal wallets. Remove one first.'); return res.redirect(back); }
  try {
    const { rows: [w] } = await query(
      'INSERT INTO client_wallets (user_id,label,asset,network,address,memo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [u.id, label, asset, network, address, memo]);
    await h.audit(req, 'withdrawal_wallet_added', u.id, { id: w.id, asset, network, address });
  } catch (e) {
    if (e.code === '23505') { h.flash(req, 'error', 'You have already saved this address.'); return res.redirect(back); }
    throw e;
  }
  h.flash(req, 'success', 'Wallet saved. For your security, our team will verify it before it can receive withdrawals (usually within one business day).');
  res.redirect(back);
}));

router.post('/wallets/:id/delete', wrap(async (req, res) => {
  const { rows: [w] } = await query('SELECT * FROM client_wallets WHERE id=$1 AND user_id=$2', [Number(req.params.id) || 0, req.user.id]);
  if (!w) return res.redirect('/funds/withdraw#wallets');
  const { rows: inUse } = await query(
    "SELECT 1 FROM transactions WHERE user_id=$1 AND type='withdrawal' AND status='pending' AND wallet_address=$2", [req.user.id, w.address]);
  if (inUse.length) { h.flash(req, 'error', 'This wallet has a withdrawal in progress and cannot be removed yet.'); return res.redirect('/funds/withdraw#wallets'); }
  await query('DELETE FROM client_wallets WHERE id=$1', [w.id]);
  await h.audit(req, 'withdrawal_wallet_removed', req.user.id, { asset: w.asset, network: w.network, address: w.address });
  h.flash(req, 'success', 'Wallet removed.');
  res.redirect('/funds/withdraw#wallets');
}));

router.post('/withdraw', limiter, wrap(async (req, res) => {
  const u = req.user;
  const back = '/funds/withdraw';
  if (u.status !== 'active') { h.flash(req, 'error', 'Withdrawals are available on active accounts only.'); return res.redirect(back); }
  if (REQUIRE_KYC && u.kyc_status !== 'verified') { h.flash(req, 'error', 'Please complete identity verification before withdrawing.'); return res.redirect(back); }
  const amount = h.amount(req.body.amount);
  const { rows: [w] } = await query("SELECT * FROM client_wallets WHERE id=$1 AND user_id=$2 AND status='approved'", [Number(req.body.wallet_id) || 0, u.id]);
  if (!w) { h.flash(req, 'error', 'Choose one of your verified withdrawal wallets.'); return res.redirect(back); }
  if (!amount || amount < MIN_WITHDRAWAL) { h.flash(req, 'error', `The minimum withdrawal is ${h.money(MIN_WITHDRAWAL, u.base_currency)}.`); return res.redirect(back); }
  if (!(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) { h.flash(req, 'error', 'Your password was incorrect. No withdrawal was requested.'); return res.redirect(back); }

  // Lock the client's row so two simultaneous requests can't both pass the balance check
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
    const { rows: txs } = await client.query('SELECT * FROM transactions WHERE user_id=$1', [u.id]);
    const s = summarize(txs, await inPlansValue(u.id, client));
    if (amount > s.available) {
      await client.query('ROLLBACK');
      h.flash(req, 'error', `You can withdraw up to ${h.money(s.available, u.base_currency)}.`);
      return res.redirect(back);
    }
    const { rows: [t] } = await client.query(
      `INSERT INTO transactions (user_id,type,amount,status,tx_date,description,asset,network,wallet_address,wallet_memo,client_requested)
       VALUES ($1,'withdrawal',$2,'pending',CURRENT_DATE,$3,$4,$5,$6,$7,TRUE) RETURNING id`,
      [u.id, amount, `Withdrawal to ${w.asset} (${cx.networkName(w.network)}) ${cx.shortAddr(w.address)}`, w.asset, w.network, w.address, w.memo]);
    await client.query('COMMIT');
    await h.audit(req, 'withdrawal_requested', u.id, { id: t.id, amount, asset: w.asset, network: w.network, address: w.address });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  h.flash(req, 'success', `Withdrawal of ${h.money(amount, u.base_currency)} requested. You will see the blockchain transaction here once it has been sent.`);
  res.redirect(back);
}));

module.exports = router;
