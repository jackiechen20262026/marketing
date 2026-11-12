import "dotenv/config";
import fs from "node:fs";
import { db } from "../db.js";
// Explicit target guard: never invoked from application startup.
const target = process.argv[2];
if (
  !target ||
  target !== process.env.DB_NAME ||
  !/^marketing(?:_(?:upgrade_restore|restore_final)_\d+)?$/.test(target)
)
  throw Error("Explicit Marketing database name must match DB_NAME");
const c = await db.getConnection();
try {
  const [[lock]] = await c.query(
    "SELECT GET_LOCK('marketing-upgrade-migration',0) ok",
  );
  if (!lock.ok) throw Error("Migration already running");
  const sql = fs.readFileSync(
    new URL("../db/migrations/20261112-marketing.sql", import.meta.url),
    "utf8",
  );
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await c.query(statement);
  console.log("Applied 20261112-marketing to " + target);
} finally {
  await c.query("SELECT RELEASE_LOCK('marketing-upgrade-migration')");
  c.release();
  await db.end();
}
