import mysql from "mysql2/promise";
let pool;
export function aiReadPool() {
  if (!process.env.AI_DB_USER || !process.env.AI_DB_PASSWORD)
    throw Error("AI_READONLY_DB_NOT_CONFIGURED");
  return (pool ||= mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.AI_DB_USER,
    password: process.env.AI_DB_PASSWORD,
    connectionLimit: 3,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  }));
}
export async function closeAiReadPool() {
  if (pool) await pool.end();
}
