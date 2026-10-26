const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "db_idsecours",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: ["DATE"],
  timezone: "Z",
  charset: "utf8mb4"
});

/* q("SELECT ... WHERE id = ?", [id]) → rows ; one(...) → première ligne ou null */
const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] || null;

/* transaction : await tx(async c => { await c.query(...) }) */
async function tx(fn) {
  const c = await pool.getConnection();
  try { await c.beginTransaction(); const r = await fn(c); await c.commit(); return r; }
  catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
}

module.exports = { pool, q, one, tx };
