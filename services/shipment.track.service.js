import { db } from "../db.js";
import { YtoClient } from "./yto.client.js";

const yto = new YtoClient();

/** -----------------------------
 * helpers
 * ----------------------------- */
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return JSON.stringify({
      _stringify_error: String(e?.message || e),
      rawType: typeof obj,
    });
  }
}

function parseTimeMaybe(v) {
  if (!v) return null;
  const t = String(v).trim();
  if (!t) return null;

  const d = new Date(t.replace(/\//g, "-"));
  if (!Number.isNaN(d.getTime())) return d;

  const n = Number(t);
  if (Number.isFinite(n)) {
    const ms = n > 2e12 ? n : n > 2e9 ? n * 1000 : null;
    if (ms) {
      const dd = new Date(ms);
      if (!Number.isNaN(dd.getTime())) return dd;
    }
  }

  return null;
}

function toIsoLocal(dt) {
  if (!dt) return null;
  const pad = (x) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(
    dt.getHours()
  )}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

function normalizeObjectKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

function pick(obj, keys = []) {
  if (!obj || typeof obj !== "object") return null;

  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return obj[k];
    }
  }

  const lower = normalizeObjectKeys(obj);
  for (const k of keys) {
    const v = lower[String(k).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return v;
    }
  }

  return null;
}

/** -----------------------------
 * 圆通专用解析
 * ----------------------------- */
function extractYtoArray(resp) {
  if (!resp) return [];

  if (Array.isArray(resp)) return resp;

  if (resp && typeof resp === "object") {
    const candidates = [
      resp.data,
      resp.result,
      resp.response,
      resp.body,
      resp.list,
      resp.items,
      resp.records,
      resp.details,
      resp.detailList,
      resp.traceList,
      resp.traces,
      resp.routes,
      resp.route,
      resp.mailNoData,
      resp.mailData,
    ];

    for (const c of candidates) {
      if (Array.isArray(c) && c.length) return c;
    }
  }

  return [];
}

function normalizeYtoNode(it) {
  if (!it || typeof it !== "object") return null;

  const time = pick(it, [
    "upload_Time",
    "upload_time",
    "uploadTime",
    "uploadtim",
    "upload_tim",
    "time",
    "scanTime",
    "scan_time",
    "operateTime",
    "operate_time",
    "acceptTime",
    "accept_time",
    "nodeTime",
    "node_time",
    "eventTime",
    "event_time",
    "ftime",
    "dateTime",
    "datetime",
  ]);

  const desc = pick(it, [
    "processInfo",
    "process_info",
    "processinfo",
    "nodeContent",
    "node_content",
    "context",
    "description",
    "desc",
    "detail",
    "content",
    "remark",
    "message",
    "info",
    "statusDesc",
    "status_desc",
    "statusName",
    "status_name",
    "status",
  ]);

  const place = pick(it, [
    "upload_Address",
    "upload_address",
    "uploadAddress",
    "siteName",
    "site_name",
    "branchName",
    "branch_name",
    "city",
    "area",
    "place",
  ]);

  return {
    time: time ? String(time).trim() : null,
    desc: desc ? String(desc).trim() : null,
    place: place ? String(place).trim() : null,
    raw: it,
  };
}

function extractYtoNodes(resp) {
  const arr = extractYtoArray(resp);
  if (!Array.isArray(arr) || !arr.length) return [];

  return arr
    .map(normalizeYtoNode)
    .filter(Boolean)
    .filter((n) => n.time || n.desc);
}

/** -----------------------------
 * 状态识别
 * ----------------------------- */
function detectSignedFromDesc(desc) {
  const t = String(desc || "").toLowerCase();

  return (
    t.includes("已签收") ||
    t.includes("签收") ||
    t.includes("妥投") ||
    t.includes("已投递") ||
    t.includes("投递成功") ||
    t.includes("本人收") ||
    t.includes("家人代收") ||
    t.includes("门卫代收") ||
    t.includes("前台代收") ||
    t.includes("前台签收") ||
    t.includes("驿站签收") ||
    t.includes("代签收") ||
    t.includes("代收") ||
    t.includes("已代收") ||
    t.includes("已代签") ||
    t.includes("delivered") ||
    t.includes("signed")
  );
}

