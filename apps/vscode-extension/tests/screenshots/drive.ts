/**
 * Drives a scratch `code serve-web` (see make-fixture.ts) in headless
 * Chromium and takes screenshots of the Guides view. Manual check, not CI:
 *
 *   bun tests/screenshots/drive.ts <url> <out dir> [step…]
 *
 * Steps: home, generate, guide, hover, diff. Without steps, all of them.
 */

import { chromium, type Frame, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url, outDir, ...stepsArg] = process.argv.slice(2);
if (!url || !outDir) throw new Error("usage: drive.ts <url> <out dir> [steps]");
mkdirSync(outDir, { recursive: true });
const steps = new Set(stepsArg.length ? stepsArg : ["home", "generate", "guide", "hover", "diff"]);

const USER_SETTINGS = JSON.stringify({
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  // What the reader's "Turn on" answer sets (the extension asks once).
  "diffEditor.codeLens": true,
  "workbench.layoutControl.enabled": false,
  "window.commandCenter": true,
  "git.openRepositoryInParentFolders": "never",
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
}, null, 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string, keepMouse = false): Promise<void> {
  if (!keepMouse) {
    await page.mouse.move(1300, 880);
    await sleep(300);
  }
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path });
  console.log(`shot ${path}`);
}

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(`>${title}`);
  await sleep(600);
  await page.keyboard.press("Enter");
}

/** The frame of the webview whose root shows `selector`. */
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
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console] ${m.text().slice(0, 300)}`);
  });
  process.on("unhandledRejection", () => {});
  activePage = page;
  await page.goto(url);
  await page.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
  await sleep(4000);
  // The web workbench keeps user settings in the browser: write them through the settings editor, then reload.
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
  await page.keyboard.press("U"); // close the settings editor (close saved editors)
  await sleep(800);
  await command(page, "View: Close Secondary Side Bar");
  await sleep(800);
  // Open the Guides container.
  await page.locator('.activitybar .action-item [aria-label^="Guides"], .activitybar a[aria-label^="Guides"]').first().click();
  await sleep(2500);

  if (steps.has("home")) {
    await command(page, "Plannotator: Open Guided Reviews");
    await webviewFrame(page, ".pn-home");
    await sleep(2500);
    await shot(page, "1-dashboard");
  }

  if (steps.has("generate")) {
    await command(page, "Plannotator: New Guided Review");
    await page.locator(".quick-input-widget").waitFor({ state: "visible" });
    await sleep(1200);
    await shot(page, "2-new-source");
    await page.keyboard.press("Enter"); // the PR for this branch
    await sleep(1500);
    await shot(page, "3-new-model");
    // Pick the model the defaults point at, then effort.
    await page.keyboard.press("Enter");
    await sleep(1200);
    await shot(page, "4-new-effort");
    await page.keyboard.press("Enter");
    const frame = await webviewFrame(page, ".pn-gen", 60_000);
    await frame.locator(".pn-act-builder").nth(7).waitFor({ timeout: 60_000 });
    await sleep(800);
    await shot(page, "5-generating");
    await page.locator(".pn-guide, .pn-chapter").first().waitFor({ timeout: 1 }).catch(() => {});
    await webviewFrame(page, ".pn-guide", 120_000);
    await sleep(3000);
  }

  if (steps.has("guide")) {
    await webviewFrame(page, ".pn-guide", 30_000);
    await sleep(2000);
    await shot(page, "6-guide-overview");
  }

  if (steps.has("hover")) {
    const frame = await webviewFrame(page, ".pn-guide .pn-diagram-link", 30_000);
    await frame.locator(".pn-diagram-link").nth(3).hover();
    await frame.locator(".pn-popover .pn-pop-head").waitFor({ timeout: 30_000 });
    await sleep(1500);
    await shot(page, "7-overview-hover", true);
  }

  if (steps.has("diff")) {
    const frame = await webviewFrame(page, ".pn-guide", 30_000);
    await frame.locator(".pn-chapter").nth(1).click();
    await sleep(5000);
    await shot(page, "8-chapter-diff");
  }

  await browser.close();
}

let activePage: Page | null = null;

main().catch(async (err) => {
  console.error(err);
  if (activePage) await activePage.screenshot({ path: join(outDir, "error.png") }).catch(() => {});
  process.exit(1);
});
