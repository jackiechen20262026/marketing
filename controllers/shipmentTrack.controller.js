import {
  listTrackSummary,
  updateTrackByShipmentId,
  listTrackLogs,
  getTrackDetailByShipmentId,
} from "../services/shipment.track.service.js";

/**
 * 轨迹汇总页
 */
export async function trackSummaryPage(req, res) {
  try {
    const range = req.query.range || "90";
    const keyword = String(req.query.keyword || "").trim();
    const signType = String(req.query.signType || "").trim();

    const result = await listTrackSummary({
      range,
      keyword,
      signType,
    });

    res.render("shipments/trackSummary", {
      title: "圆通轨迹",
      range,
      keyword,
      signType,
      rows: result.rows || [],
      signTypeMonthlyStats: result.signTypeMonthlyStats || [],
    });
  } catch (e) {
    console.error("trackSummaryPage error:", e);
    res.status(500).send("trackSummaryPage error");
  }
}

/**
 * 单条轨迹详情 API
 */
export async function trackDetailApi(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ ok: false, error: "invalid id" });
    }

    const data = await getTrackDetailByShipmentId(id);
    if (!data) {
      return res.status(404).json({ ok: false, error: "not found" });
    }

    return res.json({
      ok: true,
      shipment: data.shipment,
      raw: data.raw,
      summary: data.summary,
    });
  } catch (e) {
    console.error("trackDetailApi error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

/**
 * 手动刷新单条轨迹
 */
export async function refreshOneTrack(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "invalid id" });

    const r = await updateTrackByShipmentId(id, {
      force: true,
      source: "manual",
    });

    if (!r.ok) return res.status(500).json(r);
    return res.json(r);
  } catch (e) {
    console.error("refreshOneTrack error:", e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

/**
 * 轨迹更新日志页
 */
export async function trackLogsPage(req, res) {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const shipmentId = req.query.shipmentId
      ? Number(req.query.shipmentId)
      : null;

    const rows = await listTrackLogs({
      limit,
      shipmentId,
    });

    res.render("shipments/trackLogs", {
      title: "轨迹更新日志",
      limit,
      shipmentId: shipmentId || "",
      rows,
    });
  } catch (e) {
    console.error("trackLogsPage error:", e);
    res.status(500).send("trackLogsPage error");
  }
}

export default {
  trackSummaryPage,
  trackDetailApi,
  refreshOneTrack,
  trackLogsPage,
};