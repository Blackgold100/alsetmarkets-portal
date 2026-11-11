// End-to-end test of the portal: sign-in, admin console, client dashboard, crypto deposits and withdrawals.
// Run in the Replit workspace (not the live deployment):  npm test
// It starts its own copy of the server on a spare port, uses the workspace database,
// creates throwaway users ending in @example.test, and deletes them all at the end.

require('../src/env');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PORT = Number(process.env.TEST_PORT || 3999);
const B = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const ADMIN = { email: `test-admin-${RUN}@example.test`, password: 'TestAdmin2026x' };
const CLIENT_EMAIL = `test-client-${RUN}@example.test`;
const TRX = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const TRX2 = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const H1 = RUN.padEnd(64, 'a').replace(/[^0-9a-f]/g, 'c').slice(0, 64);
const H2 = RUN.padEnd(64, 'b').replace(/[^0-9a-f]/g, 'd').slice(0, 64);
const H3 = RUN.padEnd(64, 'e').replace(/[^0-9a-f]/g, 'f').slice(0, 64);
const H4 = RUN.padEnd(64, '1').replace(/[^0-9a-f]/g, '2').slice(0, 64);

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Create the database first (guide step 2).'); process.exit(1); }
if (process.env.REPLIT_DEPLOYMENT) { console.error('Refusing to run tests on the live deployment. Run npm test in the workspace.'); process.exit(1); }

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

