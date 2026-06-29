import { listLeadTrackRows } from "../services/leadTrack.service.js";

function s(v) {
  return String(v == null ? "" : v).trim();
}

function qBool(v) {
  const t = s(v).toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

export async function leadTracksPage(req, res) {
  try {
    const filters = {
      keyword: s(req.query.keyword),
      stage: s(req.query.stage),
      trackStatus: s(req.query.trackStatus),
      signType: s(req.query.signType),
      range: s(req.query.range) || "90",
      showClosed: qBool(req.query.show_closed),
      page: Math.max(1, Number(req.query.page || 1)),
      pageSize: Math.min(200, Math.max(20, Number(req.query.pageSize || 50))),
    };

    const result = await listLeadTrackRows(filters);

    res.render("shipments/leadTracks", {
      title: "客人轨迹",
      active: "lead-tracks",
      user: req.user,
      ...filters,
      rows: result.rows,
      pagination: result.pagination,
      summary: result.summary,
      success: s(req.query.success),
      error: s(req.query.error),
    });
  } catch (e) {
    console.error("leadTracksPage error:", e);
    res.status(500).render("errors/500", {
      title: "系统错误",
      error: e,
      active: "lead-tracks",
      user: req.user,
    });
  }
}

export default {
  leadTracksPage,
};
