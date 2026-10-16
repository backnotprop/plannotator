/**
 * PROTOTYPE (proto/inbox-fixed-address): drive the scratch Inbox's window in
 * headless Chromium: wait for the one-time dialog, screenshot it, and (only
 * with --click-sure) click Sure and follow the tab to the fixed address.
 *
 *   bun scripts/proto-fixed-address/ui-flow.ts <scratch inbox url> <shots dir> [--click-sure]
 *
 * --click-sure runs the privileged step through the Inbox. Use it only where
 * the Inbox was started with PLANNOTATOR_PROTO_NAME_ELEVATE=sudo (a CI runner
 * with passwordless sudo) or =direct (an elevated Windows runner); on a
 * person's computer the OS would ask for their password.
 * Plain HTTP: no certificate is involved; the tab moving to the name and
 * reading its own health proves the route.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [url, shots = "proto-shots"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const clickSure = process.argv.includes("--click-sure");
if (!url) {
  console.error("usage: ui-flow.ts <scratch inbox url> <shots dir> [--click-sure]");
  process.exit(2);
}
if (new URL(url).port === String(process.env.REAL_INBOX_PORT ?? 59812)) {
  console.error("refusing: that is the real Inbox's port");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await context.newPage();
let failed = false;
try {
  await page.goto(url);
  const dialog = page.locator('[data-dialog="fixed-address"]');
  await dialog.waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(shots, "01-dialog.png") });
  console.log("dialog shown:", (await dialog.locator("h2").textContent())?.trim());
  if (!clickSure) {
    await dialog.locator("[data-name-later]").click();
    await page.goto(`${url.replace(/\/$/, "")}/#settings/devices`);
    await page.locator("[data-settings-fixed-address]").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, "02-settings-row.png"), fullPage: true });
    console.log("settings row:", (await page.locator("[data-name-row]").getAttribute("data-name-row")) ?? "?");
  } else {
    await dialog.locator("[data-name-sure]").click();
    // The server's answer first (read through the localhost origin, which keeps working)...
    const local = new URL(url).origin;
    let state: { status?: string; reason?: string | null; probe?: string | null } = {};
    const until = Date.now() + 6 * 60_000;
    const reader = await context.newPage();
    while (Date.now() < until) {
      state = ((await (await reader.request.get(`${local}/api/inbox/name`)).json()) as { name: typeof state }).name;
      if (state.status !== "working") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log("name state:", JSON.stringify(state));
    if (state.status !== "on") throw new Error(`the fixed address did not turn on: ${state.reason ?? state.status}`);
    // ...then the tab, which moves itself to the name.
    const moved = await page
      .waitForURL(/^http:\/\/inbox\.plannotator\.localhost\//, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForLoadState("load").catch(() => {});
    await page.screenshot({ path: join(shots, "03-after-sure.png") });
    console.log("tab moved to the name:", moved, page.url());
    if (moved) {
      const health = await page.evaluate(async () => (await fetch("/api/inbox/health")).json()).catch((e) => ({ error: String(e) }));
      console.log("health through the name:", JSON.stringify(health));
      console.log("secure context:", await page.evaluate(() => window.isSecureContext).catch(() => "?"));
    }
  }
} catch (error) {
  failed = true;
  console.error("ui-flow failed:", String(error).split("\n")[0]);
  await page.screenshot({ path: join(shots, "99-failure.png") }).catch(() => {});
  const status = await page.evaluate(async () => (await fetch("/api/inbox/name")).text()).catch(() => "?");
  console.error("name state:", status);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
