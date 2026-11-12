import { Router } from "express";
import { db } from "../db.js";
import { csrfCheck } from "../middlewares/marketingSecurity.js";
import { assertLead, currentUser, audit } from "../services/marketingAccess.js";
import {
  setImportant,
  savePlan,
  shipmentAction,
  transaction,
} from "../services/mailing.service.js";
import {
  resolveException,
  openException,
} from "../services/mailingExceptions.js";
import { listStats, exportStats, metrics } from "../services/mailingStats.js";
import { wallTime, fromUtcSql } from "../services/mailingCalendar.js";
import batchService from "../services/batch.service.js";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch((e) =>
    res.status(e.status || 400).send(e.message),
  );
export default function mailingRoutes() {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });
  const attachmentRoot = path.resolve(
    process.env.MAIL_ATTACHMENT_DIR || "storage/mailing-attachments",
  );
  r.post(
    "/mailing/exceptions/:id/attachment",
    upload.single("attachment"),
    csrfCheck,
    wrap(async (req, res) => {
      const [[x]] = await db.query(
        "SELECT * FROM mailing_exceptions WHERE id=?",
        [req.params.id],
      );
      if (!x) throw Error("异常不存在");
      await assertLead(req.user, x.lead_id);
      const b = req.file?.buffer;
      if (!b) throw Error("请选择附件");
      const ext =
        b.subarray(0, 5).toString() === "%PDF-"
          ? "pdf"
          : b
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "png"
            : b[0] === 255 && b[1] === 216
              ? "jpg"
              : null;
      if (!ext) throw Error("仅支持经过文件签名验证的 PDF、PNG、JPEG");
      await fs.mkdir(attachmentRoot, { recursive: true });
      const name = crypto.randomUUID() + "." + ext;
      await fs.writeFile(path.join(attachmentRoot, name), b, { flag: "wx" });
      await transaction(async (c) => {
        await c.query("UPDATE mailing_exceptions SET attachment=? WHERE id=?", [
          name,
          x.id,
        ]);
        await audit(c, {
          leadId: x.lead_id,
          userId: req.user.id,
          action: "exception_attachment",
          after: { exceptionId: x.id, file: name },
        });
      });
      res.redirect("/portal/leads/" + x.lead_id + "/mailing");
    }),
  );
  r.get(
    "/mailing/exceptions/:id/attachment",
    wrap(async (req, res) => {
      const [[x]] = await db.query(
        "SELECT * FROM mailing_exceptions WHERE id=?",
        [req.params.id],
      );
      if (!x) throw Error("异常不存在");
      await assertLead(req.user, x.lead_id);
      if (!/^[a-f0-9-]+\.(pdf|png|jpg)$/.test(x.attachment || ""))
        throw Error("附件不存在");
      res.download(path.join(attachmentRoot, x.attachment));
    }),
  );
  r.post(
    "/mailing/shipments/:id/resend",
    csrfCheck,
    wrap(async (req, res) => {
      const user = await currentUser(req.user.id);
      const [[s]] = await db.query(
        "SELECT id,lead_id FROM shipments WHERE id=?",
        [req.params.id],
      );
      if (!s) throw Error("运单不存在");
      const b = await batchService.createBatch({
        user,
        batchName: "补寄草稿 " + s.id,
        leadIds: [s.lead_id],
        early: true,
        reason: req.body.reason,
        originalShipmentId: s.id,
      });
      res.redirect("/portal/batches/" + b.id);
    }),
  );
  r.get(
    "/mailing",
    wrap(async (req, res) => {
      const user = await currentUser(req.user.id);
      const filters = { ...req.query, user };
      const data = await listStats(filters);
      const [tasks] = await db.query(
        `SELECT t.*,l.company_name FROM todo_tasks t JOIN leads l ON l.id=t.lead_id WHERE t.task_type IN ('mailing_due','mailing_exception') AND t.status IN ('pending','planned') ${user.role === "Admin" ? "" : "AND (t.owner_user_id=? OR l.owner_id=?)"} ORDER BY t.owner_user_id IS NULL DESC,t.due_at LIMIT 200`,
        user.role === "Admin" ? [] : [user.id, user.id],
      );
      res.render("portal/mailing", {
        title: "发信计划与统计",
        active: "mailing",
        ...data,
        filters,
        metrics,
        tasks,
      });
    }),
  );
  r.get(
    "/mailing/export",
    wrap(async (req, res) => {
      const user = await currentUser(req.user.id);
      res.type("text/csv").attachment("mailing.csv");
      res.write(
        "\uFEFF客户编号,客户,重要,加入批次,下单成功,实际寄出,物流签收,客户确认\r\n",
      );
      const cell = (v) =>
        '"' +
        String(v ?? "")
          .replace(/^[=+@-]/, "'$&")
          .replaceAll('"', '""') +
        '"';
      for await (const row of exportStats({ ...req.query, user })) {
        if (res.destroyed) break;
        res.write(
          [
            row.id,
            row.company_name,
            row.important_flag,
            row.mail_count,
            row.ordered_count,
            row.dispatched_count,
            row.signed_count,
            row.confirmed_count,
          ]
            .map(cell)
            .join(",") + "\r\n",
        );
      }
      res.end();
    }),
  );
  r.get(
    "/leads/:id/mailing",
    wrap(async (req, res) => {
      const lead = await assertLead(req.user, req.params.id);
      const [[plan]] = await db.query(
        "SELECT * FROM mailing_plans WHERE lead_id=?",
        [lead.id],
      );
      const [shipments] = await db.query(
        "SELECT id,waybill_no,push_status,dispatched_at,signed_at,confirmed_received_at,original_shipment_id,query_status FROM shipments WHERE lead_id=? ORDER BY id DESC LIMIT 100",
        [lead.id],
      );
      const [exceptions] = await db.query(
        "SELECT * FROM mailing_exceptions WHERE lead_id=? ORDER BY id DESC LIMIT 100",
        [lead.id],
      );
      const [history] = await db.query(
        "SELECT action,reason,created_at FROM marketing_audit WHERE lead_id=? ORDER BY id DESC LIMIT 30",
        [lead.id],
      );
      const [owners] = await db.query(
        "SELECT id,name,username FROM users WHERE status=1",
      );
      res.render("portal/mailing_detail", {
        title: "客户发信计划",
        active: "mailing",
        lead,
        plan,
        shipments,
        exceptions,
        history,
        owners,
        nextLocal: plan?.next_at
          ? wallTime(fromUtcSql(plan.next_at)).slice(0, 16).replace(" ", "T")
          : "",
      });
    }),
  );
  r.post(
    "/leads/:id/important",
    csrfCheck,
    wrap(async (req, res) => {
      await setImportant(req.user, req.params.id, req.body.flag === "1");
      res.redirect("/portal/leads/" + req.params.id + "/mailing");
    }),
  );
  r.post(
    "/leads/:id/mailing",
    csrfCheck,
    wrap(async (req, res) => {
      await savePlan(req.user, req.params.id, req.body);
      res.redirect("/portal/leads/" + req.params.id + "/mailing");
    }),
  );
  r.post(
    "/mailing/shipments/:id/evidence",
    csrfCheck,
    wrap(async (req, res) => {
      await shipmentAction(req.user, req.params.id, req.body);
      res.redirect("/portal/mailing");
    }),
  );
  r.post(
    "/mailing/exceptions/:id/resolve",
    csrfCheck,
    wrap(async (req, res) => {
      await resolveException(req.user, req.params.id, req.body);
      res.redirect("/portal/mailing");
    }),
  );
  r.post(
    "/mailing/exceptions/:id/assign",
    csrfCheck,
    wrap(async (req, res) => {
      await transaction(async (c) => {
        const actor = await currentUser(req.user.id, c);
        const [[x]] = await c.query(
          "SELECT * FROM mailing_exceptions WHERE id=?",
          [req.params.id],
        );
        if (!x) throw Error("异常不存在");
        await assertLead(actor, x.lead_id, c, true);
        const owner = req.body.owner_id ? Number(req.body.owner_id) : null;
        if (owner) await currentUser(owner, c);
        if (actor.role !== "Admin" && String(owner) !== String(actor.id))
          throw Error("仅管理员可转派");
        if (!req.body.note) throw Error("请填写处理备注");
        await c.query(
          "UPDATE mailing_exceptions SET owner_id=?,note=? WHERE id=?",
          [owner, String(req.body.note).slice(0, 4000), x.id],
        );
        await c.query(
          "UPDATE todo_tasks SET owner_user_id=? WHERE dedupe_key=?",
          [owner, "exception:" + x.id],
        );
        await audit(c, {
          leadId: x.lead_id,
          userId: actor.id,
          action: "exception_assigned",
          reason: req.body.note,
          after: { exceptionId: x.id, owner },
        });
      });
      res.redirect("/portal/mailing");
    }),
  );
  r.post(
    "/mailing/shipments/:id/not-received",
    csrfCheck,
    wrap(async (req, res) => {
      await transaction(async (c) => {
        const [[s]] = await c.query("SELECT * FROM shipments WHERE id=?", [
          req.params.id,
        ]);
        if (!s) throw Error("运单不存在");
        await assertLead(req.user, s.lead_id, c, true);
        if (!req.body.reason) throw Error("必须填写客户反馈");
        await openException(
          c,
          s,
          "customer_not_received",
          String(req.body.reason).slice(0, 1000),
          true,
        );
        await audit(c, {
          leadId: s.lead_id,
          userId: req.user.id,
          action: "not_received",
          reason: req.body.reason,
          after: { shipmentId: s.id },
        });
      });
      res.redirect("/portal/mailing");
    }),
  );
  r.post(
    "/leads/:id/early-mailing",
    csrfCheck,
    wrap(async (req, res) => {
      const user = await currentUser(req.user.id);
      const b = await batchService.createBatch({
        user,
        batchName: "提前发件 " + req.params.id,
        leadIds: [req.params.id],
        early: true,
        reason: req.body.reason,
      });
      res.redirect("/portal/batches/" + b.id);
    }),
  );
  return r;
}
