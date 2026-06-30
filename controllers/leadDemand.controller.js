import * as leadService from "../services/lead.service.js";
import * as taskEngine from "../services/taskEngine.js";

function s(v) {
  return String(v == null ? "" : v).trim();
}

function qBool(v) {
  return s(v) === "1" || s(v).toLowerCase() === "true";
}

export async function demandPage(req, res) {
  const keyword = s(req.query.keyword);
  const showClosed = qBool(req.query.show_closed);

  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await leadService.listDemandLeads({
    keyword: keyword || null,
    showClosed,
    page,
    pageSize,
  });

  try {
    await taskEngine.refreshLeadsTasks(data.rows || []);

    const data2 = await leadService.listDemandLeads({
      keyword: keyword || null,
      showClosed,
      page,
      pageSize,
    });

    return res.render("portal/lead_demand", {
      title: "有需求客人（微信号）",
      active: "lead",
      user: req.user,
      keyword,
      showClosed,
      rows: data2.rows,
      pagination: data2.pagination,
      success: s(req.query.success),
      error: s(req.query.error),
    });
  } catch (e) {
    return res.render("portal/lead_demand", {
      title: "有需求客人（微信号）",
      active: "lead",
      user: req.user,
      keyword,
      showClosed,
      rows: data.rows,
      pagination: data.pagination,
      success: s(req.query.success),
      error: s(req.query.error) || (e?.message ? `任务刷新失败：${e.message}` : ""),
    });
  }
}

export default {
  demandPage,
};