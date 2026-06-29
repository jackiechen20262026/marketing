import { db } from "../db.js";
import { parseTrackSummary } from "./shipment.track.service.js";

const PAGE_SIZES = [20, 50, 100, 200];
const LEVELS = ["A", "B", "C", "D"];

function s(v) {
  return String(v == null ? "" : v).trim();
}

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function normalizePagination({ page, pageSize }) {
  const p = Math.max(1, n(page, 1));
  const ps = PAGE_SIZES.includes(n(pageSize, 50)) ? n(pageSize, 50) : 50;
  return { page: p, pageSize: ps };
}

function statusLabel(status) {
  const st = s(status).toUpperCase();
  if (st === "SIGNED") return "已签收";
  if (st === "EXCEPTION") return "异常";
  if (st === "IN_TRANSIT") return "运输中";
  if (st === "NO_TRACK") return "无轨迹";
  return "未知";
}

function normalizeTrackStatus(row, summary) {
  const dbStatus = s(row.latest_logistics_status).toUpperCase();
  if (row.latest_signed_at || summary?.isSigned || dbStatus === "SIGNED") return "SIGNED";
  if (dbStatus === "EXCEPTION" || summary?.statusText === "EXCEPTION") return "EXCEPTION";
  if (dbStatus === "IN_TRANSIT" || summary?.statusText === "IN_TRANSIT") return "IN_TRANSIT";
  if (!row.latest_shipment_id) return "NO_TRACK";
  return dbStatus || summary?.statusText || "UNKNOWN";
}

function buildAdvice(status) {
  if (status === "SIGNED") return "样品已签收，适合安排微信/电话跟进";
  if (status === "EXCEPTION") return "物流异常，先处理签收问题再推进开发";
  if (status === "IN_TRANSIT") return "样品在途，可等待或提醒客户留意";
  if (status === "NO_TRACK") return "暂无圆通轨迹，可确认是否已建批次/推单";
  return "状态未知，建议手动刷新轨迹";
}

function parseSummary(row) {
  if (!row.latest_track_json) return null;
  try {
    return parseTrackSummary(JSON.parse(row.latest_track_json));
  } catch {
    return null;
  }
}

function matchesClientFilters(row, { trackStatus, signType }) {
  if (trackStatus && row.merged_track_status !== trackStatus) return false;
  if (signType && s(row.signReceiveType) !== signType) return false;
  return true;
}

function sortRows(a, b) {
  const order = { EXCEPTION: 0, SIGNED: 1, IN_TRANSIT: 2, UNKNOWN: 3, NO_TRACK: 4 };
  const oa = order[a.merged_track_status] ?? 9;
  const ob = order[b.merged_track_status] ?? 9;
  if (oa !== ob) return oa - ob;
  return Number(b.id || 0) - Number(a.id || 0);
}

function sortLeadRows(a, b) {
  return Number(b.id || 0) - Number(a.id || 0);
}

