import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const candidates = [
  "server/routes/portal.ts",
  "server/routes/portal.js",
  "server/routes/public.ts",
  "server/routes/public.js",
  "dist/index.js",
];

console.log("[diagnose] cwd:", root);
for (const rel of candidates) {
  const abs = path.resolve(root, rel);
  console.log(`${rel} -> ${abs} :: ${fs.existsSync(abs) ? "exists" : "missing"}`);
}

if (fs.existsSync(path.resolve(root, "server/routes/portal.js"))) {
  console.log("[warn] Detected server/routes/portal.js; this can shadow TS route source in some runtimes.");
}
