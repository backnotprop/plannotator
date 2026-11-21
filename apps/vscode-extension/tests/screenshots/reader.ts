/**
 * The Guide tab in a real VS Code (manual, not CI): drives a scratch
 * `code serve-web` on the checkout-service world (make-fixture.ts, the FAKE
 * ACP agent, a fake `gh`) in headless Chromium, and takes the approved
 * design's four shots (`.product/approved/vscode-guide-reader/`, a1-a4):
 *
 *   a1  the guide in one tab: chapter 1 reviewed, chapter 2's prose beside its diff, the outline in the side bar
 *   a2  side bar closed; the language server's hover on `computeBackoff`, drawn by the reader
 *   a3  ⌘-click `signHeaders` (outside the change): sign.ts opens beside, at the definition
 *   a4  lines 25-31 selected, asked; the answer page beside, the marker on the lines
 *
 *   bun tests/screenshots/reader.ts <url> <out dir> [dark|light]
 *
 * The first run writes the guide through the New Guided Review flow (the fake
 * agent builds PR #482); later runs open it from the dashboard.
 */

import { chromium, type Frame, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url, outDir, themeArg] = process.argv.slice(2);
if (!url || !outDir) throw new Error("usage: reader.ts <url> <out dir> [dark|light]");
const light = themeArg === "light";
mkdirSync(outDir, { recursive: true });
const suffix = light ? "-light" : "";

const USER_SETTINGS = JSON.stringify({
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": light ? "Default Light Modern" : "Default Dark Modern",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "workbench.layoutControl.enabled": false,
  "window.commandCenter": true,
  "git.openRepositoryInParentFolders": "never",
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
  "breadcrumbs.enabled": true,
}, null, 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string): Promise<void> {
  const path = join(outDir, `${name}${suffix}.png`);
  await page.screenshot({ path });
  console.log(`shot ${path}`);
}

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(`>${title}`);
  await sleep(700);
  await page.keyboard.press("Enter");
}

