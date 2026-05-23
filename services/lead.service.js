import { db } from "../db.js";

const STAGES = ["已导入", "已联系", "已报价", "已成交", "已关闭"];
const LEVELS = ["A", "B", "C", "D"];

// ✅ 统一分页白名单：批次创建页要的 50/100/200/400/500
const ALLOWED_PAGE_SIZES = [50, 100, 200, 400, 500];
const DEFAULT_PAGE_SIZE = 50;

function normalizeEmpty(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function friendlyDupError(err) {
  const msg = String(err?.message || "");
  if (err?.code === "ER_DUP_ENTRY") {
    if (msg.includes("uk_leads_vat_no_norm")) return "德国 VAT 已存在（不允许重复）";
    if (msg.includes("uk_leads_unified_code_norm")) return "统一社会信用代码已存在（不允许重复）";
    return "唯一字段重复（VAT 或 统一社会信用代码）";
  }
  return null;
}

function normalizePagination({ page, pageSize }) {
  let p = Number(page || 1);
  if (!Number.isFinite(p) || p < 1) p = 1;

  let ps = Number(pageSize || DEFAULT_PAGE_SIZE);
  ps = ALLOWED_PAGE_SIZES.includes(ps) ? ps : DEFAULT_PAGE_SIZE;

  return { p, ps };
}

function buildPagination({ page, pageSize, total }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const t = Number(total || 0);

  return {
    page: p,
    pageSize: ps,
    total: t,
    totalPages: Math.max(1, Math.ceil(t / ps)),
  };
}

/**
 * ✅ 线索列表附带统计（发信/拜访/跟进）
 * 方案1：发信统计只要进入过批次就算，不再限制 campaign_batch_items.status='ready'
 */
function leadStatsJoinsSql() {
  return `
    LEFT JOIN (
      SELECT
        lead_id,
        COUNT(*) AS followup_count,
        SUM(CASE WHEN visit_checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS visit_count
      FROM lead_followups
      GROUP BY lead_id
    ) f ON f.lead_id = l.id

    LEFT JOIN (
      SELECT
        lead_id,
        COUNT(DISTINCT batch_id) AS mail_count
      FROM campaign_batch_items
      GROUP BY lead_id
    ) m ON m.lead_id = l.id
  `;
}

/**
 * ✅ 下一步任务（next_task_*）
 */
function leadNextTaskJoinSql() {
  return `
    LEFT JOIN (
      SELECT
        x.lead_id,
        x.min_due AS due_at,
        GROUP_CONCAT(DISTINCT t.task_type ORDER BY t.task_type SEPARATOR ',') AS task_types
      FROM (
        SELECT lead_id, MIN(due_at) AS min_due
        FROM todo_tasks
        WHERE status IN ('pending','planned')
        GROUP BY lead_id
      ) x
      JOIN todo_tasks t
        ON t.lead_id = x.lead_id
       AND t.due_at = x.min_due
       AND t.status IN ('pending','planned')
      GROUP BY x.lead_id, x.min_due
    ) nt ON nt.lead_id = l.id
  `;
}

/**
 * ✅ 每个 lead 最近一次“成功发货”的 shipment
 * 成功发货定义：waybill_no IS NOT NULL AND TRIM(waybill_no) <> ''
 */
function latestSuccessShipmentJoinSql(leadAlias = "l", shipAlias = "ls") {
  return `
    LEFT JOIN (
      SELECT s1.*
      FROM shipments s1
      INNER JOIN (
        SELECT lead_id, MAX(id) AS max_id
        FROM shipments
        WHERE waybill_no IS NOT NULL
          AND TRIM(waybill_no) <> ''
        GROUP BY lead_id
      ) z
        ON z.max_id = s1.id
    ) ${shipAlias} ON ${shipAlias}.lead_id = ${leadAlias}.id
  `;
}

/**
 * ✅ 批次创建规则 SQL（最终版）
 *
 * 规则：
 * 1) 已成交不显示
 * 2) 无群客户：30天内已成功发货 -> 不显示
 * 3) 有群客户：90天内已成功发货 -> 不显示
 * 4) 最近一次成功发货 logistics_status='EXCEPTION' -> 不显示（去轨迹页处理）
 */
function buildBatchCandidateWhere({ keyword, stage, level, ids, alias = "l", shipAlias = "ls" }) {
  let where = `
    WHERE ${alias}.is_active = 1
      AND COALESCE(${alias}.is_closed, 0) = 0
      AND ${alias}.workflow_stage <> '已成交'
      AND (
        ${shipAlias}.id IS NULL
        OR (
          COALESCE(${shipAlias}.logistics_status, '') <> 'EXCEPTION'
          AND ${shipAlias}.created_at < DATE_SUB(
            NOW(),
            INTERVAL CASE
              WHEN ${alias}.wechat_group_code IS NOT NULL
               AND TRIM(${alias}.wechat_group_code) <> ''
              THEN 90
              ELSE 30
            END DAY
          )
        )
      )
  `;

  const params = {};

  if (keyword) {
    where += `
      AND (
        ${alias}.company_name LIKE :kw
        OR ${alias}.contact_name LIKE :kw
        OR ${alias}.receiver_name LIKE :kw
        OR ${alias}.receiver_mobile LIKE :kw
        OR ${alias}.phone LIKE :kw
        OR ${alias}.wechat LIKE :kw
        OR ${alias}.wechat_group_code LIKE :kw
        OR ${alias}.vat_no LIKE :kw
        OR ${alias}.unified_code LIKE :kw
        OR ${alias}.category LIKE :kw
        OR ${alias}.brand LIKE :kw
      )
    `;
    params.kw = `%${keyword}%`;
  }

  if (stage && STAGES.includes(stage)) {
    where += ` AND ${alias}.workflow_stage = :stage `;
    params.stage = stage;
  }

  if (level && LEVELS.includes(level)) {
    where += ` AND ${alias}.customer_level = :level `;
    params.level = level;
  }

  if (Array.isArray(ids) && ids.length) {
    const validIds = ids.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (validIds.length) {
      where += ` AND ${alias}.id IN (${validIds.map((_, i) => `:id_${i}`).join(",")}) `;
      validIds.forEach((id, i) => {
        params[`id_${i}`] = id;
      });
    } else {
      where += ` AND 1=0 `;
    }
  }

  return { where, params };
}

// -----------------------
// ✅ 关闭/恢复线索
// -----------------------
export async function closeLead({ id, userId, reason }) {
  const n = toFiniteNumber(id);
  if (n == null) throw new Error("id 不合法");

  await db.query(
    `
    UPDATE leads
    SET is_closed=1,
        closed_at=NOW(),
        closed_reason=:reason,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=:id AND is_active=1
    `,
    { id: n, reason: reason || null }
  );
}

export async function reopenLead({ id, userId, reason }) {
  const n = toFiniteNumber(id);
  if (n == null) throw new Error("id 不合法");

  await db.query(
    `
    UPDATE leads
    SET is_closed=0,
        closed_at=NULL,
        closed_reason=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=:id AND is_active=1
    `,
    { id: n }
  );
}

// -----------------------
// ✅ 列表：线索池
// -----------------------
export async function listLeads({ keyword, stage, level, showClosed, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  let where = " WHERE l.is_active=1 ";
  const params = {};

  if (!showClosed) where += " AND COALESCE(l.is_closed,0)=0 ";

  if (keyword) {
    where +=
      " AND (" +
      " l.company_name LIKE :kw" +
      " OR l.receiver_name LIKE :kw" +
      " OR l.receiver_mobile LIKE :kw" +
      " OR l.phone LIKE :kw" +
      " OR l.vat_no LIKE :kw" +
      " OR l.unified_code LIKE :kw" +
      " OR l.category LIKE :kw" +
      " ) ";
    params.kw = `%${keyword}%`;
  }
  if (stage && STAGES.includes(stage)) {
    where += " AND l.workflow_stage = :stage ";
    params.stage = stage;
  }
  if (level && LEVELS.includes(level)) {
    where += " AND l.customer_level = :level ";
    params.level = level;
  }

  const [[countRow]] = await db.query(`SELECT COUNT(1) AS cnt FROM leads l ${where}`, params);

  const [rows] = await db.query(
    `
    SELECT
      l.*,
      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count
    FROM leads l
    ${leadStatsJoinsSql()}
    ${where}
    ORDER BY l.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

// -----------------------
// ✅ 列表：批次创建候选池（新）
// -----------------------
export async function listBatchCandidates({ keyword, stage, level, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  const { where, params } = buildBatchCandidateWhere({
    keyword,
    stage,
    level,
    alias: "l",
    shipAlias: "ls",
  });

  const joins = `
    ${leadStatsJoinsSql()}
    ${latestSuccessShipmentJoinSql("l", "ls")}
  `;

  const [[countRow]] = await db.query(
    `
    SELECT COUNT(1) AS cnt
    FROM leads l
    ${joins}
    ${where}
    `,
    params
  );

  const [rows] = await db.query(
    `
    SELECT
      l.*,
      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count,

      ls.id AS last_success_shipment_id,
      ls.waybill_no AS last_success_waybill_no,
      ls.logistics_status AS last_success_logistics_status,
      ls.created_at AS last_success_shipment_at,

      CASE
        WHEN l.wechat_group_code IS NOT NULL AND TRIM(l.wechat_group_code) <> '' THEN 90
        ELSE 30
      END AS batch_cycle_days
    FROM leads l
    ${joins}
    ${where}
    ORDER BY l.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

// -----------------------
// ✅ 创建批次前二次校验（新）
// -----------------------
export async function filterLeadIdsForBatchCreation({ leadIds }) {
  const ids = (leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!ids.length) {
    return { eligibleIds: [], blockedIds: [] };
  }

  const { where, params } = buildBatchCandidateWhere({
    ids,
    alias: "l",
    shipAlias: "ls",
  });

  const joins = `
    ${latestSuccessShipmentJoinSql("l", "ls")}
  `;

  const [rows] = await db.query(
    `
    SELECT
      l.id,
      l.company_name,
      l.workflow_stage,
      l.wechat_group_code,
      ls.waybill_no AS last_success_waybill_no,
      ls.logistics_status AS last_success_logistics_status,
      ls.created_at AS last_success_shipment_at
    FROM leads l
    ${joins}
    ${where}
    ORDER BY l.id DESC
    `,
    params
  );

  const eligibleIds = (rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  const eligibleSet = new Set(eligibleIds);
  const blockedIds = ids.filter((id) => !eligibleSet.has(id));

  return {
    eligibleIds,
    blockedIds,
    rows,
  };
}

// -----------------------
// ✅ 列表：需求客人（阶段1：有微信 & 未建群）
// -----------------------
export async function listDemandLeads({ keyword, showClosed, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  let where = `
    WHERE l.is_active=1
      AND l.wechat IS NOT NULL AND TRIM(l.wechat) <> ''
      AND (l.wechat_group_code IS NULL OR TRIM(l.wechat_group_code) = '')
  `;
  const params = {};

  if (!showClosed) where += " AND COALESCE(l.is_closed,0)=0 ";

  if (keyword) {
    where +=
      " AND (" +
      " l.company_name LIKE :kw" +
      " OR l.contact_name LIKE :kw" +
      " OR l.wechat LIKE :kw" +
      " OR l.phone LIKE :kw" +
      " OR l.vat_no LIKE :kw" +
      " OR l.unified_code LIKE :kw" +
      " OR l.category LIKE :kw" +
      " ) ";
    params.kw = `%${keyword}%`;
  }

  const [[countRow]] = await db.query(`SELECT COUNT(1) AS cnt FROM leads l ${where}`, params);

  const [rows] = await db.query(
    `
    SELECT
      l.id, l.owner_id,
      l.company_name, l.contact_name, l.wechat, l.phone,
      l.category,
      l.wechat_group_code,
      l.workflow_stage, l.customer_level, l.priority, l.source,
      l.sample_tracking_no,
      l.is_closed, l.closed_at, l.closed_reason,
      l.created_at, l.updated_at,

      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count,

      nt.task_types AS next_task_types,
      nt.due_at AS next_task_due_at
    FROM leads l
    ${leadStatsJoinsSql()}
    ${leadNextTaskJoinSql()}
    ${where}
    ORDER BY l.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

// -----------------------
// ✅ 列表：合作意向（阶段2：已建群 + 未寄样品）
// -----------------------
export async function listPartnerIntentLeads({ keyword, showClosed, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  let where = `
    WHERE l.is_active=1
      AND l.wechat_group_code IS NOT NULL AND TRIM(l.wechat_group_code) <> ''
      AND (l.sample_tracking_no IS NULL OR TRIM(l.sample_tracking_no) = '')
  `;
  const params = {};

  if (!showClosed) where += " AND COALESCE(l.is_closed,0)=0 ";

  if (keyword) {
    where +=
      " AND (" +
      " l.company_name LIKE :kw" +
      " OR l.contact_name LIKE :kw" +
      " OR l.wechat_group_code LIKE :kw" +
      " OR l.wechat LIKE :kw" +
      " OR l.phone LIKE :kw" +
      " OR l.vat_no LIKE :kw" +
      " OR l.unified_code LIKE :kw" +
      " OR l.category LIKE :kw" +
      " ) ";
    params.kw = `%${keyword}%`;
  }

  const [[countRow]] = await db.query(`SELECT COUNT(1) AS cnt FROM leads l ${where}`, params);

  const [rows] = await db.query(
    `
    SELECT
      l.id, l.owner_id,
      l.company_name, l.contact_name,
      l.category,
      l.wechat_group_code, l.wechat_group_qr,
      l.wechat, l.phone,
      l.workflow_stage, l.customer_level, l.priority, l.source,
      l.sample_tracking_no,
      l.is_closed, l.closed_at, l.closed_reason,
      l.created_at, l.updated_at,

      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count,

      nt.task_types AS next_task_types,
      nt.due_at AS next_task_due_at
    FROM leads l
    ${leadStatsJoinsSql()}
    ${leadNextTaskJoinSql()}
    ${where}
    ORDER BY l.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

// -----------------------
// ✅ 列表：已寄样品（阶段3：有单号 + 未成交）— 也带 next_task
// -----------------------
export async function listSampleSentLeads({ keyword, showClosed, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  let where = `
    WHERE l.is_active=1
      AND l.sample_tracking_no IS NOT NULL AND TRIM(l.sample_tracking_no) <> ''
      AND COALESCE(l.workflow_stage, '') <> '已成交'
  `;
  const params = {};

  if (!showClosed) where += " AND COALESCE(l.is_closed,0)=0 ";

  if (keyword) {
    where +=
      " AND (" +
      " l.company_name LIKE :kw" +
      " OR l.contact_name LIKE :kw" +
      " OR l.wechat LIKE :kw" +
      " OR l.phone LIKE :kw" +
      " OR l.sample_tracking_no LIKE :kw" +
      " OR l.vat_no LIKE :kw" +
      " OR l.unified_code LIKE :kw" +
      " OR l.category LIKE :kw" +
      " ) ";
    params.kw = `%${keyword}%`;
  }

  const [[countRow]] = await db.query(`SELECT COUNT(1) AS cnt FROM leads l ${where}`, params);

  const [rows] = await db.query(
    `
    SELECT
      l.id, l.owner_id,
      l.company_name, l.contact_name, l.wechat, l.phone,
      l.category,
      l.wechat_group_code, l.wechat_group_qr,
      l.workflow_stage, l.customer_level, l.priority, l.source,
      l.sample_tracking_no,
      l.is_closed, l.closed_at, l.closed_reason,
      l.created_at, l.updated_at,

      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count,

      nt.task_types AS next_task_types,
      nt.due_at AS next_task_due_at
    FROM leads l
    ${leadStatsJoinsSql()}
    ${leadNextTaskJoinSql()}
    ${where}
    ORDER BY l.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

// -----------------------
// ✅ 列表：已成交（第4步）
// -----------------------
export async function listDealLeads({ keyword, showClosed, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  let where = `
    WHERE l.is_active=1
      AND COALESCE(l.workflow_stage, '') = '已成交'
  `;
  const params = {};

  if (!showClosed) where += " AND COALESCE(l.is_closed,0)=0 ";

  if (keyword) {
    where +=
      " AND (" +
      " l.company_name LIKE :kw" +
      " OR l.contact_name LIKE :kw" +
      " OR l.wechat LIKE :kw" +
      " OR l.phone LIKE :kw" +
      " OR l.sample_tracking_no LIKE :kw" +
      " OR l.vat_no LIKE :kw" +
      " OR l.unified_code LIKE :kw" +
      " OR l.category LIKE :kw" +
      " ) ";
    params.kw = `%${keyword}%`;
  }

  const [[countRow]] = await db.query(`SELECT COUNT(1) AS cnt FROM leads l ${where}`, params);

  const [rows] = await db.query(
    `
    SELECT
      l.id, l.owner_id,
      l.company_name, l.contact_name, l.wechat, l.phone,
      l.category,
      l.wechat_group_code, l.wechat_group_qr,
      l.workflow_stage, l.customer_level, l.priority, l.source,
      l.sample_tracking_no,
      l.is_closed, l.closed_at, l.closed_reason,
      l.created_at, l.updated_at,

      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count,

      nt.task_types AS next_task_types,
      nt.due_at AS next_task_due_at
    FROM leads l
    ${leadStatsJoinsSql()}
    ${leadNextTaskJoinSql()}
    ${where}
    ORDER BY l.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

export async function getLeadById(id) {
  const n = toFiniteNumber(id);
  if (n == null) return null;
  const [rows] = await db.query("SELECT * FROM leads WHERE id=:id AND is_active=1", { id: n });
  return rows[0] || null;
}

export async function getFollowups(leadId) {
  const lid = toFiniteNumber(leadId);
  if (lid == null) return [];

  const [rows] = await db.query(
    `
    SELECT
      f.*,
      u.username AS created_by_name,
      (SELECT COUNT(1) FROM lead_followup_photos p WHERE p.followup_id = f.id) AS photo_count
    FROM lead_followups f
    LEFT JOIN users u ON u.id = f.created_by
    WHERE f.lead_id=:lead_id
    ORDER BY f.id DESC
    `,
    { lead_id: lid }
  );
  return rows;
}

export async function listAllFollowups({ keyword, type, needAnalysis, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  let where = " WHERE l.is_active=1 ";
  const params = {};

  if (type) {
    where += " AND f.followup_type = :type ";
    params.type = type;
  }
  if (needAnalysis === 0 || needAnalysis === 1) {
    where += " AND f.need_analysis = :need_analysis ";
    params.need_analysis = needAnalysis;
  }
  if (keyword) {
    where +=
      " AND (" +
      " l.company_name LIKE :kw" +
      " OR l.wechat LIKE :kw" +
      " OR l.phone LIKE :kw" +
      " OR f.content LIKE :kw" +
      " ) ";
    params.kw = `%${keyword}%`;
  }

  const [[countRow]] = await db.query(
    `
    SELECT COUNT(1) AS cnt
    FROM lead_followups f
    JOIN leads l ON l.id = f.lead_id
    ${where}
    `,
    params
  );

  const [rows] = await db.query(
    `
    SELECT
      f.id,
      f.lead_id,
      f.followup_type,
      f.content,
      f.need_analysis,
      f.analysis,
      f.visit_lat,
      f.visit_lng,
      f.visit_address,
      f.visit_checked_in_at,
      f.created_at,
      l.company_name,
      u.username AS created_by_name,
      (SELECT COUNT(1) FROM lead_followup_photos p WHERE p.followup_id = f.id) AS photo_count
    FROM lead_followups f
    JOIN leads l ON l.id = f.lead_id
    LEFT JOIN users u ON u.id = f.created_by
    ${where}
    ORDER BY f.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

export async function listAllPlans({ keyword, type, status, dateFrom, dateTo, page, pageSize }) {
  const { p, ps } = normalizePagination({ page, pageSize });
  const offset = (p - 1) * ps;

  let where = " WHERE l.is_active=1 ";
  const params = {};

  if (type) {
    where += " AND p.plan_type = :plan_type ";
    params.plan_type = type;
  }
  if (status) {
    where += " AND p.status = :status ";
    params.status = status;
  }
  if (dateFrom) {
    where += " AND (p.planned_at IS NOT NULL AND DATE(p.planned_at) >= :date_from) ";
    params.date_from = dateFrom;
  }
  if (dateTo) {
    where += " AND (p.planned_at IS NOT NULL AND DATE(p.planned_at) <= :date_to) ";
    params.date_to = dateTo;
  }
  if (keyword) {
    where +=
      " AND (" +
      " l.company_name LIKE :kw" +
      " OR l.wechat LIKE :kw" +
      " OR l.phone LIKE :kw" +
      " OR p.plan_note LIKE :kw" +
      " ) ";
    params.kw = `%${keyword}%`;
  }

  const [[countRow]] = await db.query(
    `
    SELECT COUNT(1) AS cnt
    FROM lead_followup_plans p
    JOIN leads l ON l.id = p.lead_id
    ${where}
    `,
    params
  );

  const [rows] = await db.query(
    `
    SELECT
      p.id,
      p.lead_id,
      p.plan_type,
      p.planned_at,
      p.plan_note,
      p.status,
      p.created_at,
      l.company_name,
      u.username AS created_by_name
    FROM lead_followup_plans p
    JOIN leads l ON l.id = p.lead_id
    LEFT JOIN users u ON u.id = p.created_by
    ${where}
    ORDER BY
      CASE p.status WHEN 'PLANNED' THEN 0 WHEN 'DONE' THEN 1 ELSE 2 END,
      p.planned_at IS NULL,
      p.planned_at ASC,
      p.id DESC
    LIMIT ${ps} OFFSET ${offset}
    `,
    params
  );

  return {
    rows,
    pagination: buildPagination({ page: p, pageSize: ps, total: Number(countRow?.cnt || 0) }),
  };
}

export async function createPlan({ leadId, planType, plannedAt, planNote, userId }) {
  const lid = toFiniteNumber(leadId);
  if (lid == null) throw new Error("leadId 不合法");

  await db.query(
    `
    INSERT INTO lead_followup_plans
      (lead_id, plan_type, planned_at, plan_note, status, created_by)
    VALUES
      (:lead_id, :plan_type, :planned_at, :plan_note, 'PLANNED', :created_by)
    `,
    {
      lead_id: lid,
      plan_type: planType || "other",
      planned_at: plannedAt ? new Date(plannedAt) : null,
      plan_note: planNote || null,
      created_by: toFiniteNumber(userId),
    }
  );
}

export async function listPlansByLeadId(leadId) {
  const lid = toFiniteNumber(leadId);
  if (lid == null) return [];

  const [rows] = await db.query(
    `
    SELECT
      p.*,
      u.username AS created_by_name
    FROM lead_followup_plans p
    LEFT JOIN users u ON u.id = p.created_by
    WHERE p.lead_id = :lead_id
    ORDER BY
      CASE p.status WHEN 'PLANNED' THEN 0 WHEN 'DONE' THEN 1 ELSE 2 END,
      p.planned_at IS NULL,
      p.planned_at ASC,
      p.id DESC
    `,
    { lead_id: lid }
  );
  return rows;
}

export async function countOpenPlansByLeadId(leadId) {
  const lid = toFiniteNumber(leadId);
  if (lid == null) return 0;

  const [[r]] = await db.query(
    `SELECT COUNT(1) AS cnt FROM lead_followup_plans WHERE lead_id=:lead_id AND status='PLANNED'`,
    { lead_id: lid }
  );
  return Number(r?.cnt || 0);
}

export async function addFollowup({ leadId, type, content, nextAt, userId, needAnalysis, analysis }) {
  const lid = toFiniteNumber(leadId);
  if (lid == null) throw new Error("leadId 不合法");

  await db.query(
    `
    INSERT INTO lead_followups
      (lead_id, followup_type, content, analysis, need_analysis, next_followup_at, created_by)
    VALUES
      (:lead_id,:followup_type,:content,:analysis,:need_analysis,:next_followup_at,:created_by)
    `,
    {
      lead_id: lid,
      followup_type: type || "other",
      content: String(content || "").trim(),
      analysis: analysis || null,
      need_analysis: needAnalysis ? 1 : 0,
      next_followup_at: nextAt ? new Date(nextAt) : null,
      created_by: toFiniteNumber(userId),
    }
  );
}

export async function createVisitFollowup({
  leadId,
  content,
  needAnalysis,
  analysis,
  lat,
  lng,
  address,
  userAgent,
  userId,
  photos,
}) {
  const lid = toFiniteNumber(leadId);
  if (lid == null) throw new Error("leadId 不合法");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("定位经纬度不合法");
  if (!photos?.length) throw new Error("必须至少上传 1 张照片");

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [ret] = await conn.query(
      `
      INSERT INTO lead_followups
        (lead_id, followup_type, content, analysis, need_analysis, next_followup_at, created_by,
         visit_lat, visit_lng, visit_address, visit_checked_in_at, visit_device)
      VALUES
        (:lead_id, 'visit', :content, :analysis, :need_analysis, NULL, :created_by,
         :visit_lat, :visit_lng, :visit_address, :visit_checked_in_at, :visit_device)
      `,
      {
        lead_id: lid,
        content: content || "",
        analysis: analysis || null,
        need_analysis: needAnalysis ? 1 : 0,
        created_by: toFiniteNumber(userId),
        visit_lat: lat,
        visit_lng: lng,
        visit_address: address || null,
        visit_checked_in_at: new Date(),
        visit_device: userAgent || null,
      }
    );

    const followupId = ret.insertId;

    for (const f of photos) {
      const rel = `/uploads/followups/${f.filename}`;
      await conn.query(
        `
        INSERT INTO lead_followup_photos
          (followup_id, file_path, original_name, mime_type, file_size)
        VALUES
          (:followup_id, :file_path, :original_name, :mime_type, :file_size)
        `,
        {
          followup_id: followupId,
          file_path: rel,
          original_name: f.originalname || null,
          mime_type: f.mimetype || null,
          file_size: Number(f.size || 0) || null,
        }
      );
    }

    await conn.commit();
    return followupId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ✅ 优先发件：打标记
export async function markLeadPrioritySend({ leadId }) {
  const lid = toFiniteNumber(leadId);
  if (lid == null) throw new Error("leadId 不合法");

  await db.query(
    `
    UPDATE leads
    SET priority_send_flag = 1,
        priority_send_at = NOW(),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = :id
      AND is_active = 1
    `,
    { id: lid }
  );

  return { ok: true, leadId: lid };
}

// ✅ 优先发件：取已标记线索
export async function listPrioritySendLeads() {
  const [rows] = await db.query(
    `
    SELECT
      l.*,
      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count,

      ls.id AS last_success_shipment_id,
      ls.waybill_no AS last_success_waybill_no,
      ls.logistics_status AS last_success_logistics_status,
      ls.created_at AS last_success_shipment_at,

      CASE
        WHEN l.wechat_group_code IS NOT NULL AND TRIM(l.wechat_group_code) <> '' THEN 90
        ELSE 30
      END AS batch_cycle_days
    FROM leads l
    ${leadStatsJoinsSql()}
    ${latestSuccessShipmentJoinSql("l", "ls")}
    WHERE l.is_active = 1
      AND COALESCE(l.is_closed, 0) = 0
      AND COALESCE(l.priority_send_flag, 0) = 1
      AND l.workflow_stage <> '已成交'
    ORDER BY l.priority_send_at DESC, l.id DESC
    `
  );

  return rows || [];
}

// ✅ 优先发件：批次创建后清标记
export async function clearPrioritySendFlagsByLeadIds({ leadIds }) {
  const ids = Array.from(
    new Set((leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)))
  );

  if (!ids.length) return { ok: true, affected: 0 };

  await db.query(
    `
    UPDATE leads
    SET priority_send_flag = 0,
        priority_send_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${ids.map((_, i) => `:id_${i}`).join(",")})
    `,
    ids.reduce((acc, id, i) => {
      acc[`id_${i}`] = id;
      return acc;
    }, {})
  );

  return { ok: true, affected: ids.length };
}

export async function createLead(data, userId) {
  const payload = mapLeadPayload(data);
  payload.owner_id = toFiniteNumber(userId);

  try {
    const [ret] = await db.query(
      `INSERT INTO leads (
        company_name, company_name_en, amazon_company_name,
        unified_code, vat_no,
        wechat, wechat_group_code, wechat_group_qr,
        legal_person, registered_capital, registration_date,
        contact_name, phone, email,
        website, category, amazon_shop_url, company_profile,
        workflow_stage, priority, customer_level,
        source, owner_id,
        is_active,

        receiver_name, receiver_mobile,
        receiver_province, receiver_city, receiver_county, receiver_town,
        receiver_address, receiver_postal_code,
        country,

        brand,
        sample_tracking_no
      ) VALUES (
        :company_name, :company_name_en, :amazon_company_name,
        :unified_code, :vat_no,
        :wechat, :wechat_group_code, :wechat_group_qr,
        :legal_person, :registered_capital, :registration_date,
        :contact_name, :phone, :email,
        :website, :category, :amazon_shop_url, :company_profile,
        :workflow_stage, :priority, :customer_level,
        :source, :owner_id,
        1,

        :receiver_name, :receiver_mobile,
        :receiver_province, :receiver_city, :receiver_county, :receiver_town,
        :receiver_address, :receiver_postal_code,
        'China',

        :brand,
        :sample_tracking_no
      )`,
      payload
    );
    return ret.insertId;
  } catch (err) {
    const f = friendlyDupError(err);
    if (f) throw new Error(f);
    throw err;
  }
}

export async function updateLead(id, data) {
  const n = toFiniteNumber(id);
  if (n == null) throw new Error("id 不合法");

  const payload = mapLeadPayload(data);
  payload.id = n;

  try {
    await db.query(
      `UPDATE leads SET
        company_name=:company_name,
        company_name_en=:company_name_en,
        amazon_company_name=:amazon_company_name,
        unified_code=:unified_code,
        vat_no=:vat_no,
        wechat=:wechat,
        wechat_group_code=:wechat_group_code,
        wechat_group_qr=:wechat_group_qr,
        legal_person=:legal_person,
        registered_capital=:registered_capital,
        registration_date=:registration_date,
        contact_name=:contact_name,
        phone=:phone,
        email=:email,
        website=:website,
        category=:category,
        amazon_shop_url=:amazon_shop_url,
        company_profile=:company_profile,
        workflow_stage=:workflow_stage,
        priority=:priority,
        customer_level=:customer_level,
        source=:source,

        receiver_name=:receiver_name,
        receiver_mobile=:receiver_mobile,
        receiver_province=:receiver_province,
        receiver_city=:receiver_city,
        receiver_county=:receiver_county,
        receiver_town=:receiver_town,
        receiver_address=:receiver_address,
        receiver_postal_code=:receiver_postal_code,

        brand=:brand,
        sample_tracking_no=:sample_tracking_no,

        country='China',
        updated_at=CURRENT_TIMESTAMP
      WHERE id=:id AND is_active=1`,
      payload
    );
  } catch (err) {
    const f = friendlyDupError(err);
    if (f) throw new Error(f);
    throw err;
  }
}

export async function disableLeads(ids) {
  const nums = (ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!nums.length) return;
  await db.query(
    `UPDATE leads SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id IN (${nums
      .map(() => "?")
      .join(",")})`,
    nums
  );
}

export async function changeStageBulk({ ids, toStage, userId, remark }) {
  if (!ids?.length) return;
  if (!STAGES.includes(toStage)) throw new Error("阶段值不合法");

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, workflow_stage FROM leads WHERE is_active=1 AND id IN (${ids
        .map(() => "?")
        .join(",")}) FOR UPDATE`,
      ids
    );

    await conn.query(
      `UPDATE leads SET workflow_stage=? WHERE is_active=1 AND id IN (${ids.map(() => "?").join(",")})`,
      [toStage, ...ids]
    );

    for (const r of rows) {
      await conn.query(
        `INSERT INTO workflow_stage_history (lead_id, from_stage, to_stage, changed_by, remark)
         VALUES (?,?,?,?,?)`,
        [r.id, r.workflow_stage, toStage, toFiniteNumber(userId), remark || null]
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

function mapLeadPayload(data) {
  const stage = normalizeEmpty(data.workflow_stage) || "已导入";
  const priority = normalizeEmpty(data.priority) || "Normal";
  const level = normalizeEmpty(data.customer_level) || "C";

  return {
    company_name: normalizeEmpty(data.company_name) || "",
    company_name_en: normalizeEmpty(data.company_name_en),
    amazon_company_name: normalizeEmpty(data.amazon_company_name),

    unified_code: normalizeEmpty(data.unified_code),
    vat_no: normalizeEmpty(data.vat_no),

    wechat: normalizeEmpty(data.wechat),
    wechat_group_code: normalizeEmpty(data.wechat_group_code),
    wechat_group_qr: normalizeEmpty(data.wechat_group_qr),

    legal_person: normalizeEmpty(data.legal_person),
    registered_capital: normalizeEmpty(data.registered_capital),
    registration_date: normalizeEmpty(data.registration_date),

    contact_name: normalizeEmpty(data.contact_name),
    phone: normalizeEmpty(data.phone),
    email: normalizeEmpty(data.email),

    website: normalizeEmpty(data.website),
    category: normalizeEmpty(data.category),
    amazon_shop_url: normalizeEmpty(data.amazon_shop_url),
    company_profile: normalizeEmpty(data.company_profile),

    workflow_stage: STAGES.includes(stage) ? stage : "已导入",
    priority: ["Low", "Normal", "High"].includes(priority) ? priority : "Normal",
    customer_level: LEVELS.includes(level) ? level : "C",

    source: normalizeEmpty(data.source),
    owner_id: null,

    receiver_name: normalizeEmpty(data.receiver_name),
    receiver_mobile: normalizeEmpty(data.receiver_mobile),
    receiver_province: normalizeEmpty(data.receiver_province),
    receiver_city: normalizeEmpty(data.receiver_city),
    receiver_county: normalizeEmpty(data.receiver_county),
    receiver_town: normalizeEmpty(data.receiver_town),
    receiver_address: normalizeEmpty(data.receiver_address),
    receiver_postal_code: normalizeEmpty(data.receiver_postal_code),

    brand: normalizeEmpty(data.brand),
    sample_tracking_no: normalizeEmpty(data.sample_tracking_no),
  };
}

export default {
  listLeads,
  listBatchCandidates,
  filterLeadIdsForBatchCreation,

  listDemandLeads,
  listPartnerIntentLeads,
  listSampleSentLeads,
  listDealLeads,

  closeLead,
  reopenLead,

  listAllPlans,
  listAllFollowups,
  getLeadById,
  getFollowups,
  createPlan,
  listPlansByLeadId,
  countOpenPlansByLeadId,
  addFollowup,
  createVisitFollowup,

  markLeadPrioritySend,
  listPrioritySendLeads,
  clearPrioritySendFlagsByLeadIds,

  createLead,
  updateLead,
  disableLeads,
  changeStageBulk,
};