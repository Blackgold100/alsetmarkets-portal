// Investment plans: allocation, weekly result distribution, redemption.
//
// How the money works
// - Moving money into a plan does not create a transaction: the money stays in the
//   client's account balance, but it is no longer "available to withdraw".
// - When an admin posts a plan's actual result for a period, every open position gets a
//   profit or loss transaction (so the balance changes) and its plan value changes by the same amount.
// - Redeeming a position (after its lock-in) makes its value available again.
const { pool, query } = require('./db');

const round2 = (n) => Math.round(n * 100) / 100;
const dayNum = (iso) => Math.floor(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / 864e5);
const isoFromDay = (d) => new Date(d * 864e5).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const MAX_WEEKLY_PCT = 30; // sanity limit on a single posted result, in percent

async function listPlans({ activeOnly = false } = {}) {
  const { rows } = await query(
    `SELECT p.*,
       COALESCE((SELECT SUM(value) FROM plan_positions x WHERE x.plan_id=p.id AND x.status='active'),0) AS aum,
       (SELECT COUNT(DISTINCT user_id)::int FROM plan_positions x WHERE x.plan_id=p.id AND x.status='active') AS investors,
       (SELECT MAX(period_end) FROM plan_results r WHERE r.plan_id=p.id) AS last_period_end
     FROM plans p ${activeOnly ? 'WHERE p.active' : ''} ORDER BY p.sort, p.id`);
  const { rows: results } = await query(
    `SELECT * FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY plan_id ORDER BY period_start DESC) AS rn FROM plan_results r) z
     WHERE rn <= 12 ORDER BY period_start`);
  for (const p of rows) {
    p.recent = results.filter((r) => r.plan_id === p.id);
    // Compounded return over the recent posted periods (actual history, not a forecast)
    p.recentCompound = p.recent.length ? p.recent.reduce((a, r) => a * (1 + r.return_pct / 100), 1) - 1 : null;
    p.resultDue = p.active && (!p.last_period_end || dayNum(today()) - dayNum(p.last_period_end) > 7);
  }
  return rows;
}

async function getPlan(id) {
  const { rows } = await query('SELECT * FROM plans WHERE id=$1', [Number(id) || 0]);
  return rows[0] || null;
}

async function userPositions(userId) {
  const { rows } = await query(
    `SELECT x.*, p.name AS plan_name, p.slug, p.risk_level,
       COALESCE((SELECT SUM(CASE t.type WHEN 'profit' THEN t.amount WHEN 'loss' THEN -t.amount ELSE 0 END)
                 FROM transactions t WHERE t.position_id=x.id AND t.status='completed'),0) AS earned
     FROM plan_positions x JOIN plans p ON p.id=x.plan_id
     WHERE x.user_id=$1 ORDER BY (x.status='active') DESC, x.started_on DESC, x.id DESC`, [userId]);
  const t = dayNum(today());
  for (const r of rows) {
    r.unlocked = dayNum(r.unlocks_on) <= t;
    r.daysLeft = Math.max(0, dayNum(r.unlocks_on) - t);
    r.pnlPct = r.principal > 0 ? (r.value - r.principal) / r.principal : null;
  }
  return rows;
}

async function inPlansValue(userId, client) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q("SELECT COALESCE(SUM(value),0) AS v FROM plan_positions WHERE user_id=$1 AND status='active'", [userId]);
  return Number(rows[0].v);
}

// Called with a summarize() function to avoid a circular import with metrics.js
async function invest({ user, plan, amount, summarize }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const { rows: txs } = await c.query('SELECT * FROM transactions WHERE user_id=$1', [user.id]);
    const s = summarize(txs, await inPlansValue(user.id, c));
    if (amount > s.available + 1e-9) {
      await c.query('ROLLBACK');
      return { error: `You have ${s.available.toFixed(2)} available to invest.`, available: s.available };
    }
    const start = today();
    const unlocks = isoFromDay(dayNum(start) + plan.lock_days);
    const { rows: [pos] } = await c.query(
      `INSERT INTO plan_positions (user_id, plan_id, principal, value, started_on, unlocks_on)
       VALUES ($1,$2,$3,$3,$4,$5) RETURNING *`, [user.id, plan.id, amount, start, unlocks]);
    await c.query('COMMIT');
    return { position: pos };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function redeem({ positionId, userId, actorId, force = false }) {
  const params = [Number(positionId) || 0];
  let sql = "SELECT * FROM plan_positions WHERE id=$1 AND status='active'";
  if (userId) { params.push(userId); sql += ' AND user_id=$2'; }
  const { rows: [pos] } = await query(sql, params);
  if (!pos) return { error: 'That investment is not open.' };
  if (!force && dayNum(pos.unlocks_on) > dayNum(today())) return { error: `This investment is locked until ${pos.unlocks_on}.` };
  await query("UPDATE plan_positions SET status='closed', closed_at=NOW(), closed_by=$2 WHERE id=$1", [pos.id, actorId || null]);
  return { position: pos };
}

// Works out what each open position would receive for a posted result.
async function computeDistribution(c, plan, start, end, pct) {
  const s = dayNum(start), e = dayNum(end), len = e - s + 1;
  const { rows } = await c.query(
    `SELECT x.*, u.full_name, u.account_no FROM plan_positions x JOIN users u ON u.id=x.user_id
     WHERE x.plan_id=$1 AND x.status='active' AND x.started_on <= $2 ORDER BY x.id FOR UPDATE OF x`, [plan.id, end]);
  return rows.map((p) => {
    const heldFrom = Math.max(dayNum(p.started_on), s);
    const factor = Math.max(0, Math.min(1, (e - heldFrom + 1) / len));
    let pnl = round2(p.value * (pct / 100) * factor);
    if (pnl < -p.value) pnl = -p.value; // a position can't go below zero
    return { position: p, factor, pnl };
  });
}

function validateResult(plan, start, end, pct, lastEnd) {
  if (!start || !end) return 'Enter the period start and end dates.';
  if (dayNum(end) < dayNum(start)) return 'The period end must be on or after the start.';
  if (dayNum(end) - dayNum(start) > 31) return 'A result period can be at most 31 days.';
  if (dayNum(end) > dayNum(today())) return 'You can only post results for periods that have ended.';
  if (lastEnd && dayNum(start) <= dayNum(lastEnd)) return `This plan already has results up to ${lastEnd}. Start the next period after that date.`;
  if (!Number.isFinite(pct)) return 'Enter the period return as a percentage, e.g. 1.25 or -0.80.';
  if (Math.abs(pct) > MAX_WEEKLY_PCT) return `Results beyond ±${MAX_WEEKLY_PCT}% in one period are refused as a safety check. Check the figure.`;
  return null;
}

async function lastResultEnd(planId, c) {
  const q = c ? c.query.bind(c) : query;
  const { rows } = await q('SELECT MAX(period_end) AS d FROM plan_results WHERE plan_id=$1', [planId]);
  return rows[0].d;
}

async function previewResult(plan, start, end, pct) {
  const err = validateResult(plan, start, end, pct, await lastResultEnd(plan.id));
  if (err) return { error: err };
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const dist = await computeDistribution(c, plan, start, end, pct);
    await c.query('ROLLBACK');
    return { dist, total: round2(dist.reduce((a, d) => a + d.pnl, 0)) };
  } finally {
    c.release();
  }
}