function detectExceptionFromDesc(desc) {
  const t = String(desc || "").toLowerCase();
  if (!t) return false;

  const recoveryHints = [
    "异常件已处理",
    "异常件处理完成",
    "问题件已处理",
    "重新派送",
    "转正常派送",
    "继续派送",
    "派送中",
    "正在为您派件",
    "已签收",
    "签收",
    "妥投",
    "已投递",
    "投递成功",
    "代收",
    "已代收",
  ];

  if (recoveryHints.some((w) => t.includes(String(w).toLowerCase()))) {
    return false;
  }

  const exceptionWords = [
    "拒收",
    "退回",
    "退件",
    "问题件",
    "无法联系",
    "电话不通",
    "地址错误",
    "地址不详",
    "地址不明",
    "超区",
    "自提",
    "拦截",
    "破损",
    "丢失",
    "少件",
    "错分",
    "改址失败",
    "派送失败",
    "异常签收",
    "退回寄件人",
  ];

  return exceptionWords.some((w) => t.includes(String(w).toLowerCase()));
}

/** -----------------------------
 * 签收方式分类（完整版）
 * 返回：
 * {
 *   signReceiveType: "前台/保安室/门口/快递架/驿站/代收点/同事/他人代收/本人/家人/其他",
 *   signReceiveRaw: "原始收件人文本"
 * }
 * ----------------------------- */
function extractSignReceiveTypeFromDesc(desc) {
  const text = String(desc || "").trim();
  if (!text) {
    return {
      signReceiveType: null,
      signReceiveRaw: null,
    };
  }

  // 优先提取“收件人: xxx / 收件人：xxx”
  let raw = null;
  const m = text.match(/收件人\s*[:：]\s*([^\s，。,；;（）()]+)/);
  if (m && m[1]) {
    raw = String(m[1]).trim();
  }

  // 再做一层兜底
  if (!raw) {
    const m2 = text.match(/收件人\s*[:：]\s*(.+?)(?:，|。|；|;|如有|请联系|或致电|感谢使用|$)/);
    if (m2 && m2[1]) {
      raw = String(m2[1]).trim();
    }
  }

  const source = String(raw || text).trim();
  if (!source) {
    return {
      signReceiveType: null,
      signReceiveRaw: null,
    };
  }

  const s = source
    .replace(/\s+/g, "")
    .replace(/[【】[\]()（）]/g, "")
    .trim();

  // 1) 前台
  if (s.includes("前台")) {
    return {
      signReceiveType: "前台",
      signReceiveRaw: raw || source,
    };
  }

  // 2) 保安室
  if (
    s.includes("保安室") ||
    s.includes("保安") ||
    s.includes("门卫") ||
    s.includes("物业")
  ) {
    return {
      signReceiveType: "保安室",
      signReceiveRaw: raw || source,
    };
  }

  // 3) 门口
  if (
    s.includes("家门口") ||
    s.includes("公司门口") ||
    s.includes("门口")
  ) {
    return {
      signReceiveType: "门口",
      signReceiveRaw: raw || source,
    };
  }

  // 4) 快递架
  if (
    s.includes("快递架") ||
    s.includes("货架") ||
    s.includes("架子") ||
    s.includes("框子") ||
    s.includes("快递间") ||
    s.includes("楼梯处") ||
    s.includes("电梯里")
  ) {
    return {
      signReceiveType: "快递架",
      signReceiveRaw: raw || source,
    };
  }

  // 5) 驿站 / 代收点 / 柜
  if (
    s.includes("驿站") ||
    s.includes("代收点") ||
    s.includes("丰巢") ||
    s.includes("菜鸟") ||
    s.includes("快递柜") ||
    s.includes("柜子")
  ) {
    return {
      signReceiveType: "驿站/代收点",
      signReceiveRaw: raw || source,
    };
  }

  // 6) 同事 / 他人代收
  if (
    s.includes("同事") ||
    s.includes("他人代收") ||
    s.includes("代收")
  ) {
    return {
      signReceiveType: "同事/他人代收",
      signReceiveRaw: raw || source,
    };
  }

  // 7) 本人 / 家人
  if (s.includes("本人")) {
    return {
      signReceiveType: "本人",
      signReceiveRaw: raw || source,
    };
  }

  if (s.includes("家人")) {
    return {
      signReceiveType: "家人",
      signReceiveRaw: raw || source,
    };
  }

  // 8) 常见位置型，先归其他
  if (
    s.includes("车间") ||
    s.includes("仓库") ||
    s.includes("办公室") ||
    s.includes("店里") ||
    s.includes("店铺")
  ) {
    return {
      signReceiveType: "其他",
      signReceiveRaw: raw || source,
    };
  }

  // 9) 纯人名，归同事/他人代收
  if (
    /^[\u4e00-\u9fa5]{2,6}$/.test(s) &&
    !s.includes("前台") &&
    !s.includes("保安") &&
    !s.includes("门卫") &&
    !s.includes("物业") &&
    !s.includes("门口") &&
    !s.includes("架") &&
    !s.includes("框") &&
    !s.includes("柜") &&
    !s.includes("驿站") &&
    !s.includes("代收点") &&
    !s.includes("车间")
  ) {
    return {
      signReceiveType: "同事/他人代收",
      signReceiveRaw: raw || source,
    };
  }

  // 10) 公司/店铺/品牌名，先归其他
  if (/^[\u4e00-\u9fa5A-Za-z0-9]{2,12}$/.test(s)) {
    return {
      signReceiveType: "其他",
      signReceiveRaw: raw || source,
    };
  }

  return {
    signReceiveType: "其他",
    signReceiveRaw: raw || source,
  };
}

