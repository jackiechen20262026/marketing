import express from "express";
import * as financeController from "../controllers/finance.controller.js";

export default function financeRoutes() {
  const r = express.Router();

  // 列表+筛选+分页
  r.get("/finance-ledger", financeController.listPage);

  // 新增流水（支持补录历史日期）
  r.post("/finance-ledger", financeController.create);

  // 作废（不删除）
  r.post("/finance-ledger/:id/void", financeController.voidRecord);

  return r;
}