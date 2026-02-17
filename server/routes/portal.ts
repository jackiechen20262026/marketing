import type { Router } from "express";
import { Router as createRouter } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../_core/db";
import { yuantongService } from "../services/yuantong.service";

type User = { id: string; name: string; role: "Admin" | "Supervisor" | "Salesperson" };

type Perm =
  | "lead.view"
  | "lead.edit"
  | "lead.import"
  | "lead.export"
  | "lead.upload"
  | "lead.reminder"
  | "campaign.view"
  | "campaign.create"
  | "campaign.detail"
  | "campaign.track"
  | "settings.yto.view"
  | "settings.yto.edit"
  | "user.view"
  | "user.edit"
  | "user.role"
  | "report.view";

const ROLE_PERMS: Record<User["role"], Perm[]> = {
  Admin: [
    "lead.view",
    "lead.edit",
    "lead.import",
    "lead.export",
    "lead.upload",
    "lead.reminder",
    "campaign.view",
    "campaign.create",
    "campaign.detail",
    "campaign.track",
    "settings.yto.view",
    "settings.yto.edit",
    "user.view",
    "user.edit",
    "user.role",
    "report.view",
  ],
  Supervisor: [
    "lead.view",
    "lead.edit",
    "lead.import",
    "lead.upload",
    "lead.reminder",
    "campaign.view",
    "campaign.create",
    "campaign.detail",
    "campaign.track",
    "settings.yto.view",
    "report.view",
  ],
  Salesperson: ["lead.view", "lead.edit", "lead.upload", "lead.reminder", "campaign.view", "campaign.create", "campaign.detail"],
};

function hasPerm(user: User, p: Perm) {
  return ROLE_PERMS[user.role].includes(p);
}

function requirePerm(p: Perm) {
  return (req: any, res: any, next: any) => {
    if (!hasPerm(req.user as User, p)) return res.status(403).send("Forbidden");
    next();
  };
}

function requireAuth(req: any, _res: any, next: any) {
  const roleKey = String(req.query?.as || "").toLowerCase();
  const role: User["role"] = roleKey === "supervisor" ? "Supervisor" : roleKey === "employee" ? "Salesperson" : "Admin";
  req.user = {
    id: role === "Admin" ? "u_admin_001" : role === "Supervisor" ? "u_super_001" : "u_emp_001",
    name: role === "Admin" ? "admin" : role === "Supervisor" ? "supervisor" : "employee",
    role,
  } as User;
  next();
}

function ownerScope(user: User) {
  if (user.role === "Admin") return { sql: "1=1", params: {} as any };
  if (user.role === "Supervisor") return { sql: "1=1", params: {} as any };
  return { sql: "owner_id=:uid", params: { uid: user.id } as any };
}

const NEXT_STAGE: Record<string, string | null> = {
  已导入: "已筛选",
  已筛选: "已发册",
  已发册: "跟踪中",
  跟踪中: "已签收",
  已签收: "跟进中",
  跟进中: "潜在客户",
  潜在客户: "已转化",
  已转化: null,
  退件: "已关闭",
  已关闭: null,
};

