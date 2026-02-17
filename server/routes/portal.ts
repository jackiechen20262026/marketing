import type { Router } from "express";
import { Router as createRouter } from "express";
import { db } from "../_core/db";
import { yuantongService } from "../services/yuantong.service";

type User = { id: string; name: string; role: "Admin" | "Supervisor" | "Salesperson" };

const ROLE_LABEL: Record<User["role"], string> = {
  Admin: "管理员",
  Supervisor: "主管",
  Salesperson: "员工",
};

function requireAuth(req: any, _res: any, next: any) {
  const roleKey = String(req.query?.as || "").toLowerCase();
  const role: User["role"] = roleKey === "supervisor" ? "Supervisor" : roleKey === "employee" ? "Salesperson" : "Admin";
  const user: User = {
    id: role === "Admin" ? "u_admin_001" : role === "Supervisor" ? "u_super_001" : "u_emp_001",
    name: role === "Admin" ? "admin" : role === "Supervisor" ? "supervisor" : "employee",
    role,
  };
  req.user = user;
  next();
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

const ALL_STAGES = ["已导入", "已筛选", "已发册", "跟踪中", "已签收", "跟进中", "潜在客户", "已转化", "退件", "已关闭"] as const;

function buildLeadScopeWhere(user: User) {
  if (user.role === "Admin") return { whereSql: "1=1", params: {} as any };
  return { whereSql: "owner_id = :uid", params: { uid: user.id } as any };
}



function requireRole(roles: User["role"][]) {
  return (req: any, res: any, next: any) => {
    const user = req.user as User;
    if (!roles.includes(user.role)) return res.status(403).send("无权限执行此操作");
    return next();
  };
}

function canManageUsers(user: User) {
  return user.role === "Admin" || user.role === "Supervisor";
}

function maskSecret(value: string | null | undefined) {
  if (!value) return "";
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function parseIds(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(x => String(x).trim()).filter(Boolean);
  return String(input || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

export function portalRoutes(): Router {
  const r = createRouter();

  const wrapAsync = (handler: any) => (req: any, res: any, next: any) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
  for (const method of ["get", "post"] as const) {
    const raw = (r as any)[method].bind(r);
    (r as any)[method] = (path: string, ...handlers: any[]) => {
      const wrapped = handlers.map(h => (h?.constructor?.name === "AsyncFunction" ? wrapAsync(h) : h));
      return raw(path, ...wrapped);
    };
  }

  r.use(requireAuth);

  r.get("/", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const [[total]] = await db.query<any[]>(`SELECT COUNT(*) AS c FROM leads WHERE ${scope.whereSql}`, scope.params);
    const [[converted]] = await db.query<any[]>(
      `SELECT COUNT(*) AS c FROM leads WHERE ${scope.whereSql} AND workflow_stage='已转化'`,
      scope.params
    );
    const [[needFollow]] = await db.query<any[]>(
      `SELECT COUNT(*) AS c FROM leads WHERE ${scope.whereSql} AND workflow_stage IN ('已签收','跟进中','潜在客户')`,
      scope.params
    );
    const [[monthNew]] = await db.query<any[]>(
      `SELECT COUNT(*) AS c FROM leads
       WHERE ${scope.whereSql}
       AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
      scope.params
    );

    res.render("portal/dashboard", {
      title: "Dashboard",
      user,
      stats: {
        totalLeads: total?.c ?? 0,
        needFollow: needFollow?.c ?? 0,
        converted: converted?.c ?? 0,
        monthNew: monthNew?.c ?? 0,
      },
    });
  });

  r.get("/users", async (req, res) => {
    const user = req.user as User;
    if (!canManageUsers(user)) return res.status(403).send("无权限访问用户页");

    const [rows] = await db.query<any[]>(
      `SELECT id, username, role, created_at AS createdAt
       FROM users
       ORDER BY FIELD(role, 'Admin', 'Supervisor', 'Salesperson'), created_at DESC`
    );

    const groups = {
      admin: rows.filter(x => x.role === "Admin"),
      supervisor: rows.filter(x => x.role === "Supervisor"),
      employee: rows.filter(x => x.role === "Salesperson"),
    };

    res.render("portal/users", { title: "Users", user, groups, roleLabel: ROLE_LABEL, msg: String(req.query.msg || "") });
  });

  r.post("/users", requireRole(["Admin"]), async (req, res) => {
    const username = String(req.body.username || "").trim();
    const roleInput = String(req.body.role || "Salesperson").trim();
    const role = roleInput === "Admin" || roleInput === "Supervisor" ? roleInput : "Salesperson";
    if (!username) return res.status(400).send("username required");

    const id = `u_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`INSERT INTO users(id, username, role, created_at) VALUES(:id, :username, :role, NOW())`, { id, username, role });
    res.redirect("/portal/users?msg=created");
  });

  r.post("/users/:id/role", requireRole(["Admin"]), async (req, res) => {
    const id = req.params.id;
    const roleInput = String(req.body.role || "Salesperson").trim();
    const role = roleInput === "Admin" || roleInput === "Supervisor" ? roleInput : "Salesperson";
    await db.query(`UPDATE users SET role=:role WHERE id=:id`, { id, role });
    res.redirect("/portal/users?msg=updated");
  });

  r.get("/settings/yuantong", requireRole(["Admin", "Supervisor"]), async (req, res) => {
    const user = req.user as User;
    const config = await yuantongService.getConfigMasked();

    const [logs] = await db.query<any[]>(
      `SELECT id, biz_type AS bizType, biz_id AS bizId, http_status AS httpStatus,
              success, error_message AS errorMessage, created_at AS createdAt
       FROM courier_api_logs
       WHERE courier_code='yto'
       ORDER BY created_at DESC
       LIMIT 30`
    );

    res.render("portal/yto_settings", {
      title: "YTO Settings",
      user,
      config,
      logs,
      saved: String(req.query.saved || ""),
      tested: String(req.query.tested || ""),
      err: String(req.query.err || ""),
    });
  });

  r.post("/settings/yuantong", requireRole(["Admin", "Supervisor"]), async (req, res) => {
    const baseUrl = String(req.body.baseUrl || "").trim();
    const appKey = String(req.body.appKey || "").trim();
    const appSecret = String(req.body.appSecret || "");
    const customerCode = String(req.body.customerCode || "");
    const enabled = String(req.body.enabled || "") === "1";

    if (!baseUrl || !appKey) return res.status(400).send("baseUrl and appKey required");

    await yuantongService.saveConfig({ baseUrl, appKey, appSecret, customerCode, enabled });
    res.redirect("/portal/settings/yuantong?saved=1");
  });

  r.post("/settings/yuantong/test", requireRole(["Admin", "Supervisor"]), async (_req, res) => {
    const cfg = await yuantongService.getConfig();
    if (!cfg) return res.redirect("/portal/settings/yuantong?err=no_config");

    const result = await yuantongService.request({
      method: "yto.open.health.check",
      bizType: "connectivity_test",
      bizId: `test_${Date.now()}`,
      payload: { ping: true, ts: Date.now() },
    });

    if (!result.ok) return res.redirect("/portal/settings/yuantong?tested=0");
    return res.redirect("/portal/settings/yuantong?tested=1");
  });

  r.get("/lead-pool", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const q = String(req.query.q || "");
    const country = String(req.query.country || "");
    const source = String(req.query.source || "");

    const whereParts: string[] = [`${scope.whereSql}`];
    const params: any = { ...scope.params, q, qLike: `%${q}%`, country, source };

    if (country) whereParts.push("country = :country");
    if (source) whereParts.push("source = :source");
    if (q) {
      whereParts.push("(company_name LIKE :qLike OR contact_name LIKE :qLike OR email LIKE :qLike OR phone LIKE :qLike)");
    }

    const whereSql = whereParts.join(" AND ");

    const [rows] = await db.query<any[]>(
      `SELECT id, company_name AS companyName, contact_name AS contactName,
              email, phone, country, source, priority,
              workflow_stage AS stage, created_at AS createdAt
       FROM leads
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT 300`,
      params
    );

    const [sources] = await db.query<any[]>(`SELECT DISTINCT source FROM leads WHERE source IS NOT NULL AND source <> '' ORDER BY source ASC`);

    res.render("portal/lead_pool", {
      title: "Lead Pool",
      user,
      q,
      country,
      source,
      rows,
      sources,
    });
  });

  r.post("/lead-pool/create", async (req, res) => {
    const user = req.user as User;
    const payload = {
      id: `l_${Math.random().toString(36).slice(2, 10)}`,
      companyName: String(req.body.companyName || "").trim(),
      contactName: String(req.body.contactName || "").trim(),
      email: String(req.body.email || "").trim(),
      phone: String(req.body.phone || "").trim(),
      country: String(req.body.country || "").trim(),
      address: String(req.body.address || "").trim(),
      source: String(req.body.source || "Amazon").trim(),
      priority: String(req.body.priority || "M").trim(),
    };

    if (!payload.companyName) return res.status(400).send("companyName required");

    await db.query(
      `INSERT INTO leads(
          id, company_name, contact_name, email, phone, country, address,
          source, priority, owner_id, workflow_stage, created_at, updated_at
       ) VALUES(
          :id, :companyName, :contactName, :email, :phone, :country, :address,
          :source, :priority, :ownerId, '已导入', NOW(), NOW()
       )`,
      {
        ...payload,
        ownerId: user.id,
      }
    );

    res.redirect("/portal/lead-pool");
  });

  r.post("/lead-pool/import", async (req, res) => {
    const user = req.user as User;
    const raw = String(req.body.rawData || "").trim();
    if (!raw) return res.status(400).send("rawData required");

    const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    let success = 0;

    for (const line of lines) {
      const [companyName, contactName, email, phone, country, address] = line.split(",").map(x => (x || "").trim());
      if (!companyName) continue;
      const id = `l_${Math.random().toString(36).slice(2, 10)}`;

      await db.query(
        `INSERT INTO leads(
            id, company_name, contact_name, email, phone, country, address,
            source, priority, owner_id, workflow_stage, created_at, updated_at
         ) VALUES(
            :id, :companyName, :contactName, :email, :phone, :country, :address,
            'Amazon', 'M', :ownerId, '已导入', NOW(), NOW()
         )`,
        { id, companyName, contactName: contactName || null, email: email || null, phone: phone || null, country: country || null, address: address || null, ownerId: user.id }
      );
      success++;
    }

    res.redirect(`/portal/lead-pool?imported=${success}`);
  });

  r.get("/campaigns", async (req, res) => {
    const user = req.user as User;
    const selectedIds = parseIds(req.query.ids);

    let selectedLeads: any[] = [];
    if (selectedIds.length) {
      const placeholders = selectedIds.map((_, i) => `:id${i}`).join(",");
      const params = selectedIds.reduce((acc: any, id, i) => ({ ...acc, [`id${i}`]: id }), {});
      const [rows] = await db.query<any[]>(
        `SELECT id, company_name AS companyName, contact_name AS contactName,
                phone, country, address, workflow_stage AS stage
         FROM leads
         WHERE id IN (${placeholders})`,
        params
      );
      selectedLeads = rows;
    }

    const [batches] = await db.query<any[]>(
      `SELECT b.id, b.name, b.template_name AS templateName, b.status,
              b.created_at AS createdAt, COUNT(i.id) AS leadCount
       FROM campaign_batches b
       LEFT JOIN campaign_batch_items i ON i.batch_id = b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT 100`
    );

    res.render("portal/campaign", { title: "Campaign", user, selectedLeads, selectedIds, batches });
  });

  r.post("/campaigns", async (req, res) => {
    const user = req.user as User;
    const ids = parseIds(req.body.ids);
    const name = String(req.body.name || "").trim();
    const templateName = String(req.body.templateName || "标准宣传单").trim();
    const note = String(req.body.note || "").trim();

    if (!ids.length || !name) return res.status(400).send("name and ids required");

    const batchId = `cb_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(
      `INSERT INTO campaign_batches(id, name, template_name, note, status, operator_id, created_at, updated_at)
       VALUES(:id, :name, :templateName, :note, 'Draft', :uid, NOW(), NOW())`,
      { id: batchId, name, templateName, note: note || null, uid: user.id }
    );

    for (const leadId of ids) {
      await db.query(
        `INSERT INTO campaign_batch_items(id, batch_id, lead_id, created_at)
         VALUES(:id, :batchId, :leadId, NOW())`,
        { id: `cbi_${Math.random().toString(36).slice(2, 10)}`, batchId, leadId }
      );

      await db.query(`UPDATE leads SET workflow_stage='已发册', updated_at=NOW() WHERE id=:id`, { id: leadId });
      await db.query(
        `INSERT INTO workflow_stage_history(lead_id, from_stage, to_stage, operator_id, note, created_at)
         VALUES(:leadId, '已筛选', '已发册', :uid, :note, NOW())`,
        { leadId, uid: user.id, note: `批次 ${name}` }
      );
    }

    res.redirect("/portal/campaigns");
  });

  r.post("/campaigns/:id/push-yto", async (req, res) => {
    const batchId = req.params.id;

    const [items] = await db.query<any[]>(
      `SELECT i.lead_id AS leadId, l.contact_name AS contactName, l.phone, l.country, l.address
       FROM campaign_batch_items i
       INNER JOIN leads l ON l.id = i.lead_id
       WHERE i.batch_id = :batchId`,
      { batchId }
    );

    for (const item of items) {
      const shipmentId = `s_${Math.random().toString(36).slice(2, 10)}`;
      await db.query(
        `INSERT INTO shipments(
          id, lead_id, carrier, waybill_no, push_status, logistics_status,
          receiver_name, receiver_phone, receiver_country, receiver_address,
          created_at, updated_at
        ) VALUES(
          :id, :leadId, 'YTO', :waybillNo, 'Pushed', 'Pending',
          :name, :phone, :country, :address,
          NOW(), NOW()
        )`,
        {
          id: shipmentId,
          leadId: item.leadId,
          waybillNo: `YT${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`,
          name: item.contactName || null,
          phone: item.phone || null,
          country: item.country || null,
          address: item.address || null,
        }
      );

      await db.query(`UPDATE leads SET workflow_stage='跟踪中', updated_at=NOW() WHERE id=:id`, { id: item.leadId });
    }

    await db.query(`UPDATE campaign_batches SET status='Pushed', updated_at=NOW() WHERE id=:id`, { id: batchId });
    res.redirect("/portal/shipments");
  });

  r.get("/workflow", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const stage = (req.query.stage as string) || "已导入";
    const q = (req.query.q as string) || "";

    const [counts] = await db.query<any[]>(
      `SELECT workflow_stage AS stage, COUNT(*) AS cnt FROM leads WHERE ${scope.whereSql} GROUP BY workflow_stage`,
      scope.params
    );

    const [leads] = await db.query<any[]>(
      `SELECT id, company_name AS companyName, contact_name AS contactName, phone, email,
              workflow_stage AS stage, priority, source, updated_at AS updatedAt
       FROM leads
       WHERE ${scope.whereSql}
         AND workflow_stage = :stage
         AND (:q = '' OR company_name LIKE :qLike OR contact_name LIKE :qLike OR email LIKE :qLike OR phone LIKE :qLike)
       ORDER BY updated_at DESC
       LIMIT 200`,
      { ...scope.params, stage, q, qLike: `%${q}%` }
    );

    res.render("portal/workflow", { title: "Workflow", user, stage, q, stageCounts: counts, leads, nextStageMap: NEXT_STAGE, stages: ALL_STAGES });
  });

  r.post("/workflow/:id/move", async (req, res) => {
    const user = req.user as User;
    const id = req.params.id;
    const toStage = String(req.body.toStage || "");
    const note = String(req.body.note || "");
    if (!toStage) return res.status(400).send("toStage required");

    const [[row]] = await db.query<any[]>(`SELECT workflow_stage AS stage FROM leads WHERE id = :id`, { id });
    if (!row) return res.status(404).send("Lead not found");

    await db.query(`UPDATE leads SET workflow_stage=:toStage, updated_at=NOW() WHERE id=:id`, { id, toStage });
    await db.query(
      `INSERT INTO workflow_stage_history(lead_id, from_stage, to_stage, operator_id, note, created_at)
       VALUES(:leadId, :fromStage, :toStage, :opId, :note, NOW())`,
      { leadId: id, fromStage: row.stage, toStage, opId: user.id, note: note || null }
    );

    res.redirect(`/portal/workflow?stage=${encodeURIComponent(toStage)}`);
  });

  r.get("/leads", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const q = (req.query.q as string) || "";
    const stage = (req.query.stage as string) || "";

    const whereParts = [`${scope.whereSql}`];
    if (stage) whereParts.push(`workflow_stage = :stage`);
    if (q) whereParts.push(`(company_name LIKE :qLike OR contact_name LIKE :qLike OR email LIKE :qLike OR phone LIKE :qLike)`);

    const [rows] = await db.query<any[]>(
      `SELECT id, company_name AS companyName, contact_name AS contactName, email, phone,
              workflow_stage AS stage, priority, source, created_at AS createdAt, updated_at AS updatedAt
       FROM leads
       WHERE ${whereParts.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT 200`,
      { ...scope.params, stage, qLike: `%${q}%` }
    );

    res.render("portal/leads", { title: "Leads", user, q, stage, stages: ALL_STAGES, leads: rows });
  });

  r.get("/leads/:id", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const id = req.params.id;
    const tab = (req.query.tab as string) || "overview";

    const [[lead]] = await db.query<any[]>(
      `SELECT id, company_name AS companyName, contact_name AS contactName,
              email, phone, country, address, workflow_stage AS stage,
              priority, source, owner_id AS ownerId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM leads
       WHERE id = :id AND ${scope.whereSql}
       LIMIT 1`,
      { ...scope.params, id }
    );
    if (!lead) return res.status(404).send("Lead not found");

    const [followups] = await db.query<any[]>(
      `SELECT f.id, f.channel, f.content, f.result, f.created_at AS createdAt,
              u.username AS operator
       FROM lead_followups f
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.lead_id = :id
       ORDER BY f.created_at DESC
       LIMIT 100`,
      { id }
    );

    const [stageHistory] = await db.query<any[]>(
      `SELECT h.id, h.from_stage AS fromStage, h.to_stage AS toStage, h.note,
              h.created_at AS createdAt, u.username AS operator
       FROM workflow_stage_history h
       LEFT JOIN users u ON u.id = h.operator_id
       WHERE h.lead_id = :id
       ORDER BY h.created_at DESC
       LIMIT 200`,
      { id }
    );

    const [[shipment]] = await db.query<any[]>(
      `SELECT s.id, s.carrier, s.waybill_no AS waybillNo, s.push_status AS pushStatus,
              s.logistics_status AS logisticsStatus, s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone, s.receiver_country AS receiverCountry,
              s.receiver_address AS receiverAddress, s.created_at AS createdAt, s.updated_at AS updatedAt
       FROM shipments s
       WHERE s.lead_id = :id
       ORDER BY s.created_at DESC
       LIMIT 1`,
      { id }
    );

    const [events] = shipment?.id
      ? await db.query<any[]>(
          `SELECT e.id, e.event_time AS eventTime, e.status, e.description, e.location, e.created_at AS createdAt
           FROM shipment_events e
           WHERE e.shipment_id = :sid
           ORDER BY COALESCE(e.event_time, e.created_at) DESC
           LIMIT 300`,
          { sid: shipment.id }
        )
      : [[] as any[]];

    const timeline = [
      ...stageHistory.map((x: any) => ({ type: "stage", at: x.createdAt, title: `阶段变更：${x.fromStage || "-"} → ${x.toStage}`, meta: x.operator ? `操作人：${x.operator}` : "", note: x.note || "" })),
      ...followups.map((x: any) => ({ type: "followup", at: x.createdAt, title: `跟进：${x.channel}`, meta: x.operator ? `记录人：${x.operator}` : "", note: `${x.content}${x.result ? `（结果：${x.result}）` : ""}` })),
      ...(events as any[]).map((x: any) => ({ type: "logistics", at: x.eventTime || x.createdAt, title: `物流：${x.status || "-"}`, meta: x.location || "", note: x.description || "" })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    res.render("portal/lead_detail", { title: `Lead · ${lead.companyName}`, user, lead, tab, stages: ALL_STAGES, nextStageMap: NEXT_STAGE, followups, stageHistory, shipment: shipment || null, events, timeline });
  });

  r.post("/leads/:id/followups", async (req, res) => {
    const user = req.user as User;
    const id = req.params.id;
    const channel = String(req.body.channel || "Other");
    const content = String(req.body.content || "").trim();
    const result = String(req.body.result || "").trim();
    if (!content) return res.status(400).send("content required");

    await db.query(
      `INSERT INTO lead_followups(lead_id, user_id, channel, content, result, created_at)
       VALUES(:leadId, :userId, :channel, :content, :result, NOW())`,
      { leadId: id, userId: user.id, channel, content, result: result || null }
    );

    res.redirect(`/portal/leads/${encodeURIComponent(id)}?tab=followups`);
  });

  r.get("/followups", async (req, res) => {
    const q = String(req.query.q || "");
    const result = String(req.query.result || "");

    const whereParts: string[] = ["1=1"];
    if (q) whereParts.push("(l.company_name LIKE :qLike OR f.content LIKE :qLike)");
    if (result) whereParts.push("f.result = :result");

    const [rows] = await db.query<any[]>(
      `SELECT f.id, f.channel, f.content, f.result, f.created_at AS createdAt,
              l.id AS leadId, l.company_name AS companyName, l.contact_name AS contactName,
              u.username AS operator
       FROM lead_followups f
       INNER JOIN leads l ON l.id = f.lead_id
       LEFT JOIN users u ON u.id = f.user_id
       WHERE ${whereParts.join(" AND ")}
       ORDER BY f.created_at DESC
       LIMIT 300`,
      { qLike: `%${q}%`, result }
    );

    const [statsRows] = await db.query<any[]>(
      `SELECT COALESCE(result, '未分类') AS resultName, COUNT(*) AS cnt
       FROM lead_followups
       GROUP BY COALESCE(result, '未分类')
       ORDER BY cnt DESC`
    );

    res.render("portal/followups", { title: "Followups", user: req.user, q, result, rows, statsRows });
  });

  r.get("/analytics", async (req, res) => {
    const [funnelRows] = await db.query<any[]>(
      `SELECT workflow_stage AS stage, COUNT(*) AS cnt
       FROM leads
       GROUP BY workflow_stage`
    );

    const [countryRows] = await db.query<any[]>(
      `SELECT COALESCE(country, 'Unknown') AS country, COUNT(*) AS cnt
       FROM leads
       GROUP BY COALESCE(country, 'Unknown')
       ORDER BY cnt DESC
       LIMIT 10`
    );

    const [shipmentRows] = await db.query<any[]>(
      `SELECT logistics_status AS status, COUNT(*) AS cnt
       FROM shipments
       GROUP BY logistics_status`
    );

    res.render("portal/analytics", { title: "Analytics", user: req.user, funnelRows, countryRows, shipmentRows, stages: ALL_STAGES });
  });

  r.get("/shipments", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const q = String(req.query.q || "");
    const status = String(req.query.status || "");
    const pushStatus = String(req.query.pushStatus || "");

    const [statRows] = await db.query<any[]>(
      `SELECT s.logistics_status AS s, COUNT(*) AS c
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE ${scope.whereSql}
       GROUP BY s.logistics_status`,
      scope.params
    );

    const stats = { total: 0, Pending: 0, InTransit: 0, Delivered: 0, Exception: 0, Returned: 0 };
    for (const row of statRows) {
      const key = String(row.s || "");
      const cnt = Number(row.c || 0);
      stats.total += cnt;
      if (key in stats) (stats as any)[key] = cnt;
    }

    const whereParts = [`${scope.whereSql}`];
    if (status) whereParts.push("s.logistics_status = :status");
    if (pushStatus) whereParts.push("s.push_status = :pushStatus");
    if (q) whereParts.push("(s.waybill_no LIKE :qLike OR s.receiver_name LIKE :qLike OR s.receiver_phone LIKE :qLike OR l.company_name LIKE :qLike)");

    const [rows] = await db.query<any[]>(
      `SELECT s.id, s.waybill_no AS waybillNo, s.push_status AS pushStatus, s.logistics_status AS logisticsStatus,
              s.receiver_name AS receiverName, s.receiver_phone AS receiverPhone, s.receiver_country AS receiverCountry,
              s.receiver_address AS receiverAddress, s.updated_at AS updatedAt,
              l.id AS leadId, l.company_name AS companyName
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE ${whereParts.join(" AND ")}
       ORDER BY s.updated_at DESC
       LIMIT 300`,
      { ...scope.params, qLike: `%${q}%`, status, pushStatus }
    );

    res.render("portal/shipments", {
      title: "Shipments",
      user,
      q,
      status,
      pushStatus,
      stats,
      rows,
      statusOptions: ["Pending", "InTransit", "Delivered", "Exception", "Returned"],
      pushStatusOptions: ["NotPushed", "Pushed", "Failed"],
    });
  });

  r.get("/shipments/:id", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const id = req.params.id;

    const [[shipment]] = await db.query<any[]>(
      `SELECT s.id, s.carrier, s.waybill_no AS waybillNo, s.push_status AS pushStatus,
              s.logistics_status AS logisticsStatus, s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone, s.receiver_country AS receiverCountry,
              s.receiver_address AS receiverAddress, s.created_at AS createdAt, s.updated_at AS updatedAt,
              l.id AS leadId, l.company_name AS companyName, l.contact_name AS contactName, l.email AS leadEmail, l.phone AS leadPhone
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE s.id = :id AND ${scope.whereSql}
       LIMIT 1`,
      { ...scope.params, id }
    );

    if (!shipment) return res.status(404).send("Shipment not found");

    const [events] = await db.query<any[]>(
      `SELECT id, event_time AS eventTime, status, description, location, created_at AS createdAt
       FROM shipment_events
       WHERE shipment_id = :id
       ORDER BY COALESCE(event_time, created_at) DESC
       LIMIT 500`,
      { id }
    );

    res.render("portal/shipment_detail", { title: `Shipment · ${shipment.waybillNo || shipment.id}`, user, shipment, events });
  });

  r.post("/shipments/:id/mark-returned", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const id = req.params.id;

    const [[shipment]] = await db.query<any[]>(
      `SELECT s.id, s.waybill_no AS waybillNo, s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone, s.receiver_address AS receiverAddress,
              s.receiver_country AS receiverCountry
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE s.id=:id AND ${scope.whereSql}
       LIMIT 1`,
      { ...scope.params, id }
    );
    if (!shipment) return res.status(404).send("Shipment not found");

    await db.query(`UPDATE shipments SET logistics_status='Returned', updated_at=NOW() WHERE id=:id`, { id });

    const pushResult = await yuantongService.pushReturnOrder({
      bizId: id,
      waybillNo: shipment.waybillNo || null,
      receiverName: shipment.receiverName || null,
      receiverPhone: shipment.receiverPhone || null,
      receiverAddress: shipment.receiverAddress || null,
      receiverCountry: shipment.receiverCountry || null,
    });

    await db.query(
      `INSERT INTO shipment_events(shipment_id, event_time, status, description, location, created_at)
       VALUES(:sid, NOW(), :status, :description, 'SYSTEM', NOW())`,
      {
        sid: id,
        status: pushResult.ok ? "ReturnPushed" : "ReturnPushFailed",
        description: pushResult.ok ? "退单已推送到圆通" : `退单推送失败: ${String(pushResult.error || "unknown")}`,
      }
    );

    res.redirect(`/portal/shipments/${encodeURIComponent(id)}`);
  });

  r.post("/returns/:id/retry-yto", async (req, res) => {
    const id = req.params.id;

    const [[shipment]] = await db.query<any[]>(
      `SELECT id, waybill_no AS waybillNo, receiver_name AS receiverName,
              receiver_phone AS receiverPhone, receiver_address AS receiverAddress,
              receiver_country AS receiverCountry
       FROM shipments
       WHERE id=:id
       LIMIT 1`,
      { id }
    );
    if (!shipment) return res.status(404).send("Shipment not found");

    const result = await yuantongService.pushReturnOrder({
      bizId: id,
      waybillNo: shipment.waybillNo || null,
      receiverName: shipment.receiverName || null,
      receiverPhone: shipment.receiverPhone || null,
      receiverAddress: shipment.receiverAddress || null,
      receiverCountry: shipment.receiverCountry || null,
    });

    await db.query(
      `INSERT INTO shipment_events(shipment_id, event_time, status, description, location, created_at)
       VALUES(:sid, NOW(), :status, :description, 'SYSTEM', NOW())`,
      {
        sid: id,
        status: result.ok ? "ReturnRetryPushed" : "ReturnRetryFailed",
        description: result.ok ? "退单重试成功" : `退单重试失败: ${String(result.error || "unknown")}`,
      }
    );

    res.redirect(`/portal/shipments/${encodeURIComponent(id)}`);
  });

  r.post("/shipments/:id/repush", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const id = req.params.id;

    const [[row]] = await db.query<any[]>(
      `SELECT s.id
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE s.id = :id AND ${scope.whereSql}
       LIMIT 1`,
      { ...scope.params, id }
    );
    if (!row) return res.status(404).send("Shipment not found");

    await db.query(`UPDATE shipments SET push_status='NotPushed', updated_at=NOW() WHERE id=:id`, { id });
    res.redirect(`/portal/shipments/${encodeURIComponent(id)}`);
  });

  r.use((err: any, req: any, res: any, _next: any) => {
    const message = String(err?.message || "");
    const code = String(err?.code || "");
    const dbUnavailable =
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "PROTOCOL_CONNECTION_LOST" ||
      /connect|database|pool|connection/i.test(message);

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
