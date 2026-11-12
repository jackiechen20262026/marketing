import "dotenv/config";
import fs from "node:fs";
import { db } from "../db.js";
import { parseTrackSummary } from "../services/shipment.track.service.js";
import { recordMailEvent } from "../services/mailing.service.js";
import { utcSql, wallToUtc, TRACK_ZONE } from "../services/mailingCalendar.js";
if (
  process.argv[2] !== process.env.DB_NAME ||
  !/^marketing(?:_(?:upgrade_restore|restore_final)_\d+)?$/.test(process.env.DB_NAME)
)
  throw Error("Explicit Marketing database mismatch");
const suspicious = [];
let last = 0,
  total = 0;
try {
  while (true) {
    const [rows] = await db.query(
      "SELECT * FROM shipments WHERE id>? ORDER BY id LIMIT 100",
      [last],
    );
    if (!rows.length) break;
    for (const ship of rows) {
      last = ship.id;
      const c = await db.getConnection();
      try {
        await c.beginTransaction();
        const [[pushed]] = await c.query(
          "SELECT MIN(created_at) at FROM shipment_events WHERE shipment_id=? AND event_type='PushSucceeded'",
          [ship.id],
        );
        if (pushed?.at && ship.waybill_no) {
          const at = utcSql(wallToUtc(pushed.at));
          await recordMailEvent(
            c,
            ship,
            "ordered",
            at,
            "Historical PushSucceeded event",
          );
          await c.query(
            "UPDATE shipments SET order_succeeded_at=COALESCE(order_succeeded_at,?) WHERE id=?",
            [at, ship.id],
          );
        }
        let summary = null;
        try {
          if(ship.track_json)summary = parseTrackSummary(JSON.parse(ship.track_json), {waybillNo:ship.waybill_no});
        } catch {}
        if (summary?.queryStatus === "OK") {
          const parse = (v) => {
            try {
              return v ? utcSql(wallToUtc(v, TRACK_ZONE)) : null;
            } catch {
              return null;
            }
          };
          // Materialize derived display fields only; never rewrite legacy logistics_status or signed_at.
          await c.query(
            "UPDATE shipments SET track_fact_status=COALESCE(track_fact_status,?),query_status=COALESCE(query_status,?),latest_event_at=COALESCE(latest_event_at,?),latest_event_desc=COALESCE(latest_event_desc,?),sign_receive_type=COALESCE(sign_receive_type,?) WHERE id=?",
            [
              summary.statusText,
              summary.queryStatus,
              parse(summary.latestTime),
              summary.latestDesc,
              summary.signReceiveType,
              ship.id,
            ],
          );
          const pickup = summary.nodes.find(
            (n) => n.raw?.infoContent === "GOT" && parse(n.time),
          );
          if (pickup) {
            const at = parse(pickup.time);
            await recordMailEvent(
              c,
              ship,
              "dispatched",
              at,
              "Historical YTO GOT node",
            );
            await c.query(
              "UPDATE shipments SET dispatched_at=COALESCE(dispatched_at,?),dispatch_source=COALESCE(dispatch_source,'tracking'),dispatch_evidence=COALESCE(dispatch_evidence,'Historical YTO GOT node') WHERE id=?",
              [at, ship.id],
            );
          }
          if (summary.hasRecipientSignedFact)
            await recordMailEvent(
              c,
              ship,
              "signed",
              parse(summary.recipientSignedTime),
              "Historical YTO recipient SIGNED node",
            );
        } else if (summary) {
          await c.query(
            "UPDATE shipments SET query_status=COALESCE(query_status,?) WHERE id=?",
            [summary.queryStatus, ship.id],
          );
        }
        if (ship.signed_at && !summary?.isSigned)
          suspicious.push({
            shipmentId: ship.id,
            leadId: ship.lead_id,
            reason: "历史签收与现存节点不一致，待人工核查",
          });
        await c.commit();
        total++;
      } catch (e) {
        await c.rollback();
        throw e;
      } finally {
        c.release();
      }
    }
  }
  if (process.env.MAIL_REVIEW_FILE)
    fs.writeFileSync(
      process.env.MAIL_REVIEW_FILE,
      JSON.stringify(suspicious, null, 2),
    );
  console.log({ total, suspicious: suspicious.length });
} finally {
  await db.end();
}
