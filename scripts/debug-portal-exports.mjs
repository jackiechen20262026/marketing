import path from "node:path";
import { pathToFileURL } from "node:url";

const url = pathToFileURL(path.resolve("server/routes/portal.ts")).href;
console.log("Trying to import:", url);

const mod = await import(url);
console.log("Export keys:", Object.keys(mod));
console.log("typeof portalRoutes:", typeof mod.portalRoutes);
console.log("typeof default:", typeof mod.default);
