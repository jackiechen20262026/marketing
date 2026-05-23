// routes/auth.routes.js
import { Router } from "express";
import * as authController from "../controllers/auth.controller.js";

export default function authRoutes() {
  const router = Router();

  router.get("/login", authController.loginPage);
  router.post("/login", authController.login);
  router.get("/logout", authController.logout);

  return router;
}