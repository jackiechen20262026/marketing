import type { Router } from "express";
import { Router as createRouter } from "express";
import { db } from "../_core/db";

type User = { id: string; name: string; role: "Admin" | "Supervisor" | "Salesperson" };

// 假登录（后续接 OAuth/session）
function requireAuth(req: any, _res: any, next: any) {
  const user: User = { id: "u_admin_001", name: "admin", role: "Admin" };
  req.user = user;
  next();
}

const NEXT_STAGE: Record<string, string | null> = {
  "已导入": "已筛选",
  "已筛选": "已发册",
  "已发册": "跟踪中",
  "跟踪中": "已签收",
  "已签收": "跟进中",
  "跟进中": "潜在客户",
  "潜在客户": "已转化",
  "已转化": null,
  "退件": "已关闭",
  "已关闭": null,
};

const ALL_STAGES = [
  "已导入",
  "已筛选",
  "已发册",
  "跟踪中",
  "已签收",
  "跟进中",
  "潜在客户",
  "已转化",
  "退件",
  "已关闭",
] as const;

function buildLeadScopeWhere(user: User) {
  if (user.role === "Admin") return { whereSql: "1=1", params: {} as any };
  return { whereSql: "owner_id = :uid", params: { uid: user.id } as any };
}

export function portalRoutes(): Router {
  const r = createRouter();
  r.use(requireAuth);

  r.get("/", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const [[total]] = await db.query<any[]>(
      `SELECT COUNT(*) AS c FROM leads WHERE ${scope.whereSql}`,
      scope.params
    );
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

  r.get("/workflow", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const stage = (req.query.stage as string) || "已导入";
    const q = (req.query.q as string) || "";

    const [counts] = await db.query<any[]>(
      `SELECT workflow_stage AS stage, COUNT(*) AS cnt
       FROM leads
       WHERE ${scope.whereSql}
       GROUP BY workflow_stage`,
      scope.params
    );

    const params: any = { ...scope.params, stage, qLike: `%${q}%` };
    const [leads] = await db.query<any[]>(
      `SELECT id, company_name AS companyName, contact_name AS contactName, phone, email,
              workflow_stage AS stage, priority, source, updated_at AS updatedAt
       FROM leads
       WHERE ${scope.whereSql}
         AND workflow_stage = :stage
         AND (:q = '' OR company_name LIKE :qLike OR contact_name LIKE :qLike OR email LIKE :qLike OR phone LIKE :qLike)
       ORDER BY updated_at DESC
       LIMIT 200`,
      { ...params, q }
    );

    res.render("portal/workflow", {
      title: "Workflow",
      user,
      stage,
      q,
      stageCounts: counts,
      leads,
      nextStageMap: NEXT_STAGE,
      stages: ALL_STAGES,
    });
  });

  r.post("/workflow/:id/move", async (req, res) => {
    const user = req.user as User;
    const id = req.params.id;
    const toStage = String(req.body.toStage || "");
    const note = String(req.body.note || "");

    if (!toStage) return res.status(400).send("toStage required");

    const [[row]] = await db.query<any[]>(
      `SELECT workflow_stage AS stage FROM leads WHERE id = :id`,
      { id }
    );
    if (!row) return res.status(404).send("Lead not found");
    const fromStage = row.stage as string;

    const next = NEXT_STAGE[fromStage] ?? null;
    const allowed = new Set([next, "退件", "已关闭"].filter(Boolean) as string[]);
    if (!allowed.has(toStage) && user.role !== "Admin") {
      return res.status(400).send(`Stage move not allowed: ${fromStage} -> ${toStage}`);
    }

    await db.query(
      `UPDATE leads SET workflow_stage=:toStage, updated_at=NOW() WHERE id=:id`,
      { id, toStage }
    );

    await db.query(
      `INSERT INTO workflow_stage_history(lead_id, from_stage, to_stage, operator_id, note, created_at)
       VALUES(:leadId, :fromStage, :toStage, :opId, :note, NOW())`,
      { leadId: id, fromStage, toStage, opId: user.id, note: note || null }
    );

    res.redirect(`/portal/workflow?stage=${encodeURIComponent(toStage)}`);
  });

  r.get("/leads", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const q = (req.query.q as string) || "";
    const stage = (req.query.stage as string) || "";
    const params: any = { ...scope.params, q, qLike: `%${q}%`, stage };

    const whereParts = [`${scope.whereSql}`];
    if (stage) whereParts.push(`workflow_stage = :stage`);
    if (q)
      whereParts.push(
        `(company_name LIKE :qLike OR contact_name LIKE :qLike OR email LIKE :qLike OR phone LIKE :qLike)`
      );

    const whereSql = whereParts.join(" AND ");

    const [rows] = await db.query<any[]>(
      `SELECT id, company_name AS companyName, contact_name AS contactName, email, phone,
              workflow_stage AS stage, priority, source, created_at AS createdAt, updated_at AS updatedAt
       FROM leads
       WHERE ${whereSql}
       ORDER BY updated_at DESC
       LIMIT 200`,
      params
    );

    res.render("portal/leads", {
      title: "Leads",
      user,
      q,
      stage,
      stages: ALL_STAGES,
      leads: rows,
    });
  });

  // ========== Lead Detail ==========
  r.get("/leads/:id", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const id = req.params.id;
    const tab = (req.query.tab as string) || "overview";

    const [[lead]] = await db.query<any[]>(
      `SELECT id,
              company_name AS companyName,
              contact_name AS contactName,
              email, phone,
              country, address,
              workflow_stage AS stage,
              priority, source,
              owner_id AS ownerId,
              created_at AS createdAt,
              updated_at AS updatedAt
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
      `SELECT s.id, s.carrier,
              s.waybill_no AS waybillNo,
              s.push_status AS pushStatus,
              s.logistics_status AS logisticsStatus,
              s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone,
              s.receiver_country AS receiverCountry,
              s.receiver_address AS receiverAddress,
              s.created_at AS createdAt, s.updated_at AS updatedAt
       FROM shipments s
       WHERE s.lead_id = :id
       ORDER BY s.created_at DESC
       LIMIT 1`,
      { id }
    );

    let events: any[] = [];
    if (shipment?.id) {
      const [ev] = await db.query<any[]>(
        `SELECT e.id, e.event_time AS eventTime, e.status, e.description, e.location, e.created_at AS createdAt
         FROM shipment_events e
         WHERE e.shipment_id = :sid
         ORDER BY COALESCE(e.event_time, e.created_at) DESC
         LIMIT 300`,
        { sid: shipment.id }
      );
      events = ev;
    }

    const timeline = [
      ...stageHistory.map((x: any) => ({
        type: "stage",
        at: x.createdAt,
        title: `阶段变更：${x.fromStage || "-"} → ${x.toStage}`,
        meta: x.operator ? `操作人：${x.operator}` : "",
        note: x.note || "",
      })),
      ...followups.map((x: any) => ({
        type: "followup",
        at: x.createdAt,
        title: `跟进：${x.channel}`,
        meta: x.operator ? `记录人：${x.operator}` : "",
        note: `${x.content}${x.result ? `（结果：${x.result}）` : ""}`,
      })),
      ...events.map((x: any) => ({
        type: "logistics",
        at: x.eventTime || x.createdAt,
        title: `物流：${x.status || "-"}`,
        meta: x.location || "",
        note: x.description || "",
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    res.render("portal/lead_detail", {
      title: `Lead · ${lead.companyName}`,
      user,
      lead,
      tab,
      stages: ALL_STAGES,
      nextStageMap: NEXT_STAGE,
      followups,
      stageHistory,
      shipment: shipment || null,
      events,
      timeline,
    });
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

  r.post("/leads/:id/shipments", async (req, res) => {
    const id = req.params.id;

    const [[lead]] = await db.query<any[]>(
      `SELECT id, contact_name AS contactName, phone, country, address
       FROM leads
       WHERE id = :id
       LIMIT 1`,
      { id }
    );
    if (!lead) return res.status(404).send("Lead not found");

    const shipmentId = `s_${Math.random().toString(36).slice(2, 10)}`;

    await db.query(
      `INSERT INTO shipments(
          id, lead_id, carrier, push_status, logistics_status,
          receiver_name, receiver_phone, receiver_country, receiver_address,
          created_at, updated_at
       ) VALUES(
          :sid, :leadId, 'YTO', 'NotPushed', 'Pending',
          :name, :phone, :country, :addr,
          NOW(), NOW()
       )`,
      {
        sid: shipmentId,
        leadId: id,
        name: lead.contactName || null,
        phone: lead.phone || null,
        country: lead.country || null,
        addr: lead.address || null,
      }
    );

    res.redirect(`/portal/leads/${encodeURIComponent(id)}?tab=logistics`);
  });
  
    // =========================
  // Shipments List（订单列表）
  // =========================
  r.get("/shipments", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const q = String(req.query.q || "");
    const status = String(req.query.status || ""); // Pending|InTransit|Delivered|Exception|Returned
    const pushStatus = String(req.query.pushStatus || ""); // NotPushed|Pushed|Failed

    // 统计卡片
    const [statRows] = await db.query<any[]>(
      `SELECT logistics_status AS s, COUNT(*) AS c
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE ${scope.whereSql}
       GROUP BY logistics_status`,
      scope.params
    );

    const stats = {
      total: 0,
      Pending: 0,
      InTransit: 0,
      Delivered: 0,
      Exception: 0,
      Returned: 0,
    };

    for (const r of statRows) {
      const key = String(r.s || "");
      const cnt = Number(r.c || 0);
      stats.total += cnt;
      if (key in stats) (stats as any)[key] = cnt;
    }

    const whereParts: string[] = [`${scope.whereSql}`];
    const params: any = { ...scope.params, q, qLike: `%${q}%`, status, pushStatus };

    if (status) whereParts.push(`s.logistics_status = :status`);
    if (pushStatus) whereParts.push(`s.push_status = :pushStatus`);
    if (q) {
      whereParts.push(
        `(s.waybill_no LIKE :qLike OR s.receiver_name LIKE :qLike OR s.receiver_phone LIKE :qLike OR l.company_name LIKE :qLike)`
      );
    }

    const whereSql = whereParts.join(" AND ");

    const [rows] = await db.query<any[]>(
      `SELECT s.id,
              s.waybill_no AS waybillNo,
              s.push_status AS pushStatus,
              s.logistics_status AS logisticsStatus,
              s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone,
              s.receiver_country AS receiverCountry,
              s.receiver_address AS receiverAddress,
              s.created_at AS createdAt,
              s.updated_at AS updatedAt,
              l.id AS leadId,
              l.company_name AS companyName
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE ${whereSql}
       ORDER BY s.updated_at DESC
       LIMIT 300`,
      params
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

  // =========================
  // Shipment Detail（订单详情）
  // =========================
  r.get("/shipments/:id", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const id = req.params.id;

    const [[shipment]] = await db.query<any[]>(
      `SELECT s.id,
              s.carrier,
              s.waybill_no AS waybillNo,
              s.push_status AS pushStatus,
              s.logistics_status AS logisticsStatus,
              s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone,
              s.receiver_country AS receiverCountry,
              s.receiver_address AS receiverAddress,
              s.created_at AS createdAt,
              s.updated_at AS updatedAt,
              l.id AS leadId,
              l.company_name AS companyName,
              l.contact_name AS contactName,
              l.email AS leadEmail,
              l.phone AS leadPhone
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE s.id = :id AND ${scope.whereSql}
       LIMIT 1`,
      { ...scope.params, id }
    );

    if (!shipment) return res.status(404).send("Shipment not found");

    const [events] = await db.query<any[]>(
      `SELECT id,
              event_time AS eventTime,
              status,
              description,
              location,
              created_at AS createdAt
       FROM shipment_events
       WHERE shipment_id = :id
       ORDER BY COALESCE(event_time, created_at) DESC
       LIMIT 500`,
      { id }
    );

    res.render("portal/shipment_detail", {
      title: `Shipment · ${shipment.waybillNo || shipment.id}`,
      user,
      shipment,
      events,
    });
  });

  // （可选）重推：先做成“标记为 Failed->NotPushed”，后面接圆通 API 再真正推送
  r.post("/shipments/:id/repush", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);
    const id = req.params.id;

    // 确保有权限（通过 leads scope）
    const [[row]] = await db.query<any[]>(
      `SELECT s.id
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE s.id = :id AND ${scope.whereSql}
       LIMIT 1`,
      { ...scope.params, id }
    );
    if (!row) return res.status(404).send("Shipment not found");

    await db.query(
      `UPDATE shipments
       SET push_status='NotPushed', updated_at=NOW()
       WHERE id=:id`,
      { id }
    );

    res.redirect(`/portal/shipments/${encodeURIComponent(id)}`);
  });
  
    // =========================
  // Shipments List（订单列表）
  // =========================
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
    for (const r of statRows) {
      const key = String(r.s || "");
      const cnt = Number(r.c || 0);
      stats.total += cnt;
      if (key in stats) (stats as any)[key] = cnt;
    }

    const whereParts: string[] = [`${scope.whereSql}`];
    const params: any = { ...scope.params, q, qLike: `%${q}%`, status, pushStatus };

    if (status) whereParts.push(`s.logistics_status = :status`);
    if (pushStatus) whereParts.push(`s.push_status = :pushStatus`);
    if (q) {
      whereParts.push(
        `(s.waybill_no LIKE :qLike OR s.receiver_name LIKE :qLike OR s.receiver_phone LIKE :qLike OR l.company_name LIKE :qLike)`
      );
    }

    const whereSql = whereParts.join(" AND ");

    const [rows] = await db.query<any[]>(
      `SELECT s.id,
              s.waybill_no AS waybillNo,
              s.push_status AS pushStatus,
              s.logistics_status AS logisticsStatus,
              s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone,
              s.updated_at AS updatedAt,
              l.id AS leadId,
              l.company_name AS companyName
       FROM shipments s
       INNER JOIN leads l ON l.id = s.lead_id
       WHERE ${whereSql}
       ORDER BY s.updated_at DESC
       LIMIT 300`,
      params
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

  // =========================
  // Shipment Detail（订单详情）
  // =========================
  r.get("/shipments/:id", async (req, res) => {
    const user = req.user as User;
    const scope = buildLeadScopeWhere(user);

    const id = req.params.id;

    const [[shipment]] = await db.query<any[]>(
      `SELECT s.id,
              s.carrier,
              s.waybill_no AS waybillNo,
              s.push_status AS pushStatus,
              s.logistics_status AS logisticsStatus,
              s.receiver_name AS receiverName,
              s.receiver_phone AS receiverPhone,
              s.receiver_country AS receiverCountry,
              s.receiver_address AS receiverAddress,
              s.created_at AS createdAt,
              s.updated_at AS updatedAt,
              l.id AS leadId,
              l.company_name AS companyName
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

    res.render("portal/shipment_detail", {
      title: `Shipment · ${shipment.waybillNo || shipment.id}`,
      user,
      shipment,
      events,
    });
  });

  // 重推（MVP：先把状态打回 NotPushed）
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



  return r;
}
