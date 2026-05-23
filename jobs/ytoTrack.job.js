import cron from "node-cron";
import shipmentTrackService from "../services/shipment.track.service.js";

let running = false;

// 每 2 小时执行一次：0 */2 * * *
cron.schedule("0 */2 * * *", async () => {
  if (running) {
    console.log("[ytoTrack.job] skipped: previous run still running");
    return;
  }

  running = true;

  try {
    console.log("[ytoTrack.job] start");

    const result = await shipmentTrackService.updateDueTracks({ limit: 100 });

    console.log("[ytoTrack.job] done:", {
      total: result.total,
      success: result.success,
      failed: result.failed,
      skipped: result.skipped,
    });
  } catch (e) {
    console.error("[ytoTrack.job] failed:", e);
  } finally {
    running = false;
  }
});