function agent() {
  const jar = {};
  return {
    async req(p, { method = 'GET', form } = {}) {
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
      let body;
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      const r = await fetch(B + p, { method, headers, body, redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
    },
    async csrf(p) { const r = await this.req(p); const m = r.text.match(/name="_csrf" value="([^"]+)"/); return m && m[1]; },
    async post(page, action, form) { const t = await this.csrf(page); return this.req(action, { method: 'POST', form: { _csrf: t, ...form } }); },
    async json(method, p, body) {
      if (!this.token) { const page = await this.req('/'.concat(p.startsWith('/admin') ? 'admin' : '')); this.token = (page.text.match(/name="csrf-token" content="([^"]+)"/) || [])[1]; }
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), accept: 'application/json', 'x-csrf-token': this.token || '' };
      if (body) headers['content-type'] = 'application/json';
      const r = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      let data = null; try { data = await r.json(); } catch (e) { /* not JSON */ }
      return { status: r.status, data };
    },
    async flash(p) { const r = await this.req(p); const m = r.text.match(/class="alert alert-(success|error)"[^>]*>[\s\S]*?<span>([^<]*)</); return m ? m[1] : null; },
  };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(B + '/healthz'); if (r.ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not start on port ' + PORT);
}

async function cleanup(walletIds) {
  if (walletIds.length) await db.query('DELETE FROM firm_wallets WHERE id = ANY($1)', [walletIds]);
  await db.query("DELETE FROM users WHERE email LIKE $1", [`%-${RUN}@example.test`]);
  // The temporary test plan and anything attached to it
  await db.query("DELETE FROM transactions WHERE plan_id IN (SELECT id FROM plans WHERE slug=$1)", [`test-${RUN}`]);
  await db.query("DELETE FROM plan_positions WHERE plan_id IN (SELECT id FROM plans WHERE slug=$1)", [`test-${RUN}`]);
  await db.query("DELETE FROM plan_results WHERE plan_id IN (SELECT id FROM plans WHERE slug=$1)", [`test-${RUN}`]);
  await db.query("DELETE FROM plans WHERE slug=$1", [`test-${RUN}`]);
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const walletIds = [];

  try {
    await waitForServer();
    // A throwaway admin, created directly in the database
    await db.query(
      `INSERT INTO users (role,email,password_hash,full_name,status,kyc_status,must_change_password)
       VALUES ('admin',$1,$2,'Test Admin','active','verified',FALSE)`,
      [ADMIN.email, await bcrypt.hash(ADMIN.password, 10)]);

    console.log('\nSign-in & security');
    const a = agent();
    let r = await a.post('/login', '/login', { email: ADMIN.email, password: 'wrong-password' });
    check(r.status === 401, 'wrong password is rejected');
    r = await a.post('/login', '/login', { email: ADMIN.email, password: ADMIN.password });
    check(r.loc === '/admin', 'admin signs in');
    r = await a.req('/admin/clients/new', { method: 'POST', form: { _csrf: 'forged' } });
    check(r.status === 403, 'forms without a valid CSRF token are refused');

    console.log('\nAdmin: clients & transactions');
    r = await a.post('/admin/clients/new', '/admin/clients', {
      full_name: 'Test Client', email: CLIENT_EMAIL, tier: 'Standard', base_currency: 'USD', role: 'client', opened_on: '2025-01-15',
    });
    const tempPw = (r.text.match(/Temporary password<\/dt><dd class="num"[^>]*>([^<]+)</) || [])[1];
    const id = (r.text.match(/\/admin\/clients\/(\d+)"/) || [])[1];
    check(tempPw && id, 'client created with a temporary password');
    const entries = [['deposit', '10000', '2025-01-15'], ['profit', '450', '2025-02-28'], ['fee', '50', '2025-02-28'], ['loss', '100', '2025-03-31'], ['withdrawal', '1000', '2025-04-10']];
    for (const [type, amount, tx_date] of entries) await a.post(`/admin/clients/${id}`, `/admin/clients/${id}/transactions`, { type, amount, tx_date, status: 'completed' });
    await a.post(`/admin/clients/${id}`, `/admin/clients/${id}/profile`, {
      full_name: 'Test Client', email: CLIENT_EMAIL, status: 'active', tier: 'Standard', kyc_status: 'verified', base_currency: 'USD', opened_on: '2025-01-15',
    });
    await a.post(`/admin/clients/${id}`, `/admin/clients/${id}/upgrade`, { upgrade_active: 'on', upgrade_title: 'Eligible for Professional', upgrade_target_tier: 'Professional' });
    for (const p of [`/admin`, `/admin/clients/${id}`, `/admin/clients/${id}/preview`, '/admin/wallets', '/admin/notices', '/admin/team', '/admin/audit']) {
      r = await a.req(p); check(r.status === 200, `admin page ${p} loads`);
    }

    console.log('\nClient: first sign-in & dashboard');
    const c = agent();
    r = await c.post('/login', '/login', { email: CLIENT_EMAIL, password: tempPw });
    check(r.loc === '/account/password', 'temporary password forces a password change');
    r = await c.post('/account/password', '/account/password', { current: tempPw, next: 'ClientTest2026', confirm: 'ClientTest2026' });
    check(r.loc === '/', 'client sets a new password');
    r = await c.req('/');
    // 10,000 in − 1,000 out = 9,000 invested; ROI = 450 − 50 − 100 = 300; balance 9,300
    check(r.text.includes('$9,000.00'), 'total invested = $9,000.00');
    check(r.text.includes('+$300.00'), 'total ROI = +$300.00');
    check(r.text.includes('$9,300.00'), 'account balance = $9,300.00');
    check(r.text.includes('Eligible for Professional'), 'upgrade notice shows');
    for (const p of ['/?range=ALL', '/transactions', '/account', '/funds/deposit', '/funds/withdraw']) {
      r = await c.req(p); check(r.status === 200, `client page ${p} loads`);
    }
    r = await c.req('/admin');
    check(r.status === 403, 'client cannot open the admin console');

    console.log('\nCrypto deposits');
    r = await a.post('/admin/wallets', '/admin/wallets', { asset: 'USDT', network: 'TRC20', address: TRX, confirm_address: TRX2 });
    check((await a.flash('/admin/wallets')) === 'error', 'mismatched confirmation address is rejected');
    r = await a.post('/admin/wallets', '/admin/wallets', { asset: 'USDT', network: 'TRC20', address: 'Tnotreal', confirm_address: 'Tnotreal' });
    check((await a.flash('/admin/wallets')) === 'error', 'invalid TRC20 address is rejected');
    await a.post('/admin/wallets', '/admin/wallets', { user_id: id, asset: 'USDT', network: 'TRC20', address: TRX2, confirm_address: TRX2, label: 'test' });
    const { rows: fw } = await db.query('SELECT id FROM firm_wallets WHERE user_id=$1', [id]);
    fw.forEach((w) => walletIds.push(w.id));
    r = await c.req('/funds/deposit');
    check(r.text.includes(TRX2) && r.text.includes('data:image/svg+xml'), 'client sees the deposit address and QR code');
    const depWallet = (r.text.match(/<option value="(\d+)">USDT · Tron/) || [])[1];
    await c.post('/funds/deposit', '/funds/deposit', { wallet_id: depWallet, amount: '500', tx_hash: 'not-a-hash' });
    check((await c.flash('/funds/deposit')) === 'error', 'invalid transaction hash is rejected');
    await c.post('/funds/deposit', '/funds/deposit', { wallet_id: depWallet, amount: '500', tx_hash: H1 });
    check((await c.flash('/funds/deposit')) === 'success', 'deposit submitted as pending');
    await c.post('/funds/deposit', '/funds/deposit', { wallet_id: depWallet, amount: '500', tx_hash: H1 });
    check((await c.flash('/funds/deposit')) === 'error', 'the same hash cannot be submitted twice');
    const { rows: [dep] } = await db.query("SELECT id FROM transactions WHERE user_id=$1 AND tx_hash=$2", [id, H1]);
    await a.post('/admin', `/admin/transactions/${dep.id}/status`, { status: 'completed', back: 'dashboard' });
    r = await c.req('/');
    check(r.text.includes('$9,800.00'), 'approved deposit is added to the balance ($9,800.00)');

    console.log('\nCrypto withdrawals');
    await c.post('/funds/withdraw', '/funds/wallets', { asset: 'USDT', network: 'TRC20', address: TRX, label: 'Test', password: 'wrong' });
    check((await c.flash('/funds/withdraw')) === 'error', 'adding a wallet needs the correct password');
    await c.post('/funds/withdraw', '/funds/wallets', { asset: 'USDT', network: 'TRC20', address: TRX, label: 'Test', password: 'ClientTest2026' });
    const { rows: [cw] } = await db.query('SELECT id,status FROM client_wallets WHERE user_id=$1', [id]);
    check(cw && cw.status === 'pending', 'new withdrawal wallet waits for admin approval');
    await a.post('/admin', `/admin/client-wallets/${cw.id}/status`, { status: 'approved', back: 'dashboard' });
    await c.post('/funds/withdraw', '/funds/withdraw', { wallet_id: cw.id, amount: '999999', password: 'ClientTest2026' });
    check((await c.flash('/funds/withdraw')) === 'error', 'cannot withdraw more than the available balance');
    await c.post('/funds/withdraw', '/funds/withdraw', { wallet_id: cw.id, amount: '800', password: 'ClientTest2026' });
    check((await c.flash('/funds/withdraw')) === 'success', 'withdrawal requested');
    r = await c.req('/');
    check(r.text.includes('$9,000.00'), 'pending withdrawal reduces "available to withdraw" ($9,000.00)');
    const { rows: [wd] } = await db.query("SELECT id FROM transactions WHERE user_id=$1 AND type='withdrawal' AND status='pending'", [id]);
    await a.post('/admin', `/admin/transactions/${wd.id}/status`, { status: 'completed', back: 'dashboard', tx_hash: H2 });
    r = await c.req('/funds/withdraw');
    check(r.text.includes('tronscan.org/#/transaction/' + H2), 'client sees the payout on the block explorer');

    console.log('\nInvestment plans');
    // Balance here: 10,000 + 500 − 1,000 − 800 + 300 = 9,000, all available
    const { rows: [tp] } = await db.query(
      `INSERT INTO plans (slug,name,summary,risk_level,min_amount,lock_days,sort) VALUES ($1,$2,'Test plan','High',250,7,99) RETURNING *`,
      [`test-${RUN}`, `Test Plan ${RUN}`]);
    r = await c.req('/plans');
    check(r.status === 200 && r.text.includes(`Test Plan ${RUN}`) && r.text.includes('Mining') && r.text.includes('Crypto Trading'), 'plans page lists Mining, Stocks, Crypto Trading');
    await c.post('/plans', `/plans/${tp.id}/invest`, { amount: '100', password: 'ClientTest2026', accept: 'on' });
    check((await c.flash('/plans')) === 'error', 'investment below the plan minimum is refused');
    await c.post('/plans', `/plans/${tp.id}/invest`, { amount: '2000', password: 'ClientTest2026' });
    check((await c.flash('/plans')) === 'error', 'investing requires accepting the risk and lock-in terms');
    await c.post('/plans', `/plans/${tp.id}/invest`, { amount: '2000', password: 'wrong', accept: 'on' });
    check((await c.flash('/plans')) === 'error', 'investing requires the correct password');
    await c.post('/plans', `/plans/${tp.id}/invest`, { amount: '2000', password: 'ClientTest2026', accept: 'on' });
    check((await c.flash('/plans')) === 'success', 'client invests $2,000');
    const { rows: [pos] } = await db.query('SELECT * FROM plan_positions WHERE user_id=$1 AND plan_id=$2', [id, tp.id]);
    const daysLocked = Math.round((Date.parse(pos.unlocks_on) - Date.parse(pos.started_on)) / 864e5);
    check(pos && daysLocked === 7, 'investment is locked for the plan’s 7 days');
    r = await c.req('/');
    check(r.text.includes('$9,000.00') && r.text.includes('$7,000.00'), 'balance stays $9,000.00; available drops to $7,000.00');
    await c.post('/plans', `/plans/${tp.id}/invest`, { amount: '8000', password: 'ClientTest2026', accept: 'on' });
    check((await c.flash('/plans')) === 'error', 'cannot invest more than the available balance');
    const { rows: [stdTier] } = await db.query("SELECT plan_limit FROM tiers WHERE name='Standard'");
    if (stdTier && stdTier.plan_limit !== null) {
      const over = (Number(stdTier.plan_limit) - 2000 + 1).toFixed(2);
      await c.post('/plans', `/plans/${tp.id}/invest`, { amount: over, password: 'ClientTest2026', accept: 'on' });
      r = await c.req('/plans');
      check(r.text.includes('tier allows up to') && r.text.includes('Upgrade'), 'investing beyond the Standard tier threshold is refused with an upgrade prompt');
      check(r.text.includes('plan investment limit'), 'plans page shows the tier threshold and how much is used');
    }
    await c.post('/plans', `/plans/positions/${pos.id}/redeem`, {});
    check((await c.flash('/plans')) === 'error', 'cannot withdraw from a plan before the lock-in ends');
    const day = new Date().toISOString().slice(0, 10);
    r = await a.post(`/admin/plans/${tp.id}`, `/admin/plans/${tp.id}/preview`, { period_start: day, period_end: day, return_pct: '45' });
    check(r.text.includes('safety check'), 'implausible results (over ±30%) are refused');
    r = await a.post(`/admin/plans/${tp.id}`, `/admin/plans/${tp.id}/preview`, { period_start: day, period_end: day, return_pct: '2' });
    check(r.status === 200 && r.text.includes('+$40.00'), 'preview shows +$40.00 for a +2% result on $2,000');
    await a.post(`/admin/plans/${tp.id}`, `/admin/plans/${tp.id}/results`, { period_start: day, period_end: day, return_pct: '2', confirm: 'yes' });
    r = await c.req('/');
    check(r.text.includes('$9,040.00') && r.text.includes('$2,040.00'), 'posting +2% credits $40: balance $9,040.00, plan value $2,040.00');
    await a.post(`/admin/plans/${tp.id}`, `/admin/plans/${tp.id}/results`, { period_start: day, period_end: day, return_pct: '2', confirm: 'yes' });
    check((await a.flash(`/admin/plans/${tp.id}`)) === 'error', 'the same period cannot be posted twice');
    const { rows: [res1] } = await db.query('SELECT id FROM plan_results WHERE plan_id=$1', [tp.id]);
    await a.post(`/admin/plans/${tp.id}`, `/admin/plan-results/${res1.id}/undo`, {});
    r = await c.req('/');
    check(r.text.includes('$9,000.00') && !r.text.includes('$2,040.00'), 'undo reverses the result for every investor');
    await a.post(`/admin/plans/${tp.id}`, `/admin/plans/${tp.id}/results`, { period_start: day, period_end: day, return_pct: '-1.5', confirm: 'yes' });
    r = await c.req('/');
    check(r.text.includes('$8,970.00') && r.text.includes('$1,970.00'), 'a −1.5% result debits $30: balance $8,970.00, plan value $1,970.00');
    r = await c.req('/transactions');
    check(r.text.includes(`Test Plan ${RUN} plan · result`), 'the plan result appears in the client’s transaction history');
    await a.post(`/admin/plans/${tp.id}`, `/admin/positions/${pos.id}/release`, {});
    r = await c.req('/funds/withdraw');
    check(r.text.includes('$8,970.00') && !r.text.includes('Not including'), 'released investment returns to available ($8,970.00)');
    for (const p of ['/admin/plans', `/admin/plans/${tp.id}`, `/admin/clients/${id}`]) { r = await a.req(p); check(r.status === 200, `admin page ${p} loads`); }

    console.log('\nAccount upgrades');
    const { rows: tierRows } = await db.query("SELECT * FROM tiers WHERE offered AND upgrade_amount > 0 ORDER BY rank");
    const pro = tierRows[0], top = tierRows[tierRows.length - 1];
    r = await c.req('/upgrade');
    check(r.status === 200 && r.text.includes(pro.name) && r.text.includes(top.name) && r.text.includes('stays your money'), `upgrade page lists ${pro.name} and ${top.name} and says the deposit stays the client's`);
    r = await c.post('/upgrade', `/upgrade/${pro.id}/choose`, {});
    const reqId = (r.loc || '').split('upgrade=')[1];
    check(r.loc && r.loc.startsWith('/funds/deposit?upgrade='), 'choosing a tier goes to the deposit page');
    r = await c.req(r.loc);
    check(r.text.includes(`Upgrade to ${pro.name}`) && r.text.includes(`value="${Number(pro.upgrade_amount).toFixed(2)}"`), 'deposit page shows the upgrade and pre-fills its amount');
    await c.post('/funds/deposit', '/funds/deposit', { wallet_id: depWallet, amount: String(pro.upgrade_amount), tx_hash: H3, upgrade_request_id: reqId });
    let { rows: [ur] } = await db.query('SELECT * FROM upgrade_requests WHERE id=$1', [reqId]);
    let { rows: [cu] } = await db.query('SELECT tier FROM users WHERE id=$1', [id]);
    check(ur.status === 'deposit_submitted' && cu.tier === 'Standard', 'tier does not change until the deposit is approved');
    const { rows: [upDep] } = await db.query('SELECT id FROM transactions WHERE tx_hash=$1', [H3]);
    r = await a.req('/admin');
    check(r.text.includes(`Upgrade to ${pro.name}`), 'admin approval queue labels the upgrade deposit');
    await a.post('/admin', `/admin/transactions/${upDep.id}/status`, { status: 'completed', back: 'dashboard' });
    ({ rows: [ur] } = await db.query('SELECT * FROM upgrade_requests WHERE id=$1', [reqId]));
    ({ rows: [cu] } = await db.query('SELECT tier, upgrade_active FROM users WHERE id=$1', [id]));
    check(ur.status === 'completed' && cu.tier === pro.name && cu.upgrade_active === false, `approving the deposit upgrades the client to ${pro.name} and hides the notice`);
    r = await c.req('/');
    check(r.text.includes(`Welcome to ${pro.name}`), 'client sees a confirmation on the dashboard');
    if (top.id !== pro.id) {
      r = await c.post('/upgrade', `/upgrade/${top.id}/choose`, {});
      const req2 = (r.loc || '').split('upgrade=')[1];
      await c.post('/funds/deposit', '/funds/deposit', { wallet_id: depWallet, amount: '100', tx_hash: H4, upgrade_request_id: req2 });
      const { rows: [shortDep] } = await db.query('SELECT id FROM transactions WHERE tx_hash=$1', [H4]);
      r = await a.req('/admin');
      check(r.text.includes('Short of'), 'a deposit below the upgrade amount is flagged as short');
      await a.post('/admin', `/admin/transactions/${shortDep.id}/status`, { status: 'completed', back: 'dashboard' });
      ({ rows: [cu] } = await db.query('SELECT tier FROM users WHERE id=$1', [id]));
      check(cu.tier === pro.name, 'a short deposit is credited but does not upgrade the account');
      await a.post(`/admin/clients/${id}`, `/admin/upgrade-requests/${req2}/complete`, {});
      ({ rows: [cu] } = await db.query('SELECT tier FROM users WHERE id=$1', [id]));
      check(cu.tier === top.name, `admin can complete an upgrade manually (${top.name})`);
    }
    r = await a.req('/admin/tiers');
    check(r.status === 200, 'admin tiers page loads');

    console.log('\nLive support chat');
    r = await c.json('GET', '/chat/api/messages');
    check(r.status === 200 && r.data.status === 'new', 'client starts with no conversation');
    r = await fetch(B + '/chat/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) });
    check(r.status === 401 || r.status === 403, 'chat API refuses requests without a session or CSRF token');
    r = await c.json('POST', '/chat/api/messages', { body: 'Hello, when will my deposit be credited? <script>alert(1)</script>' });
    check(r.status === 200 && r.data.message.role === 'client', 'client sends a message');
    r = await c.json('POST', '/chat/api/messages', { body: '   ' });
    check(r.status === 400, 'empty messages are refused');
    r = await a.json('GET', '/admin/chat/api/summary');
    check(r.status === 200 && r.data.unread >= 1, 'admin sees an unread message count');
    r = await a.json('GET', '/admin/chat/api/threads');
    const thread = r.data.threads.find((t) => t.account && t.name === 'Test Client');
    check(thread && thread.unread >= 1 && thread.waiting, 'conversation appears in the admin inbox as awaiting reply');
    r = await a.req(`/admin/chat/${thread.id}`);
    check(r.status === 200 && !r.text.includes('<script>alert(1)</script>'), 'admin conversation page loads and message HTML is escaped');
    r = await a.json('POST', `/admin/chat/api/threads/${thread.id}/messages`, { body: 'It is confirming now and will be credited within 30 minutes.' });
    check(r.status === 200 && r.data.message.role === 'admin', 'admin replies');
    r = await c.json('GET', '/chat/api/messages');
    check(r.data.messages.some((m) => m.role === 'admin') && r.data.unread >= 1, 'client receives the reply with an unread badge');
    check(r.data.online === true, 'client sees support as online');
    await c.json('POST', '/chat/api/read');
    r = await c.json('GET', '/chat/api/messages');
    check(r.data.unread === 0, 'opening the chat marks replies as read');
    const lastId = r.data.messages[r.data.messages.length - 1].id;
    r = await c.json('GET', `/chat/api/messages?after=${lastId}`);
    check(r.data.messages.length === 0, 'polling returns only new messages');
    r = await c.json('GET', '/admin/chat/api/summary');
    check(r.status === 403, 'clients cannot use the admin chat API');
    await a.post(`/admin/chat/${thread.id}`, `/admin/chat/${thread.id}/status`, { status: 'closed' });
    await c.json('POST', '/chat/api/messages', { body: 'One more question' });
    r = await a.json('GET', '/admin/chat/api/threads?filter=open');
    check(r.data.threads.some((t) => t.id === thread.id), 'a closed conversation reopens when the client writes again');
  } catch (e) {
    failed++;
    console.error('\nTest run crashed:', e.message);
    if (serverLog) console.error('--- server output ---\n' + serverLog.slice(-2000));
  } finally {
    await cleanup(walletIds).catch((e) => console.error('Cleanup failed:', e.message));
    server.kill();
    await db.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
