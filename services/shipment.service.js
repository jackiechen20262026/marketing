// services/shipment.service.js
import { db } from "../db.js";
import { YtoClient } from "./yto.client.js";

const yto = new YtoClient();

const SENDER = {
  name: "欧美售后联盟-徐翔",
  province: "广东",
  city: "深圳市",
  county: "龙华区",
  town: "鹊满山创客中心 A栋501-1",
  address: "华荣路105号",
  mobile: "13117349016 ",
};

const RETRYABLE_CODES = new Set([200010002, 200010005, 200017006, 200017008, 200017010]);

let SHIPMENT_COLS = null;
let PUSH_STATUS_ENUM = null;

async function loadShipmentMeta() {
  if (SHIPMENT_COLS && PUSH_STATUS_ENUM) return;

  const [cols] = await db.query(
    `
    SELECT COLUMN_NAME AS col, COLUMN_TYPE AS colType
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'shipments'
    `
  );

  SHIPMENT_COLS = new Set((cols || []).map((r) => String(r.col)));

  const ps = (cols || []).find((r) => String(r.col) === "push_status");
  if (ps && typeof ps.colType === "string" && ps.colType.toLowerCase().startsWith("enum(")) {
    const raw = ps.colType.slice(5, -1);
    const items = raw
      .split(",")
      .map((x) => x.trim())
      .map((x) => x.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'"));
    PUSH_STATUS_ENUM = items;
  } else {
    PUSH_STATUS_ENUM = [];
  }
}

function hasCol(col) {
  return SHIPMENT_COLS && SHIPMENT_COLS.has(col);
}

function mapPushStatus(wanted) {
  const list = PUSH_STATUS_ENUM || [];
  if (!list.length) return wanted;

  const lower = list.map((x) => String(x).toLowerCase());
  const pick = (...cands) => {
    for (const c of cands) {
      const idx = lower.indexOf(String(c).toLowerCase());
      if (idx >= 0) return list[idx];
    }
    return null;
  };

  if (wanted === "NotPushed") return pick("pending", "notpushed", "not_pushed", "not-pushed") || list[0];
  if (wanted === "Pushed") return pick("pushed", "success", "done") || list[0];
  if (wanted === "Failed") return pick("failed", "fail", "error") || list[0];
  return list[0];
}

function pick(obj, keys) {
  for (const k of keys) {
    if (!obj) continue;
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const t = String(v).trim();
    if (t !== "") return v;
  }
  return null;
}

function normalizePhone(v) {
  if (v === undefined || v === null) return null;
  let t = String(v).trim();
  if (!t) return null;

  t = t.replace(/\s+/g, "").replace(/-/g, "");
  if (t.endsWith(".0")) t = t.slice(0, -2);

  if (/e\+?/i.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) t = String(Math.trunc(n));
  }
  if (/^\d+\.\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) t = String(Math.trunc(n));
  }
  return t || null;
}

function buildLogisticsNo({ batchId, leadId }) {
  const suffix = String(Date.now()).slice(-6);
  return `B${batchId}_${leadId}_${suffix}`;
}

let EVENT_TABLE_EXISTS = null;
async function detectEventTable() {
  if (EVENT_TABLE_EXISTS !== null) return EVENT_TABLE_EXISTS;
  const [rows] = await db.query(
    `
    SELECT COUNT(1) AS cnt
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'shipment_events'
    `
  );
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

function filterInsertPayload(payload) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(payload)) {
    if (hasCol(k)) {
      cols.push(k);
      vals.push(v);
    }
  }
  return { cols, vals };
}

