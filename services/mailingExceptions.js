import { db } from "../db.js";
import { transaction } from "./mailing.service.js";
import { assertLead, audit, currentUser } from "./marketingAccess.js";
export const exceptionHours = {
  noPickup: Number(process.env.MAIL_NO_PICKUP_HOURS || 48),
  stale: Number(process.env.MAIL_STALE_HOURS || 72),
  proxy: Number(process.env.MAIL_PROXY_CONFIRM_HOURS || 24),
};
export async function openException(c, s, kind, reason, blocking = false) {
  await c.query(
    `INSERT IGNORE INTO mailing_exceptions(lead_id,shipment_id,kind,owner_id,reason,blocking) SELECT ?,?,?,owner_id,?,? FROM leads WHERE id=?`,
    [s.lead_id, s.id, kind, reason, blocking, s.lead_id],
  );
  if (kind === "customer_not_received" || s.latest_event_at) {
    await c.query(
      "UPDATE mailing_exceptions SET status='open',reason=?,resolved_at=NULL WHERE shipment_id=? AND kind=? AND status='resolved' AND (?=1 OR resolved_at<?)",
      [
        reason,
        s.id,
        kind,
        kind === "customer_not_received" ? 1 : 0,
        s.latest_event_at || null,
      ],
    );
  }
  await c.query(
    `INSERT INTO todo_tasks(lead_id,shipment_id,owner_user_id,task_type,due_at,dedupe_key,remark)
 SELECT lead_id,shipment_id,owner_id,'mailing_exception',UTC_TIMESTAMP(),CONCAT('exception:',id),reason FROM mailing_exceptions WHERE shipment_id=? AND kind=? AND status='open'
 ON DUPLICATE KEY UPDATE status=IF(todo_tasks.status IN ('done','skip'),'pending',todo_tasks.status),resolved_at=NULL,remark=VALUES(remark)`,
    [s.id, kind],
  );
}
export async function scanExceptions() {
  const c = await db.getConnection();
  try {
    const [[lock]] = await c.query(
      "SELECT GET_LOCK('marketing-exception-scan',0) ok",
    );
    if (!lock.ok) return;
    try {
      let last = 0;
      while (true) {
        const [rows] = await c.query(
          `SELECT s.* FROM shipments s JOIN leads l ON l.id=s.lead_id WHERE s.id>? AND s.waybill_no IS NOT NULL AND l.is_active=1 AND l.is_closed=0 AND s.released_for_mailing_at IS NULL ORDER BY s.id LIMIT 200`,
          [last],
        );
        if (!rows.length) break;
        for (const s of rows) {
          last = s.id;
          const age = (v) =>
            v
              ? (Date.now() - Date.parse(String(v).replace(" ", "T") + "Z")) /
                3600000
              : 0;
          if (
            !s.dispatched_at &&
            s.order_succeeded_at &&
            age(s.order_succeeded_at) > exceptionHours.noPickup
          )
            await openException(
              c,
              s,
              "no_pickup",
              "下单后尚无可靠揽收依据；请核查，不能认定客户未收信",
            );
          if ((s.track_fact_status || s.logistics_status) === "EXCEPTION")
            await openException(
              c,
              s,
              /退回|退件/.test(s.latest_event_desc || "")
                ? "returned"
                : /拒收/.test(s.latest_event_desc || "")
                  ? "refused"
                  : "delivery_error",
              "物流存在明确异常，请人工处理",
              true,
            );
          if (
            s.latest_event_at &&
            s.logistics_status === "IN_TRANSIT" &&
            age(s.latest_event_at) > exceptionHours.stale
          )
            await openException(c, s, "stale", "物流节点长时间未更新");
          if (
            s.sign_receive_type &&
            /代收|门卫|前台|驿站/.test(s.sign_receive_type) &&
            !s.confirmed_received_at &&
            age(s.signed_observed_at) > exceptionHours.proxy
          )
            await openException(c, s, "proxy_confirm", "代收后等待客户确认");
        }
      }
    } finally {
      await c.query("SELECT RELEASE_LOCK('marketing-exception-scan')");
    }
  } finally {
    c.release();
  }
}
export async function resolveException(user, id, input) {
  return transaction(async (c) => {
    const [[x]] = await c.query("SELECT * FROM mailing_exceptions WHERE id=?", [
      id,
    ]);
    if (!x) throw Error("异常不存在");
    await assertLead(user, x.lead_id, c, true);
    const note = String(input.note || "").trim();
    if (!note || !input.condition) throw Error("必须说明处理结果和解除条件");
    await c.query(
      "UPDATE mailing_exceptions SET status='resolved',note=?,resolved_at=UTC_TIMESTAMP() WHERE id=?",
      [note, id],
    );
    await c.query(
      "UPDATE todo_tasks SET status='done',resolved_at=UTC_TIMESTAMP(),remark=? WHERE dedupe_key=?",
      [note, "exception:" + id],
    );
    if(input.release_reservation==='1'){
      const actor=await currentUser(user.id,c);if(actor.role!=='Admin')throw Error('解除原单占用需要管理员');
      await c.query('UPDATE shipments SET released_for_mailing_at=COALESCE(released_for_mailing_at,UTC_TIMESTAMP()) WHERE id=?',[x.shipment_id]);
      await c.query('DELETE r FROM mailing_reservations r JOIN shipments s ON s.lead_id=r.lead_id AND s.batch_id=r.batch_id WHERE s.id=?',[x.shipment_id]);
      await audit(c,{leadId:x.lead_id,userId:user.id,action:'shipment_reservation_released',reason:input.condition,after:{shipmentId:x.shipment_id}});
    }
    await audit(c, {
      leadId: x.lead_id,
      userId: user.id,
      action: "exception_resolved",
      reason: note,
      after: { id, condition: input.condition },
    });
  });
}
