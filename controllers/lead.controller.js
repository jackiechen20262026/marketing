import XLSX from "xlsx";
import * as leadService from "../services/lead.service.js";
import * as taskEngine from "../services/taskEngine.js";
import * as todoService from "../services/todo.service.js";

const STAGES = ["已导入", "已联系", "已报价", "已成交", "已关闭"];
const LEVELS = ["A", "B", "C", "D"];
const PRIORITIES = ["Low", "Normal", "High"];

const FOLLOWUP_TYPES = [
  { key: "call", name: "电话" },
  { key: "wechat", name: "微信" },
  { key: "email", name: "邮件" },
  { key: "visit", name: "拜访" },
  { key: "other", name: "其他" },
];

const PLAN_STATUSES = [
  { key: "", name: "全部状态" },
  { key: "PLANNED", name: "计划中" },
  { key: "DONE", name: "已完成" },
  { key: "CANCELLED", name: "已取消" },
];

// --------------------
// 预览数据临时存储（内存）
// token -> { createdAt, filename, headers, rows, validRows, invalidRows }
// --------------------
const PREVIEW_STORE = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 min

function now() {
  return Date.now();
}
function cleanupPreviewStore() {
  const t = now();
  for (const [k, v] of PREVIEW_STORE.entries()) {
    if (!v?.createdAt || t - v.createdAt > PREVIEW_TTL_MS) PREVIEW_STORE.delete(k);
  }
}
function makeToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function s(v) {
  return String(v == null ? "" : v).trim();
}

function redirectWithMsg(res, base, { success, error } = {}) {
  const qs = [];
  if (success) qs.push(`success=${encodeURIComponent(success)}`);
  if (error) qs.push(`error=${encodeURIComponent(error)}`);
  res.redirect(qs.length ? `${base}?${qs.join("&")}` : base);
}

function normalizeDateYYYYMMDD(v) {
  if (!v) return null;

  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }

  if (typeof v === "number") {
    try {
      const d = XLSX.SSF.parse_date_code(v);
      if (d && d.y && d.m && d.d) {
        const yyyy = String(d.y).padStart(4, "0");
        const mm = String(d.m).padStart(2, "0");
        const dd = String(d.d).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      }
    } catch {}
  }

  const t = s(v);
  if (!t) return null;

  const m = t.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    const yyyy = m[1];
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function parseIds(v) {
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(","));
  return String(v || "").split(",");
}

/** 兼容手机号科学计数法 / 去空格短横线 */
function normalizePhone(v) {
  if (v === undefined || v === null) return null;
  let t = String(v).trim();
  if (!t) return null;

  t = t.replace(/\s+/g, "").replace(/-/g, "");
  if (t.endsWith(".0")) t = t.slice(0, -2);

  if (/e\+?/i.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) t = String(Math.trunc(n));
  }

  if (/^\d+\.\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) t = String(Math.trunc(n));
  }

  return t || null;
}

/** 清洗行：把表头 trim + 去 BOM */
function cleanRowKeys(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    const nk = String(k).replace(/^\uFEFF/, "").trim();
    out[nk] = row[k];
  }
  return out;
}

function mustNumericId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(404).render("errors/404", { title: "页面不存在" });
    return null;
  }
  return id;
}

function qBool(v) {
  return s(v) === "1" || s(v).toLowerCase() === "true";
}

// --------------------
// 页面：线索池
// --------------------
export async function poolPage(req, res) {
  const keyword = s(req.query.keyword);
  const stage = s(req.query.stage);
  const level = s(req.query.level);
  const showClosed = qBool(req.query.show_closed);

  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await leadService.listLeads({
    keyword: keyword || null,
    stage: stage || null,
    level: level || null,
    showClosed,
    page,
    pageSize,
  });

  res.render("portal/lead_pool", {
    title: "线索池",
    active: "lead",
    user: req.user,

    keyword,
    stage,
    level,
    showClosed,
    STAGES,
    LEVELS,

    rows: data.rows,
    pagination: data.pagination,

    success: s(req.query.success),
    error: s(req.query.error),
  });
}

// --------------------
// ✅ 页面：有需求客人（有微信号）
// --------------------
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

