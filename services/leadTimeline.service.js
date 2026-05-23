import { db } from "../db.js";

function rid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

async function getTimeline({ leadId }) {
  const [followups] = await db.query(
    `SELECT id, channel, content, result, created_at AS createdAt, user_id AS userId
     FROM lead_followups
     WHERE lead_id=:leadId
     ORDER BY created_at DESC
     LIMIT 200`,
    { leadId }
  );

  const [stages] = await db.query(
    `SELECT id, from_stage AS fromStage, to_stage AS toStage, note, created_at AS createdAt, operator_id AS operatorId
     FROM workflow_stage_history
     WHERE lead_id=:leadId
     ORDER BY created_at DESC
     LIMIT 200`,
    { leadId }
  );

  const [shipments] = await db.query(
    `SELECT id, waybill_no AS waybillNo, push_status AS pushStatus, logistics_status AS logisticsStatus,
            created_at AS createdAt, updated_at AS updatedAt
     FROM shipments
     WHERE lead_id=:leadId
     ORDER BY created_at DESC
     LIMIT 50`,
    { leadId }
  );

  const shipmentIds = (shipments || []).map(x => x.id);
  let events = [];
  if (shipmentIds.length) {
    const placeholders = shipmentIds.map((_, i) => `:id${i}`).join(",");
    const params = shipmentIds.reduce((acc, id, i) => ({ ...acc, [`id${i}`]: id }), {});
    const [ev] = await db.query(
      `SELECT id, shipment_id AS shipmentId, event_time AS eventTime, status, description, location, created_at AS createdAt
       FROM shipment_events
       WHERE shipment_id IN (${placeholders})
       ORDER BY COALESCE(event_time, created_at) DESC
       LIMIT 300`,
      params
    );
    events = ev || [];
  }

  // 统一成 timeline（最新在前）
  const timeline = [
    ...(stages || []).map(x => ({
      type: "stage",
      at: x.createdAt,
      title: `阶段变更：${x.fromStage || "-"} → ${x.toStage}`,
      meta: x.operatorId || "",
      note: x.note || "",
    })),
    ...(followups || []).map(x => ({
      type: "followup",
      at: x.createdAt,
      title: `跟进：${x.channel}`,
      meta: x.userId || "",
      note: `${x.content}${x.result ? `（结果：${x.result}）` : ""}`,
    })),
    ...(events || []).map(x => ({
      type: "logistics",
      at: x.eventTime || x.createdAt,
      title: `物流：${x.status || "-"}`,
      meta: x.location || "",
      note: x.description || "",
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return timeline;
}

async function addFollowup({ leadId, userId, channel, content, result }) {
  await db.query(
    `INSERT INTO lead_followups(id, lead_id, user_id, channel, content, result, created_at)
     VALUES(:id, :leadId, :userId, :channel, :content, :result, NOW())`,
    { id: rid("lf"), leadId, userId, channel, content, result }
  );
}

export default {
  getTimeline,
  addFollowup,
};
