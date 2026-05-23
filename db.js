// db.js (ESM)
// mysql2/promise pool
import mysql from "mysql2/promise";

const {
  DB_HOST = "127.0.0.1",
  DB_PORT = "3306",
  DB_USER = "root",
  DB_PASSWORD = "",
  DB_NAME = "marketing",
} = process.env;

export const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,

  // allow :named placeholders in queries (as you use in lead.service.js)
  namedPlaceholders: true,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  // BIGINT safety
  supportBigNumbers: true,
  bigNumberStrings: true,
});

// backward-compatible alias
export const db = pool;