async function postResult({ plan, start, end, pct, note, actorId }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM plans WHERE id=$1 FOR UPDATE', [plan.id]); // one posting per plan at a time
    const err = validateResult(plan, start, end, pct, await lastResultEnd(plan.id, c));
    if (err) { await c.query('ROLLBACK'); return { error: err }; }
    const dist = await computeDistribution(c, plan, start, end, pct);
    const total = round2(dist.reduce((a, d) => a + d.pnl, 0));
    const { rows: [result] } = await c.query(
      `INSERT INTO plan_results (plan_id, period_start, period_end, return_pct, note, positions, total_pnl, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [plan.id, start, end, pct, note, dist.length, total, actorId]);
    const label = `${plan.name} plan · result ${start} to ${end} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    for (const d of dist) {
      if (d.pnl === 0) continue;
      await c.query('UPDATE plan_positions SET value = value + $1 WHERE id=$2', [d.pnl, d.position.id]);
      await c.query(
        `INSERT INTO transactions (user_id, type, amount, status, tx_date, description, created_by, plan_id, position_id, plan_result_id)
         VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9)`,
        [d.position.user_id, d.pnl > 0 ? 'profit' : 'loss', Math.abs(d.pnl), end,
          d.factor < 1 ? `${label}, part period` : label, actorId, plan.id, d.position.id, result.id]);
    }
    await c.query('COMMIT');
    return { result, count: dist.length, total };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { error: 'A result for this period has already been posted.' };
    throw e;
  } finally {
    c.release();
  }
}

// Undo the most recent result of a plan (e.g. a typo), restoring every position.
async function reverseResult({ resultId }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [r] } = await c.query('SELECT * FROM plan_results WHERE id=$1 FOR UPDATE', [Number(resultId) || 0]);
    if (!r) { await c.query('ROLLBACK'); return { error: 'That result does not exist.' }; }
    const { rows: [latest] } = await c.query('SELECT id FROM plan_results WHERE plan_id=$1 ORDER BY period_start DESC LIMIT 1', [r.plan_id]);
    if (latest.id !== r.id) { await c.query('ROLLBACK'); return { error: 'Only the most recent result can be undone. Undo the later ones first.' }; }
    const { rows: txs } = await c.query('SELECT * FROM transactions WHERE plan_result_id=$1', [r.id]);
    for (const t of txs) {
      const delta = t.type === 'profit' ? -t.amount : t.amount;
      await c.query('UPDATE plan_positions SET value = GREATEST(0, value + $1) WHERE id=$2', [delta, t.position_id]);
    }
    await c.query('DELETE FROM transactions WHERE plan_result_id=$1', [r.id]);
    await c.query('DELETE FROM plan_results WHERE id=$1', [r.id]);
    await c.query('COMMIT');
    return { result: r, reversed: txs.length };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

function nextPeriod(lastEnd) {
  // Suggest the next 7-day period: the day after the last result, or the most recent full Mon–Sun week.
  const t = dayNum(today());
  if (lastEnd) {
    const s = dayNum(lastEnd) + 1;
    return { start: isoFromDay(s), end: isoFromDay(Math.min(s + 6, t)) };
  }
  const dow = (new Date(t * 864e5).getUTCDay() + 6) % 7; // Monday = 0
  const lastSunday = t - dow - 1;
  return { start: isoFromDay(lastSunday - 6), end: isoFromDay(lastSunday) };
}

module.exports = {
  listPlans, getPlan, userPositions, inPlansValue, invest, redeem,
  previewResult, postResult, reverseResult, nextPeriod, MAX_WEEKLY_PCT, today, dayNum,
};