function buildSyncDiagnosis(resp, summary) {
  const nodes = summary?.nodes || [];
  const latestTime = summary?.latestTime || null;
  const latestDesc = summary?.latestDesc || null;
  const latestDt = parseTimeMaybe(latestTime);

  if (!Array.isArray(resp) && (!resp || typeof resp !== "object")) {
    return {
      code: "API_EMPTY",
      label: "API无响应",
      level: "bad",
      message: "圆通接口无有效响应对象",
    };
  }

  if (!nodes.length) {
    return {
      code: "NO_TRACK_NODES",
      label: "API已返回，但无轨迹节点",
      level: "bad",
      message: "接口请求成功，但没有解析出任何轨迹节点，需要检查圆通返回结构或此单暂无轨迹",
    };
  }

  if (summary.isSigned) {
    return {
      code: "SIGNED_CONFIRMED",
      label: "API已同步签收",
      level: "ok",
      message: `已从API轨迹识别到签收。最新节点：${latestDesc || "-"}`,
    };
  }

  if (latestDt) {
    const ageMs = Date.now() - latestDt.getTime();
    const ageHours = ageMs / 1000 / 60 / 60;

    if (ageHours > 48) {
      return {
        code: "TRACK_STALE",
        label: "API轨迹偏旧",
        level: "warn",
        message: `API返回了轨迹，但最新轨迹距今约 ${Math.floor(ageHours)} 小时，需确认圆通开放接口是否已同步官网最新状态`,
      };
    }
  }

  return {
    code: "TRACK_OK_NOT_SIGNED",
    label: "API轨迹已同步，当前未签收",
    level: "ok",
    message: `API已有轨迹，最新状态未识别为签收。最新节点：${latestDesc || "-"}`,
  };
}

