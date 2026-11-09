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

// First-run admin login, used only when ADMIN_PASSWORD is not set in Secrets.
// It must be changed at first sign-in, and it can't be chosen again afterwards.
const DEFAULT_ADMIN_EMAIL = 'admin@alsetmarkets.com';
const DEFAULT_ADMIN_PASSWORD = 'AlsetAdmin@2026';

async function ensureAdmin() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'");
  if (rows[0].n > 0) return;
  const email = (process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
  const usingDefault = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  if (password.length < 10) {
    console.warn('ADMIN_PASSWORD must be at least 10 characters. Fix it in Secrets, then restart.');
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  // The default password must be replaced at first sign-in; a password from Secrets can be kept.
  await pool.query(
    `INSERT INTO users (role, email, password_hash, full_name, status, kyc_status, must_change_password)
     VALUES ('admin', $1, $2, 'Administrator', 'active', 'verified', $3)`,
    [email, hash, usingDefault]
  );
  if (usingDefault) {
    console.warn(`Admin account created for ${email} with the DEFAULT password (see ADMIN-LOGIN.md). Sign in now and change it.`);
  } else {
    console.log(`Admin account created for ${email}`);
  }
}

module.exports = { pool, query, migrate, ensureAdmin, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD };
