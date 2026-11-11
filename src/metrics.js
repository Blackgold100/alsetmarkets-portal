const { query } = require('./db');
const plans = require('./plans');

const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'];
const ALLOC_COLORS = ['#2F6BFF', '#C98A12', '#00968A', '#8B5CF6', '#D6408F', '#64748B'];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function dayNum(iso) {
  return Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5);
}
function effect(t) {
  // [investedDelta, balanceDelta]
  switch (t.type) {
    case 'deposit': return [t.amount, t.amount];
    case 'withdrawal': return [-t.amount, -t.amount];
    case 'profit': return [0, t.amount];
    case 'loss': return [0, -t.amount];
    case 'fee': return [0, -t.amount];
    default: return [0, 0];
  }
}

async function loadAccount(userId) {
  const [tx, hold, docs, notices] = await Promise.all([
    query('SELECT t.*, EXISTS (SELECT 1 FROM deposit_proofs p WHERE p.transaction_id=t.id) AS has_proof FROM transactions t WHERE t.user_id=$1 ORDER BY t.tx_date DESC, t.id DESC', [userId]),
    query('SELECT * FROM holdings WHERE user_id=$1 ORDER BY current_value DESC, id', [userId]),
    query('SELECT * FROM documents WHERE user_id=$1 ORDER BY issued_on DESC, id DESC', [userId]),
    query('SELECT * FROM notices WHERE active AND (user_id IS NULL OR user_id=$1) ORDER BY created_at DESC LIMIT 5', [userId]),
  ]);
  return { transactions: tx.rows, holdings: hold.rows, documents: docs.rows, notices: notices.rows };
}

function summarize(transactions, inPlans = 0) {
  const done = transactions.filter((t) => t.status === 'completed');
  const sum = (type) => done.filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0);
  const deposits = sum('deposit');
  const withdrawals = sum('withdrawal');
  const profit = sum('profit');
  const loss = sum('loss');
  const fees = sum('fee');
  const invested = deposits - withdrawals;
  const roi = profit - loss - fees;
  const balance = invested + roi;
  const pendingWithdrawals = transactions.filter((t) => t.status === 'pending' && t.type === 'withdrawal').reduce((a, t) => a + t.amount, 0);
  const pendingDeposits = transactions.filter((t) => t.status === 'pending' && t.type === 'deposit').reduce((a, t) => a + t.amount, 0);
  const available = Math.max(0, Math.round((balance - pendingWithdrawals - inPlans) * 100) / 100);

  // Monthly P/L (profit - loss - fees), and return vs balance at the start of each month
  const months = new Map();
  const sorted = [...done].sort((a, b) => (a.tx_date < b.tx_date ? -1 : a.tx_date > b.tx_date ? 1 : a.id - b.id));
  let running = 0;
  for (const t of sorted) {
    const key = t.tx_date.slice(0, 7);
    if (!months.has(key)) months.set(key, { key, startBalance: running, pl: 0, deposits: 0 });
    const m = months.get(key);
    const [, db] = effect(t);
    if (t.type === 'deposit') m.deposits += t.amount;
    if (t.type === 'profit' || t.type === 'loss' || t.type === 'fee') m.pl += db;
    running += db;
  }
  const monthly = [...months.values()].map((m) => {
    const base = m.startBalance + m.deposits / 2;
    return { ...m, ret: base > 0 ? m.pl / base : null };
  });
  const plMonths = monthly.filter((m) => m.pl !== 0);
  const best = plMonths.reduce((a, m) => (a === null || m.pl > a.pl ? m : a), null);
  const worst = plMonths.reduce((a, m) => (a === null || m.pl < a.pl ? m : a), null);
  const thisKey = todayISO().slice(0, 7);
  const thisMonth = months.get(thisKey);

  return {
    deposits, withdrawals, profit, loss, fees, invested, roi, balance, available, inPlans,
    pendingWithdrawals, pendingDeposits,
    roiPct: invested > 0 ? roi / invested : null,
    monthly: monthly.slice(-12).reverse(),
    monthsUp: plMonths.filter((m) => m.pl > 0).length,
    monthsDown: plMonths.filter((m) => m.pl < 0).length,
    best, worst,
    thisMonthPl: thisMonth ? thisMonth.pl : 0,
    firstDate: sorted.length ? sorted[0].tx_date : null,
    sortedCompleted: sorted,
  };
}

function niceStep(span) {
  const raw = span / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function shortMoney(v, sym) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K' : a.toFixed(0);
  return (v < 0 ? '−' : '') + sym + s;
}