export function parseTrackSummary(resp) {
  const nodes = extractYtoNodes(resp);

  const withDt = nodes
    .map((n) => ({
      ...n,
      dt: parseTimeMaybe(n.time),
    }))
    .sort((a, b) => {
      const ta = a.dt ? a.dt.getTime() : 0;
      const tb = b.dt ? b.dt.getTime() : 0;
      return ta - tb;
    });

  const latest = withDt.length ? withDt[withDt.length - 1] : null;
  const latestTime = latest?.dt ? toIsoLocal(latest.dt) : latest?.time || null;
  const latestDesc = (latest?.desc || "").trim() || null;

  const signedNode = [...withDt].reverse().find((n) => detectSignedFromDesc(n.desc)) || null;
  const isSigned = !!signedNode;
  const signedTime = signedNode?.dt ? toIsoLocal(signedNode.dt) : signedNode?.time || null;

  const signInfo = signedNode
    ? extractSignReceiveTypeFromDesc(signedNode.desc)
    : { signReceiveType: "未签收", signReceiveRaw: null };

  const signReceiveType = signedNode ? (signInfo.signReceiveType || "未识别") : "未签收";
  const signReceiveRaw = signedNode ? (signInfo.signReceiveRaw || null) : null;

  let statusText = "UNKNOWN";

  if (!withDt.length) {
    statusText = "UNKNOWN";
  } else if (isSigned) {
    statusText = "SIGNED";
  } else if (detectExceptionFromDesc(latestDesc)) {
    statusText = "EXCEPTION";
  } else if (latestDesc) {
    statusText = "IN_TRANSIT";
  }

  const diagnosis = buildSyncDiagnosis(resp, {
    nodes: withDt,
    latestTime,
    latestDesc,
    isSigned,
  });

  return {
    nodes: withDt,
    latestTime,
    latestDesc,
    signedTime,
    isSigned,
    signReceiveType,
    signReceiveRaw,
    statusText,
    diagnosis,
  };
}

function buildSignTypeMonthlyStats(rows = []) {
  const map = new Map();

  for (const r of rows) {
    if (!r || !r.signed_at) continue;

    const dt = parseTimeMaybe(r.signed_at);
    if (!dt) continue;

    const month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    const signType = String(r.signReceiveType || "未识别");

    if (!map.has(month)) {
      map.set(month, new Map());
    }

    const monthMap = map.get(month);
    monthMap.set(signType, Number(monthMap.get(signType) || 0) + 1);
  }

  return Array.from(map.entries())
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .map(([month, typeMap]) => ({
      month,
      total: Array.from(typeMap.values()).reduce((s, n) => s + Number(n || 0), 0),
      items: Array.from(typeMap.entries())
        .map(([signType, count]) => ({ signType, count }))
        .sort((a, b) => b.count - a.count),
    }));
}

/** -----------------------------
 * shipment_events logging
 * ----------------------------- */
let EVENT_TABLE_EXISTS = null;

async function detectEventTable() {
  if (EVENT_TABLE_EXISTS !== null) return EVENT_TABLE_EXISTS;

  const [rows] = await db.query(`
    SELECT COUNT(1) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'shipment_events'
  `);

  EVENT_TABLE_EXISTS = Number(rows?.[0]?.cnt || 0) > 0;
  return EVENT_TABLE_EXISTS;
}

async function addEvent(conn, shipmentId, type, status, message, raw) {
  const ok = await detectEventTable();
  if (!ok) return;

  await conn.query(
    `INSERT INTO shipment_events(
      shipment_id, event_type, event_status, event_message, raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, NOW())`,
    [shipmentId, type, status ?? null, message ?? null, raw ? JSON.stringify(raw) : null]
  );
}

/** -----------------------------
 * DB helpers
 * ----------------------------- */
async function getShipmentById(conn, id) {
  const [rows] = await conn.query(`SELECT * FROM shipments WHERE id=? LIMIT 1`, [Number(id)]);
  return rows?.[0] || null;
}

/** -----------------------------
 * Core APIs
 * ----------------------------- */
