import { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db.js";
import { csrfCheck } from "../middlewares/marketingSecurity.js";
import { currentUser } from "../services/marketingAccess.js";
import { ownedSession, runAnalysis } from "../services/aiAssistant.js";
import { wallToUtc, utcSql } from "../services/mailingCalendar.js";
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch((e) =>
    res.status(e.status || 400).json({ error: e.message }),
  );
export default function aiRoutes() {
  const r = Router();
  r.get(
    "/ai-assistant",
    wrap(async (req, res) => {
      await currentUser(req.user.id);
      res.render("portal/ai_assistant", {
        title: "AI 助手",
        active: "ai-assistant",
        leadIds: String(req.query.leadIds || ""),
      });
    }),
  );
  r.get(
    "/ai-assistant/sessions",
    wrap(async (req, res) => {
      await currentUser(req.user.id);
      const [rows] = await db.query(
        "SELECT id,title,created_at FROM ai_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        [req.user.id],
      );
      res.json(rows);
    }),
  );
  r.post(
    "/ai-assistant/sessions",
    csrfCheck,
    wrap(async (req, res) => {
      await currentUser(req.user.id);
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO ai_sessions(id,user_id,title) VALUES(?,?,?)",
        [id, req.user.id, String(req.body.title || "新对话").slice(0, 160)],
      );
      res.json({ id });
    }),
  );
  r.get(
    "/ai-assistant/sessions/:id",
    wrap(async (req, res) => {
      await ownedSession(req.user.id, req.params.id);
      const [rows] = await db.query(
        "SELECT role,content,created_at FROM ai_messages WHERE session_id=? ORDER BY id LIMIT 200",
        [req.params.id],
      );
      res.json(rows);
    }),
  );
  r.post(
    "/ai-assistant/sessions/:id/chat",
    csrfCheck,
    wrap(async (req, res) => {
      await ownedSession(req.user.id, req.params.id);
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const emit = (event, data) => {
        if (!res.destroyed)
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      try {
        await runAnalysis({
          userId: req.user.id,
          sessionId: req.params.id,
          requestKey: String(req.body.requestKey || ""),
          message: req.body.message,
          selectedIds: req.body.leadIds || [],
          dateFrom: req.body.dateFrom
            ? utcSql(wallToUtc(req.body.dateFrom + " 00:00:00"))
            : null,
          dateTo: req.body.dateTo
            ? utcSql(wallToUtc(req.body.dateTo + " 23:59:59"))
            : null,
          signal: controller.signal,
          emit,
        });
      } catch (e) {
        emit("error", { message: e.message });
      } finally {
        res.end();
      }
    }),
  );
  return r;
}
