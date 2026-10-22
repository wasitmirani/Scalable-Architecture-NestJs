/**
 * Reset a user's password to a known bcrypt hash so login works.
 * Usage: node scripts/reset-user-password.js <email> <newPassword>
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');

(async () => {
  const email = process.argv[2] || 'wasitmirani32@gmail.com';
  const newPassword = process.argv[3] || 'Password123!';

  const c = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'sample_db',
  });

  const hash = await bcrypt.hash(newPassword, 12);
  const [result] = await c.query('UPDATE users SET password = ? WHERE email = ?', [
    hash,
    email,
  ]);

  console.log('Updated rows:', result.affectedRows);
  console.log('Email:', email);
  console.log('New password:', newPassword);
  console.log('Hash prefix:', hash.slice(0, 7));

  // Verify immediately
  const [rows] = await c.query('SELECT password FROM users WHERE email = ? LIMIT 1', [email]);
  const ok = await bcrypt.compare(newPassword, rows[0].password);
  console.log('Verify compare:', ok);

  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