export async function updateTrackByShipmentId(id, { force = false, source = "unknown" } = {}) {
  const shipmentId = Number(id);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const ship = await getShipmentById(conn, shipmentId);
    if (!ship) throw new Error(`Shipment not found: ${shipmentId}`);

    if (!ship.waybill_no) {
      await addEvent(conn, ship.id, "TrackUpdateSkipped", "NO_WAYBILL", "No waybill_no, skip", {
        source,
        force,
      });
      await conn.commit();
      return { ok: false, skipped: true, reason: "NO_WAYBILL", shipment: ship };
    }

    if (!force && ship.signed_at) {
      await addEvent(conn, ship.id, "TrackUpdateSkipped", "SIGNED_SKIP", "Signed already, skip", {
        source,
        force,
      });
      await conn.commit();
      return { ok: true, skipped: true, reason: "SIGNED_SKIP", shipment: ship };
    }

    if (!force && ship.track_updated_at) {
      const last = new Date(ship.track_updated_at);
      const diffMs = Date.now() - last.getTime();

      if (diffMs < 2 * 60 * 60 * 1000) {
        await addEvent(conn, ship.id, "TrackUpdateSkipped", "NOT_DUE", "Not due (<2h), skip", {
          source,
          force,
          track_updated_at: ship.track_updated_at,
        });
        await conn.commit();
        return { ok: true, skipped: true, reason: "NOT_DUE", shipment: ship };
      }
    }

    await addEvent(conn, ship.id, "TrackUpdateStart", "START", "Query YTO track", {
      source,
      force,
      waybill_no: ship.waybill_no,
    });

    const resp = await yto.queryTrack(ship.waybill_no);
    const summary = parseTrackSummary(resp);

    let signedAt = null;
    if (summary.isSigned && !ship.signed_at) {
      const signedDt = parseTimeMaybe(summary.signedTime);
      signedAt = signedDt || new Date();
    }

    await conn.query(
      `UPDATE shipments
       SET track_json=?,
           track_updated_at=?,
           logistics_status=?,
           signed_at=COALESCE(?, signed_at),
           updated_at=NOW()
       WHERE id=?`,
      [
        safeStringify(resp),
        new Date(),
        summary.statusText,
        signedAt,
        ship.id,
      ]
    );

    await addEvent(conn, ship.id, "TrackUpdateSucceeded", summary.statusText, "Track updated", {
      source,
      force,
      waybill_no: ship.waybill_no,
      diagnosis: summary.diagnosis,
      statusText: summary.statusText,
      isSigned: summary.isSigned,
      signedTime: summary.signedTime,
      latestTime: summary.latestTime,
      latestDesc: summary.latestDesc,
      signReceiveType: summary.signReceiveType,
      signReceiveRaw: summary.signReceiveRaw,
      nodeCount: summary.nodes.length,
      apiResponse: resp,
    });

    const updated = await getShipmentById(conn, ship.id);
    await conn.commit();

    return {
      ok: true,
      skipped: false,
      shipment: updated,
      summary: {
        latestTime: summary.latestTime,
        latestDesc: summary.latestDesc,
        signedTime: summary.signedTime,
        statusText: summary.statusText,
        isSigned: summary.isSigned,
        signReceiveType: summary.signReceiveType,
        signReceiveRaw: summary.signReceiveRaw,
        nodeCount: summary.nodes.length,
        diagnosis: summary.diagnosis,
      },
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    try {
      const c2 = await db.getConnection();
      try {
        await addEvent(c2, shipmentId, "TrackUpdateFailed", "FAILED", e?.message || String(e), {
          source,
          force,
        });
      } finally {
        c2.release();
      }
    } catch {}

    return { ok: false, skipped: false, error: e?.message || String(e) };
  } finally {
    conn.release();
  }
}

export async function updateDueTracks({ limit = 100 } = {}) {
  const lim = Number(limit) || 100;

  const [rows] = await db.query(
    `
    SELECT id
    FROM shipments
    WHERE waybill_no IS NOT NULL
      AND signed_at IS NULL
      AND (
        track_updated_at IS NULL
        OR track_updated_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)
      )
    ORDER BY track_updated_at IS NULL DESC, track_updated_at ASC, id ASC
    LIMIT ?
    `,
    [lim]
  );

  const results = [];
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of rows || []) {
    const one = await updateTrackByShipmentId(r.id, { force: false, source: "cron" });
    results.push({ id: r.id, ...one });

    if (one.skipped) skipped++;
    else if (one.ok) success++;
    else failed++;
  }

  return { total: (rows || []).length, success, failed, skipped, results };
}

