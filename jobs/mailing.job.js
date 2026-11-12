import cron from "node-cron";
import { scanPlans } from "../services/mailing.service.js";
import { scanExceptions } from "../services/mailingExceptions.js";
export async function scanMailing() {
  await scanPlans();
  await scanExceptions();
}
if (process.env.DISABLE_JOBS !== "1")
  cron.schedule(
    "*/5 * * * *",
    () =>
      scanMailing().catch((e) =>
        console.error("[mailing scan]", e.code || "FAILED"),
      ),
    { timezone: "Europe/Berlin", noOverlap: true },
  );
