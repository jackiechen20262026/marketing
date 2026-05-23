// services/user.service.js
import bcrypt from "bcrypt";
import { db } from "../db.js";

function s(v) {
  return String(v == null ? "" : v).trim();
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// session/UI：把 DB 的 Admin/User 归一到 admin/user
function normalizeRole(role) {
  const r = String(role || "").trim();
  return r === "Admin" ? "admin" : "user";
}

// session/UI：把 DB 的 1/0 归一到 active/disabled
function normalizeStatus(status) {
  return Number(status) === 1 ? "active" : "disabled";
}

// UI -> DB
function roleToDb(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "admin" ? "Admin" : "User";
}
function statusToDb(status) {
  const st = String(status || "").trim().toLowerCase();
  return st === "disabled" ? 0 : 1;
}

export async function getUserById(id) {
  const n = toFiniteNumber(id);
  if (n == null) return null;

  const [rows] = await db.query(
    `SELECT id, username, name, role, status, created_at, updated_at
     FROM users WHERE id=:id`,
    { id: n }
  );
  return rows[0] || null;
}

export async function getUserByUsername(username) {
  const u = s(username);
  if (!u) return null;

  const [rows] = await db.query(
    `SELECT id, username, name, password_hash, role, status, created_at, updated_at
     FROM users WHERE username=:username`,
    { username: u }
  );
  return rows[0] || null;
}

// 登录验证
export async function verifyLogin(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return null;

  if (Number(user.status) !== 1) return null;

  const ok = await bcrypt.compare(String(password || ""), String(user.password_hash || ""));
  if (!ok) return null;

  return {
    id: user.id,
    username: user.username,
    name: user.name || user.username,
    role: normalizeRole(user.role),       // admin | user
    status: normalizeStatus(user.status), // active | disabled
  };
}

// 用户列表：搜索/筛选/分页
export async function listUsers({ keyword, role, status, page, pageSize }) {
  const p = Math.max(1, Number(page || 1));
  const ps = Math.min(100, Math.max(10, Number(pageSize || 20)));
  const offset = (p - 1) * ps;

  let where = " WHERE 1=1 ";
  const params = {};

  const kw = s(keyword);
  if (kw) {
    where += " AND (username LIKE :kw OR name LIKE :kw) ";
    params.kw = `%${kw}%`;
  }

  const r = s(role).toLowerCase(); // admin/user
  if (r === "admin" || r === "user") {
    where += " AND role=:role ";
    params.role = roleToDb(r); // Admin/User
  }

  const st = s(status).toLowerCase(); // active/disabled
  if (st === "active") where += " AND status=1 ";
  else if (st === "disabled") where += " AND status=0 ";

  const [[countRow]] = await db.query(`SELECT COUNT(1) AS cnt FROM users ${where}`, params);

  const [rows] = await db.query(
    `SELECT id, username, name, role, status, created_at, updated_at
     FROM users ${where}
     ORDER BY id DESC
     LIMIT ${ps} OFFSET ${offset}`,
    params
  );

  const total = Number(countRow?.cnt || 0);
  return {
    rows,
    pagination: {
      page: p,
      pageSize: ps,
      total,
      totalPages: Math.max(1, Math.ceil(total / ps)),
    },
  };
}

// 创建用户
export async function createUser({ username, name, password, role, status }) {
  const u = s(username);
  if (!u) throw new Error("username 必填");

  const pw = String(password || "");
  if (pw.length < 6) throw new Error("密码至少 6 位");

  const nm = s(name) || null;
  const rl = roleToDb(role);      // Admin/User
  const st = statusToDb(status);  // 1/0

  const hash = await bcrypt.hash(pw, 10);

  try {
    const [ret] = await db.query(
      `INSERT INTO users (username, name, password_hash, role, status)
       VALUES (:username,:name,:password_hash,:role,:status)`,
      { username: u, name: nm, password_hash: hash, role: rl, status: st }
    );
    return ret.insertId;
  } catch (e) {
    if (e?.code === "ER_DUP_ENTRY") throw new Error("username 已存在");
    throw e;
  }
}

// 修改用户
export async function updateUser(id, { name, role, status }) {
  const n = toFiniteNumber(id);
  if (n == null) throw new Error("id 不合法");

  const nm = s(name) || null;
  const rl = roleToDb(role);
  const st = statusToDb(status);

  await db.query(
    `UPDATE users SET name=:name, role=:role, status=:status WHERE id=:id`,
    { id: n, name: nm, role: rl, status: st }
  );
}

// 重置密码
export async function resetPassword(id, newPassword) {
  const n = toFiniteNumber(id);
  if (n == null) throw new Error("id 不合法");

  const pw = String(newPassword || "");
  if (pw.length < 6) throw new Error("密码至少 6 位");

  const hash = await bcrypt.hash(pw, 10);
  await db.query(`UPDATE users SET password_hash=:hash WHERE id=:id`, { id: n, hash });
}

// ✅ 一键切换启用/停用
export async function toggleUserStatus(id) {
  const n = toFiniteNumber(id);
  if (n == null) throw new Error("id 不合法");

  const [rows] = await db.query(`SELECT id, status FROM users WHERE id=:id`, { id: n });
  const u = rows[0];
  if (!u) throw new Error("用户不存在");

  const next = Number(u.status) === 1 ? 0 : 1;
  await db.query(`UPDATE users SET status=:status WHERE id=:id`, { id: n, status: next });
}