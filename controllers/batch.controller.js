import batchService from "../services/batch.service.js";
import shipmentService from "../services/shipment.service.js";
import * as leadService from "../services/lead.service.js";

function s(v) {
  return String(v == null ? "" : v).trim();
}

function redirectWithMsg(res, url, { success, error } = {}) {
  const qs = [];
  if (success) qs.push(`success=${encodeURIComponent(success)}`);
  if (error) qs.push(`error=${encodeURIComponent(error)}`);
  res.redirect(qs.length ? `${url}?${qs.join("&")}` : url);
}

function parseIds(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    if (input.includes(",")) return input.split(",").map((x) => x.trim()).filter(Boolean);
    return [input];
  }
  return [];
}

/** 页面：批次列表 */
export async function listPage(req, res) {
  const rows = await batchService.listBatches({ limit: 200 });
  res.render("portal/batch_list", {
    title: "批次列表",
    active: "batch",
    user: req.user,
    rows,
  });
}

/** 页面：创建批次页 */
export async function createPage(req, res) {
  const keyword = s(req.query.keyword);
  const stage = s(req.query.stage);
  const level = s(req.query.level);

  let page = Number(req.query.page || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;

  const ALLOWED_PAGE_SIZES = [50, 100, 200, 400, 500];
  let pageSize = Number(req.query.pageSize || 50);
  pageSize = ALLOWED_PAGE_SIZES.includes(pageSize) ? pageSize : 50;

  const data = await leadService.listBatchCandidates({
    keyword: keyword || null,
    stage: stage || null,
    level: level || null,
    page,
    pageSize,
  });

  const priorityLeads = await leadService.listPrioritySendLeads();
  const priorityLeadIds = priorityLeads.map((x) => Number(x.id)).filter((n) => Number.isFinite(n));
  const normalLeads = data.rows || [];

  const seen = new Set();
  const mergedLeads = [];

  for (const row of [...priorityLeads, ...normalLeads]) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    mergedLeads.push({
      ...row,
      is_priority_send: priorityLeadIds.includes(id) ? 1 : 0,
    });
  }

  res.render("portal/batch_create", {
    title: "创建批次",
    active: "batch",
    user: req.user,

    keyword,
    stage,
    level,
    pageSize,
    STAGES: ["已导入", "已联系", "已报价", "已成交", "已关闭"],
    LEVELS: ["A", "B", "C", "D"],

    leads: mergedLeads,
    priorityLeadIds,
    pagination: data.pagination,

    ruleHint:
      "默认排除：已成交客户；无群客户近30天已成功发货客户；有群客户近90天已成功发货客户；最近一次物流状态为 EXCEPTION 的客户不在批次里表现，请到圆通轨迹页处理。优先发件客户会自动进入本页。",

    error: s(req.query.error),
    success: s(req.query.success),
  });
}

/** 页面：创建批次提交 */
export async function createBatch(req, res) {
  const batchName = s(req.body.batch_name || req.body.name);
  const remark = s(req.body.remark || req.body.note) || null;

  const idsRaw = parseIds(req.body.ids);
  const selectedLeadIds = idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n));

  if (!batchName) {
    return redirectWithMsg(res, "/portal/batches/create", { error: "batch_name 必填" });
  }

  try {
    const priorityLeads = await leadService.listPrioritySendLeads();
    const priorityLeadIds = priorityLeads.map((x) => Number(x.id)).filter((n) => Number.isFinite(n));

    const prioritySet = new Set(priorityLeadIds);
    const normalSelectedIds = selectedLeadIds.filter((id) => !prioritySet.has(id));

    let eligibleNormalIds = [];
    let blockedIds = [];

    if (normalSelectedIds.length) {
      const checked = await leadService.filterLeadIdsForBatchCreation({ leadIds: normalSelectedIds });
      eligibleNormalIds = checked.eligibleIds || [];
      blockedIds = checked.blockedIds || [];
    }

    const finalLeadIds = Array.from(new Set([...priorityLeadIds, ...eligibleNormalIds]));

    if (!finalLeadIds.length) {
      return redirectWithMsg(res, "/portal/batches/create", {
        error: "没有可加入批次的线索",
      });
    }

    const created = await batchService.createBatch({
      user: req.user,
      batchName,
      remark,
      leadIds: finalLeadIds,
    });

    if (priorityLeadIds.length) {
      await leadService.clearPrioritySendFlagsByLeadIds({ leadIds: priorityLeadIds });
    }

    if (blockedIds.length > 0) {
      const msg = `批次已创建，已自动过滤 ${blockedIds.length} 条不符合规则的线索；优先发件客户已自动加入`;
      return res.redirect(
        `/portal/batches/${encodeURIComponent(created.id)}?success=${encodeURIComponent(msg)}`
      );
    }

    return res.redirect(`/portal/batches/${encodeURIComponent(created.id)}`);
  } catch (e) {
    return redirectWithMsg(res, "/portal/batches/create", { error: e?.message || String(e) });
  }
}

