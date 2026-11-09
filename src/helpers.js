const crypto = require('crypto');
const { query } = require('./db');

// ---------- Formatting (exposed to views) ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function money(n, currency = 'USD', dp = 2) {
  const v = Number(n) || 0;
  const sym = { USD: '$', EUR: '€', GBP: '£', NGN: '₦' }[currency] ?? '';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v < 0 ? '−' : '') + (sym || currency + ' ') + s;
}
function signedMoney(n, currency, dp) {
  const v = Number(n) || 0;
  return (v > 0 ? '+' : '') + money(v, currency, dp);
}
function pct(n, dp = 2) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n * 100).toFixed(dp) + '%';
}
function date(d) {
  if (!d) return '—';
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  const [y, m, day] = s.slice(0, 10).split('-');
  return `${day} ${MONTHS[Number(m) - 1]} ${y}`;
}
function dateTime(d) {
  if (!d) return '—';
  const x = new Date(d);
  return `${date(x.toISOString())}, ${x.toISOString().slice(11, 16)} UTC`;
}
function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- CSRF ----------
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST') {
    const token = req.body && req.body._csrf;
    if (!token || token.length !== req.session.csrf.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) {
      return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Go back, refresh the page and try again.' });
    }
  }
  next();
}

// ---------- Auth guards ----------
async function loadUser(req, res, next) {
  res.locals.user = null;
  if (req.session.userId) {
    const { rows } = await query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
    const u = rows[0];
    if (!u || u.status === 'closed') {
      req.session.userId = null;
    } else {
      req.user = u;
      res.locals.user = u;
    }
  }
  next();
}
function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.must_change_password && !req.path.startsWith('/account/password')) {
    return res.redirect('/account/password');
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'This area is for administrators only.' });
  if (req.user.must_change_password) return res.redirect('/account/password');
  next();
}

// ---------- Audit ----------
async function audit(req, action, targetUserId, details) {
  try {
    await query(
      'INSERT INTO audit_log (actor_id, actor_email, action, target_user_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user ? req.user.id : null, req.user ? req.user.email : null, action, targetUserId || null,
       details ? JSON.stringify(details) : null, req.ip]
    );
  } catch (e) {
    console.error('audit failed', e.message);
  }
}

// ---------- Validation ----------
function str(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}
function optStr(v, max = 500) {
  const s = str(v, max);
  return s === '' ? null : s;
}
function amount(v) {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  if (!isFinite(n) || n <= 0 || n > 1e13) return null;
  return Math.round(n * 100) / 100;
}
function nonNeg(v) {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  if (!isFinite(n) || n < 0 || n > 1e13) return null;
  return Math.round(n * 100) / 100;
}
function isoDate(v) {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
}
function safeUrl(v) {
  const s = str(v, 1000);
  if (!s) return null;
  if (s.startsWith('/')) return s.startsWith('//') ? null : s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
function oneOf(v, list, fallback) {
  return list.includes(v) ? v : fallback;
}
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}
function flash(req, type, text) {
  req.session.flash = { type, text };
}

module.exports = {
  money, signedMoney, pct, date, dateTime, titleCase,
  csrf, loadUser, requireLogin, requireAdmin, audit,
  str, optStr, amount, nonNeg, isoDate, safeUrl, oneOf, tempPassword, flash,
};
