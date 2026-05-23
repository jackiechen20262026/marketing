import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import * as leadController from "../controllers/lead.controller.js";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export default function leadRoutes() {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  const uploadDir = path.resolve(process.cwd(), "uploads", "followups");
  ensureDir(uploadDir);

  const visitUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
        const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
        cb(null, `visit_${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype || "");
      if (!ok) return cb(new Error("仅允许上传图片（jpeg/png/webp）"));
      cb(null, true);
    },
  });

  const todoUploadDir = path.resolve(process.cwd(), "uploads", "todos");
  ensureDir(todoUploadDir);

  const todoEvidenceUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, todoUploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
        const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".pdf"].includes(ext) ? ext : ".png";
        cb(null, `todo_${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`);
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const okImg = /^image\/(jpeg|png|webp)$/i.test(file.mimetype || "");
      const okPdf = /^application\/pdf$/i.test(file.mimetype || "");
      if (!okImg && !okPdf) return cb(new Error("仅允许上传 图片(jpeg/png/webp) 或 PDF"));
      cb(null, true);
    },
  });

  router.get("/lead-pool", leadController.poolPage);

  router.get("/leads/demand", leadController.demandPage);
  router.get("/leads/partner-intent", leadController.partnerIntentPage);
  router.get("/leads/sample-sent", leadController.sampleSentPage);
  router.get("/leads/deal", leadController.dealPage);

  router.post("/leads/:id(\\d+)/close", leadController.closeLead);
  router.post("/leads/:id(\\d+)/reopen", leadController.reopenLead);
  router.post("/leads/:id(\\d+)/priority-send", leadController.prioritySend);

  router.get("/todos", leadController.todosPage);
  router.post("/todos/:id(\\d+)/complete", todoEvidenceUpload.single("evidence"), leadController.todoComplete);
  router.post("/todos/:id(\\d+)/skip", leadController.todoSkip);

  router.get("/plans", leadController.plansAllPage);
  router.get("/followups", leadController.followupsListPage);

  router.get("/leads/:id(\\d+)/plans", leadController.plansPage);
  router.post("/leads/:id(\\d+)/plans", leadController.createPlan);

  router.get("/leads/:id(\\d+)/followups/new", leadController.followupNewPage);
  router.post("/leads/:id(\\d+)/followups/new", leadController.followupCreateFromPage);

  router.get("/leads/:id(\\d+)/visit", leadController.visitMobilePage);
  router.post("/leads/:id(\\d+)/visit", visitUpload.array("photos", 6), leadController.visitSubmit);

  router.get("/leads/import", leadController.importPage);
  router.post("/leads/import/preview", upload.single("xlsxFile"), leadController.importPreview);
  router.post("/leads/import/commit", leadController.importCommit);

  router.post("/lead-pool/import-xlsx", upload.single("xlsxFile"), leadController.importPreview);

  router.get("/leads/new", leadController.newPage);
  router.post("/leads/create", leadController.create);

  router.post("/leads/bulk-disable", leadController.bulkDisable);
  router.post("/leads/bulk-stage", leadController.bulkStage);

  router.get("/leads/:id(\\d+)", leadController.detailPage);
  router.get("/leads/:id(\\d+)/edit", leadController.editPage);
  router.post("/leads/:id(\\d+)/update", leadController.update);

  router.post("/leads/:id(\\d+)/followups", leadController.addFollowup);

  router.get("/leads/manage", (req, res) => res.redirect("/portal/lead-pool"));

  return router;
}