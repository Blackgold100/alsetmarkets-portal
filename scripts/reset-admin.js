// Reset an administrator's password from the Replit Shell:
//   node scripts/reset-admin.js admin@alsetmarkets.com
// Prints a new temporary password; the admin must change it at next sign-in.
require('../src/env');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { tempPassword } = require('../src/helpers');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) { console.error('Usage: node scripts/reset-admin.js <admin email>'); process.exit(1); }
  const pw = tempPassword();
  const { rowCount } = await pool.query(
    "UPDATE users SET password_hash=$1, must_change_password=TRUE, failed_logins=0, locked_until=NULL WHERE email=$2 AND role='admin'",
    [await bcrypt.hash(pw, 12), email]);
  if (!rowCount) console.error(`No administrator with email ${email}.`);
  else console.log(`Temporary password for ${email}: ${pw}\nSign in and set a new password straight away.`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
