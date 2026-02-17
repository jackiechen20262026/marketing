import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import mysql from "mysql2/promise";

const host = process.env.DB_HOST || "127.0.0.1";
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER || "root";
const password = process.env.DB_PASS || "";
const database = process.env.DB_NAME || "marketing";
const schemaPath = path.resolve(process.cwd(), "db/schema.sql");

async function main() {
  const sql = await fs.readFile(schemaPath, "utf8");

  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true,
  });

  try {
    console.log(`[db:init] Connected to mysql://${host}:${port} as ${user}`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE \`${database}\``);
    await connection.query(sql);
    console.log(`[db:init] Database '${database}' is ready. Schema applied from db/schema.sql`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error("[db:init] Failed:", error.message);
  process.exit(1);
});