function parseIds(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String).map(x => x.trim()).filter(Boolean);
  return String(input || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function t(_req: any, key: string, fallback?: string) {
  return fallback || key;
}

function nowIso() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

async function saveLeadActivity(leadId: string, type: string, operatorId: string, note?: string, metadata?: any) {
  await db.query(
    `INSERT INTO lead_activity_logs(lead_id, activity_type, note, operator_id, metadata_json, created_at)
     VALUES(:leadId,:type,:note,:operatorId,:meta,NOW())`,
    { leadId, type, note: note || null, operatorId, meta: metadata ? JSON.stringify(metadata) : null }
  );
}

export function portalRoutes(): Router {
  const r = createRouter();

  const wrapAsync = (handler: any) => (req: any, res: any, next: any) => Promise.resolve(handler(req, res, next)).catch(next);
  for (const method of ["get", "post"] as const) {
    const raw = (r as any)[method].bind(r);
    (r as any)[method] = (routePath: string, ...handlers: any[]) => raw(routePath, ...handlers.map((h: any) => (h?.constructor?.name === "AsyncFunction" ? wrapAsync(h) : h)));
  }

  r.use(requireAuth);
  r.use((req: any, res: any, next: any) => {
    res.locals.t = (key: string, fallback?: string) => t(req, key, fallback);
    next();
  });

  r.get("/", async (req, res) => {
    const user = req.user as User;
    const scope = ownerScope(user);
    const [[total]] = await db.query<any[]>(`SELECT COUNT(*) c FROM leads WHERE ${scope.sql}`, scope.params);
    const [[converted]] = await db.query<any[]>(`SELECT COUNT(*) c FROM leads WHERE ${scope.sql} AND workflow_stage='已转化'`, scope.params);
    const [[reminder]] = await db.query<any[]>(`SELECT COUNT(*) c FROM leads WHERE ${scope.sql} AND next_visit_reminder IS NOT NULL`, scope.params);
    const [[returned]] = await db.query<any[]>(
      `SELECT COUNT(*) c FROM shipments s INNER JOIN leads l ON l.id=s.lead_id WHERE ${scope.sql} AND s.logistics_status='Returned'`,
      scope.params
    );
    res.render("portal/dashboard", { title: "Dashboard", user, stats: { totalLeads: total?.c || 0, converted: converted?.c || 0, needFollow: reminder?.c || 0, monthNew: returned?.c || 0 } });
  });

  r.get("/users", requirePerm("user.view"), async (req, res) => {
    const user = req.user as User;
    const [rows] = await db.query<any[]>(`SELECT id, username, role, status, created_at AS createdAt FROM users ORDER BY created_at DESC`);
    res.render("portal/users", { title: "Users", user, rows, msg: String(req.query.msg || "") });
  });

  r.get("/users/new", requirePerm("user.edit"), (req, res) => res.render("portal/user_form", { title: "New User", user: req.user, row: null }));
  r.get("/users/:id/edit", requirePerm("user.edit"), async (req, res) => {
    const [[row]] = await db.query<any[]>(`SELECT id, username, role, status FROM users WHERE id=:id`, { id: req.params.id });
    if (!row) return res.status(404).send("User not found");
    res.render("portal/user_form", { title: "Edit User", user: req.user, row });
  });

  r.post("/users", requirePerm("user.edit"), async (req, res) => {
    const id = `u_${Math.random().toString(36).slice(2, 10)}`;
    const username = String(req.body.username || "").trim();
    if (!username) return res.status(400).send("username required");
    await db.query(`INSERT INTO users(id,username,password_hash,role,status,created_at) VALUES(:id,:username,:password,:role,:status,NOW())`, {
      id,
      username,
      password: String(req.body.password || "") || null,
      role: ["Admin", "Supervisor", "Salesperson"].includes(req.body.role) ? req.body.role : "Salesperson",
      status: req.body.status === "inactive" ? "inactive" : "active",
    });
    res.redirect("/portal/users?msg=created");
  });

  r.post("/users/:id", requirePerm("user.edit"), async (req, res) => {
    await db.query(`UPDATE users SET username=:username, role=:role, status=:status, password_hash=COALESCE(NULLIF(:password,''),password_hash) WHERE id=:id`, {
      id: req.params.id,
      username: String(req.body.username || "").trim(),
      role: ["Admin", "Supervisor", "Salesperson"].includes(req.body.role) ? req.body.role : "Salesperson",
      status: req.body.status === "inactive" ? "inactive" : "active",
      password: String(req.body.password || ""),
    });
    res.redirect("/portal/users?msg=updated");
  });

  r.get("/settings/yuantong", requirePerm("settings.yto.view"), async (req, res) => {
    const user = req.user as User;
    const config = await yuantongService.getConfigMasked();
    const [logs] = await db.query<any[]>(`SELECT id,biz_type AS bizType,biz_id AS bizId,http_status AS httpStatus,success,error_message AS errorMessage,created_at AS createdAt FROM courier_api_logs WHERE courier_code='yto' ORDER BY created_at DESC LIMIT 30`);
    res.render("portal/yto_settings", { title: "YTO", user, config, logs, canEdit: hasPerm(user, "settings.yto.edit"), saved: req.query.saved, tested: req.query.tested });
  });

  r.post("/settings/yuantong", requirePerm("settings.yto.edit"), async (req, res) => {
    await yuantongService.saveConfig({
      baseUrl: String(req.body.baseUrl || "").trim(),
      appKey: String(req.body.appKey || "").trim(),
      appSecret: String(req.body.appSecret || ""),
      customerCode: String(req.body.customerCode || ""),
      enabled: String(req.body.enabled || "") === "1",
    });
    res.redirect("/portal/settings/yuantong?saved=1");
  });

  r.post("/settings/yuantong/test", requirePerm("settings.yto.view"), async (_req, res) => {
    const result = await yuantongService.request({ method: "yto.open.health.check", bizType: "connectivity_test", bizId: `test_${Date.now()}`, payload: { ts: Date.now() } });
    res.redirect(`/portal/settings/yuantong?tested=${result.ok ? "1" : "0"}`);
  });


  r.get("/lead-pool", requirePerm("lead.view"), (req, res) => {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(`/portal/leads${query}`);
  });
  r.get("/leads", requirePerm("lead.view"), async (req, res) => {
    const user = req.user as User;
    const scope = ownerScope(user);
    const q = String(req.query.company_name || req.query.q || "").trim();
    const owner = String(req.query.owner || "").trim();
    const city = String(req.query.city || "").trim();
    const country = String(req.query.country || "").trim();
    const reminder = String(req.query.next_visit_reminder || "").trim();
    const where = [`${scope.sql}`];
    const params: any = { ...scope.params, qLike: `%${q}%`, owner, city, country };
    if (q) where.push("(l.company_name LIKE :qLike OR l.contact_name LIKE :qLike OR l.phone LIKE :qLike)");
    if (owner) where.push("l.owner_id=:owner");
    if (city) where.push("l.city=:city");
    if (country) where.push("l.country=:country");
    if (reminder === "today") where.push("DATE(l.next_visit_reminder)=CURDATE()");
    if (reminder === "week") where.push("YEARWEEK(l.next_visit_reminder,1)=YEARWEEK(CURDATE(),1)");
    if (reminder === "overdue") where.push("l.next_visit_reminder < NOW()");

    const [rows] = await db.query<any[]>(
      `SELECT l.id,l.company_name AS companyName,l.contact_name AS contactName,l.phone,l.city,l.country,l.brand_json AS brands,
              l.brochure_sent_count AS brochureSentCount,l.visit_count AS visitCount,
              l.last_visit_at AS lastVisitAt,l.next_visit_reminder AS nextVisitReminder,l.owner_id AS owner,
              (SELECT MAX(created_at) FROM lead_activity_logs a WHERE a.lead_id=l.id AND a.activity_type='brochure_sent') AS lastSentAt
       FROM leads l WHERE ${where.join(" AND ")}
       ORDER BY l.updated_at DESC LIMIT 300`,
      params
    );

    const selectedIds = parseIds(req.query.ids);
    res.render("portal/leads", { title: "Leads", user, q, owner, city, country, reminder, rows, selectedIds, canImport: hasPerm(user, "lead.import"), canExport: hasPerm(user, "lead.export") });
  });

  r.get("/leads/new", requirePerm("lead.edit"), (req, res) => res.render("portal/lead_form", { title: "New Lead", user: req.user, row: null }));
  r.get("/leads/:id/edit", requirePerm("lead.edit"), async (req, res) => {
    const [[row]] = await db.query<any[]>(`SELECT * FROM leads WHERE id=:id LIMIT 1`, { id: req.params.id });
    if (!row) return res.status(404).send("Lead not found");
    res.render("portal/lead_form", { title: "Edit Lead", user: req.user, row });
  });

  r.post("/leads", requirePerm("lead.edit"), async (req, res) => {
    const user = req.user as User;
    const id = `l_${Math.random().toString(36).slice(2, 10)}`;
    const companyName = String(req.body.company_name || "").trim();
    if (!companyName) return res.status(400).send("company_name required");
    await db.query(
      `INSERT INTO leads(
        id,company_name,contact_name,email,phone,street,house_number,postal_code,city,country,social_credit_code,website,company_profile,brand_json,address,
        source,priority,owner_id,workflow_stage,brochure_sent_count,visit_count,created_at,updated_at
       ) VALUES(
        :id,:companyName,:contactName,:email,:phone,:street,:houseNumber,:postalCode,:city,:country,:socialCreditCode,:website,:companyProfile,:brandJson,:address,
        'Amazon','M',:owner,'已导入',0,0,NOW(),NOW()
       )`,
      {
        id,
        companyName,
        contactName: String(req.body.contact_name || "") || null,
        email: String(req.body.email || "") || null,
        phone: String(req.body.phone || "") || null,
        street: String(req.body.street || "") || null,
        houseNumber: String(req.body.house_number || "") || null,
        postalCode: String(req.body.postal_code || "") || null,
        city: String(req.body.city || "") || null,
        country: String(req.body.country || "China") || "China",
        socialCreditCode: String(req.body.social_credit_code || "") || null,
        website: String(req.body.website || "") || null,
        companyProfile: String(req.body.company_profile || "") || null,
        brandJson: JSON.stringify(String(req.body.brand || "").split(",").map(s => s.trim()).filter(Boolean)),
        address: `${String(req.body.street || "")} ${String(req.body.house_number || "")}`.trim() || null,
        owner: user.id,
      }
    );
    await saveLeadActivity(id, "lead_created", user.id, "创建线索");
    res.redirect(`/portal/leads/${id}`);
  });

  r.post("/leads/:id", requirePerm("lead.edit"), async (req, res) => {
    const id = req.params.id;
    await db.query(
      `UPDATE leads SET
        company_name=:companyName,contact_name=:contactName,email=:email,phone=:phone,
        street=:street,house_number=:houseNumber,postal_code=:postalCode,city=:city,country=:country,
        social_credit_code=:socialCreditCode,website=:website,company_profile=:companyProfile,brand_json=:brandJson,
        address=:address,updated_at=NOW()
       WHERE id=:id`,
      {
        id,
        companyName: String(req.body.company_name || "").trim(),
        contactName: String(req.body.contact_name || "") || null,
        email: String(req.body.email || "") || null,
        phone: String(req.body.phone || "") || null,
        street: String(req.body.street || "") || null,
        houseNumber: String(req.body.house_number || "") || null,
        postalCode: String(req.body.postal_code || "") || null,
        city: String(req.body.city || "") || null,
        country: String(req.body.country || "China") || "China",
        socialCreditCode: String(req.body.social_credit_code || "") || null,
        website: String(req.body.website || "") || null,
        companyProfile: String(req.body.company_profile || "") || null,
        brandJson: JSON.stringify(String(req.body.brand || "").split(",").map(s => s.trim()).filter(Boolean)),
        address: `${String(req.body.street || "")} ${String(req.body.house_number || "")}`.trim() || null,
      }
    );
    await saveLeadActivity(id, "lead_updated", (req.user as User).id, "编辑线索");
    res.redirect(`/portal/leads/${id}`);
  });

  r.get("/leads/:id", requirePerm("lead.view"), async (req, res) => {
    const id = req.params.id;
    const user = req.user as User;
    const [[lead]] = await db.query<any[]>(`SELECT * FROM leads WHERE id=:id LIMIT 1`, { id });
    if (!lead) return res.status(404).send("Lead not found");
    const [logs] = await db.query<any[]>(`SELECT a.*,u.username AS operator FROM lead_activity_logs a LEFT JOIN users u ON u.id=a.operator_id WHERE a.lead_id=:id ORDER BY a.created_at DESC LIMIT 200`, { id });
    const [files] = await db.query<any[]>(`SELECT * FROM lead_files WHERE lead_id=:id ORDER BY created_at DESC LIMIT 100`, { id });
    const [followups] = await db.query<any[]>(`SELECT id,channel,content,result,created_at AS createdAt FROM lead_followups WHERE lead_id=:id ORDER BY created_at DESC LIMIT 100`, { id });
    const limitStatus = Number(lead.brochure_sent_count || 0) >= Number(lead.brochure_limit_count || 0) ? "over" : "ok";
    res.render("portal/lead_detail", { title: "Lead Detail", user, lead, logs, files, followups, limitStatus });
  });

  r.post("/leads/:id/upload", requirePerm("lead.upload"), async (req, res) => {
    const id = req.params.id;
    const fileUrl = String(req.body.file_url || "").trim();
    const fileName = String(req.body.file_name || "image").trim();
    if (!fileUrl) return res.status(400).send("file_url required");
    await db.query(`INSERT INTO lead_files(lead_id,file_name,file_url,file_type,operator_id,created_at) VALUES(:id,:name,:url,:type,:uid,NOW())`, {
      id,
      name: fileName,
      url: fileUrl,
      type: "image/url",
      uid: (req.user as User).id,
    });
    await saveLeadActivity(id, "file_upload", (req.user as User).id, `上传文件 ${fileName}`);
    res.redirect(`/portal/leads/${id}`);
  });

  r.post("/leads/:id/reminder", requirePerm("lead.reminder"), async (req, res) => {
    const id = req.params.id;
    const reminder = String(req.body.next_visit_reminder || "");
    await db.query(`UPDATE leads SET next_visit_reminder=:r, updated_at=NOW() WHERE id=:id`, { id, r: reminder || null });
    await saveLeadActivity(id, "reminder_set", (req.user as User).id, `设置提醒 ${reminder}`);
    res.redirect(`/portal/leads/${id}`);
  });

  r.post("/leads/:id/visit", requirePerm("lead.edit"), async (req, res) => {
    const id = req.params.id;
    await db.query(`UPDATE leads SET visit_count=visit_count+1,last_visit_at=NOW(),updated_at=NOW() WHERE id=:id`, { id });
    await saveLeadActivity(id, "visit", (req.user as User).id, String(req.body.note || "记录拜访"));
    res.redirect(`/portal/leads/${id}`);
  });

  r.get("/leads/recommendations", requirePerm("lead.view"), async (req, res) => {
    const [rows] = await db.query<any[]>(
      `SELECT id,company_name AS companyName,contact_name AS contactName,phone,
              brochure_sent_count AS brochureSentCount,visit_count AS visitCount,next_visit_reminder AS nextVisitReminder,
              CASE
                WHEN brochure_sent_count=0 THEN '从未发送宣传册'
                WHEN last_visit_at IS NULL THEN '从未拜访'
                WHEN next_visit_reminder IS NULL THEN '未设置提醒'
                ELSE '建议跟进'
              END AS reason
       FROM leads
       ORDER BY brochure_sent_count ASC, visit_count DESC, updated_at DESC
       LIMIT 100`
    );
    res.render("portal/recommendations", { title: "Recommendations", user: req.user, rows });
  });

  r.get("/leads/import", requirePerm("lead.import"), (req, res) => res.render("portal/import_leads", { title: "Import Leads", user: req.user, preview: null, msg: "" }));
  r.post("/leads/import", requirePerm("lead.import"), async (req, res) => {
    const raw = String(req.body.rawData || "").trim();
    if (!raw) return res.status(400).send("rawData required");
    const user = req.user as User;
    const rows = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    let ok = 0;
    let fail = 0;
    for (const line of rows) {
      const [company, contact, phone, city, country, brand] = line.split(",").map(x => (x || "").trim());
      if (!company) {
        fail++;
        continue;
      }
      const id = `l_${Math.random().toString(36).slice(2, 10)}`;
      await db.query(
        `INSERT INTO leads(id,company_name,contact_name,phone,city,country,brand_json,owner_id,workflow_stage,created_at,updated_at)
         VALUES(:id,:company,:contact,:phone,:city,:country,:brand,:owner,'已导入',NOW(),NOW())`,
        { id, company, contact: contact || null, phone: phone || null, city: city || null, country: country || "China", brand: JSON.stringify(brand ? [brand] : []), owner: user.id }
      );
      ok++;
    }
    res.render("portal/import_leads", { title: "Import Leads", user, preview: rows.slice(0, 10), msg: `导入完成：成功 ${ok}，失败 ${fail}` });
  });

  r.get("/leads/template", async (_req, res) => {
    const header = "company_name,contact_name,phone,city,country,brand,social_credit_code,website,street,house_number,postal_code,company_profile\n";
    const sample = "示例公司,张三,13800000000,Shenzhen,China,BrandA,9144XXXX,www.example.com,Nanshan,88,518000,主营跨境电商\n";
    const data = header + sample;
    const p = path.join(process.cwd(), "tmp-lead-template.csv");
    await fs.writeFile(p, data, "utf8");
    res.download(p, "lead_import_template.csv");
  });

  r.get("/leads/export", requirePerm("lead.export"), async (_req, res) => {
    const [rows] = await db.query<any[]>(`SELECT company_name,contact_name,phone,city,country,brochure_sent_count,visit_count,next_visit_reminder FROM leads ORDER BY created_at DESC LIMIT 1000`);
    const head = "company_name,contact_name,phone,city,country,brochure_sent_count,visit_count,next_visit_reminder\n";
    const body = rows.map((r: any) => [r.company_name, r.contact_name, r.phone, r.city, r.country, r.brochure_sent_count, r.visit_count, r.next_visit_reminder].map((x: any) => `"${String(x ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=leads_export.csv");
    res.send(head + body);
  });

  r.get("/campaigns", requirePerm("campaign.view"), async (req, res) => {
    const selectedIds = parseIds(req.query.ids);
    let selectedLeads: any[] = [];
    if (selectedIds.length) {
      const params = Object.fromEntries(selectedIds.map((x, i) => [`id${i}`, x]));
      const [rows] = await db.query<any[]>(
        `SELECT id,company_name AS companyName,contact_name AS contactName,phone,country,workflow_stage AS stage
         FROM leads
         WHERE id IN (${selectedIds.map((_, i) => `:id${i}`).join(",")})`,
        params
      );
      selectedLeads = rows;
    }

    const [batches] = await db.query<any[]>(
      `SELECT b.id,b.name,b.template_name AS templateName,b.status,b.operator_id AS operator,b.created_at AS createdAt,
              COUNT(i.id) AS leadCount,
              SUM(CASE WHEN i.push_status='Failed' THEN 1 ELSE 0 END) AS failedCount
       FROM campaign_batches b
       LEFT JOIN campaign_batch_items i ON i.batch_id=b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT 200`
    );
    res.render("portal/campaign", { title: "Campaigns", user: req.user, selectedIds, selectedLeads, batches });
  });

  r.get("/campaigns/new", requirePerm("campaign.create"), async (req, res) => {
    const ids = parseIds(req.query.ids);
    const [leads] = ids.length
      ? await db.query<any[]>(`SELECT id,company_name AS companyName,brochure_sent_count AS brochureSentCount,brochure_limit_count AS brochureLimitCount FROM leads WHERE id IN (${ids.map((_, i) => `:id${i}`).join(",")})`, Object.fromEntries(ids.map((x, i) => [`id${i}`, x])))
      : [[], [] as any];
    res.render("portal/campaign_new", { title: "New Campaign", user: req.user, ids, leads });
  });

  r.post("/campaigns", requirePerm("campaign.create"), async (req, res) => {
    const user = req.user as User;
    const ids = parseIds(req.body.ids);
    if (!ids.length) return res.status(400).send("ids required");
    const batchId = `cb_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`INSERT INTO campaign_batches(id,name,template_name,note,status,operator_id,created_at,updated_at) VALUES(:id,:name,:tpl,:note,'Draft',:op,NOW(),NOW())`, {
      id: batchId,
      name: String(req.body.name || "批次"),
      tpl: String(req.body.template_name || req.body.templateName || "标准模板"),
      note: String(req.body.note || "") || null,
      op: user.id,
    });
    for (const leadId of ids) {
      const [[lead]] = await db.query<any[]>(`SELECT brochure_sent_count AS sent, brochure_limit_count AS lim FROM leads WHERE id=:id`, { id: leadId });
      const overLimit = Number(lead?.sent || 0) >= Number(lead?.lim || 0);
      if (overLimit && user.role !== "Admin") continue;
      await db.query(`INSERT INTO campaign_batch_items(id,batch_id,lead_id,push_status,created_at) VALUES(:id,:bid,:lid,'NotPushed',NOW())`, {
        id: `cbi_${Math.random().toString(36).slice(2, 10)}`,
        bid: batchId,
        lid: leadId,
      });
      await db.query(`UPDATE leads SET brochure_sent_count=brochure_sent_count+1, updated_at=NOW(), workflow_stage='已发册' WHERE id=:id`, { id: leadId });
      await saveLeadActivity(leadId, "brochure_sent", user.id, `批次 ${batchId}`);
    }
    res.redirect(`/portal/campaigns/${batchId}`);
  });

  r.get("/campaigns/:batchId", requirePerm("campaign.detail"), async (req, res) => {
    const batchId = req.params.batchId;
    const [[batch]] = await db.query<any[]>(`SELECT id,name,template_name AS templateName,note,status,operator_id AS operator,created_at AS createdAt FROM campaign_batches WHERE id=:id`, { id: batchId });
    if (!batch) return res.status(404).send("Batch not found");
    const [items] = await db.query<any[]>(
      `SELECT i.id,i.lead_id AS leadId,i.shipment_id AS shipmentId,i.push_status AS pushStatus,i.push_error AS pushError,
              l.company_name AS companyName,l.contact_name AS contactName,
              s.waybill_no AS waybillNo,s.logistics_status AS logisticsStatus,
              (SELECT MAX(event_time) FROM shipment_events e WHERE e.shipment_id=s.id) AS lastTrackAt
       FROM campaign_batch_items i
       INNER JOIN leads l ON l.id=i.lead_id
       LEFT JOIN shipments s ON s.id=i.shipment_id
       WHERE i.batch_id=:id
       ORDER BY i.created_at DESC`,
      { id: batchId }
    );
    res.render("portal/campaign_detail", { title: "Campaign Detail", user: req.user, batch, items });
  });

  r.post("/campaigns/:batchId/push-yto", requirePerm("campaign.track"), async (req, res) => {
    const batchId = req.params.batchId;
    const [items] = await db.query<any[]>(
      `SELECT i.id,i.lead_id AS leadId,l.contact_name AS contactName,l.phone,l.country,l.address
       FROM campaign_batch_items i INNER JOIN leads l ON l.id=i.lead_id
       WHERE i.batch_id=:id`,
      { id: batchId }
    );
    for (const item of items) {
      const sid = `s_${Math.random().toString(36).slice(2, 10)}`;
      const waybillNo = `YT${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;
      await db.query(
        `INSERT INTO shipments(id,lead_id,carrier,waybill_no,push_status,logistics_status,receiver_name,receiver_phone,receiver_country,receiver_address,created_at,updated_at)
         VALUES(:id,:leadId,'YTO',:waybill,'Pushed','Pending',:name,:phone,:country,:addr,NOW(),NOW())`,
        { id: sid, leadId: item.leadId, waybill: waybillNo, name: item.contactName, phone: item.phone, country: item.country, addr: item.address }
      );
      await db.query(`UPDATE campaign_batch_items SET shipment_id=:sid,push_status='Pushed',push_error=NULL WHERE id=:id`, { sid, id: item.id });
    }
    await db.query(`UPDATE campaign_batches SET status='Sent', updated_at=NOW() WHERE id=:id`, { id: batchId });
    res.redirect(`/portal/campaigns/${batchId}`);
  });

  r.post("/campaigns/:batchId/refresh-track", requirePerm("campaign.track"), async (req, res) => {
    const [items] = await db.query<any[]>(`SELECT shipment_id AS shipmentId FROM campaign_batch_items WHERE batch_id=:id AND shipment_id IS NOT NULL`, { id: req.params.batchId });
    for (const i of items) {
      await db.query(`INSERT INTO shipment_events(shipment_id,event_time,status,description,location,created_at) VALUES(:sid,NOW(),'TrackRefresh','批次刷新轨迹','YTO',NOW())`, { sid: i.shipmentId });
    }
    res.redirect(`/portal/campaigns/${req.params.batchId}`);
  });

  r.get("/shipments", async (req, res) => {
    const [rows] = await db.query<any[]>(`SELECT s.id,s.waybill_no AS waybillNo,s.push_status AS pushStatus,s.logistics_status AS logisticsStatus,s.updated_at AS updatedAt,l.company_name AS companyName FROM shipments s INNER JOIN leads l ON l.id=s.lead_id ORDER BY s.updated_at DESC LIMIT 300`);
    res.render("portal/shipments", { title: "Shipments", user: req.user, rows, q: "", status: "", pushStatus: "", stats: { total: rows.length }, statusOptions: [], pushStatusOptions: [] });
  });

  r.get("/shipments/:id", async (req, res) => {
    const [[shipment]] = await db.query<any[]>(`SELECT s.*,l.id AS leadId,l.company_name AS companyName,l.contact_name AS contactName,l.email AS leadEmail,l.phone AS leadPhone FROM shipments s INNER JOIN leads l ON l.id=s.lead_id WHERE s.id=:id`, { id: req.params.id });
    if (!shipment) return res.status(404).send("Shipment not found");
    const [events] = await db.query<any[]>(`SELECT id,event_time AS eventTime,status,description,location,created_at AS createdAt FROM shipment_events WHERE shipment_id=:id ORDER BY COALESCE(event_time,created_at) DESC`, { id: req.params.id });
    res.render("portal/shipment_detail", { title: "Shipment", user: req.user, shipment: { ...shipment, waybillNo: shipment.waybill_no, pushStatus: shipment.push_status, logisticsStatus: shipment.logistics_status, receiverName: shipment.receiver_name, receiverPhone: shipment.receiver_phone, receiverCountry: shipment.receiver_country, receiverAddress: shipment.receiver_address, createdAt: shipment.created_at, updatedAt: shipment.updated_at }, events });
  });

  r.post("/shipments/:id/mark-returned", async (req, res) => {
    const id = req.params.id;
    const [[shipment]] = await db.query<any[]>(`SELECT id,waybill_no AS waybillNo,receiver_name AS receiverName,receiver_phone AS receiverPhone,receiver_country AS receiverCountry,receiver_address AS receiverAddress FROM shipments WHERE id=:id`, { id });
    if (!shipment) return res.status(404).send("Shipment not found");
    await db.query(`UPDATE shipments SET logistics_status='Returned', updated_at=NOW() WHERE id=:id`, { id });
    const push = await yuantongService.pushReturnOrder({ bizId: id, waybillNo: shipment.waybillNo, receiverName: shipment.receiverName, receiverPhone: shipment.receiverPhone, receiverAddress: shipment.receiverAddress, receiverCountry: shipment.receiverCountry });
    await db.query(`INSERT INTO shipment_events(shipment_id,event_time,status,description,location,created_at) VALUES(:id,NOW(),:status,:desc,'SYSTEM',NOW())`, {
      id,
      status: push.ok ? "ReturnPushed" : "ReturnPushFailed",
      desc: push.ok ? "退单已推送圆通" : `退单推送失败 ${push.error || ""}`,
    });
    res.redirect(`/portal/shipments/${id}`);
  });

  r.post("/returns/:id/retry-yto", async (req, res) => {
    const id = req.params.id;
    const [[shipment]] = await db.query<any[]>(`SELECT id,waybill_no AS waybillNo,receiver_name AS receiverName,receiver_phone AS receiverPhone,receiver_country AS receiverCountry,receiver_address AS receiverAddress FROM shipments WHERE id=:id`, { id });
    if (!shipment) return res.status(404).send("Shipment not found");
    const push = await yuantongService.pushReturnOrder({ bizId: id, waybillNo: shipment.waybillNo, receiverName: shipment.receiverName, receiverPhone: shipment.receiverPhone, receiverAddress: shipment.receiverAddress, receiverCountry: shipment.receiverCountry });
    await db.query(`INSERT INTO shipment_events(shipment_id,event_time,status,description,location,created_at) VALUES(:id,NOW(),:status,:desc,'SYSTEM',NOW())`, {
      id,
      status: push.ok ? "ReturnRetryPushed" : "ReturnRetryFailed",
      desc: push.ok ? "退单重试成功" : `退单重试失败 ${push.error || ""}`,
    });
    res.redirect(`/portal/shipments/${id}`);
  });

  r.get("/reminders", requirePerm("lead.reminder"), async (req, res) => {
    const [todayRows] = await db.query<any[]>(`SELECT id,company_name AS companyName,contact_name AS contactName,next_visit_reminder AS reminderAt FROM leads WHERE DATE(next_visit_reminder)=CURDATE() ORDER BY next_visit_reminder ASC`);
    const [overdueRows] = await db.query<any[]>(`SELECT id,company_name AS companyName,contact_name AS contactName,next_visit_reminder AS reminderAt FROM leads WHERE next_visit_reminder < NOW() ORDER BY next_visit_reminder ASC`);
    res.render("portal/reminders", { title: "Reminders", user: req.user, todayRows, overdueRows });
  });

  r.get("/logs", requirePerm("report.view"), async (req, res) => {
    const q = String(req.query.q || "");
    const [rows] = await db.query<any[]>(
      `SELECT a.id,a.lead_id AS leadId,a.activity_type AS type,a.note,a.created_at AS createdAt,u.username AS operator
       FROM lead_activity_logs a LEFT JOIN users u ON u.id=a.operator_id
       WHERE (:q='' OR a.lead_id=:q OR a.activity_type LIKE :qLike)
       ORDER BY a.created_at DESC LIMIT 500`,
      { q, qLike: `%${q}%` }
    );
    res.render("portal/logs", { title: "Logs", user: req.user, q, rows });
  });

  r.get("/analytics", async (_req, res) => {
    const [funnelRows] = await db.query<any[]>(`SELECT workflow_stage AS stage,COUNT(*) AS cnt FROM leads GROUP BY workflow_stage`);
    const [countryRows] = await db.query<any[]>(`SELECT COALESCE(country,'Unknown') AS country,COUNT(*) AS cnt FROM leads GROUP BY COALESCE(country,'Unknown') ORDER BY cnt DESC LIMIT 10`);
    const [shipmentRows] = await db.query<any[]>(`SELECT logistics_status AS status,COUNT(*) AS cnt FROM shipments GROUP BY logistics_status`);
    res.render("portal/analytics", { title: "Analytics", user: _req.user, funnelRows, countryRows, shipmentRows, stages: Object.keys(NEXT_STAGE) });
  });

  r.get("/workflow", async (_req, res) => {
    res.redirect("/portal/leads");
  });

  r.get("/followups", async (req, res) => {
    const [rows] = await db.query<any[]>(`SELECT f.id,f.channel,f.content,f.result,f.created_at AS createdAt,l.id AS leadId,l.company_name AS companyName FROM lead_followups f INNER JOIN leads l ON l.id=f.lead_id ORDER BY f.created_at DESC LIMIT 200`);
    res.render("portal/followups", { title: "Followups", user: req.user, q: "", result: "", rows, statsRows: [] });
  });

  r.use((err: any, req: any, res: any, _next: any) => {
    const message = String(err?.message || "");
    const code = String(err?.code || "");
    const dbUnavailable = code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "PROTOCOL_CONNECTION_LOST" || /connect|database|pool|connection/i.test(message);
    if (dbUnavailable) {
      if (req.method === "GET") {
        return res.status(503).render("portal/db_unavailable", {
          title: "Database Unavailable",
          user: req.user,
          requestPath: req.originalUrl,
          dbHost: process.env.DB_HOST || "127.0.0.1",
          dbPort: process.env.DB_PORT || "3306",
          dbName: process.env.DB_NAME || "marketing",
        });
      }
      return res.status(503).send("数据库暂不可用，请先启动 MySQL 并检查 .env 配置。");
    }
    console.error("[portal] unexpected error", err);
    return res.status(500).send("系统异常，请稍后再试。");
  });

  return r;
}