export async function listLeadTrackRows({
  keyword = "",
  stage = "",
  level = "",
  trackStatus = "",
  signType = "",
  range = "90",
  showClosed = false,
  page = 1,
  pageSize = 50,
  sortMode = "status",
} = {}) {
  const pg = normalizePagination({ page, pageSize });
  const isAllRange = s(range).toLowerCase() === "all";
  const rangeSql = isAllRange ? "" : "AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)";

  const where = ["l.is_active=1"];
  const params = [];

  if (!showClosed) where.push("COALESCE(l.is_closed,0)=0");

  const kw = s(keyword);
  if (kw) {
    where.push(`(
      l.company_name LIKE ?
      OR l.contact_name LIKE ?
      OR l.receiver_name LIKE ?
      OR l.receiver_mobile LIKE ?
      OR l.phone LIKE ?
      OR l.wechat LIKE ?
      OR l.wechat_group_code LIKE ?
      OR l.vat_no LIKE ?
      OR l.unified_code LIKE ?
      OR l.category LIKE ?
      OR ls.waybill_no LIKE ?
      OR ls.logistics_status LIKE ?
    )`);
    for (let i = 0; i < 12; i++) params.push(`%${kw}%`);
  }

  const stg = s(stage);
  if (stg) {
    where.push("l.workflow_stage = ?");
    params.push(stg);
  }

  const lv = s(level);
  if (lv && LEVELS.includes(lv)) {
    where.push("l.customer_level = ?");
    params.push(lv);
  }

  const [rows] = await db.query(
    `
    SELECT
      l.id,
      l.company_name,
      l.contact_name,
      l.phone,
      l.wechat,
      l.wechat_group_code,
      l.category,
      l.workflow_stage,
      l.customer_level,
      l.priority,
      l.sample_tracking_no,
      l.receiver_name,
      l.receiver_mobile,
      l.receiver_city,
      l.is_closed,
      l.created_at,
      l.updated_at,

      COALESCE(m.mail_count, 0) AS mail_count,
      COALESCE(f.visit_count, 0) AS visit_count,
      COALESCE(f.followup_count, 0) AS followup_count,

      ls.id AS latest_shipment_id,
      ls.batch_id AS latest_batch_id,
      ls.waybill_no AS latest_waybill_no,
      ls.logistics_status AS latest_logistics_status,
      ls.track_updated_at AS latest_track_updated_at,
      ls.signed_at AS latest_signed_at,
      ls.created_at AS latest_shipment_created_at,
      ls.track_json AS latest_track_json
    FROM leads l
    LEFT JOIN (
      SELECT lead_id, COUNT(*) AS followup_count,
             SUM(CASE WHEN visit_checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS visit_count
      FROM lead_followups
      GROUP BY lead_id
    ) f ON f.lead_id = l.id
    LEFT JOIN (
      SELECT lead_id, COUNT(DISTINCT batch_id) AS mail_count
      FROM campaign_batch_items
      GROUP BY lead_id
    ) m ON m.lead_id = l.id
    LEFT JOIN (
      SELECT s1.*
      FROM shipments s1
      INNER JOIN (
        SELECT lead_id, MAX(id) AS max_id
        FROM shipments
        WHERE waybill_no IS NOT NULL
          AND TRIM(waybill_no) <> ''
          ${rangeSql}
        GROUP BY lead_id
      ) z ON z.max_id = s1.id
    ) ls ON ls.lead_id = l.id
    WHERE ${where.join(" AND ")}
    ORDER BY l.id DESC
    LIMIT 5000
    `,
    params
  );

  const enriched = (rows || []).map((row) => {
    const summary = parseSummary(row);
    const mergedStatus = normalizeTrackStatus(row, summary);
    const signReceiveType = summary?.signReceiveType || (mergedStatus === "SIGNED" ? "未识别" : "未签收");

    return {
      ...row,
      merged_track_status: mergedStatus,
      merged_track_status_label: statusLabel(mergedStatus),
      latest_track_time: summary?.latestTime || null,
      latest_track_desc: summary?.latestDesc || null,
      signed_track_time: summary?.signedTime || null,
      signReceiveType,
      signReceiveRaw: summary?.signReceiveRaw || null,
      track_node_count: summary?.nodes?.length || 0,
      track_diagnosis: summary?.diagnosis || null,
      development_advice: buildAdvice(mergedStatus),
    };
  });

  const sorter = sortMode === "lead" ? sortLeadRows : sortRows;
  const filtered = enriched
    .filter((row) => matchesClientFilters(row, { trackStatus: s(trackStatus), signType: s(signType) }))
    .sort(sorter);

  const total = filtered.length;
  const start = (pg.page - 1) * pg.pageSize;
  const pagedRows = filtered.slice(start, start + pg.pageSize);

  const summary = filtered.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.latest_waybill_no) acc.withTrack += 1;
      if (row.merged_track_status === "SIGNED") acc.signed += 1;
      if (row.merged_track_status === "EXCEPTION") acc.exception += 1;
      if (row.merged_track_status === "IN_TRANSIT") acc.inTransit += 1;
      if (row.merged_track_status === "NO_TRACK") acc.noTrack += 1;
      return acc;
    },
    { total: 0, withTrack: 0, signed: 0, exception: 0, inTransit: 0, noTrack: 0 }
  );

  return {
    rows: pagedRows,
    pagination: {
      page: pg.page,
      pageSize: pg.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pg.pageSize)),
    },
    summary,
  };
}

export default {
  listLeadTrackRows,
};
