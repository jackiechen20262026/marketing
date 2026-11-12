import {assertEligible} from './mailing.service.js';
import {currentUser,audit} from './marketingAccess.js';
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
export async function createBatch({ user, batchName, remark, leadIds, early=false, reason=null, originalShipmentId=null }) {
  const leadIdsNum = (leadIds || [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));

  if (!batchName) throw new Error("batchName required");
  if (!leadIdsNum.length) throw new Error("leadIds required");

  const createdBy = Number(user?.id) || null;

  const conn = await db.getConnection();
  try {
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await conn.beginTransaction();

    const [ret] = await conn.query(
      `INSERT INTO campaign_batches(batch_name, remark, status, created_by, created_at, updated_at)
       VALUES(?, ?, 'draft', ?, NOW(), NOW())`,
      [batchName, remark || null, createdBy]
    );

    const batchId = ret.insertId;

    const uniq = Array.from(new Set(leadIdsNum)).sort((a,b)=>a-b);
    const actor=await currentUser(user?.id,conn);
    if(early && (actor.role!=='Admin'||!String(reason||'').trim()))throw Error('提前发件需要管理员权限和原因');
    if(originalShipmentId&&(!early||uniq.length!==1))throw Error('补寄需要独立草稿和人工授权');
    for (const leadId of uniq) {
      await conn.query('SELECT id FROM leads WHERE id=? FOR UPDATE',[leadId]);
      await assertEligible(conn,leadId,{early});
      const [[plan]]=await conn.query('SELECT version FROM mailing_plans WHERE lead_id=? AND enabled=1',[leadId]);
      await conn.query('INSERT INTO mailing_reservations(lead_id,batch_id,plan_version) VALUES(?,?,?)',[leadId,batchId,plan?.version||null]);
      await conn.query(
        `INSERT INTO campaign_batch_items(batch_id, lead_id, status, error_msg, created_at)
         VALUES(?, ?, 'pending', NULL, NOW())`,
        [batchId, leadId]
      );
      if(originalShipmentId){
        const [[original]]=await conn.query('SELECT id,lead_id,waybill_no FROM shipments WHERE id=?',[originalShipmentId]);
        if(!original||!original.waybill_no||String(original.lead_id)!==String(leadId))throw Error('原运单不属于此客户');
        await conn.query("INSERT INTO shipments(batch_id,lead_id,original_shipment_id,push_status) VALUES(?,?,?,'pending')",[batchId,leadId,originalShipmentId]);
        await audit(conn,{leadId,userId:user.id,action:'resend_draft',reason,after:{originalShipmentId,batchId}});
      }
    }

    await conn.query('UPDATE campaign_batch_items i JOIN mailing_reservations r ON r.batch_id=i.batch_id AND r.lead_id=i.lead_id SET i.plan_version=r.plan_version WHERE i.batch_id=?',[batchId]);
    if(early)for(const leadId of uniq)await audit(conn,{leadId,userId:user.id,action:'early_send',reason,after:{batchId}});
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
    const [[lock]]=await conn.query('SELECT GET_LOCK(?,0) ok',['marketing-batch:'+batchId]);
    if(!lock.ok)throw Error('BATCH_BUSY');
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, status FROM campaign_batches WHERE id=? LIMIT 1 FOR UPDATE`,
      [batchId]
    );

    const batch = rows?.[0];
    if (!batch) throw new Error("批次不存在");
    if (String(batch.status || "").toLowerCase() !== "draft") {
      throw new Error("仅未推送批次允许删除");
    }

    const [[pushed]]=await conn.query('SELECT COUNT(*) n FROM shipments WHERE (waybill_no IS NOT NULL OR yto_request_id IS NOT NULL) AND batch_id=?',[batchId]);
    if(Number(pushed.n))throw Error('已有运单的批次不能删除');
    await conn.query('DELETE FROM mailing_reservations WHERE batch_id=?',[batchId]);
    await conn.query("UPDATE campaign_batch_items SET status='removed' WHERE batch_id=?",[batchId]);
    await conn.query("UPDATE campaign_batches SET status='closed' WHERE id=?",[batchId]);

    await conn.commit();
    return { ok: true, id: batchId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)',['marketing-batch:'+batchId]);
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
    const [[lock]]=await conn.query('SELECT GET_LOCK(?,0) ok',['marketing-batch:'+bid]);
    if(!lock.ok)throw Error('BATCH_BUSY');
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
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
    const [[pushed]]=await conn.query('SELECT COUNT(*) n FROM shipments WHERE (waybill_no IS NOT NULL OR yto_request_id IS NOT NULL) AND batch_id=? AND lead_id IN ('+placeholders+')',[bid,...ids]);
    if(Number(pushed.n))throw Error('已有运单不能移出');
    await conn.query('DELETE FROM mailing_reservations WHERE batch_id=? AND lead_id IN ('+placeholders+')',[bid,...ids]);
    const [ret] = await conn.query(
      `UPDATE campaign_batch_items SET status='removed'
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
    await conn.query('SELECT RELEASE_LOCK(?)',['marketing-batch:'+bid]);
    conn.release();
  }
}

/** 推送完成后标记批次完成 */
export async function markBatchCompleted({ id }) {
  const batchId = Number(id);
  if (!batchId || Number.isNaN(batchId)) throw new Error("invalid batch id");

  await db.query(
    `UPDATE campaign_batches
     SET status=CASE WHEN EXISTS(SELECT 1 FROM shipments s WHERE s.batch_id=? AND NULLIF(TRIM(s.waybill_no),'') IS NOT NULL) THEN 'done' ELSE 'draft' END, updated_at=NOW()
     WHERE id=? AND status<>'closed'`,
    [batchId,batchId]
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
