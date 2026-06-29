import { listLeadTrackRows } from "../services/leadTrack.service.js";

const STAGES = ["已导入", "已联系", "已报价", "已成交", "已关闭"];
const LEVELS = ["A", "B", "C", "D"];

function s(v) {
  return String(v == null ? "" : v).trim();
}

function qBool(v) {
  const t = s(v).toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

function buildFilters(req, defaults = {}) {
  return {
    keyword: s(req.query.keyword),
    stage: s(req.query.stage),
    level: s(req.query.level),
    trackStatus: s(req.query.trackStatus),
    signType: s(req.query.signType),
    range: s(req.query.range) || defaults.range || "90",
    showClosed: qBool(req.query.show_closed),
    page: Math.max(1, Number(req.query.page || 1)),
    pageSize: Math.min(200, Math.max(20, Number(req.query.pageSize || defaults.pageSize || 50))),
    sortMode: defaults.sortMode || "status",
  };
}

export async function leadPoolMergedPage(req, res) {
  try {
    const filters = buildFilters(req, { range: "90", pageSize: 20, sortMode: "lead" });
    const result = await listLeadTrackRows(filters);

    res.render("portal/lead_pool", {
      title: "线索池",
      active: "lead",
      user: req.user,

      keyword: filters.keyword,
      stage: filters.stage,
      level: filters.level,
      showClosed: filters.showClosed,
      STAGES,
      LEVELS,

      rows: result.rows,
      pagination: result.pagination,
      ytoSummary: result.summary,
      ytoRange: filters.range,

      success: s(req.query.success),
      error: s(req.query.error),
    });
  } catch (e) {
    console.error("leadPoolMergedPage error:", e);
    res.status(500).render("errors/500", {
      title: "系统错误",
      error: e,
      active: "lead",
      user: req.user,
    });
  }
}

export async function leadTracksPage(req, res) {
  try {
    const filters = buildFilters(req, { range: "90", pageSize: 50, sortMode: "status" });
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
  leadPoolMergedPage,
  leadTracksPage,
};
