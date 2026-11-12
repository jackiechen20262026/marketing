import { db } from "../db.js";
import { assertLead, audit, currentUser } from "./marketingAccess.js";
import {
  BUSINESS_ZONE,
  wallToUtc,
  utcSql,
  fromUtcSql,
  addNaturalMonths,
} from "./mailingCalendar.js";
export async function transaction(fn) {
  const c = await db.getConnection();
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await c.beginTransaction();
    const v = await fn(c);
    await c.commit();
    return v;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
const integer = (v, min, max) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error("整数参数超出范围");
  return n;
};
export async function setImportant(user, id, flag) {
  return transaction(async (c) => {
    const l = await assertLead(user, id, c, true);
    const value = flag ? 1 : 0;
    await c.query("UPDATE leads SET important_flag=? WHERE id=?", [value, id]);
    await audit(c, {
      leadId: id,
      userId: user.id,
      action: "important",
      before: { flag: l.important_flag },
      after: { flag: value },
    });
  });
}
export async function savePlan(user, id, input) {
  return transaction(async (c) => {
    const l = await assertLead(user, id, c, true);
    const [[old]] = await c.query(
      "SELECT * FROM mailing_plans WHERE lead_id=?",
      [id],
    );
    if (old && Number(input.version) !== old.version)
      throw Error("计划已被修改，请刷新后重试");
    const reason = String(input.reason || "").trim();
    if (!reason) throw Error("请填写修改或暂停原因");
    const enabled = input.enabled === "1",
      paused = input.paused === "1";
    if (
      enabled &&
      (!l.is_active || l.is_closed || l.workflow_stage === "已关闭")
    )
      throw Error("已关闭或停用客户不能启用计划");
    const next = input.next_at ? utcSql(wallToUtc(input.next_at)) : null;
    if (enabled && !next)
      throw Error("请明确设置首次/下一次发信日期，不能从单号推测寄出日期");
    const months = integer(input.months, 1, 1200),
      days = integer(input.reminder_days ?? 3, 0, 365);
    const owner = input.owner_id
      ? integer(input.owner_id, 1, Number.MAX_SAFE_INTEGER)
      : null;
    if (owner) await currentUser(owner, c);
    const actor = await currentUser(user.id, c);
    if (actor.role !== "Admin" && owner && String(owner) !== String(actor.id))
      throw Error("仅管理员可以转派负责人");
    const version = (old?.version || 0) + 1;
    await c.query(
      `INSERT INTO mailing_plans(lead_id,enabled,months,next_at,reminder_days,owner_id,paused,pause_reason,version,manual_next)
 VALUES(?,?,?,?,?,?,?,?,?,1) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),months=VALUES(months),next_at=VALUES(next_at),reminder_days=VALUES(reminder_days),owner_id=VALUES(owner_id),paused=VALUES(paused),pause_reason=VALUES(pause_reason),version=VALUES(version),manual_next=1,updated_at=NOW()`,
      [
        id,
        enabled,
        months,
        next,
        days,
        owner,
        paused,
        paused ? reason : null,
        version,
      ],
    );
    await c.query(
      "UPDATE todo_tasks SET status='skip',resolved_at=NOW(),remark='计划已修改' WHERE lead_id=? AND task_type='mailing_due' AND status IN ('pending','planned')",
      [id],
    );
    await audit(c, {
      leadId: id,
      userId: user.id,
      action: "plan_changed",
      reason,
      before: old,
      after: {
        enabled,
        months,
        next,
        days,
        owner,
        paused,
        version,
        timezone: BUSINESS_ZONE,
      },
    });
  });
}
// Shared eligibility expression: aliases are internal constants, never user input.
export function eligibilitySql({ ignoreBatch = null, early = false } = {}) {
  const occupancy =
    ignoreBatch == null
      ? ""
      : ` AND i.batch_id<>${integer(ignoreBatch, 1, Number.MAX_SAFE_INTEGER)}`;
  return `l.is_active=1 AND COALESCE(l.is_closed,0)=0 AND l.workflow_stage NOT IN ('已关闭','已成交')
 AND NOT EXISTS(SELECT 1 FROM mailing_exceptions x WHERE x.lead_id=l.id AND x.status='open' AND x.blocking=1)
 AND NOT EXISTS(SELECT 1 FROM mailing_plans p WHERE p.lead_id=l.id AND p.paused=1)
 AND NOT EXISTS(SELECT 1 FROM campaign_batch_items i JOIN campaign_batches b ON b.id=i.batch_id LEFT JOIN shipments sx ON sx.batch_id=i.batch_id AND sx.lead_id=i.lead_id WHERE i.lead_id=l.id AND i.status<>'removed' AND ((b.status IN ('draft','ready','pushing') AND (sx.id IS NULL OR (sx.dispatched_at IS NULL AND sx.released_for_mailing_at IS NULL))) OR (sx.waybill_no IS NOT NULL AND sx.dispatched_at IS NULL AND sx.released_for_mailing_at IS NULL))${occupancy})
 AND NOT EXISTS(SELECT 1 FROM shipments sx WHERE sx.id=(SELECT MAX(s.id) FROM shipments s WHERE s.lead_id=l.id AND s.waybill_no IS NOT NULL) AND COALESCE(sx.track_fact_status,sx.logistics_status) IN ('EXCEPTION','RETURNED','REFUSED') AND NOT EXISTS(SELECT 1 FROM mailing_exceptions x WHERE x.shipment_id=sx.id AND x.blocking=1 AND x.status='resolved'))
 AND (${
   early
     ? "1=1"
     : `CASE WHEN EXISTS(SELECT 1 FROM mailing_plans p WHERE p.lead_id=l.id AND p.enabled=1)
 THEN EXISTS(SELECT 1 FROM mailing_plans p WHERE p.lead_id=l.id AND p.enabled=1 AND p.next_at<=UTC_TIMESTAMP())
 ELSE NOT EXISTS(SELECT 1 FROM shipments s WHERE s.lead_id=l.id AND s.waybill_no IS NOT NULL AND TRIM(s.waybill_no)<>'' AND s.created_at>=DATE_SUB(NOW(),INTERVAL IF(NULLIF(TRIM(l.wechat_group_code),'') IS NULL,30,90) DAY)) END`
 })`;
}
export async function assertEligible(
  c,
  id,
  { ignoreBatch, early = false } = {},
) {
  const [[row]] = await c.query(
    `SELECT l.id FROM leads l WHERE l.id=? AND ${eligibilitySql({ ignoreBatch, early })}`,
    [id],
  );
  if (!row) throw Error(`客户 #${id} 尚未到期、暂停、有异常或已被批次占用`);
}
export async function scanPlans() {
  return transaction(async (c) => {
    const [[lock]] = await c.query(
      "SELECT GET_LOCK('marketing-mailing-scan',0) ok",
    );
    if (!lock.ok) return { skipped: true };
    try {
      await c.query(`UPDATE todo_tasks t JOIN leads l ON l.id=t.lead_id LEFT JOIN mailing_plans p ON p.lead_id=l.id
 SET t.status='skip',t.resolved_at=NOW(),t.remark='计划停用或客户关闭'
 WHERE t.task_type='mailing_due' AND t.status IN ('pending','planned') AND (l.is_active=0 OR l.is_closed=1 OR l.workflow_stage='已关闭' OR p.enabled=0 OR p.paused=1 OR p.version<>t.plan_version)`);
      const [r] =
        await c.query(`INSERT INTO todo_tasks(lead_id,owner_user_id,task_type,due_at,status,dedupe_key,plan_version)
 SELECT p.lead_id,p.owner_id,'mailing_due',p.next_at,'pending',CONCAT('mail:',p.lead_id,':',p.version),p.version
 FROM mailing_plans p JOIN leads l ON l.id=p.lead_id
 WHERE p.enabled=1 AND p.paused=0 AND p.next_at<=DATE_ADD(UTC_TIMESTAMP(),INTERVAL p.reminder_days DAY)
 AND l.is_active=1 AND l.is_closed=0 AND l.workflow_stage NOT IN ('已关闭','已成交')
 AND NOT EXISTS(SELECT 1 FROM mailing_exceptions x WHERE x.lead_id=l.id AND x.status='open' AND x.blocking=1)
 ON DUPLICATE KEY UPDATE dedupe_key=VALUES(dedupe_key)`);
      return { affected: r.affectedRows };
    } finally {
      await c.query("SELECT RELEASE_LOCK('marketing-mailing-scan')");
    }
  });
}
export async function recordMailEvent(c, ship, type, at, evidence) {
  if (!ship.waybill_no) throw Error("缺少运单号");
  const [r] = await c.query(
    `INSERT IGNORE INTO mailing_events(lead_id,shipment_id,event_type,event_key,event_at,observed_at,evidence,is_resend) VALUES(?,?,?,?,?,UTC_TIMESTAMP(),?,?)`,
    [
      ship.lead_id,
      ship.id,
      type,
      `${ship.carrier || "YTO"}:${ship.waybill_no}`,
      at,
      evidence,
      ship.original_shipment_id ? 1 : 0,
    ],
  );
  return r.affectedRows === 1;
}
export async function dispatchInTransaction(
  c,
  ship,
  at,
  evidence,
  source,
  userId = null,
) {
  const fresh = await recordMailEvent(c, ship, "dispatched", at, evidence);
  if (!fresh) return false;
  await c.query(
    "UPDATE shipments SET dispatched_at=COALESCE(dispatched_at,?),dispatch_evidence=COALESCE(dispatch_evidence,?),dispatch_source=COALESCE(dispatch_source,?) WHERE id=?",
    [at, evidence, source, ship.id],
  );
  if (!ship.original_shipment_id) {
    const [[p]] = await c.query(
      "SELECT * FROM mailing_plans WHERE lead_id=? FOR UPDATE",
      [ship.lead_id],
    );
    const [[item]] = await c.query(
      "SELECT plan_version FROM campaign_batch_items WHERE batch_id=? AND lead_id=?",
      [ship.batch_id, ship.lead_id],
    );
    if (p?.enabled && item?.plan_version === p.version) {
      const next = utcSql(addNaturalMonths(fromUtcSql(at), p.months));
      await c.query(
        "UPDATE mailing_plans SET next_at=?,version=version+1,manual_next=0,updated_at=NOW() WHERE lead_id=?",
        [next, ship.lead_id],
      );
      await c.query(
        "UPDATE todo_tasks SET status='done',resolved_at=NOW() WHERE lead_id=? AND task_type='mailing_due' AND plan_version=? AND status IN ('pending','planned')",
        [ship.lead_id, p.version],
      );
      await audit(c, {
        leadId: ship.lead_id,
        userId,
        action: "cycle_completed",
        reason: evidence,
        before: { next: p.next_at, version: p.version },
        after: { next, shipmentId: ship.id },
      });
    }
  }
  await c.query(
    "DELETE FROM mailing_reservations WHERE lead_id=? AND batch_id=?",
    [ship.lead_id, ship.batch_id],
  );
  return true;
}
export async function shipmentAction(user, id, input) {
  return transaction(async (c) => {
    const [[ship]] = await c.query("SELECT * FROM shipments WHERE id=?", [id]);
    if (!ship) throw Error("运单不存在");
    await assertLead(user, ship.lead_id, c, true);
    const evidence = String(input.evidence || "").trim();
    if (!evidence) throw Error("必须填写凭证或确认记录");
    const at = utcSql(wallToUtc(input.at));
    if (fromUtcSql(at) > new Date()) throw Error("不能记录未来的业务事实");
    if (input.action === "dispatch")
      await dispatchInTransaction(c, ship, at, evidence, "manual", user.id);
    else if (input.action === "confirm") {
      await recordMailEvent(c, ship, "confirmed", at, evidence);
      await c.query(
        "UPDATE shipments SET confirmed_received_at=COALESCE(confirmed_received_at,?) WHERE id=?",
        [at, id],
      );
    } else throw Error("未知操作");
    await audit(c, {
      leadId: ship.lead_id,
      userId: user.id,
      action: input.action,
      reason: evidence,
      after: { shipmentId: id, at },
    });
  });
}
