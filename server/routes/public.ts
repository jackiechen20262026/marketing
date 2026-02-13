import type { Router } from "express";
import { Router as createRouter } from "express";

export function publicRoutes(): Router {
  const r = createRouter();
  r.get("/", (_req, res) => res.send("Marketing system running. Go to /portal"));
  return r;
}