async function safeUpdateShipment(conn, id, payload) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(payload)) {
    if (!hasCol(k)) continue;
    sets.push(`${k}=?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  await conn.query(`UPDATE shipments SET ${sets.join(", ")} WHERE id=?`, vals);
}

async function loadLeadReceiver(conn, leadId) {
  const [rows] = await conn.query(`SELECT * FROM leads WHERE id=? LIMIT 1`, [leadId]);
  if (!rows.length) throw new Error(`Lead not found: ${leadId}`);
  const lead = rows[0];

  const contactName = pick(lead, ["receiver_name", "contact_name", "consignee", "linkman", "name"]);
  const companyName = pick(lead, ["company_name", "company", "companyName"]);
  const name = String(contactName || companyName || "").trim() || null;

  // ✅ 手机兜底：receiver_mobile -> phone
  const phoneRaw = pick(lead, ["receiver_mobile", "phone", "mobile", "tel"]);
  const phone = normalizePhone(phoneRaw);

  const province = String(pick(lead, ["receiver_province"]) || "").trim() || null;
  const city = String(pick(lead, ["receiver_city"]) || "").trim() || null;
  const county = String(pick(lead, ["receiver_county"]) || "").trim() || null;
  const town = String(pick(lead, ["receiver_town"]) || "").trim() || null;
  const address = String(pick(lead, ["receiver_address"]) || "").trim() || null;
  const postalCode = String(pick(lead, ["receiver_postal_code"]) || "").trim() || null;

  const receiver = {
    name,
    phone,
    province,
    city,
    county,
    town,
    address,
    postalCode,
    country: "China",
  };

  // 推单硬校验（准备阶段用）
  const missing = [];
  if (!receiver.name) missing.push("receiver_name");
  if (!receiver.phone) missing.push("receiver_mobile（可用 phone 兜底）");
  if (!receiver.province) missing.push("receiver_province");
  if (!receiver.city) missing.push("receiver_city");
  if (!receiver.address) missing.push("receiver_address");

  return { lead, receiver, missing };
}

async function ensureShipment(conn, { batchId, leadId, receiver }) {
  await loadShipmentMeta();

  const [rows] = await conn.query(
    `SELECT * FROM shipments WHERE batch_id=? AND lead_id=? LIMIT 1`,
    [batchId, leadId]
  );
  if (rows.length) return rows[0];

  const payload = {
    batch_id: batchId,
    lead_id: leadId,
    carrier: "YTO",
    waybill_no: null,
    push_status: mapPushStatus("NotPushed"),
    receiver_name: receiver.name ?? null,
    receiver_mobile: receiver.phone ?? null,
    receiver_province: receiver.province ?? null,
    receiver_city: receiver.city ?? null,
    receiver_county: receiver.county ?? null,
    receiver_town: receiver.town ?? null,
    receiver_address: receiver.address ?? null,
    receiver_postal_code: receiver.postalCode ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const { cols, vals } = filterInsertPayload(payload);
  if (!cols.length) throw new Error("shipments 表字段无法匹配：请检查是否存在 batch_id/lead_id");

  const placeholders = cols.map(() => "?").join(", ");
  const [ret] = await conn.query(
    `INSERT INTO shipments(${cols.join(", ")}) VALUES(${placeholders})`,
    vals
  );

  const shipmentId = ret.insertId;
  await addEvent(conn, shipmentId, "EnsureShipment", mapPushStatus("NotPushed"), "Shipment created", { batchId, leadId });
  const [[ship]] = await conn.query(`SELECT * FROM shipments WHERE id=?`, [shipmentId]);
  return ship;
}

/**
 * ✅ 批次推单前检查：返回缺字段列表（不推单）
 */
export async function precheckBatchToYto({ batchId }) {
  const bid = Number(batchId);
  if (!bid || Number.isNaN(bid)) throw new Error("invalid batchId");

  const conn = await db.getConnection();
  try {
    const [items] = await conn.query(
      `SELECT lead_id FROM campaign_batch_items WHERE batch_id=? ORDER BY id ASC`,
      [bid]
    );

    const missingList = [];
    for (const it of items) {
      const leadId = it.lead_id;
      const { lead, missing } = await loadLeadReceiver(conn, leadId);
      if (missing.length) {
        missingList.push({
          leadId,
          company_name: lead.company_name,
          contact_name: lead.contact_name,
          phone: lead.phone,
          missing,
        });
      }
    }

    return {
      batchId: bid,
      total: items.length,
      missingCount: missingList.length,
      missingList,
    };
  } finally {
    conn.release();
  }
}

async function pushOneShipment(conn, { batchId, leadId, retryFailedOnly, force }) {
  await loadShipmentMeta();

  const { receiver, missing } = await loadLeadReceiver(conn, leadId);
  const ship = await ensureShipment(conn, { batchId, leadId, receiver });

  const pushStatus = ship.push_status ?? "pending";
  const waybillNo = ship.waybill_no ?? null;

  if (waybillNo) {
    await addEvent(conn, ship.id, "PushSkipped", pushStatus, "Already pushed", { waybill_no: waybillNo });
    return { ok: true, skipped: true, shipment: ship };
  }

  if (retryFailedOnly && String(pushStatus).toLowerCase() !== "failed") {
    await addEvent(conn, ship.id, "PushSkipped", pushStatus, "Skip non-failed when retryFailedOnly=true");
    return { ok: true, skipped: true, shipment: ship };
  }

  // ✅ 若缺字段：
  // - force=false：交给 controller 先提示（这里返回 fail，但不算推单错误）
  // - force=true：写入 failed 并跳过
  if (missing.length) {
    const msg = `缺少推单必填字段：${missing.join("、")}`;

    await safeUpdateShipment(conn, ship.id, {
      push_status: mapPushStatus("Failed"),
      error_message: msg,
      updated_at: new Date(),
    });
    await addEvent(conn, ship.id, "PushBlocked", mapPushStatus("Failed"), msg, { missing });

    if (!force) {
      return { ok: false, skipped: true, blocked: true, shipment: ship, error: msg };
    }
    return { ok: false, skipped: true, blocked: false, shipment: ship, error: msg };
  }

  const logisticsNo = ship.yto_request_id ?? buildLogisticsNo({ batchId, leadId });
  await safeUpdateShipment(conn, ship.id, { yto_request_id: logisticsNo, updated_at: new Date() });

  const param = {
    logisticsNo,
    senderName: SENDER.name,
    senderProvinceName: SENDER.province,
    senderCityName: SENDER.city,
    senderCountyName: SENDER.county || undefined,
    senderTownName: SENDER.town || undefined,
    senderAddress: SENDER.address,
    senderMobile: SENDER.mobile,

    recipientName: receiver.name,
    recipientProvinceName: receiver.province,
    recipientCityName: receiver.city,
    recipientCountyName: receiver.county || undefined,
    recipientTownName: receiver.town || undefined,
    recipientAddress: receiver.address,
    recipientMobile: receiver.phone,

    remark: undefined,
    productCode: "PK",
  };

  await safeUpdateShipment(conn, ship.id, { yto_raw_request: JSON.stringify(param), updated_at: new Date() });
  await addEvent(conn, ship.id, "PushRequested", pushStatus, "Call YTO createOrder", { logisticsNo });

  try {
    const resp = await yto.createOrder(param);

    await safeUpdateShipment(conn, ship.id, {
      push_status: mapPushStatus("Pushed"),
      waybill_no: resp.mailNo ?? null,
      error_message: null,
      yto_raw_response: JSON.stringify(resp),
      updated_at: new Date(),
    });

    await addEvent(conn, ship.id, "PushSucceeded", mapPushStatus("Pushed"), "YTO create success", {
      logisticsNo: resp.logisticsNo,
      mailNo: resp.mailNo,
    });

    const [[updated]] = await conn.query(`SELECT * FROM shipments WHERE id=?`, [ship.id]);
    return { ok: true, skipped: false, shipment: updated || ship };
  } catch (e) {
    let code = null;
    const msg = e?.message ? String(e.message) : "YTO error";

    try {
      const m1 = msg.match(/"code"\s*:\s*(\d+)/);
      const m2 = msg.match(/code=(\d+)/);
      const hit = m1 || m2;
      if (hit) code = Number(hit[1]);
    } catch {}

    const retryable = code ? RETRYABLE_CODES.has(code) : false;

    await safeUpdateShipment(conn, ship.id, {
      push_status: mapPushStatus("Failed"),
      error_message: `${msg} retryable=${retryable}`,
      yto_raw_response: JSON.stringify({ message: msg, code, retryable }),
      updated_at: new Date(),
    });

    await addEvent(conn, ship.id, "PushFailed", mapPushStatus("Failed"), msg, { code, retryable });

    return { ok: false, skipped: false, shipment: ship, error: msg, code, retryable };
  }
}

export async function pushBatchToYto(batchId, options = {}) {
  const bid = Number(batchId);
  if (!bid || Number.isNaN(bid)) throw new Error("invalid batchId");

  const retryFailedOnly = !!options.retryFailedOnly;
  const limit = options.limit ? Number(options.limit) : null;
  const force = !!options.force;

  const conn = await db.getConnection();
  try {
    const sql =
      `SELECT lead_id FROM campaign_batch_items WHERE batch_id=? ORDER BY id ASC ` +
      (limit ? "LIMIT ?" : "");
    const [items] = await conn.query(sql, limit ? [bid, limit] : [bid]);

    const results = [];
    let success = 0;
    let failed = 0;
    let skipped = 0;
    let blocked = 0;

    for (const it of items) {
      const leadId = it.lead_id;

      const oneConn = await db.getConnection();
      try {
        await oneConn.beginTransaction();
        const r = await pushOneShipment(oneConn, { batchId: bid, leadId, retryFailedOnly, force });
        await oneConn.commit();

        results.push({ leadId, ...r });

        if (r.blocked) blocked++;
        if (r.skipped) skipped++;
        else if (r.ok) success++;
        else failed++;
      } catch (e) {
        try { await oneConn.rollback(); } catch {}
        results.push({ leadId, ok: false, skipped: false, error: e?.message || String(e) });
        failed++;
      } finally {
        oneConn.release();
      }
    }

    return { batchId: bid, total: items.length, success, failed, skipped, blocked, results };
  } finally {
    conn.release();
  }
}

export async function repushFailed(batchId, options = {}) {
  return pushBatchToYto(batchId, { ...options, retryFailedOnly: true });
}

export async function listByBatch({ batchId }) {
  await loadShipmentMeta();
  const [rows] = await db.query(`SELECT * FROM shipments WHERE batch_id=? ORDER BY id ASC`, [Number(batchId)]);
  return (rows || []).map((r) => ({
    ...r,
    leadId: r.lead_id,
    batchId: r.batch_id,
    pushStatus: r.push_status,
    waybillNo: r.waybill_no,
    errorMessage: r.error_message,
  }));
}

function normalizeArgs(arg1, arg2) {
  if (typeof arg1 === "number" || /^[0-9]+$/.test(String(arg1))) {
    return { batchId: Number(arg1), options: arg2 || {} };
  }
  if (arg1 && typeof arg1 === "object") {
    const batchId = Number(arg1.batchId ?? arg1.batch_id ?? arg1.id);
    const options = {
      limit: arg1.limit ?? arg1.options?.limit,
      retryFailedOnly: !!(arg1.retryFailedOnly ?? arg1.options?.retryFailedOnly),
      force: !!(arg1.force ?? arg1.options?.force),
    };
    return { batchId, options };
  }
  return { batchId: NaN, options: {} };
}

export async function pushBatchToYtoCompat(arg1, arg2) {
  const { batchId, options } = normalizeArgs(arg1, arg2);
  if (!batchId || Number.isNaN(batchId)) throw new Error("invalid batchId");
  return pushBatchToYto(batchId, options);
}

export async function repushFailedCompat(arg1, arg2) {
  const { batchId, options } = normalizeArgs(arg1, arg2);
  if (!batchId || Number.isNaN(batchId)) throw new Error("invalid batchId");
  return repushFailed(batchId, options);
}

export default {
  precheckBatchToYto,
  pushBatchToYto: pushBatchToYtoCompat,
  repushFailed: repushFailedCompat,
  listByBatch,
};