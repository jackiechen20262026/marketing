#!/usr/bin/env node
/**
 * scripts/migrate_users_password_hash.js
 *
 * ✅ 批量把 users.password_hash 里的“明文/非 bcrypt”升级为 bcrypt
 * ✅ 复用项目的 db.js getPool()
 * ✅ 支持 dry-run / 指定用户 / 仅启用用户
 *
 * 用法：
 *   node scripts/migrate_users_password_hash.js
 *   node scripts/migrate_users_password_hash.js --dry-run
 *   node scripts/migrate_users_password_hash.js --ids=2,3
 *   node scripts/migrate_users_password_hash.js --only-active
 */

import bcrypt from "bcryptjs";
import { getPool } from "../db.js";

// -------------------- 参数解析 --------------------

function parseArgs(argv) {
  const out = {
    dryRun: false,
    ids: null,
    onlyActive: false,
    limit: 200,
  };

  for (const a of argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--only-active") out.onlyActive = true;
    else if (a.startsWith("--ids=")) {
      const list = a
        .split("=")[1]
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      out.ids = list.length ? list : [];
    } else if (a.startsWith("--limit=")) {
      const n = Number(a.split("=")[1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.min(n, 2000);
    }
  }

  return out;
}

const args = parseArgs(process.argv);

// -------------------- 工具函数 --------------------

function isBcryptHash(s) {
  const v = String(s || "");
  return /^\$2[aby]\$\d{2}\$/.test(v) && v.length >= 50;
}

function mask(s) {
  const v = String(s || "");
  if (!v) return "";
  if (v.length <= 4) return "*".repeat(v.length);
  return v.slice(0, 2) + "*".repeat(Math.min(12, v.length - 4)) + v.slice(-2);
}

async function tableHasColumn(conn, table, col) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
  return rows.some((r) => String(r.Field) === col);
}

// -------------------- 主逻辑 --------------------

async function main() {
  console.log("=== users.password_hash bcrypt migration ===");
  console.log("Args:", args);

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const hasLegacyCol = await tableHasColumn(conn, "users", "password_hash_legacy");

    let where = ["password_hash IS NOT NULL", "TRIM(password_hash) <> ''"];
    let params = [];

    if (args.onlyActive) {
      where.push("is_active=1");
    }

    if (args.ids !== null) {
      if (args.ids.length === 0) {
        console.log("No valid ids provided.");
        return;
      }
      where.push(`id IN (${args.ids.map(() => "?").join(",")})`);
      params.push(...args.ids);
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const [[cntRow]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM users ${whereSql}`,
      params
    );

    console.log("Total candidate rows:", cntRow.cnt);

    let lastId = 0;
    let processed = 0;
    let upgraded = 0;
    let skipped = 0;
    let failed = 0;

    while (true) {
      const [rows] = await conn.query(
        `
        SELECT id, username, password_hash
          FROM users
         ${whereSql ? whereSql + " AND" : "WHERE"}
           id > ?
         ORDER BY id ASC
         LIMIT ?
        `,
        [...params, lastId, args.limit]
      );

      if (!rows.length) break;

      for (const r of rows) {
        processed++;
        lastId = r.id;

        const id = r.id;
        const username = r.username;
        const ph = String(r.password_hash || "");

        if (!ph.trim()) {
          skipped++;
          continue;
        }

        if (isBcryptHash(ph)) {
          skipped++;
          continue;
        }

        try {
          const newHash = await bcrypt.hash(ph, 10);

          if (args.dryRun) {
            console.log(`[DRY] upgrade id=${id} user=${username} from=${mask(ph)}`);
          } else {
            await conn.beginTransaction();

            if (hasLegacyCol) {
              await conn.query(
                `UPDATE users 
                   SET password_hash_legacy=?, password_hash=?, updated_at=CURRENT_TIMESTAMP
                 WHERE id=? LIMIT 1`,
                [ph, newHash, id]
              );
            } else {
              await conn.query(
                `UPDATE users 
                   SET password_hash=?, updated_at=CURRENT_TIMESTAMP
                 WHERE id=? LIMIT 1`,
                [newHash, id]
              );
            }

            await conn.commit();
            console.log(`upgrade OK id=${id} user=${username}`);
          }

          upgraded++;
        } catch (e) {
          failed++;
          try {
            await conn.rollback();
          } catch {}
          console.error(`upgrade FAIL id=${id}`, e.message);
        }
      }

      console.log(
        `progress: processed=${processed}, upgraded=${upgraded}, skipped=${skipped}, failed=${failed}`
      );
    }

    console.log("=== DONE ===");
    console.log({
      processed,
      upgraded,
      skipped,
      failed,
      dryRun: args.dryRun,
    });
  } finally {
    conn.release();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});