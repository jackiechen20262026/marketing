import { db } from "../db.js";
export async function currentUser(id, conn = db) {
  const [[u]] = await conn.query(
    "SELECT id,role,status FROM users WHERE id=?",
    [id],
  );
  if (!u || !u.status)
    throw Object.assign(Error("登录已失效"), { status: 403 });
  return u;
}
export async function assertLead(user, id, conn = db, lock = false) {
  const u = await currentUser(user?.id, conn);
  const [[lead]] = await conn.query(
    "SELECT * FROM leads WHERE id=?" + (lock ? " FOR UPDATE" : ""),
    [id],
  );
  if (!lead || (u.role !== "Admin" && String(lead.owner_id) !== String(u.id)))
    throw Object.assign(Error("无客户访问权限"), { status: 403 });
  return lead;
}
export async function audit(
  conn,
  { leadId, userId, action, reason, before, after },
) {
  await conn.query(
    "INSERT INTO marketing_audit(lead_id,user_id,action,reason,before_json,after_json) VALUES(?,?,?,?,?,?)",
    [
      leadId || null,
      userId || null,
      action,
      reason || null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ],
  );
}
