import { db } from "../db.js";

/** 批次列表（附带 leadCount） */
export async function listBatches({ limit } = {}) {
  const lim = Math.min(500, Math.max(10, Number(limit || 200)));

  const [rows] = await db.query(
    `
    SELECT b.*,
           (SELECT COUNT(1) FROM campaign_batch_items i WHERE i.batch_id = b.id) AS leadCount
    FROM campaign_batches b
    ORDER BY b.id DESC
    LIMIT ?
    `,
    [lim]
  );

  return (rows || []).map((b) => ({
    ...b,
    batchName: b.batch_name,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  }));
}

/** 创建批次 + 插入 items */
export async function createBatch({ user, batchName, remark, leadIds }) {
  const leadIdsNum = (leadIds || [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));

  if (!batchName) throw new Error("batchName required");
  if (!leadIdsNum.length) throw new Error("leadIds required");

  const createdBy = Number(user?.id) || null;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [ret] = await conn.query(
      `INSERT INTO campaign_batches(batch_name, remark, status, created_by, created_at, updated_at)
       VALUES(?, ?, 'draft', ?, NOW(), NOW())`,
      [batchName, remark || null, createdBy]
    );

    const batchId = ret.insertId;

    const uniq = Array.from(new Set(leadIdsNum));
    for (const leadId of uniq) {
      await conn.query(
        `INSERT INTO campaign_batch_items(batch_id, lead_id, status, error_msg, created_at)
         VALUES(?, ?, 'pending', NULL, NOW())`,
        [batchId, leadId]
      );
    }

    await conn.commit();
    return { id: batchId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 获取批次 */
export async function getBatch({ id }) {
  const batchId = Number(id);
  const [rows] = await db.query(`SELECT * FROM campaign_batches WHERE id=? LIMIT 1`, [batchId]);
  return rows[0] || null;
}

/** 获取批次明细（items + leads 信息） */
export async function getBatchItems({ batchId }) {
  const bid = Number(batchId);

  const [rows] = await db.query(
    `
    SELECT
      i.id,
      i.batch_id,
      i.lead_id,
      i.status AS item_status,
      i.error_msg,
      i.created_at AS item_created_at,

      l.company_name,
      l.contact_name,
      l.phone,
      l.workflow_stage,
      l.customer_level,
      l.category
    FROM campaign_batch_items i
    LEFT JOIN leads l ON l.id = i.lead_id
    WHERE i.batch_id=?
    ORDER BY i.id ASC
    `,
    [bid]
  );

  return (rows || []).map((r) => ({
    ...r,
    leadId: r.lead_id,
    companyName: r.company_name,
    contactName: r.contact_name,
    stage: r.workflow_stage,
    level: r.customer_level,
  }));
}

/** 删除批次：仅 draft 允许删除 */
export async function deleteBatch({ id }) {
  const batchId = Number(id);
  if (!batchId || Number.isNaN(batchId)) throw new Error("invalid batch id");

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, status FROM campaign_batches WHERE id=? LIMIT 1`,
      [batchId]
    );

    const batch = rows?.[0];
    if (!batch) throw new Error("批次不存在");
    if (String(batch.status || "").toLowerCase() !== "draft") {
      throw new Error("仅未推送批次允许删除");
    }

    await conn.query(`DELETE FROM campaign_batch_items WHERE batch_id=?`, [batchId]);
    await conn.query(`DELETE FROM campaign_batches WHERE id=?`, [batchId]);

    await conn.commit();
    return { ok: true, id: batchId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 删除选中明细：仅 draft 允许，把客户移出当前批次 */
export async function removeBatchItems({ batchId, leadIds }) {
  const bid = Number(batchId);
  const ids = Array.from(
    new Set((leadIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)))
  );

  if (!bid || Number.isNaN(bid)) throw new Error("invalid batch id");
  if (!ids.length) throw new Error("请先勾选要移出的线索");

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, status FROM campaign_batches WHERE id=? LIMIT 1`,
      [bid]
    );

    const batch = rows?.[0];
    if (!batch) throw new Error("批次不存在");
    if (String(batch.status || "").toLowerCase() !== "draft") {
      throw new Error("仅未推送批次允许移除线索");
    }

    const placeholders = ids.map(() => "?").join(",");
    const [ret] = await conn.query(
      `DELETE FROM campaign_batch_items
       WHERE batch_id=?
         AND lead_id IN (${placeholders})`,
      [bid, ...ids]
    );

    await conn.query(
      `UPDATE campaign_batches
       SET updated_at=NOW()
       WHERE id=?`,
      [bid]
    );

    await conn.commit();
    return { ok: true, batchId: bid, removed: Number(ret?.affectedRows || 0) };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 推送完成后标记批次完成 */
export async function markBatchCompleted({ id }) {
  const batchId = Number(id);
  if (!batchId || Number.isNaN(batchId)) throw new Error("invalid batch id");

  await db.query(
    `UPDATE campaign_batches
     SET status='completed', updated_at=NOW()
     WHERE id=?`,
    [batchId]
  );

  return { ok: true, id: batchId };
}

export default {
  listBatches,
  createBatch,
  getBatch,
  getBatchItems,
  deleteBatch,
  removeBatchItems,
  markBatchCompleted,
};