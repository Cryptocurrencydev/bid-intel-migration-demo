// Visits every page as every persona at 390px and 1280px. Fails on console errors, page errors,
// failed requests, or horizontal page overflow. Usage: node e2e/smoke.mjs [baseUrl] [--shots dir]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:3400").replace(/\/$/, "");
const shotsIdx = process.argv.indexOf("--shots");
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const pages = ["/", "/reports", "/contracts", "/contracts?q=radar", "/crm", "/security", "/migration"];
const personas = ["owner", "member", "other", "researcher", "lapsed", "anon"];
const viewports = [{ name: "mobile", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }];

const browser = await chromium.launch();
const problems = [];
let visits = 0;
for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  for (const path of pages) {
    for (const as of path === "/security" || path === "/migration" ? ["owner"] : personas) {
      const page = await ctx.newPage();
      const url = `${base}${path}${path.includes("?") ? "&" : "?"}as=${as}`;
      page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`${vp.name} ${url} console.${m.type()}: ${m.text()}`); });
      page.on("pageerror", (e) => problems.push(`${vp.name} ${url} pageerror: ${e.message}`));
      page.on("requestfailed", (r) => r.failure()?.errorText !== "net::ERR_ABORTED" && problems.push(`${vp.name} ${url} requestfailed: ${r.url()} ${r.failure()?.errorText}`));
      page.on("response", (r) => { if (r.status() >= 400) problems.push(`${vp.name} ${url} HTTP ${r.status()} ${r.url()}`); });
      const res = await page.goto(url, { waitUntil: "load" });
      await page.waitForTimeout(400);
      if (!res || res.status() !== 200) problems.push(`${vp.name} ${url} status ${res?.status()}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${vp.name} ${url} horizontal overflow ${overflow}px`);
      const footer = await page.locator("footer a[href='https://dctechltd.com']").count();
      if (footer !== 1) problems.push(`${vp.name} ${url} DC Tech credit missing`);
      if (shots && (as === "owner" || path === "/crm" || path === "/reports"))
        await page.screenshot({ path: `${shots}/${vp.name}${path.replace(/[/?=]/g, "_") || "_home"}-${as}.png`, fullPage: false });
      visits++;
      await page.close();
    }
  }
  // persona switcher navigation works client-side
  const page = await ctx.newPage();
  await page.goto(`${base}/reports?as=owner`);
  await page.getByRole("link", { name: "Anonymous" }).click();
  await page.waitForURL(/as=anon/);
  if ((await page.locator(".badge.allow", { hasText: "🔓 unlocked" }).count()) !== 0) problems.push(`${vp.name} switcher: anon still sees unlocked reports`);
  await page.close();
  await ctx.close();
}
await browser.close();
console.log(`${visits} page visits, ${problems.length} problems`);
for (const p of problems) console.log(" -", p);
process.exit(problems.length ? 1 : 0);
