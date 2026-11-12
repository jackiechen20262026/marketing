import mailingRoutes from './mailing.routes.js';
import aiRoutes from './ai.routes.js';
// routes/portal.js
import express from "express";
import leadRoutes from "./lead.routes.js";
import batchRoutes from "./batch.routes.js";
import userRoutes from "./user.routes.js";
import { requireAuth } from "../middlewares/auth.js";
import financeRoutes from "./finance.routes.js";

export default function portalRoutes() {
  const r = express.Router();

  // ✅ 所有 /portal 下必须登录
  r.use(requireAuth);

  r.use(mailingRoutes());
  r.use(aiRoutes());

  // 线索模块
  r.use(leadRoutes());

  // 批次模块
  r.use(batchRoutes());

  // 用户管理模块（内部已做 requireAdmin）
  r.use(userRoutes());
  
  r.use(financeRoutes());

  return r;
}