function buildChart(summary, range, currency) {
  const sym = { USD: '$', EUR: '€', GBP: '£', NGN: '₦' }[currency] ?? '';
  const tx = summary.sortedCompleted;
  if (!tx.length) return null;

  // Daily points at each transaction date
  const pts = [];
  let inv = 0, bal = 0;
  for (const t of tx) {
    const [di, db] = effect(t);
    inv += di; bal += db;
    const last = pts[pts.length - 1];
    if (last && last.d === t.tx_date) { last.inv = inv; last.bal = bal; }
    else pts.push({ d: t.tx_date, inv, bal });
  }
  const today = todayISO();
  if (pts[pts.length - 1].d < today) pts.push({ d: today, inv, bal });

  // Range window
  const endDay = dayNum(pts[pts.length - 1].d);
  const back = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365 }[range];
  let startDay = dayNum(pts[0].d);
  if (back) startDay = Math.max(startDay, endDay - back);
  if (range === 'YTD') startDay = Math.max(startDay, dayNum(today.slice(0, 4) + '-01-01'));
  // value carried into the window
  let carry = null;
  const win = [];
  for (const p of pts) {
    if (dayNum(p.d) < startDay) carry = p;
    else win.push(p);
  }
  if (carry) {
    const iso = new Date(startDay * 864e5).toISOString().slice(0, 10);
    win.unshift({ d: iso, inv: carry.inv, bal: carry.bal });
  }
  if (win.length === 1) {
    const iso = new Date((dayNum(win[0].d) - 1) * 864e5).toISOString().slice(0, 10);
    win.unshift({ d: iso, inv: win[0].inv, bal: win[0].bal });
  }

  const d0 = dayNum(win[0].d), d1 = dayNum(win[win.length - 1].d);
  const values = win.flatMap((p) => [p.inv, p.bal]);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi === lo) { hi += Math.max(1, Math.abs(hi) * 0.05); lo -= Math.max(1, Math.abs(lo) * 0.05); }
  const step = niceStep(hi - lo);
  const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step;
  const W = 1000, H = 280, pad = 10;
  const x = (iso) => (d1 === d0 ? 0 : ((dayNum(iso) - d0) / (d1 - d0)) * W);
  const y = (v) => pad + (1 - (v - yMin) / (yMax - yMin)) * (H - 2 * pad);

  let line = '', invPath = '';
  win.forEach((p, i) => {
    const X = x(p.d).toFixed(1);
    if (i === 0) {
      line += `M${X} ${y(p.bal).toFixed(1)}`;
      invPath += `M${X} ${y(p.inv).toFixed(1)}`;
    } else {
      // values change on the transaction date: draw as steps
      line += `L${X} ${y(win[i - 1].bal).toFixed(1)}L${X} ${y(p.bal).toFixed(1)}`;
      invPath += `L${X} ${y(win[i - 1].inv).toFixed(1)}L${X} ${y(p.inv).toFixed(1)}`;
    }
  });
  const area = `${line}L${W} ${H - pad}L0 ${H - pad}Z`;
  let grid = '';
  const yTicks = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) {
    const Y = y(v);
    grid += `M0 ${Y.toFixed(1)}L${W} ${Y.toFixed(1)}`;
    yTicks.push({ top: Y, label: shortMoney(v, sym) });
  }
  const xTicks = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const day = Math.round(d0 + ((d1 - d0) * i) / (n - 1));
    const iso = new Date(day * 864e5).toISOString().slice(0, 10);
    xTicks.push({ left: (i / (n - 1)) * 100, iso, align: i === 0 ? 'start' : i === n - 1 ? 'end' : 'mid' });
  }

  // Period result excluding deposits/withdrawals
  const first = win[0], lastP = win[win.length - 1];
  const flows = lastP.inv - first.inv;
  const gain = lastP.bal - first.bal - flows;
  const base = first.bal + flows / 2;

  return {
    line, area, inv: invPath, grid, yTicks, xTicks,
    points: win.map((p) => ({ x: x(p.d) / W, d: p.d, bal: p.bal, inv: p.inv, yb: y(p.bal) })),
    gain, gainPct: base > 0 ? gain / base : null,
  };
}

function allocation(holdings) {
  const total = holdings.reduce((a, h) => a + h.current_value, 0);
  if (!holdings.length || total <= 0) return { total: 0, groups: [], rows: [] };
  const byClass = new Map();
  holdings.forEach((h) => byClass.set(h.asset_class, (byClass.get(h.asset_class) || 0) + h.current_value));
  const classes = [...byClass.entries()].sort((a, b) => b[1] - a[1]);
  const colorOf = new Map();
  classes.forEach(([c], i) => colorOf.set(c, ALLOC_COLORS[Math.min(i, ALLOC_COLORS.length - 1)]));
  return {
    total,
    groups: classes.map(([name, value]) => ({ name, value, pct: (value / total) * 100, color: colorOf.get(name) })),
    rows: holdings.map((h) => ({
      ...h, color: colorOf.get(h.asset_class), weight: (h.current_value / total) * 100,
      pl: h.current_value - h.amount_in, plPct: h.amount_in > 0 ? (h.current_value - h.amount_in) / h.amount_in : null,
    })),
  };
}

async function dashboardData(user, range) {
  const r = RANGES.includes(range) ? range : '1Y';
  const acc = await loadAccount(user.id);
  const positions = await plans.userPositions(user.id);
  const inPlans = positions.filter((p) => p.status === 'active').reduce((a, p) => a + p.value, 0);
  const summary = summarize(acc.transactions, inPlans);
  return {
    ...acc,
    summary,
    chart: buildChart(summary, r, user.base_currency),
    range: r,
    ranges: RANGES,
    alloc: allocation(acc.holdings),
    positions,
  };
}

module.exports = { loadAccount, summarize, buildChart, allocation, dashboardData, RANGES };
