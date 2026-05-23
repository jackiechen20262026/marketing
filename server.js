import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import expressLayouts from "express-ejs-layouts";
import session from "express-session";

import authRoutes from "./routes/auth.routes.js";
import portalRoutes from "./routes/portal.js";
import shipmentTrackRoutes from "./routes/shipmentTrack.routes.js";

import "./jobs/ytoTrack.job.js";

import { requireAuth } from "./middlewares/auth.js";
import { leadStatsMiddleware } from "./middlewares/leadStats.js";

const app = express();

// ---- body parser ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- views path base ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- static ----
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

// ---- session ----
app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "hardcode_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 3600 * 1000,
    },
  })
);

// ---- views ----
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ---- layouts ----
app.use(expressLayouts);
app.set("layout", "layouts/main");

// ---- global locals ----
app.use((req, res, next) => {
  const t = (text) => (text == null ? "" : String(text));
  res.locals.t = t;
  res.locals.__ = t;

  const fullPath = (req.originalUrl || req.url || "").split("?")[0];
  res.locals.currentPath = fullPath;

  res.locals.active = res.locals.active || "";
  res.locals.user = req.session?.user || null;

  next();
});

// ---- routes ----
app.use(authRoutes());
app.use(leadStatsMiddleware);

app.use("/portal", portalRoutes());

app.use("/shipments", requireAuth, shipmentTrackRoutes());

// default redirect
app.get("/", (req, res) => {
  if (req.session?.user) return res.redirect("/portal/lead-pool");
  return res.redirect("/login");
});

// ---- 404 ----
app.use((req, res) => {
  res.status(404).render("errors/404", {
    title: "页面不存在",
    active: "",
    user: req.session?.user || null,
  });
});

// ---- error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("errors/500", {
    title: "系统错误",
    error: err,
    active: "",
    user: req.session?.user || null,
  });
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}`);
});
