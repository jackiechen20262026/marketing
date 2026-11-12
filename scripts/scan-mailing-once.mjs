import "dotenv/config";
import { scanMailing } from "../jobs/mailing.job.js";
import { db } from "../db.js";
if (process.argv[2] !== process.env.DB_NAME || process.env.DISABLE_JOBS !== "1")
  throw Error(
    "Explicit DB_NAME and DISABLE_JOBS=1 are required for one-shot scanning",
  );
try {
  await scanMailing();
  console.log("Mailing scan complete");
} finally {
  await db.end();
}
