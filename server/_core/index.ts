import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

// ✅ 先不加载 OAuth / tRPC（它们会引入 server/db.ts → drizzle）
// import { createExpressMiddleware } from "@trpc/server/adapters/express";
// import { registerOAuthRoutes } from "./oauth";
// import { appRouter } from "../routers";
// import { createContext } from "./context";

import * as publicRoutesModule from "../routes/public";
import * as portalRoutesModule from "../routes/portal";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}



function resolveRouteFactory(mod: any, name: string) {
  const fn = mod?.[name] || mod?.default;
  if (typeof fn !== "function") {
    throw new Error(`Route module missing export '${name}' (or default function)`);
  }
  return fn;
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // EJS
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));

  // ✅ 先不注册 OAuth / tRPC
  // registerOAuthRoutes(app);
  // app.use(
  //   "/api/trpc",
  //   createExpressMiddleware({
  //     router: appRouter,
  //     createContext,
  //   })
  // );

  // EJS routes
  const publicRoutes = resolveRouteFactory(publicRoutesModule, "publicRoutes");
  const portalRoutes = resolveRouteFactory(portalRoutesModule, "portalRoutes");
  app.use("/", publicRoutes());
  app.use("/portal", portalRoutes());

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