export async function listTrackSummary({ range = "90", keyword = "", signType = "" } = {}) {
  const isAll = String(range).toLowerCase() === "all";
  const where = isAll ? "" : "WHERE s.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)";

  const [rows] = await db.query(
    `
    SELECT
      s.id,
      s.batch_id,
      s.lead_id,
      s.receiver_name,
      s.receiver_city,
      s.waybill_no,
      s.logistics_status,
      s.track_updated_at,
      s.signed_at,
      s.created_at,
      s.track_json,
      l.company_name AS company_name
    FROM shipments s
    LEFT JOIN leads l ON l.id = s.lead_id
    ${where}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT 1000
    `
  );

  const enriched = (rows || []).map((r) => {
    let latestDesc = null;
    let latestTime = null;
    let nodeCount = 0;
    let signedTime = null;
    let diagnosis = null;
    let signReceiveType = r.signed_at ? "未识别" : "未签收";
    let signReceiveRaw = null;

    try {
      if (r.track_json) {
        const obj = JSON.parse(r.track_json);
        const s = parseTrackSummary(obj);
        latestDesc = s.latestDesc;
        latestTime = s.latestTime;
        signedTime = s.signedTime;
        nodeCount = s.nodes.length;
        diagnosis = s.diagnosis;
        signReceiveType = s.signReceiveType || signReceiveType;
        signReceiveRaw = s.signReceiveRaw || null;
      }
    } catch {}

    return {
      ...r,
      latestDesc,
      latestTime,
      signedTime,
      nodeCount,
      diagnosis,
      signReceiveType,
      signReceiveRaw,
    };
  });

  const kw = String(keyword || "").trim().toLowerCase();
  const st = String(signType || "").trim();

  const filteredRows = enriched.filter((r) => {
    const matchedKeyword =
      !kw ||
      [
        r.company_name,
        r.receiver_name,
        r.receiver_city,
        r.waybill_no,
        r.logistics_status,
        r.signReceiveType,
        r.signReceiveRaw,
        r.latestDesc,
      ]
        .map((x) => String(x || "").toLowerCase())
        .join(" ")
        .includes(kw);

    const matchedSignType =
      !st || st === "全部" || String(r.signReceiveType || "") === st;

    return matchedKeyword && matchedSignType;
  });

  const signTypeMonthlyStats = buildSignTypeMonthlyStats(filteredRows);

  return {
    rows: filteredRows,
    signTypeMonthlyStats,
  };
}

export async function getTrackDetailByShipmentId(id) {
  const shipmentId = Number(id);

  const [rows] = await db.query(
    `
    SELECT
      s.id,
      s.batch_id,
      s.lead_id,
      s.receiver_name,
      s.receiver_city,
      s.waybill_no,
      s.logistics_status,
      s.track_updated_at,
      s.signed_at,
      s.created_at,
      s.track_json,
      l.company_name AS company_name
    FROM shipments s
    LEFT JOIN leads l ON l.id = s.lead_id
    WHERE s.id=?
    LIMIT 1
    `,
    [shipmentId]
  );

  const row = rows?.[0];
  if (!row) return null;

  let raw = null;
  let summary = {
    nodes: [],
    latestTime: null,
    latestDesc: null,
    signedTime: null,
    isSigned: false,
    signReceiveType: row.signed_at ? "未识别" : "未签收",
    signReceiveRaw: null,
    statusText: row.logistics_status || "UNKNOWN",
    diagnosis: null,
  };

  try {
    raw = row.track_json ? JSON.parse(row.track_json) : null;
    if (raw) {
      summary = parseTrackSummary(raw);
    }
  } catch {}

  return {
    shipment: row,
    raw,
    summary,
  };
}

export async function listTrackLogs({ limit = 200, shipmentId = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);

  const where = [];
  const params = [];

  where.push(`event_type LIKE 'TrackUpdate%'`);
  if (shipmentId) {
    where.push(`shipment_id=?`);
    params.push(Number(shipmentId));
  }

  const [rows] = await db.query(
    `
    SELECT
      id, shipment_id, event_type, event_status, event_message, raw_payload, created_at
    FROM shipment_events
    WHERE ${where.join(" AND ")}
    ORDER BY id DESC
    LIMIT ?
    `,
    [...params, lim]
  );

  return rows || [];
}

export default {
  updateTrackByShipmentId,
  updateDueTracks,
  listTrackSummary,
  getTrackDetailByShipmentId,
  listTrackLogs,
  parseTrackSummary,
};