/** 页面：批次详情 */
export async function detailPage(req, res) {
  const id = Number(req.params.id);
  if (!id || Number.isNaN(id)) return res.status(400).send("invalid batch id");

  const batch = await batchService.getBatch({ id });
  if (!batch) return res.status(404).send("Batch not found");

  const items = await batchService.getBatchItems({ batchId: id });
  const shipments = await shipmentService.listByBatch({ batchId: id });

  res.render("portal/batch_detail", {
    title: `批次详情 · ${batch.batch_name || batch.id}`,
    active: "batch",
    user: req.user,
    batch,
    items,
    shipments,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

/** 删除批次 */
export async function deleteBatch(req, res) {
  const id = Number(req.params.id);
  if (!id || Number.isNaN(id)) return res.status(400).send("invalid batch id");

  try {
    await batchService.deleteBatch({ id });
    return redirectWithMsg(res, "/portal/batches", { success: "批次已删除" });
  } catch (e) {
    return redirectWithMsg(res, `/portal/batches/${id}`, { error: e?.message || String(e) });
  }
}

/** 删除选中明细 */
export async function removeBatchItems(req, res) {
  const batchId = Number(req.params.id);
  if (!batchId || Number.isNaN(batchId)) return res.status(400).send("invalid batch id");

  const idsRaw = parseIds(req.body.lead_ids || req.body.leadIds);
  const leadIds = idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n));

  try {
    const ret = await batchService.removeBatchItems({ batchId, leadIds });
    return redirectWithMsg(res, `/portal/batches/${batchId}`, {
      success: `已从当前批次移出 ${ret.removed} 条线索`,
    });
  } catch (e) {
    return redirectWithMsg(res, `/portal/batches/${batchId}`, {
      error: e?.message || String(e),
    });
  }
}

/** 页面：推送圆通 */
export async function pushYto(req, res) {
  const batchId = Number(req.params.id);
  if (!batchId || Number.isNaN(batchId)) return res.status(400).send("invalid batch id");

  const force = String(req.body?.force || req.query?.force || "").trim() === "1";

  try {
    const result = await shipmentService.pushBatchToYto({ user: req.user, batchId, force });
    await batchService.markBatchCompleted({ id: batchId });

    const msg = `推送完成：总数 ${result.total}，成功 ${result.success}，失败 ${result.failed}，跳过 ${result.skipped}`;
    redirectWithMsg(res, `/portal/batches/${batchId}`, { success: msg });
  } catch (e) {
    redirectWithMsg(res, `/portal/batches/${batchId}`, { error: e?.message || String(e) });
  }
}

/** 页面：重推失败 */
export async function repushFailed(req, res) {
  const batchId = Number(req.params.id);
  if (!batchId || Number.isNaN(batchId)) return res.status(400).send("invalid batch id");

  const force = String(req.body?.force || req.query?.force || "").trim() === "1";

  try {
    const result = await shipmentService.repushFailed({ user: req.user, batchId, force });
    const msg = `重推完成：总数 ${result.total}，成功 ${result.success}，失败 ${result.failed}，跳过 ${result.skipped}`;
    redirectWithMsg(res, `/portal/batches/${batchId}`, { success: msg });
  } catch (e) {
    redirectWithMsg(res, `/portal/batches/${batchId}`, { error: e?.message || String(e) });
  }
}

/** API：JSON 推送 */
export async function pushBatchYto(req, res) {
  const batchId = Number(req.params.batchId);
  if (!batchId || Number.isNaN(batchId)) return res.status(400).json({ ok: false, error: "invalid batch id" });

  const force = String(req.body?.force || req.query?.force || "").trim() === "1";
  const result = await shipmentService.pushBatchToYto({ user: req.user, batchId, force });

  await batchService.markBatchCompleted({ id: batchId });

  return res.json({ ok: true, batchId, result });
}

/** API：JSON 重推失败 */
export async function retryFailedBatchYto(req, res) {
  const batchId = Number(req.params.batchId);
  if (!batchId || Number.isNaN(batchId)) return res.status(400).json({ ok: false, error: "invalid batch id" });

  const force = String(req.body?.force || req.query?.force || "").trim() === "1";
  const result = await shipmentService.repushFailed({ user: req.user, batchId, force });
  return res.json({ ok: true, batchId, result });
}

export default {
  listPage,
  createPage,
  createBatch,
  detailPage,
  deleteBatch,
  removeBatchItems,
  pushYto,
  repushFailed,
  pushBatchYto,
  retryFailedBatchYto,
};