const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Return NUMERIC as JS numbers and DATE as 'YYYY-MM-DD' strings.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. On Replit, add a PostgreSQL database from the Database tool.');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1|\/tmp|host=\//.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function ensureAdmin() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'");
  if (rows[0].n > 0) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || password.length < 10) {
    console.warn('No admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) in Secrets, then restart.');
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (role, email, password_hash, full_name, status, kyc_status, must_change_password)
     VALUES ('admin', $1, $2, 'Administrator', 'active', 'verified', FALSE)`,
    [email, hash]
  );
  console.log(`Admin account created for ${email}`);
}

module.exports = { pool, query, migrate, ensureAdmin };
