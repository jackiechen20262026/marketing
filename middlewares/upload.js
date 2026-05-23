import multer from "multer";
import fs from "fs";
import path from "path";

const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    cb(null, `lead_${Date.now()}${path.extname(file.originalname)}`);
  },
});

export const upload = multer({ storage });