// --------------------
// ✅ 页面：合作意向客人（有微信群）
// --------------------
export async function partnerIntentPage(req, res) {
  const keyword = s(req.query.keyword);
  const showClosed = qBool(req.query.show_closed);

  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await leadService.listPartnerIntentLeads({
    keyword: keyword || null,
    showClosed,
    page,
    pageSize,
  });

  res.render("portal/lead_partner_intent", {
    title: "合作意向客人（微信群）",
    active: "lead",
    user: req.user,
    keyword,
    showClosed,
    rows: data.rows,
    pagination: data.pagination,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

// --------------------
// ✅ 页面：已寄样品（sample_tracking_no 不为空，未成交）
// --------------------
export async function sampleSentPage(req, res) {
  const keyword = s(req.query.keyword);
  const showClosed = qBool(req.query.show_closed);

  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await leadService.listSampleSentLeads({
    keyword: keyword || null,
    showClosed,
    page,
    pageSize,
  });

  res.render("portal/lead_sample_sent", {
    title: "已寄样品",
    active: "lead",
    user: req.user,
    keyword,
    showClosed,
    rows: data.rows,
    pagination: data.pagination,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

// --------------------
// ✅ 页面：已成交（第4步）
// --------------------
export async function dealPage(req, res) {
  const keyword = s(req.query.keyword);
  const showClosed = qBool(req.query.show_closed);

  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await leadService.listDealLeads({
    keyword: keyword || null,
    showClosed,
    page,
    pageSize,
  });

  res.render("portal/lead_deal", {
    title: "已成交",
    active: "lead",
    user: req.user,
    keyword,
    showClosed,
    rows: data.rows,
    pagination: data.pagination,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

// --------------------
// ✅ 关闭/恢复线索
// --------------------
export async function closeLead(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const reason = s(req.body.reason) || null;
  const back = s(req.body.back) || `/portal/leads/${id}`;

  try {
    await leadService.closeLead({ id, userId: req.user?.id, reason });
    return redirectWithMsg(res, back, { success: "已关闭（已从列表隐藏）" });
  } catch (e) {
    return redirectWithMsg(res, back, { error: e?.message || String(e) });
  }
}

export async function reopenLead(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const reason = s(req.body.reason) || null;
  const back = s(req.body.back) || `/portal/leads/${id}`;

  try {
    await leadService.reopenLead({ id, userId: req.user?.id, reason });
    return redirectWithMsg(res, back, { success: "已恢复（重新进入列表）" });
  } catch (e) {
    return redirectWithMsg(res, back, { error: e?.message || String(e) });
  }
}

// ✅ 优先发件
export async function prioritySend(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const back = s(req.body.back) || req.get("referer") || `/portal/leads/${id}`;

  try {
    const lead = await leadService.getLeadById(id);
    if (!lead) {
      return redirectWithMsg(res, back, { error: "线索不存在" });
    }

    await leadService.markLeadPrioritySend({ leadId: id });

    return redirectWithMsg(res, back, {
      success: "已加入优先发件，创建新批次时会自动进入",
    });
  } catch (e) {
    return redirectWithMsg(res, back, { error: e?.message || String(e) });
  }
}

// --------------------
// ✅ 代办页
// --------------------
export async function todosPage(req, res) {
  const scope = s(req.query.scope) || "overdue";
  const keyword = s(req.query.keyword) || "";
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await todoService.listTodos({
    ownerUserId: req.user?.id,
    scope,
    keyword: keyword || null,
    page,
    pageSize,
  });

  res.render("portal/todos", {
    title: "代办",
    active: "lead",
    user: req.user,
    scope,
    keyword,
    rows: data.rows,
    pagination: data.pagination,
    TASK_NAME_MAP: todoService.TASK_NAME_MAP,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

export async function todoComplete(req, res) {
  const todoId = Number(req.params.id);
  const remark = s(req.body.remark) || null;
  const back = s(req.body.back) || "/portal/todos";
  const taskType = s(req.body.task_type);

  const file = req.file || null;
  const evidencePath = file ? `/uploads/todos/${file.filename}` : null;

  try {
    if (taskType === "routine_wechat_due" && !evidencePath) {
      return redirectWithMsg(res, back, { error: "微信任务必须上传截图（选择文件后再提交）" });
    }

    await todoService.completeTodo({
      todoId,
      doneFollowupId: null,
      evidenceFile: evidencePath,
      remark,
    });

    return redirectWithMsg(res, back, { success: "已完成" });
  } catch (e) {
    return redirectWithMsg(res, back, { error: e?.message || String(e) });
  }
}

export async function todoSkip(req, res) {
  const todoId = Number(req.params.id);
  const remark = s(req.body.remark) || null;
  const back = s(req.body.back) || "/portal/todos";

  try {
    await todoService.skipTodo({ todoId, remark });
    return redirectWithMsg(res, back, { success: "已跳过" });
  } catch (e) {
    return redirectWithMsg(res, back, { error: e?.message || String(e) });
  }
}

export async function plansAllPage(req, res) {
  const keyword = s(req.query.keyword);
  const type = s(req.query.type);
  const status = s(req.query.status);
  const dateFrom = s(req.query.date_from);
  const dateTo = s(req.query.date_to);

  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await leadService.listAllPlans({
    keyword: keyword || null,
    type: type || null,
    status: status || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    page,
    pageSize,
  });

  res.render("portal/plans_list", {
    title: "总计划",
    active: "lead",
    user: req.user,

    keyword,
    type,
    status,
    dateFrom,
    dateTo,

    types: FOLLOWUP_TYPES,
    statuses: PLAN_STATUSES,

    rows: data.rows,
    pagination: data.pagination,

    success: s(req.query.success),
    error: s(req.query.error),
  });
}

export async function followupsListPage(req, res) {
  const keyword = s(req.query.keyword);
  const type = s(req.query.type);
  const needAnalysis = s(req.query.need_analysis);
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));

  const data = await leadService.listAllFollowups({
    keyword: keyword || null,
    type: type || null,
    needAnalysis: needAnalysis === "" ? null : Number(needAnalysis),
    page,
    pageSize,
  });

  res.render("portal/followups_list", {
    title: "跟进列表",
    active: "lead",
    user: req.user,

    keyword,
    type,
    needAnalysis,
    types: FOLLOWUP_TYPES,

    rows: data.rows,
    pagination: data.pagination,

    success: s(req.query.success),
    error: s(req.query.error),
  });
}

export async function plansPage(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const lead = await leadService.getLeadById(id);
  if (!lead) return res.status(404).render("errors/404", { title: "页面不存在" });

  const plans = await leadService.listPlansByLeadId(id);

  res.render("portal/lead_plans_list", {
    title: `跟进计划 - ${lead.company_name || `#${lead.id}`}`,
    active: "lead",
    user: req.user,

    lead,
    plans,
    types: FOLLOWUP_TYPES,

    success: s(req.query.success),
    error: s(req.query.error),
  });
}

export async function createPlan(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const planType = s(req.body.plan_type) || "other";
  const plannedAt = s(req.body.planned_at) || null;
  const planNote = s(req.body.plan_note) || null;

  try {
    await leadService.createPlan({
      leadId: id,
      planType,
      plannedAt,
      planNote,
      userId: req.user?.id,
    });
    return redirectWithMsg(res, `/portal/leads/${id}/plans`, { success: "计划已创建" });
  } catch (e) {
    return redirectWithMsg(res, `/portal/leads/${id}/plans`, { error: e?.message || String(e) });
  }
}

export async function followupNewPage(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const lead = await leadService.getLeadById(id);
  if (!lead) return res.status(404).render("errors/404", { title: "页面不存在" });

  res.render("portal/lead_followup_new", {
    title: "新增跟进",
    active: "lead",
    user: req.user,
    lead,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

export async function followupCreateFromPage(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const lead = await leadService.getLeadById(id);
  if (!lead) return res.status(404).render("errors/404", { title: "页面不存在" });

  const followupType = s(req.body.followup_type) || "other";
  const content = s(req.body.content);
  const nextAt = s(req.body.next_followup_at) || null;
  const needAnalysis = s(req.body.need_analysis) === "1" ? 1 : 0;
  const analysis = s(req.body.analysis) || null;

  if (followupType === "visit") {
    return redirectWithMsg(res, `/portal/leads/${id}/visit`, {
      error: "拜访必须使用【拜访打卡（手机）】页面（定位+至少1张照片）",
    });
  }
  if (!content) {
    return redirectWithMsg(res, `/portal/leads/${id}/followups/new`, { error: "请填写跟进内容" });
  }

  try {
    await leadService.addFollowup({
      leadId: id,
      type: followupType,
      content,
      nextAt,
      userId: req.user?.id,
      needAnalysis,
      analysis,
    });
    return redirectWithMsg(res, `/portal/leads/${id}`, { success: "跟进已提交" });
  } catch (e) {
    return redirectWithMsg(res, `/portal/leads/${id}/followups/new`, { error: e?.message || String(e) });
  }
}

export async function visitMobilePage(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const lead = await leadService.getLeadById(id);
  if (!lead) return res.status(404).render("errors/404", { title: "页面不存在" });

  res.render("portal/lead_visit_mobile", {
    title: "拜访打卡",
    active: "lead",
    user: req.user,
    lead,
    error: s(req.query.error),
    success: s(req.query.success),
  });
}

export async function visitSubmit(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const lead = await leadService.getLeadById(id);
  if (!lead) return res.status(404).render("errors/404", { title: "页面不存在" });

  const content = s(req.body.content);
  const needAnalysis = s(req.body.need_analysis) === "1" ? 1 : 0;
  const analysis = s(req.body.analysis) || null;

  const lat = Number(req.body.visit_lat);
  const lng = Number(req.body.visit_lng);
  const address = s(req.body.visit_address) || null;

  const photos = Array.isArray(req.files) ? req.files : [];
  const ua = s(req.headers["user-agent"]) || null;

  if (!content) {
    return redirectWithMsg(res, `/portal/leads/${id}/visit`, { error: "请填写拜访内容" });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return redirectWithMsg(res, `/portal/leads/${id}/visit`, { error: "必须完成定位打卡（获取经纬度）" });
  }
  if (!photos.length) {
    return redirectWithMsg(res, `/portal/leads/${id}/visit`, { error: "拜访必须至少上传 1 张照片" });
  }

  try {
    await leadService.createVisitFollowup({
      leadId: id,
      content,
      needAnalysis,
      analysis,
      lat,
      lng,
      address,
      userAgent: ua,
      userId: req.user?.id,
      photos,
    });

    return redirectWithMsg(res, `/portal/leads/${id}`, { success: "拜访跟进已提交" });
  } catch (e) {
    return redirectWithMsg(res, `/portal/leads/${id}/visit`, { error: e?.message || String(e) });
  }
}

export async function importPage(req, res) {
  res.render("portal/lead_import", {
    title: "导入线索",
    active: "lead",
    user: req.user,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

export async function importPreview(req, res) {
  cleanupPreviewStore();

  const file = req.file;
  if (!file) {
    return redirectWithMsg(res, "/portal/leads/import", { error: "未选择文件" });
  }

  const filename = file.originalname || "upload.xlsx";

  let rows = [];
  let headers = [];

  try {
    const wb = XLSX.read(file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
    rows = json.map(cleanRowKeys);
    headers = json.length ? Object.keys(cleanRowKeys(json[0])) : [];
  } catch (e) {
    return redirectWithMsg(res, "/portal/leads/import", {
      error: `解析失败：${e?.message || String(e)}`,
    });
  }

  if (!rows.length) {
    return redirectWithMsg(res, "/portal/leads/import", { error: "文件为空或没有数据行" });
  }

  const EXPECTED_HEADERS = [
    "company_name",
    "company_name_en",
    "amazon_company_name",
    "unified_code",
    "vat_no",
    "wechat",
    "wechat_group_code",
    "wechat_group_qr",
    "legal_person",
    "registered_capital",
    "registration_date",
    "contact_name",
    "phone",
    "email",
    "website",
    "category",
    "amazon_shop_url",
    "company_profile",
    "workflow_stage",
    "priority",
    "customer_level",
    "source",
    "receiver_name",
    "receiver_mobile",
    "receiver_province",
    "receiver_city",
    "receiver_county",
    "receiver_town",
    "receiver_address",
    "receiver_postal_code",
  ];

  const validRows = [];
  const invalidRows = [];

  rows.forEach((r, idx) => {
    const rowNo = idx + 2;
    const out = {};

    const lowerMap = {};
    for (const k of Object.keys(r)) lowerMap[String(k).toLowerCase()] = k;

    function getField(key) {
      if (r[key] !== undefined) return r[key];
      const hit = lowerMap[key.toLowerCase()];
      if (hit) return r[hit];
      return "";
    }

    for (const k of EXPECTED_HEADERS) out[k] = getField(k);

    out.company_name = s(out.company_name);
    out.company_name_en = s(out.company_name_en) || null;
    out.amazon_company_name = s(out.amazon_company_name) || null;
    out.unified_code = s(out.unified_code) || null;
    out.vat_no = s(out.vat_no) || null;

    out.wechat = s(out.wechat) || null;
    out.wechat_group_code = s(out.wechat_group_code) || null;
    out.wechat_group_qr = s(out.wechat_group_qr) || null;

    out.legal_person = s(out.legal_person) || null;
    out.registered_capital = s(out.registered_capital) || null;
    out.registration_date = normalizeDateYYYYMMDD(out.registration_date);

    out.contact_name = s(out.contact_name) || null;
    out.phone = normalizePhone(out.phone);
    out.email = s(out.email) || null;

    out.website = s(out.website) || null;
    out.category = s(out.category) || null;
    out.amazon_shop_url = s(out.amazon_shop_url) || null;
    out.company_profile = s(out.company_profile) || null;

    out.workflow_stage = STAGES.includes(s(out.workflow_stage)) ? s(out.workflow_stage) : "已导入";
    out.priority = PRIORITIES.includes(s(out.priority)) ? s(out.priority) : "Normal";
    out.customer_level = LEVELS.includes(s(out.customer_level)) ? s(out.customer_level) : "C";
    out.source = s(out.source) || "Import";

    out.receiver_name = s(out.receiver_name) || null;
    out.receiver_mobile = normalizePhone(out.receiver_mobile);
    out.receiver_province = s(out.receiver_province) || null;
    out.receiver_city = s(out.receiver_city) || null;
    out.receiver_county = s(out.receiver_county) || null;
    out.receiver_town = s(out.receiver_town) || null;
    out.receiver_address = s(out.receiver_address) || null;
    out.receiver_postal_code = s(out.receiver_postal_code) || null;

    const errors = [];
    if (!out.company_name) errors.push("company_name 必填");

    const warnings = [];
    if (!out.receiver_name) warnings.push("缺 receiver_name（推单前需补）");
    if (!out.receiver_mobile) warnings.push("缺 receiver_mobile（推单前需补，可用 phone 兜底）");
    if (!out.receiver_province) warnings.push("缺 receiver_province（推单前需补）");
    if (!out.receiver_city) warnings.push("缺 receiver_city（推单前需补）");
    if (!out.receiver_address) warnings.push("缺 receiver_address（推单前需补）");

    const previewRow = { rowNo, raw: r, data: out, errors, warnings };

    if (errors.length) invalidRows.push(previewRow);
    else validRows.push(previewRow);
  });

  const token = makeToken();
  PREVIEW_STORE.set(token, {
    createdAt: now(),
    filename,
    headers,
    rows,
    validRows,
    invalidRows,
  });

  const needFixCount = (validRows || []).filter((x) => (x.warnings || []).length > 0).length;

  res.render("portal/lead_import_preview", {
    title: "导入预览",
    active: "lead",
    user: req.user,

    token,
    filename,
    headers,
    expectedHeaders: EXPECTED_HEADERS,

    total: rows.length,
    validCount: validRows.length,
    invalidCount: invalidRows.length,
    needFixCount,

    validRows,
    invalidRows,
  });
}

export async function importCommit(req, res) {
  cleanupPreviewStore();

  const token = s(req.body.token);
  if (!token || !PREVIEW_STORE.has(token)) {
    return redirectWithMsg(res, "/portal/leads/import", { error: "预览已过期，请重新上传" });
  }

  const preview = PREVIEW_STORE.get(token);
  const validRows = preview.validRows || [];

  if (!validRows.length) {
    PREVIEW_STORE.delete(token);
    return redirectWithMsg(res, "/portal/leads/import", { error: "没有可导入的数据（全部不合法）" });
  }

  let ok = 0;
  let failed = 0;
  const failMsgs = [];

  for (const r of validRows) {
    try {
      await leadService.createLead(r.data, req.user?.id);
      ok++;
    } catch (e) {
      failed++;
      failMsgs.push(`第${r.rowNo}行：${e?.message || String(e)}`);
    }
  }

  PREVIEW_STORE.delete(token);

  if (failed > 0) {
    const msg = `导入完成：成功 ${ok} 条，失败 ${failed} 条。失败示例：${failMsgs.slice(0, 3).join("；")}`;
    return redirectWithMsg(res, "/portal/lead-pool", { error: msg });
  }

  return redirectWithMsg(res, "/portal/lead-pool", { success: `导入成功：共 ${ok} 条` });
}

export async function newPage(req, res) {
  res.render("portal/lead_create", {
    title: "新增线索",
    active: "lead",
    user: req.user,
    STAGES,
    LEVELS,
    error: null,
    form: {},
  });
}

export async function create(req, res) {
  try {
    await leadService.createLead(req.body, req.user?.id);
    redirectWithMsg(res, "/portal/lead-pool", { success: "新增成功" });
  } catch (e) {
    res.render("portal/lead_create", {
      title: "新增线索",
      active: "lead",
      user: req.user,
      STAGES,
      LEVELS,
      error: e?.message || String(e),
      form: req.body || {},
    });
  }
}

export async function detailPage(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const lead = await leadService.getLeadById(id);
  if (!lead) return res.status(404).render("errors/404", { title: "页面不存在" });

  const followups = await leadService.getFollowups(id);
  const planCount = await leadService.countOpenPlansByLeadId(id);
  const attachments = []; // 先兜底，避免页面报错

  res.render("portal/lead_detail", {
    title: `线索详情 #${lead.id}`,
    active: "lead",
    user: req.user,
    lead,
    followups,
    planCount,
    attachments,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}
export async function editPage(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  const lead = await leadService.getLeadById(id);
  if (!lead) return res.status(404).render("errors/404", { title: "页面不存在" });

  res.render("portal/lead_edit", {
    title: `编辑线索 #${lead.id}`,
    active: "lead",
    user: req.user,
    lead,
    STAGES,
    LEVELS,
    error: null,
  });
}

export async function update(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  try {
    await leadService.updateLead(id, req.body);
    res.redirect(`/portal/leads/${encodeURIComponent(id)}`);
  } catch (e) {
    const lead = await leadService.getLeadById(id);
    res.render("portal/lead_edit", {
      title: `编辑线索 #${id}`,
      active: "lead",
      user: req.user,
      lead,
      STAGES,
      LEVELS,
      error: e?.message || String(e),
    });
  }
}

export async function bulkDisable(req, res) {
  const ids = parseIds(req.body.ids).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (!ids.length) return redirectWithMsg(res, "/portal/lead-pool", { error: "未选择线索" });
  await leadService.disableLeads(ids);
  redirectWithMsg(res, "/portal/lead-pool", { success: `已停用 ${ids.length} 条（已隐藏）` });
}

export async function bulkStage(req, res) {
  const ids = parseIds(req.body.ids).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  const toStage = s(req.body.to_stage);
  const remark = s(req.body.remark) || null;

  if (!ids.length) return redirectWithMsg(res, "/portal/lead-pool", { error: "未选择线索" });
  try {
    await leadService.changeStageBulk({ ids, toStage, userId: req.user?.id, remark });
    redirectWithMsg(res, "/portal/lead-pool", { success: `已更新阶段：${ids.length} 条` });
  } catch (e) {
    redirectWithMsg(res, "/portal/lead-pool", { error: e?.message || String(e) });
  }
}

export async function addFollowup(req, res) {
  const id = mustNumericId(req, res);
  if (id == null) return;

  try {
    const followupType = s(req.body.followup_type) || "other";
    if (followupType === "visit") {
      return redirectWithMsg(res, `/portal/leads/${id}/visit`, {
        error: "拜访必须使用【拜访打卡（手机）】页面（定位+至少1张照片）",
      });
    }

    await leadService.addFollowup({
      leadId: id,
      type: followupType,
      content: req.body.content,
      nextAt: req.body.next_followup_at,
      userId: req.user?.id,
      needAnalysis: s(req.body.need_analysis) === "1" ? 1 : 0,
      analysis: s(req.body.analysis) || null,
    });

    res.redirect(`/portal/leads/${encodeURIComponent(id)}`);
  } catch (e) {
    redirectWithMsg(res, `/portal/leads/${encodeURIComponent(id)}`, {
      error: e?.message || String(e),
    });
  }
}

export default {
  poolPage,
  demandPage,
  partnerIntentPage,
  sampleSentPage,
  closeLead,
  reopenLead,
  prioritySend,
  todosPage,
  todoComplete,
  todoSkip,
  plansAllPage,
  followupsListPage,
  plansPage,
  createPlan,
  followupNewPage,
  followupCreateFromPage,
  visitMobilePage,
  visitSubmit,
  importPage,
  importPreview,
  importCommit,
  newPage,
  create,
  detailPage,
  editPage,
  update,
  bulkDisable,
  bulkStage,
  addFollowup,
};