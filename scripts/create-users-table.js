const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'sample_db',
    multipleStatements: true,
  });

  const sqlPath = path.join(__dirname, '..', 'src', 'database', 'schema', 'users.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  await connection.query(sql);
  const [rows] = await connection.query("SHOW TABLES LIKE 'users'");
  console.log('users table ready:', rows);
  await connection.end();
})().catch((err) => {
  console.error('Failed to create users table:', err.message);
  process.exit(1);
});
