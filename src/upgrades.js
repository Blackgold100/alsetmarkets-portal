// Account tier upgrades: the client deposits the tier's upgrade amount into their own
// balance; when an admin approves that deposit, the tier changes automatically.
const { query } = require('./db');

async function allTiers() {
  const { rows } = await query('SELECT * FROM tiers ORDER BY rank, id');
  return rows.map((t) => ({ ...t, benefitList: (t.benefits || '').split('\n').map((s) => s.trim()).filter(Boolean) }));
}

async function offersFor(user) {
  const tiers = await allTiers();
  const current = tiers.find((t) => t.name === user.tier);
  const rank = current ? current.rank : 0;
  return { current, offers: tiers.filter((t) => t.offered && t.rank > rank && t.upgrade_amount > 0) };
}

// The client's plan threshold: limit for their tier, principal already in open plans, room left.
async function planLimitFor(user, client) {
  const q = client ? client.query.bind(client) : query;
  const { rows: [t] } = await q('SELECT name, plan_limit FROM tiers WHERE name=$1', [user.tier]);
  const { rows: [u] } = await q("SELECT COALESCE(SUM(principal),0) AS used FROM plan_positions WHERE user_id=$1 AND status='active'", [user.id]);
  const limit = t && t.plan_limit !== null ? Number(t.plan_limit) : null;
  const used = Number(u.used);
  return { tier: user.tier, limit, used, remaining: limit === null ? null : Math.max(0, Math.round((limit - used) * 100) / 100) };
}

// Can this client invest in a plan that requires `minTier`? (null = open to every tier)
async function meetsTier(user, minTier, client) {
  if (!minTier) return true;
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q('SELECT name, rank FROM tiers WHERE name = ANY($1)', [[user.tier, minTier]]);
  const r = Object.fromEntries(rows.map((x) => [x.name, x.rank]));
  return r[minTier] !== undefined && (r[user.tier] || 0) >= r[minTier];
}

async function openRequest(userId) {
  const { rows } = await query(
    "SELECT * FROM upgrade_requests WHERE user_id=$1 AND status IN ('awaiting_deposit','deposit_submitted') ORDER BY id DESC LIMIT 1", [userId]);
  return rows[0] || null;
}

// Called whenever a transaction becomes 'completed'. Applies the upgrade if this was an
// upgrade deposit for at least the agreed amount. Returns the new tier name, or null.
async function applyIfReady(txId) {
  const { rows: [t] } = await query(
    `SELECT t.*, r.id AS req_id, r.amount AS req_amount, r.target_tier, r.status AS req_status
     FROM transactions t JOIN upgrade_requests r ON r.id=t.upgrade_request_id
     WHERE t.id=$1 AND t.type='deposit' AND t.status='completed'`, [txId]);
  if (!t || t.req_status === 'completed' || t.req_status === 'cancelled') return null;
  if (t.amount + 1e-9 < t.req_amount) return null; // short deposit: admin decides manually
  await query("UPDATE upgrade_requests SET status='completed', completed_at=NOW() WHERE id=$1", [t.req_id]);
  await query('UPDATE users SET tier=$1, upgrade_active=FALSE, updated_at=NOW() WHERE id=$2', [t.target_tier, t.user_id]);
  await query(
    "INSERT INTO notices (user_id, title, body, level) VALUES ($1,$2,$3,'success')",
    [t.user_id, `Welcome to ${t.target_tier}`, `Your deposit has been confirmed and your account is now on the ${t.target_tier} tier.`]);
  return t.target_tier;
}

module.exports = { allTiers, offersFor, openRequest, applyIfReady, planLimitFor, meetsTier };
