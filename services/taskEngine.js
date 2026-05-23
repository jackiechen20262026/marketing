// services/taskEngine.js
import { db } from "../db.js";

const VISIT_INTERVAL_BY_LEVEL = {
  A: 21, // 高价值
  B: 45, // 平常
  C: 90, // 待开发
  D: 90,
};

const GROUP_INTERVAL_DAYS = 7;  // 加微信 -> 建群
const WECHAT_INTERVAL_DAYS = 7; // 阶段1微信周更

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function addDays(d, days) {
  const t = new Date(d);
  t.setDate(t.getDate() + Number(days || 0));
  return t;
}

async function hasOpenTask(leadId, taskType) {
  const [[r]] = await db.query(
    `SELECT COUNT(1) AS cnt
     FROM todo_tasks
     WHERE lead_id=:lead_id AND task_type=:task_type AND status IN ('pending','planned')`,
    { lead_id: leadId, task_type: taskType }
  );
  return Number(r?.cnt || 0) > 0;
}

async function createTask({ leadId, ownerUserId, taskType, dueAt }) {
  await db.query(
    `INSERT INTO todo_tasks (lead_id, owner_user_id, task_type, due_at, status)
     VALUES (:lead_id, :owner_user_id, :task_type, :due_at, 'pending')`,
    {
      lead_id: leadId,
      owner_user_id: ownerUserId,
      task_type: taskType,
      due_at: dueAt,
    }
  );
}

async function getLastVisitAt(leadId) {
  // visit_checked_in_at 存在代表拜访
  const [[r]] = await db.query(
    `SELECT MAX(visit_checked_in_at) AS last_visit_at
     FROM lead_followups
     WHERE lead_id=:lead_id AND visit_checked_in_at IS NOT NULL`,
    { lead_id: leadId }
  );
  return r?.last_visit_at ? new Date(r.last_visit_at) : null;
}

async function getLastWechatAt(leadId) {
  const [[r]] = await db.query(
    `SELECT MAX(created_at) AS last_wechat_at
     FROM lead_followups
     WHERE lead_id=:lead_id AND followup_type='wechat'`,
    { lead_id: leadId }
  );
  return r?.last_wechat_at ? new Date(r.last_wechat_at) : null;
}

/**
 * 阶段1定义（与你当前数据结构对齐，先用可执行的口径）：
 * - 有微信（需求客人）且未建群（wechat_group_code 为空） => 阶段1
 */
function isStage1Lead(lead) {
  const wechatOk = !!(lead.wechat && String(lead.wechat).trim());
  const hasGroup = !!(lead.wechat_group_code && String(lead.wechat_group_code).trim());
  return wechatOk && !hasGroup;
}

export async function refreshLeadTasks(lead) {
  if (!lead?.id) return;
  const leadId = toFiniteNumber(lead.id);
  if (leadId == null) return;

  const ownerUserId = toFiniteNumber(lead.owner_id);
  if (ownerUserId == null) return; // 没负责人就不生成（避免脏数据）

  // ---------- 1) 转化：建群到期（有微信但没群） ----------
  const wechatOk = !!(lead.wechat && String(lead.wechat).trim());
  const hasGroup = !!(lead.wechat_group_code && String(lead.wechat_group_code).trim());
  if (wechatOk && !hasGroup) {
    const due = addDays(lead.created_at ? new Date(lead.created_at) : new Date(), GROUP_INTERVAL_DAYS);
    if (!(await hasOpenTask(leadId, "conv_group_due"))) {
      await createTask({ leadId, ownerUserId, taskType: "conv_group_due", dueAt: due });
    }
  }

  // ---------- 2) 维护：周期拜访 ----------
  const level = String(lead.customer_level || "C").trim().toUpperCase();
  const interval = VISIT_INTERVAL_BY_LEVEL[level] || 90;
  const lastVisitAt = await getLastVisitAt(leadId);
  const base = lastVisitAt || (lead.created_at ? new Date(lead.created_at) : new Date());
  const dueVisit = addDays(base, interval);

  if (!(await hasOpenTask(leadId, "routine_visit_due"))) {
    await createTask({ leadId, ownerUserId, taskType: "routine_visit_due", dueAt: dueVisit });
  }

  // ---------- 3) 阶段1微信：每周必须有微信跟进（需要截图） ----------
  if (isStage1Lead(lead)) {
    const lastWechatAt = await getLastWechatAt(leadId);
    const baseWechat = lastWechatAt || (lead.created_at ? new Date(lead.created_at) : new Date());
    const dueWechat = addDays(baseWechat, WECHAT_INTERVAL_DAYS);

    if (!(await hasOpenTask(leadId, "routine_wechat_due"))) {
      await createTask({ leadId, ownerUserId, taskType: "routine_wechat_due", dueAt: dueWechat });
    }
  }
}

/**
 * 批量刷新（用于列表页：一次性刷新当前页 leads）
 */
export async function refreshLeadsTasks(leads) {
  if (!Array.isArray(leads) || !leads.length) return;
  // 串行最稳（你们量不大）；后续可并发优化
  for (const lead of leads) {
    await refreshLeadTasks(lead);
  }
}