// services/todo.service.js
import { db } from "../db.js";

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPagination({ page, pageSize, total }) {
  const p = Math.max(1, Number(page || 1));
  const ps = Math.min(100, Math.max(10, Number(pageSize || 20)));
  const t = Number(total || 0);
  return {
    page: p,
    pageSize: ps,
    total: t,
    totalPages: Math.max(1, Math.ceil(t / ps)),
  };
}

export const TASK_NAME_MAP = {
  conv_group_due: "建微信群",
  conv_sample_due: "寄样品+填单号",
  conv_deal_due: "推进成交",
  routine_visit_due: "周期拜访",
  routine_wechat_due: "微信沟通（传截图）",
};

export async function listTodos({ ownerUserId, scope, keyword, page, pageSize }) {
  const uid = toFiniteNumber(ownerUserId);
  if (uid == null) throw new Error("ownerUserId 不合法");

  const p = Math.max(1, Number(page || 1));
  const ps = Math.min(100, Math.max(10, Number(pageSize || 20)));
  const offset = (p - 1) * ps;

  // scope: overdue | today | week | all
  let where = " WHERE t.owner_user_id=:uid AND t.status IN ('pending','planned') ";
  const params = { uid };

  if (keyword) {
    where += " AND (l.company_name LIKE :kw OR l.wechat LIKE :kw OR l.phone LIKE :kw OR l.contact_name LIKE :kw) ";
    params.kw = `%${keyword}%`;
  }

  if (scope === "overdue") {
    where += " AND t.due_at < NOW() ";
  } else if (scope === "today") {
    where += " AND DATE(t.due_at) = CURDATE() ";
  } else if (scope === "week") {
    where += " AND DATE(t.due_at) >= CURDATE() AND DATE(t.due_at) <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) ";
  }

  const [[countRow]] = await db.query(
    `
    SELECT COUNT(1) AS cnt
    FROM todo_tasks t
    JOIN leads l ON l.id = t.lead_id
    ${where}
    `,
    params
  );

  const [rows] = await db.query(
    `
    SELECT
      t.*,
      l.company_name,
      l.contact_name,
      l.wechat,
      l.phone,
      l.customer_level,
      l.workflow_stage
    FROM todo_tasks t
    JOIN leads l ON l.id = t.lead_id
    ${where}
    ORDER BY
      (t.due_at < NOW()) DESC,
      t.due_at ASC,
      t.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

export async function markTodoPlanned({ todoId, planId }) {
  const tid = toFiniteNumber(todoId);
  if (tid == null) throw new Error("todoId 不合法");

  await db.query(
    `
    UPDATE todo_tasks
    SET status='planned', plan_id=:plan_id, updated_at=CURRENT_TIMESTAMP
    WHERE id=:id AND status='pending'
    `,
    { id: tid, plan_id: toFiniteNumber(planId) }
  );
}

export async function completeTodo({ todoId, doneFollowupId, evidenceFile, remark }) {
  const tid = toFiniteNumber(todoId);
  if (tid == null) throw new Error("todoId 不合法");

  await db.query(
    `
    UPDATE todo_tasks
    SET status='done',
        done_followup_id=:done_followup_id,
        evidence_file=:evidence_file,
        remark=:remark,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=:id AND status IN ('pending','planned')
    `,
    {
      id: tid,
      done_followup_id: toFiniteNumber(doneFollowupId),
      evidence_file: evidenceFile || null,
      remark: remark || null,
    }
  );
}

export async function skipTodo({ todoId, remark }) {
  const tid = toFiniteNumber(todoId);
  if (tid == null) throw new Error("todoId 不合法");
  await db.query(
    `
    UPDATE todo_tasks
    SET status='skip', remark=:remark, updated_at=CURRENT_TIMESTAMP
    WHERE id=:id AND status IN ('pending','planned')
    `,
    { id: tid, remark: remark || null }
  );
}