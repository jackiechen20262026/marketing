import { db } from "../db.js";
import { wallToUtc, utcSql } from "./mailingCalendar.js";
export const metrics = {
  batch: "加入批次次数",
  ordered: "圆通下单成功次数",
  dispatched: "实际寄出次数",
  signed: "物流签收次数",
  confirmed: "客户确认收到次数",
};
export function statsQuery(f = {}) {
  f = { ...f };
  if (["0", "1", "2", "3+"].includes(f.countBucket)) {
    f.minCount = f.countBucket === "3+" ? 3 : Number(f.countBucket);
    f.maxCount = f.countBucket === "3+" ? "" : f.minCount;
  }
  const args = [],
    where = ["l.is_active=1"];
  if (!f.showClosed) where.push("l.is_closed=0");
  if (f.user && f.user.role !== "Admin") {
    where.push("l.owner_id=?");
    args.push(f.user.id);
  }
  for (const [key, col] of [
    ["stage", "workflow_stage"],
    ["level", "customer_level"],
  ])
    if (f[key]) {
      where.push(`l.${col}=?`);
      args.push(f[key]);
    }
  if (f.important === "1") where.push("l.important_flag=1");
  if (f.keyword) {
    where.push(
      "(l.company_name LIKE ? OR l.contact_name LIKE ? OR l.phone LIKE ? OR ls.waybill_no LIKE ?)",
    );
    args.push(...Array(4).fill("%" + String(f.keyword).slice(0, 200) + "%"));
  }
  const metric = Object.hasOwn(metrics, f.metric) ? f.metric : "batch";
  const eventWhere = [],
    eventArgs = [],
    batchWhere = [],
    batchArgs = [];
  if (f.months && [1, 3, 6, 12].includes(Number(f.months))) {
    eventWhere.push("event_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? MONTH)");
    eventArgs.push(Number(f.months));
    batchWhere.push("created_at>=DATE_SUB(NOW(),INTERVAL ? MONTH)");
    batchArgs.push(Number(f.months));
  }
  for (const [key, op] of [
    ["dateFrom", ">="],
    ["dateTo", "<="],
  ])
    if (f[key]) {
      const value = utcSql(
        wallToUtc(
          String(f[key]).length === 10
            ? f[key] + (key === "dateFrom" ? " 00:00:00" : " 23:59:59")
            : f[key],
        ),
      );
      eventWhere.push("event_at" + op + "?");
      eventArgs.push(value);
      // Existing batch timestamps remain in their original Europe/Berlin business time.
      batchWhere.push("created_at" + op + "?");
      batchArgs.push(
        String(f[key]).slice(0, 10) +
          (key === "dateFrom" ? " 00:00:00" : " 23:59:59"),
      );
    }
  if (f.includeResends === "0") eventWhere.push("is_resend=0");
  const count =
    metric === "batch"
      ? "COALESCE(m.mail_count,0)"
      : `COALESCE(e.${metric}_count,0)`;
  for (const [key, op] of [
    ["minCount", ">="],
    ["maxCount", "<="],
  ])
    if (f[key] !== "" && f[key] != null) {
      const n = Number(f[key]);
      if (!Number.isSafeInteger(n) || n < 0) throw Error("次数必须为非负整数");
      where.push(count + op + "?");
      args.push(n);
    }
  const status =
    "CASE WHEN ls.id IS NULL THEN 'NO_TRACK' ELSE COALESCE(ls.track_fact_status,ls.logistics_status,'UNKNOWN') END";
  if (f.trackStatus) {
    where.push(status + "=?");
    args.push(f.trackStatus);
  }
  if (f.signType) {
    where.push("COALESCE(ls.sign_receive_type,'未知')=?");
    args.push(f.signType);
  }
  if (f.due === "due")
    where.push("p.enabled=1 AND p.paused=0 AND p.next_at<=UTC_TIMESTAMP()");
  if (f.due === "paused") where.push("p.paused=1");
  if (f.due === "legacy") where.push("COALESCE(p.enabled,0)=0");
  const from = `FROM leads l
 LEFT JOIN mailing_plans p ON p.lead_id=l.id
 LEFT JOIN (SELECT lead_id,COUNT(DISTINCT batch_id) mail_count FROM campaign_batch_items ${batchWhere.length ? "WHERE " + batchWhere.join(" AND ") : ""} GROUP BY lead_id) m ON m.lead_id=l.id
 LEFT JOIN (SELECT lead_id,${["ordered", "dispatched", "signed", "confirmed"].map((k) => `SUM(event_type='${k}') ${k}_count`).join(",")},MAX(event_at) last_event_at FROM mailing_events ${eventWhere.length ? "WHERE " + eventWhere.join(" AND ") : ""} GROUP BY lead_id) e ON e.lead_id=l.id
 LEFT JOIN (SELECT lead_id,COUNT(*) followup_count,SUM(visit_checked_in_at IS NOT NULL) visit_count FROM lead_followups GROUP BY lead_id) fu ON fu.lead_id=l.id
 LEFT JOIN shipments ls ON ls.id=(SELECT MAX(s.id) FROM shipments s WHERE s.lead_id=l.id AND NULLIF(TRIM(s.waybill_no),'') IS NOT NULL ${f.range === "all" ? "" : "AND s.created_at>=DATE_SUB(NOW(),INTERVAL 90 DAY)"})
 WHERE ${where.join(" AND ")}`;
  const select = `l.*,COALESCE(m.mail_count,0) mail_count,${["ordered", "dispatched", "signed", "confirmed"].map((k) => `COALESCE(e.${k}_count,0) ${k}_count`).join(",")},e.last_event_at,
 COALESCE(fu.followup_count,0) followup_count,COALESCE(fu.visit_count,0) visit_count,p.next_at,p.enabled plan_enabled,p.paused,
 ls.id latest_shipment_id,ls.batch_id latest_batch_id,ls.waybill_no latest_waybill_no,ls.logistics_status latest_logistics_status,ls.track_updated_at latest_track_updated_at,ls.signed_at latest_signed_at,ls.created_at latest_shipment_created_at,
 ls.latest_event_at latest_track_time,ls.latest_event_desc latest_track_desc,ls.sign_receive_type signReceiveType,ls.query_status,${status} merged_track_status`;
  const sort =
    f.sort === "count_desc"
      ? `${count} DESC`
      : f.sort === "count_asc"
        ? `${count} ASC`
        : f.sort === "date"
          ? "e.last_event_at DESC"
          : f.sort === "due"
            ? "p.next_at ASC"
            : "l.important_flag DESC";
  return {
    from,
    select,
    status,
    params: [...batchArgs, ...eventArgs, ...args],
    order: `${sort},l.id DESC`,
  };
}
export async function listStats(f = {}, conn = db) {
  if (conn === db) {
    const c = await db.getConnection();
    try {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await c.query("SET TRANSACTION READ ONLY");
      await c.beginTransaction();
      const result = await listStats(f, c);
      await c.commit();
      return result;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
  const q = statsQuery(f),
    page = Math.max(1, Math.floor(Number(f.page) || 1)),
    pageSize = Math.min(200, Math.max(1, Math.floor(Number(f.pageSize) || 50)));
  const [[summary]] = await conn.query(
    `SELECT COUNT(*) total,SUM(ls.id IS NOT NULL) withTrack,SUM(${q.status}='SIGNED') signed,SUM(${q.status}='EXCEPTION') exception,SUM(${q.status}='IN_TRANSIT') inTransit,SUM(ls.id IS NULL) noTrack ${q.from}`,
    q.params,
  );
  const [rows] = await db.query(
    `SELECT ${q.select} ${q.from} ORDER BY ${q.order} LIMIT ? OFFSET ?`,
    [...q.params, pageSize, (page - 1) * pageSize],
  );
  const labels = {
    SIGNED: "已签收",
    EXCEPTION: "异常",
    IN_TRANSIT: "运输中",
    NO_TRACK: "无运单",
    UNKNOWN: "未知",
  };
  return {
    rows: rows.map((r) => ({
      ...r,
      ...Object.fromEntries(
        [
          "mail_count",
          "ordered_count",
          "dispatched_count",
          "signed_count",
          "confirmed_count",
        ].map((k) => [k, Number(r[k])]),
      ),
      merged_track_status_label: labels[r.merged_track_status] || "未知",
      signReceiveType: r.signReceiveType || "未知",
      track_node_count: null,
      track_diagnosis: {
        label: r.query_status || "尚未核验",
        code: r.query_status,
      },
      development_advice: "签收不代表购买意向；请结合跟进与需求证据",
    })),
    summary,
    pagination: {
      page,
      pageSize,
      total: Number(summary.total),
      totalPages: Math.max(1, Math.ceil(summary.total / pageSize)),
    },
  };
}
export async function* exportStats(f = {}) {
  const c = await db.getConnection();
  try {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await c.query("SET TRANSACTION READ ONLY");
    await c.beginTransaction();
    let page = 1;
    do {
      const result = await listStats({ ...f, page, pageSize: 200 }, c);
      for (const row of result.rows) yield row;
      if (page * 200 >= result.pagination.total) break;
      page++;
    } while (true);
    await c.commit();
  } finally {
    await c.rollback();
    c.release();
  }
}
