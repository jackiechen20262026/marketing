import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/othello/ai/node_modules/playwright");
if (!process.env.DB_NAME.startsWith("marketing_upgrade_restore_"))
  throw Error("test guard");
const password = crypto.randomBytes(20).toString("hex"),
  username = "test_browser_" + Date.now();
const [account] = await db.query(
  "INSERT INTO users(username,password_hash,role) VALUES(?,?,'Admin')",
  [username, await bcrypt.hash(password, 10)],
);
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:18899/login");
    await page.locator("input[name=username]").fill(username);
    await page.locator("input[name=password]").fill(password);
    await Promise.all([
      page.waitForURL("**/portal/lead-pool"),
      page.locator("button[type=submit]").click(),
    ]);
    for (const path of [
      "/portal/lead-pool",
      "/portal/mailing",
      "/portal/leads/4363",
      "/portal/leads/4363/mailing",
      "/portal/batches/create",
      "/portal/batches",
      "/portal/batches/35",
      "/portal/plans",
      "/portal/followups",
      "/shipments/lead-tracks",
      "/portal/ai-assistant",
    ]) {
      const response = await page.goto("http://localhost:18899" + path);
      console.log(viewport.width, path, response.status());
      if (response.status() !== 200)
        throw Error(path + " HTTP " + response.status());
    }
    await page.screenshot({
      path:
        "C:/othello/backups/marketing-upgrade-20261112/ai-" +
        viewport.width +
        ".png",
      fullPage: true,
    });
    console.log("browser errors", errors);
    if (errors.length) throw Error("Browser JavaScript errors");
    if (
      viewport.width === 390 &&
      (await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2,
      ))
    )
      throw Error("Mobile overflow");
    const [fixture] = await db.query(
      "INSERT INTO leads(company_name,owner_id) VALUES(?,?)",
      [
        "BROWSER_FIXTURE_" + viewport.width + "_" + Date.now(),
        account.insertId,
      ],
    );
    await page.goto(
      "http://localhost:18899/portal/leads/" + fixture.insertId + "/mailing",
    );
    await Promise.all([
      page.waitForNavigation(),
      page.getByRole("button", { name: "设为重要客人", exact: true }).click(),
    ]);
    if (
      !(await page
        .getByRole("button", { name: "取消重要标记", exact: true })
        .isVisible())
    )
      throw Error("Important form failed");
    const planForm = page.locator(
      'form[action="/portal/leads/' + fixture.insertId + '/mailing"]',
    );
    await planForm.locator("[name=enabled]").check();
    await planForm.locator("[name=next_at]").fill("2030-01-31T12:00");
    await planForm.locator("[name=reason]").fill("浏览器隔离测试");
    await Promise.all([
      page.waitForNavigation(),
      planForm.getByRole("button").click(),
    ]);
    const denied = await page.request.post(
      "http://localhost:18899/portal/leads/" + fixture.insertId + "/important",
      { form: { flag: "0" } },
    );
    if (denied.status() !== 403) throw Error("CSRF bypass");
    await page.goto("http://localhost:18899/portal/ai-assistant");
    await page.route("**/ai-assistant/sessions/*/chat", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          "event: delta\ndata: " +
          JSON.stringify({
            text: '<img src=x onerror="window.__marketingXss=1">',
          }) +
          '\n\nevent: done\ndata: {"model":"test"}\n\n',
      }),
    );
    await page.locator("#ai-input").fill("XSS 测试");
    await page.locator("#ai-send").click();
    await page.waitForFunction(() =>
      document.getElementById("ai-status").textContent.includes("已完成"),
    );
    if (
      (await page.locator("#ai-messages img").count()) ||
      (await page.evaluate(() => window.__marketingXss))
    )
      throw Error("XSS executed");
    console.log(viewport.width, "forms, CSRF and stream XSS passed");
    await page.close();
  }
} finally {
  await browser.close();
  await db.end();
}
