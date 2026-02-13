// server.js (ESM) - Node 20.6+/18.19+/24+ compatible
import "dotenv/config";
import { spawn } from "node:child_process";
import process from "node:process";

const nodeExe = process.execPath;

// Node 新版本：用 --import tsx (不是 --loader)
const args = ["--import", "tsx", "server/_core/index.ts"];

const child = spawn(nodeExe, args, { stdio: "inherit", shell: false });

child.on("exit", code => process.exit(code ?? 0));