async function webviewFrame(page: Page, selector: string, timeoutMs = 30_000): Promise<Frame> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator(selector).count()) return frame;
      } catch {
        // detached
      }
    }
    await sleep(300);
  }
  throw new Error(`no webview shows ${selector}`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  activePage = page;
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 40|Content Security|ERR /.test(m.text())) console.log(`[console] ${m.text().slice(0, 300)}`);
  });
  await page.goto(url);
  await page.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
  await sleep(4000);
  await command(page, "Preferences: Open User Settings (JSON)");
  await sleep(2000);
  await page.evaluate((text) => navigator.clipboard.writeText(text), USER_SETTINGS);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Meta+V");
  await sleep(500);
  await page.keyboard.press("Meta+S");
  await sleep(1000);
  await page.reload();
  await page.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
  await sleep(5000);
  await page.keyboard.press("Meta+K");
  await page.keyboard.press("U");
  await sleep(800);
  await command(page, "View: Close Secondary Side Bar");
  await sleep(600);

  // Open the guide: from the dashboard when it exists, else write it.
  await command(page, "Guided Reviews: Open Dashboard");
  const home = await webviewFrame(page, ".pn-home", 60_000);
  await sleep(2500);
  const recent = home.locator(".pn-home .pn-row", { hasText: "Retry failed webhook deliveries" });
  if (await recent.count()) {
    await recent.first().click();
  } else {
    await command(page, "Guided Reviews: New Guided Review");
    await page.locator(".quick-input-widget").waitFor({ state: "visible" });
    await sleep(1200);
    // What, then the agent, its model and its effort (each step's default).
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press("Enter");
      await sleep(2000);
    }
  }
  const reader = await webviewFrame(page, "[data-reader-strip]", 180_000);
  await reader.locator('[data-guide-section="1"]').waitFor({ timeout: 60_000 });
  await sleep(3000);
  const frameBox = await (await reader.frameElement()).boundingBox();
  if (!frameBox) throw new Error("no reader frame");

  // a1: chapter 1 reviewed (it folds), chapter 2 in view, the outline in the side bar.
  const firstReviewed = reader.locator('[data-guide-section="0"] button', { hasText: "Reviewed" });
  if (await firstReviewed.count()) await firstReviewed.first().click();
  await sleep(600);
  await page.locator('.activitybar .action-item [aria-label^="Guided Reviews"], .activitybar a[aria-label^="Guided Reviews"]').first().click().catch(() => undefined);
  await sleep(1500);
  await reader.evaluate(() => {
    const el = document.querySelector('[data-guide-section="1"]');
    const strip = (document.querySelector("[data-reader-strip]") as HTMLElement).offsetHeight;
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - strip - 12 });
  });
  await sleep(1500);
  await page.mouse.move(frameBox.x + frameBox.width - 10, frameBox.y + frameBox.height - 10);
  await sleep(400);
  await shot(page, "a1");

  // a2: the side bar closed; hover computeBackoff in deliver.ts.
  await command(page, "View: Close Primary Side Bar");
  await sleep(1500);
  const box2 = (await (await reader.frameElement()).boundingBox())!;
  // Scroll deliver.ts's own viewer down to its last lines (the file's diff scrolls inside its card).
  await reader.evaluate(() => {
    const shell = document.querySelector('[data-guide-file-shell="src/webhooks/deliver.ts"]');
    for (const el of Array.from(shell?.querySelectorAll("*") ?? []) as HTMLElement[]) {
      if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
    }
  });
  await sleep(1200);
  // Hover the computeBackoff on line 31 (Playwright's locators reach into Pierre's shadow roots).
  const token = (file: string, text: string) => reader.locator(`[data-guide-file-shell="${file}"] span[data-char]`).filter({ hasText: new RegExp(`^${text}$`) });
  const backoff = token("src/webhooks/deliver.ts", "computeBackoff").last();
  // The first hover in a window waits for the language server to load the project.
  for (let tries = 0; tries < 4 && !(await reader.locator("[data-reader-hover-card]").count()); tries++) {
    await page.mouse.move(box2.x + 30, box2.y + box2.height - 30);
    await sleep(300);
    await backoff.hover();
    await reader.locator("[data-reader-hover-card]").waitFor({ timeout: 8_000 }).catch(() => undefined);
  }
  console.log("hover round trips:", JSON.stringify(await reader.evaluate(() => (window as unknown as { __pnHoverTimings: unknown[] }).__pnHoverTimings)).slice(0, 1500));
  await reader.locator("[data-reader-hover-card]").waitFor({ timeout: 2_000 });
  await sleep(900);
  await shot(page, "a2");

  // a3: ⌘-click signHeaders (defined outside the change): sign.ts opens beside.
  await page.mouse.move(box2.x + 30, box2.y + box2.height - 30);
  await sleep(500);
  const sign = token("src/webhooks/deliver.ts", "signHeaders").last();
  await page.keyboard.down("Meta");
  await sign.hover();
  await sleep(200);
  await sign.click({ modifiers: ["Meta"] });
  await page.keyboard.up("Meta");
  await page.locator('.tab', { hasText: "sign.ts" }).first().waitFor({ timeout: 15_000 });
  await sleep(2500);
  await sign.hover().catch(() => undefined);
  await sleep(600);
  await shot(page, "a3");

  // a4: back to one group; select lines 25-31 and ask.
  // Close sign.ts (its tab's close button), back to the Guide tab alone.
  const signTab = page.locator(".tab", { hasText: "sign.ts" }).first();
  await signTab.hover();
  await signTab.locator(".codicon-close, .action-label.codicon").first().click();
  await sleep(800);
  await command(page, "View: Join All Editor Groups");
  await sleep(1500);
  const reader4 = await webviewFrame(page, "[data-reader-strip]");

  // A definition inside the guide: ⌘-click computeBackoff (defined in chapter 1's retryPolicy.ts) scrolls the Guide tab to its line.
  const backoff3 = reader4.locator('[data-guide-file-shell="src/webhooks/deliver.ts"] span[data-char]').filter({ hasText: /^computeBackoff$/ }).last();
  await backoff3.scrollIntoViewIfNeeded();
  await backoff3.click({ modifiers: ["Meta"] });
  await sleep(2500);
  const landed = await reader4.evaluate(() => {
    const shell = document.querySelector('[data-guide-file-shell="src/webhooks/retryPolicy.ts"]');
    if (!shell) return "no retryPolicy.ts";
    const box = shell.getBoundingClientRect();
    return box.top < innerHeight && box.bottom > 0 ? "retryPolicy.ts in view" : `retryPolicy.ts not in view (${Math.round(box.top)})`;
  });
  console.log(`in-guide definition: ${landed}`);
  await shot(page, "a3-in-guide");
  await reader4.locator("[data-reader-strip] button", { hasText: /Back/ }).first().click().catch(() => undefined);
  await sleep(1500);
  const gutter = (line: number) => reader4.locator(`[data-guide-file-shell="src/webhooks/deliver.ts"] [data-column-number="${line}"]`).last();
  const g25 = await gutter(25).boundingBox();
  const g31 = await gutter(31).boundingBox();
  if (!g25 || !g31) throw new Error("lines 25-31 not on screen");
  await page.mouse.move(g25.x + g25.width / 2, g25.y + g25.height / 2);
  await page.mouse.down();
  await page.mouse.move(g31.x + g31.width / 2, g31.y + g31.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(800);
  const askBox = reader4.locator('textarea[placeholder="Ask about this code..."]');
  await askBox.waitFor({ timeout: 10_000 });
  await askBox.fill("Why return a value here instead of throwing?");
  await sleep(300);
  await shot(page, "a4-ask");
  await reader4.locator("button", { hasText: /^Ask$/ }).last().click();
  // The answer page opens beside; wait for the agent's page.
  await webviewFrame(page, ".pn-answer-frame, iframe[sandbox]", 60_000).catch(() => undefined);
  await sleep(9000);
  await shot(page, "a4");

  await browser.close();
}

let activePage: Page | null = null;

main().catch(async (err) => {
  console.error(err);
  if (activePage) await activePage.screenshot({ path: join(outDir, "error.png") }).catch(() => {});
  process.exit(1);
});
