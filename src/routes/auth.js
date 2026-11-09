const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const h = require('../helpers');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.', email: '' }),
});

// Dummy hash to keep timing similar when the email doesn't exist
const DUMMY = bcrypt.hashSync('not-a-real-password', 10);

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/');
  res.render('login', { error: null, email: '' });
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = h.str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const generic = 'Incorrect email or password.';
  const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];

  if (!u) {
    await bcrypt.compare(password, DUMMY);
    return res.status(401).render('login', { error: generic, email });
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return res.status(423).render('login', { error: 'This account is temporarily locked after several failed attempts. Try again in 15 minutes or contact support.', email });
  }
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) {
    const fails = u.failed_logins + 1;
    await query('UPDATE users SET failed_logins=$1, locked_until=$2 WHERE id=$3',
      [fails >= 5 ? 0 : fails, fails >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null, u.id]);
    return res.status(401).render('login', { error: generic, email });
  }
  if (u.status === 'closed') {
    return res.status(403).render('login', { error: 'This account is closed. Please contact support.', email });
  }

  await query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=NOW(), last_login_ip=$1 WHERE id=$2', [req.ip, u.id]);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = u.id;
    req.user = u;
    h.audit(req, 'login', u.id);
    if (u.must_change_password) return res.redirect('/account/password');
    res.redirect(u.role === 'admin' ? '/admin' : '/');
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('alset.sid');
    res.redirect('/login');
  });
});

router.get('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('change-password', { error: null, forced: req.user.must_change_password });
});

router.post('/account/password', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { current, next: nextPw, confirm } = req.body;
  const forced = req.user.must_change_password;
  const fail = (error) => res.status(400).render('change-password', { error, forced });

  if (!(await bcrypt.compare(String(current || ''), req.user.password_hash))) return fail('Your current password is incorrect.');
  const pw = String(nextPw || '');
  if (pw.length < 10) return fail('New password must be at least 10 characters.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return fail('New password must include letters and numbers.');
  if (pw !== String(confirm || '')) return fail('The new passwords do not match.');
  if (await bcrypt.compare(pw, req.user.password_hash)) return fail('Choose a password different from your current one.');

  const hash = await bcrypt.hash(pw, 12);
  await query('UPDATE users SET password_hash=$1, must_change_password=FALSE, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
  // Sign out other sessions of this user
  await query("DELETE FROM session WHERE (sess->>'userId')::int = $1 AND sid <> $2", [req.user.id, req.sessionID]).catch(() => {});
  await h.audit(req, 'password_changed', req.user.id);
  h.flash(req, 'success', 'Your password has been updated.');
  res.redirect(req.user.role === 'admin' ? '/admin' : '/');
}));

module.exports = router;
