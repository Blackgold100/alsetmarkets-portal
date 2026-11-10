// Live support chat: a JSON API polled by the client widget and the admin inbox.
// Polling (every few seconds) works on every Replit deployment type, including Autoscale
// with several instances, because all state lives in PostgreSQL.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const h = require('../helpers');
const { summarize } = require('../metrics');
const { inPlansValue } = require('../plans');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const MAX_LEN = 2000;
const ONLINE_WINDOW = "INTERVAL '3 minutes'";

const sendLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'You are sending messages too quickly. Please wait a moment.' }),
});

function apiAuth(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    if (req.user.must_change_password) return res.status(403).json({ error: 'Please set a new password first.' });
    if (req.user.role !== role) return res.status(403).json({ error: 'Not allowed.' });
    next();
  };
}
function cleanBody(v) {
  const s = String(v ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s.slice(0, MAX_LEN);
}
function afterId(req) {
  const n = Number(req.query.after);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
function shape(m) {
  return {
    id: m.id, role: m.sender_role, body: m.body, at: m.created_at,
    name: m.sender_role === 'admin' ? (m.sender_name || 'Support').split(/\s+/)[0] : m.sender_role === 'client' ? m.sender_name : null,
    read: !!m.read_at,
  };
}
async function supportOnline() {
  const { rows } = await query(`SELECT EXISTS (SELECT 1 FROM users WHERE role='admin' AND last_seen_at > NOW() - ${ONLINE_WINDOW}) AS on`);
  return rows[0].on;
}
async function messagesFor(threadId, after, limit = 200) {
  const { rows } = await query(
    `SELECT m.*, u.full_name AS sender_name FROM chat_messages m LEFT JOIN users u ON u.id=m.sender_id
     WHERE m.thread_id=$1 AND m.id>$2 ORDER BY m.id DESC LIMIT $3`, [threadId, after, limit]);
  return rows.reverse().map(shape);
}

// ===================== Client =====================
const client = express.Router();
client.use(apiAuth('client'));

client.get('/api/messages', wrap(async (req, res) => {
  const { rows: [t] } = await query('SELECT * FROM chat_threads WHERE user_id=$1', [req.user.id]);
  const messages = t ? await messagesFor(t.id, afterId(req)) : [];
  const { rows: [u] } = t
    ? await query("SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_id=$1 AND sender_role<>'client' AND read_at IS NULL", [t.id])
    : { rows: [{ n: 0 }] };
  res.json({ messages, unread: u.n, online: await supportOnline(), status: t ? t.status : 'new' });
}));

client.post('/api/messages', sendLimiter, wrap(async (req, res) => {
  const body = cleanBody(req.body.body);
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  if (req.user.status === 'closed') return res.status(403).json({ error: 'This account is closed.' });
  const { rows: [t] } = await query(
    `INSERT INTO chat_threads (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET status='open', last_message_at=NOW() RETURNING *`, [req.user.id]);
  const { rows: [m] } = await query(
    "INSERT INTO chat_messages (thread_id, sender_id, sender_role, body) VALUES ($1,$2,'client',$3) RETURNING *",
    [t.id, req.user.id, body]);
  await query('UPDATE chat_threads SET last_message_at=NOW() WHERE id=$1', [t.id]);

  // If nobody from support is online, post one automatic note (at most once every 6 hours)
  if (!(await supportOnline())) {
    const { rows: recent } = await query(
      "SELECT 1 FROM chat_messages WHERE thread_id=$1 AND sender_role='system' AND created_at > NOW() - INTERVAL '6 hours'", [t.id]);
    if (!recent.length) {
      await query("INSERT INTO chat_messages (thread_id, sender_role, body) VALUES ($1,'system',$2)", [t.id,
        `Thanks for your message. Our team isn't online right now, but we'll reply here as soon as we're back. You can also email ${req.app.locals.brand.supportEmail}.`]);
    }
  }
  res.json({ message: shape({ ...m, sender_name: req.user.full_name }) });
}));

client.post('/api/read', wrap(async (req, res) => {
  await query(
    `UPDATE chat_messages SET read_at=NOW() WHERE read_at IS NULL AND sender_role<>'client'
     AND thread_id=(SELECT id FROM chat_threads WHERE user_id=$1)`, [req.user.id]);
  res.json({ ok: true });
}));

// ===================== Admin =====================
const admin = express.Router();
// Only whole numbers are conversation ids; anything else falls through to a 404
admin.param('id', (req, res, next, id) => (/^\d{1,9}$/.test(id) ? next() : next('route')));

const THREADS_SQL = `
  SELECT t.*, u.full_name, u.email, u.account_no, u.status AS account_status, u.tier,
         a.full_name AS assigned_name,
         (SELECT COUNT(*)::int FROM chat_messages m WHERE m.thread_id=t.id AND m.sender_role='client' AND m.read_at IS NULL) AS unread,
         (SELECT body FROM chat_messages m WHERE m.thread_id=t.id AND m.sender_role<>'system' ORDER BY m.id DESC LIMIT 1) AS last_body,
         (SELECT sender_role FROM chat_messages m WHERE m.thread_id=t.id AND m.sender_role<>'system' ORDER BY m.id DESC LIMIT 1) AS last_role
  FROM chat_threads t JOIN users u ON u.id=t.user_id LEFT JOIN users a ON a.id=t.assigned_to`;

function threadSummary(t) {
  return {
    id: t.id, status: t.status, unread: t.unread, name: t.full_name, account: t.account_no, tier: t.tier,
    lastBody: t.last_body ? t.last_body.slice(0, 140) : '', lastRole: t.last_role, lastAt: t.last_message_at,
    assigned: t.assigned_name, waiting: t.last_role === 'client' && t.status === 'open',
  };
}
async function listThreads(filter) {
  const where = filter === 'closed' ? "WHERE t.status='closed'" : filter === 'all' ? '' : "WHERE t.status='open'";
  const { rows } = await query(`${THREADS_SQL} ${where} ORDER BY t.last_message_at DESC LIMIT 200`);
  return rows.map(threadSummary);
}
async function touch(req) {
  await query('UPDATE users SET last_seen_at=NOW() WHERE id=$1', [req.user.id]);
}

// Pages
admin.get('/', h.requireAdmin, wrap(async (req, res) => {
  await touch(req);
  const filter = h.oneOf(req.query.filter, ['open', 'closed', 'all'], 'open');
  res.render('admin/chat', { title: 'Support chat', threads: await listThreads(filter), filter, thread: null, adminArea: true });
}));

admin.get('/:id', h.requireAdmin, wrap(async (req, res) => {
  await touch(req);
  const { rows: [t] } = await query(`${THREADS_SQL} WHERE t.id=$1`, [Number(req.params.id)]);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'That conversation does not exist.' });
  const { rows: tx } = await query('SELECT * FROM transactions WHERE user_id=$1', [t.user_id]);
  const { rows: [clientUser] } = await query('SELECT * FROM users WHERE id=$1', [t.user_id]);
  const filter = h.oneOf(req.query.filter, ['open', 'closed', 'all'], 'open');
  res.render('admin/chat', {
    title: `Chat · ${t.full_name}`, threads: await listThreads(filter), filter, adminArea: true,
    thread: threadSummary(t), threadUserId: t.user_id, clientUser, summary: summarize(tx, await inPlansValue(t.user_id)),
    quickReplies: [
      'Thanks for reaching out. Let me look into this for you now.',
      'Your deposit has been received and is being confirmed on the blockchain. It will be credited shortly.',
      'Your withdrawal has been processed. You can see the transaction link on your Withdraw page.',
      'To complete verification, please email a photo ID and a proof of address dated within the last 3 months.',
      'Is there anything else I can help you with today?',
    ],
  });
}));

