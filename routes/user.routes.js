// routes/user.routes.js
import express from "express";
import { requireAdmin } from "../middlewares/auth.js";
import * as usersController from "../controllers/user.controller.js";

export default function userRoutes() {
  const r = express.Router();

  // 用户管理：全部需要管理员
  r.use("/users", requireAdmin);

  r.get("/users", usersController.index);

  r.get("/users/new", usersController.newPage);
  r.post("/users", usersController.create);

  r.get("/users/:id/edit", usersController.editPage);
  r.post("/users/:id", usersController.update);

  r.post("/users/:id/reset-password", usersController.resetPassword);

  // ✅ 一键启用/停用
  r.post("/users/:id/toggle-status", usersController.toggleStatus);

  return r;
}