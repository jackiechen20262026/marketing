import "dotenv/config";
import fs from "node:fs";
import crypto from "node:crypto";
import { db } from "../db.js";
const target = process.argv[2];
if (
  target !== process.env.DB_NAME ||
  !/^marketing(?:_upgrade_restore_\d+)?$/.test(target)
)
  throw Error("Database guard");
const username =
  target === "marketing" ? "marketing_ai_read" : "marketing_ai_test_read";
const password = crypto.randomBytes(32).toString("hex");
const grants = {
  users: "id,role,status",
  leads:
    "id,company_name,workflow_stage,customer_level,important_flag,is_closed,is_active,owner_id",
  mailing_events: "id,lead_id,event_type,event_at",
  shipments:
    "id,lead_id,waybill_no,logistics_status,query_status,latest_event_at,latest_event_desc,sign_receive_type,dispatched_at,signed_at,confirmed_received_at,track_json",
  lead_followups: "id,lead_id,followup_type,content,created_at",
  mailing_plans: "lead_id,months,next_at,timezone,paused,enabled",
  mailing_exceptions: "id,lead_id,shipment_id,kind,status,reason,created_at",
};
try {
  const [exists] = await db.query("SELECT User FROM mysql.user WHERE User=?", [
    username,
  ]);
  if (exists.length)
    throw Error(
      "Reader exists; retain its existing password/configuration, do not rotate automatically",
    );
  await db.query("CREATE USER ?@'localhost' IDENTIFIED BY ?", [
    username,
    password,
  ]);
  for (const [table, columns] of Object.entries(grants))
    await db.query(
      `GRANT SELECT (${columns}) ON \`${target}\`.\`${table}\` TO ?@'localhost'`,
      [username],
    );
  fs.appendFileSync(
    ".env",
    `\nAI_DB_USER=${username}\nAI_DB_PASSWORD=${password}\n`,
  );
  console.log("Provisioned column-limited AI reader for " + target);
} catch (error) {
  // Do not log mysql2's SQL field: CREATE USER contains a newly generated secret.
  throw new Error(error.code || "AI_READER_PROVISION_FAILED");
} finally {
  await db.end();
}