admin.post('/:id/status', h.requireAdmin, wrap(async (req, res) => {
  const status = h.oneOf(req.body.status, ['open', 'closed'], null);
  const { rows: [t] } = await query('UPDATE chat_threads SET status=COALESCE($1,status) WHERE id=$2 RETURNING *', [status, Number(req.params.id)]);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'That conversation does not exist.' });
  await h.audit(req, status === 'closed' ? 'chat_closed' : 'chat_reopened', t.user_id, { thread: t.id });
  h.flash(req, 'success', status === 'closed' ? 'Conversation closed. It reopens if the client writes again.' : 'Conversation reopened.');
  res.redirect(`/admin/chat/${t.id}`);
}));

admin.post('/:id/assign', h.requireAdmin, wrap(async (req, res) => {
  const { rows: [t] } = await query('UPDATE chat_threads SET assigned_to=$1 WHERE id=$2 RETURNING *', [req.body.unassign ? null : req.user.id, Number(req.params.id)]);
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'That conversation does not exist.' });
  res.redirect(`/admin/chat/${t.id}`);
}));

// JSON API
admin.use('/api', apiAuth('admin'));

admin.get('/api/summary', wrap(async (req, res) => {
  await touch(req);
  const { rows: [r] } = await query(
    `SELECT COUNT(*)::int AS unread, COUNT(DISTINCT m.thread_id)::int AS threads, MAX(m.id) AS latest
     FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
     WHERE m.sender_role='client' AND m.read_at IS NULL`);
  res.json({ unread: r.unread, threads: r.threads, latest: r.latest || 0 });
}));

admin.get('/api/threads', wrap(async (req, res) => {
  await touch(req);
  res.json({ threads: await listThreads(h.oneOf(req.query.filter, ['open', 'closed', 'all'], 'open')) });
}));

admin.get('/api/threads/:id/messages', wrap(async (req, res) => {
  await touch(req);
  const id = Number(req.params.id);
  const { rows: [t] } = await query('SELECT id, status FROM chat_threads WHERE id=$1', [id]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json({ messages: await messagesFor(id, afterId(req)), status: t.status });
}));

admin.post('/api/threads/:id/messages', sendLimiter, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const body = cleanBody(req.body.body);
  if (!body) return res.status(400).json({ error: 'Type a reply first.' });
  const { rows: [t] } = await query(
    "UPDATE chat_threads SET last_message_at=NOW(), status='open', assigned_to=COALESCE(assigned_to,$2) WHERE id=$1 RETURNING *", [id, req.user.id]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { rows: [m] } = await query(
    "INSERT INTO chat_messages (thread_id, sender_id, sender_role, body) VALUES ($1,$2,'admin',$3) RETURNING *", [id, req.user.id, body]);
  // Replying means the admin has read the client's messages
  await query("UPDATE chat_messages SET read_at=NOW() WHERE thread_id=$1 AND sender_role='client' AND read_at IS NULL", [id]);
  await touch(req);
  res.json({ message: shape({ ...m, sender_name: req.user.full_name }) });
}));

admin.post('/api/threads/:id/read', wrap(async (req, res) => {
  await query("UPDATE chat_messages SET read_at=NOW() WHERE thread_id=$1 AND sender_role='client' AND read_at IS NULL", [Number(req.params.id)]);
  res.json({ ok: true });
}));

module.exports = { client, admin };
