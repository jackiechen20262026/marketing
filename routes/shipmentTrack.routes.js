import { Router } from "express";
import {
  trackSummaryPage,
  refreshOneTrack,
  trackDetailApi,
  trackLogsPage,
} from "../controllers/shipmentTrack.controller.js";

export default function shipmentTrackRoutes() {
  const router = Router();

  // 圆通轨迹汇总页
  router.get("/tracks", trackSummaryPage);

  // 单条轨迹详情（弹窗 API）
  router.get("/:id/track/detail", trackDetailApi);

  // 手动刷新单条轨迹
  router.post("/:id/track/refresh", refreshOneTrack);

  // 轨迹更新日志
  router.get("/track-logs", trackLogsPage);

  return router;
}