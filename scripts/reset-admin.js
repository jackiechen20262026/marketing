import mysql from "mysql2/promise";
import bcrypt from "bcrypt";

// 用法：
// 方式1：环境变量
//   set MYSQL_HOST=213.165.83.190
//   set MYSQL_PORT=3306
//   set MYSQL_USER=xxx
//   set MYSQL_PASSWORD=xxx
//   set MYSQL_DATABASE=marketing
//   node scripts/reset-admin.js admin NewPass123456
//
// 方式2：命令行参数（用户名/新密码）
//   node scripts/reset-admin.js admin NewPass123456

const username = (process.argv[2] || "admin").trim();
const newPassword = (process.argv[3] || "Admin123456").trim();

const host = process.env.MYSQL_HOST || "127.0.0.1";
const port = Number(process.env.MYSQL_PORT || 3306);
const user = process.env.MYSQL_USER || "root";
const password = process.env.MYSQL_PASSWORD || "";
const database = process.env.MYSQL_DATABASE || "marketing";

if (!newPassword || newPassword.length < 6) {
  console.error("新密码至少 6 位");
  process.exit(1);
}

const conn = await mysql.createConnection({
  host,
  port,
  user,
  password,
  database,
  namedPlaceholders: true,
});

const hash = await bcrypt.hash(newPassword, 10);

await conn.execute(
  "UPDATE users SET password_hash=:hash, role='admin', status='active' WHERE username=:u",
  { hash, u: username }
);

await conn.end();

console.log(`OK: ${username} password reset -> ${newPassword}`);
process.exit(0);