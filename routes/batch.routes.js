import { Router } from "express";
import * as batchModule from "../controllers/batch.controller.js";

export default function batchRoutes() {
  const router = Router();

  const ctrl = batchModule?.default ? { ...batchModule.default, ...batchModule } : batchModule;

  const H = (name) => {
    const fn = ctrl?.[name];
    if (typeof fn === "function") return fn;
    return (req, res) => res.status(500).send(`Batch handler not implemented: ${name}`);
  };

  // ===== 页面 =====
  router.get("/batches", H("listPage"));
  router.get("/batches/create", H("createPage"));
  router.get("/batches/new", (req, res) => res.redirect("/portal/batches/create"));
  router.post("/batches", H("createBatch"));

  // 详情页
  router.get("/batches/:id", H("detailPage"));

  // 删除整个批次
  router.post("/batches/:id/delete", H("deleteBatch"));

  // 删除选中明细（把客户移出当前批次）
  router.post("/batches/:id/remove-items", H("removeBatchItems"));

  // 页面按钮（POST）
  router.post("/batches/:id/push-yto", H("pushYto"));
  router.post("/batches/:id/repush-failed", H("repushFailed"));

  // 兼容 GET
  router.get("/batches/:id/yto/push", H("pushYto"));
  router.get("/batches/:id/yto/retry-failed", H("repushFailed"));

  // ===== API（JSON）=====
  router.post("/batches/:batchId/api/yto/push", H("pushBatchYto"));
  router.post("/batches/:batchId/api/yto/retry-failed", H("retryFailedBatchYto"));

  return router;
}