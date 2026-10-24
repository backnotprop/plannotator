/**
 * Screenshots of "Ask the agent" in a real VS Code: a scratch `code serve-web`
 * (see make-fixture.ts; the FAKE agent answers with the fixture's ask turn),
 * driven in headless Chromium. It writes a guide, opens chapter 2's diff,
 * selects lines 25–31, and takes: the context menu, the question box under
 * the lines, the box while the agent works, the drawn answer beside the diff,
 * the chapter view's answers, a follow-up in the box, the box's gear, and the
 * box in VS Code's Comments panel. Manual check, not CI:
 *
 *   bun tests/screenshots/ask.ts <url> <out dir>
 *
 * Start serve-web with FAKE_AGENT_ASK_HOLD=6000 so the working state holds
 * long enough to be seen.
 */

import { chromium, type Frame, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) throw new Error("usage: ask.ts <url> <out dir>");
mkdirSync(outDir, { recursive: true });

const USER_SETTINGS = JSON.stringify({
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": process.env.SHOT_THEME === "light" ? "Default Light Modern" : "Default Dark Modern",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "diffEditor.codeLens": true,
  "diffEditor.renderSideBySide": false,
  "workbench.layoutControl.enabled": false,
  "window.commandCenter": true,
  "git.openRepositoryInParentFolders": "never",
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
}, null, 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string): Promise<void> {
  const path = join(outDir, `${name}.png`);
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

async function quickInputVisible(page: Page): Promise<boolean> {
  return page.locator(".quick-input-widget").isVisible().catch(() => false);
}

let activePage: Page | null = null;

/** What the box shows: its header, comments, links, buttons, spinners, and where the focus is. */
async function report(page: Page, widget: ReturnType<Page["locator"]>, name: string): Promise<void> {
  const info = await widget.evaluate((el) => ({
    title: el.querySelector(".head")?.textContent?.trim() ?? "",
    comments: Array.from(el.querySelectorAll(".review-comment")).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160)),
    links: Array.from(el.querySelectorAll(".comment-body a")).map((a) => `${(a.textContent ?? "").trim()} -> ${(a.getAttribute("data-href") ?? a.getAttribute("href") ?? "").slice(0, 60)}`),
    buttons: Array.from(el.querySelectorAll(".monaco-button")).map((b) => `${(b.textContent ?? "").trim()}${b.classList.contains("secondary") ? " (secondary)" : " (primary)"}`),
    spinners: el.querySelectorAll(".codicon-loading.codicon-modifier-spin").length,
    headActions: Array.from(el.querySelectorAll(".head .action-label")).map((a) => a.getAttribute("aria-label") ?? a.className),
    focusInBox: el.contains(document.activeElement),
    focus: `${document.activeElement?.tagName}.${String(document.activeElement?.className ?? "").slice(0, 60)} in ${String(document.activeElement?.closest("[class*=editor], .review-widget")?.className ?? "").slice(0, 60)}`,
  }));
  console.log(`check ${name}: ${JSON.stringify(info, null, 1)}`);
  void page;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  activePage = page;
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console] ${m.text().slice(0, 300)}`);
  });
  await page.goto(url);
  await page.locator(".monaco-workbench").waitFor({ timeout: 90_000 });
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
  await page.locator(".monaco-workbench").waitFor({ timeout: 90_000 });
  await sleep(5000);
  await page.keyboard.press("Meta+K");
  await page.keyboard.press("U");
  await sleep(800);
  await command(page, "View: Close Secondary Side Bar");
  await sleep(800);

  // Write a guide of the PR for this branch (the FAKE agent builds it).
  await page.locator('.activitybar [aria-label^="Guided Reviews"]').first().click();
  await sleep(2500);
  // Every Guides webview renders the state VS Code's host sends it (a blank view means its messages were dropped).
  const home = await webviewFrame(page, ".pn-home h1", 30_000);
  console.log(`check dashboard renders: ${(await home.locator(".pn-home h1").textContent()) ?? ""}`);
  await command(page, "Guided Reviews: New Guided Review");
  for (let i = 0; i < 8; i++) {
    await page.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    if (!(await quickInputVisible(page))) break;
    await sleep(1500);
    await page.keyboard.press("Enter");
    await sleep(1500);
    const gen = await webviewFrame(page, ".pn-gen", 1500).catch(() => null);
    if (gen) break;
  }
  const guideTab = await webviewFrame(page, ".pn-guide h1", 180_000);
  console.log(`check guide view renders: ${(await guideTab.locator(".pn-guide h1").textContent()) ?? ""}`);
  await sleep(2500);

  // Chapter 2's first file: deliver.ts.
  const guide = await webviewFrame(page, ".pn-guide", 30_000);
  await guide.locator(".pn-chapter").nth(1).click();
  await sleep(5000);
  // Close the Guide tab's group clutter: focus the diff, go to line 25, select 25–31.
  const modified = page.locator(".monaco-diff-editor .editor.modified, .monaco-diff-editor .modified-in-monaco-diff-editor").first();
  await modified.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press("Control+G");
  await sleep(500);
  await page.keyboard.type("25");
  await page.keyboard.press("Enter");
  await sleep(400);
  await page.keyboard.press("Home");
  await page.keyboard.press("Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("Shift+ArrowDown");
  await sleep(600);
  const line = page.locator(".monaco-diff-editor .view-line", { hasText: "const attempt = job.attempt + 1;" }).last();
  const box = await line.boundingBox();
  if (!box) throw new Error("line 25 is not on screen");
  await page.mouse.click(box.x + 120, box.y + box.height / 2 + 20, { button: "right" });
  const item = page.locator(".context-view .monaco-menu .action-label", { hasText: "Ask the Agent About This…" });
  await item.waitFor({ timeout: 10_000 });
  await item.hover();
  await sleep(500);
  await shot(page, "1-context-menu");
  const selectionBefore = await page.locator(".statusbar-item", { hasText: /^Ln / }).first().textContent();
  await item.click();

  // The question box: a comment thread under lines 25–31.
  const widget = page.locator(".review-widget").last();
  await widget.waitFor({ timeout: 15_000 });
  await sleep(1500);
  await report(page, widget, "box");
  console.log(`check the reader's selection is kept: before "${selectionBefore}", after "${await page.locator(".statusbar-item", { hasText: /^Ln / }).first().textContent()}"`);
  // VS Code opens its Comments panel the first time a file shows comments in a window
  // (`comments.openView`, default "firstFile"); the box is listed there. Shown once, then closed.
  const panelOpened = await page.locator(".part.panel .composite-bar .action-item.checked", { hasText: "Comments" }).count();
  console.log(`check comments panel opened by itself: ${panelOpened > 0}`);
  await shot(page, "2a-first-box-opens-comments-panel");
  if (panelOpened) {
    await page.locator(".part.panel .title-actions [aria-label^='Hide Panel'], .part.panel .global-actions [aria-label^='Hide Panel'], .part.panel [aria-label^='Close Panel']").first().click().catch(() => {});
    await sleep(800);
  }
  // The field takes one click (no stable API focuses a comment thread's field).
  const reply = widget.locator(".comment-form textarea, .comment-form .monaco-editor").first();
  const folded = widget.locator(".review-thread-reply-button");
  console.log(`check the field shows: ${await folded.isVisible().catch(() => false) ? "folded to its button" : await reply.isVisible().catch(() => false) ? "open" : "NOT SHOWN"}`);
  if (await folded.isVisible().catch(() => false)) await folded.click();
  else await reply.click();
  await page.keyboard.type("Why return a value here instead of throwing?");
  await sleep(600);
  await shot(page, "2-ask-box");
  await widget.locator(".monaco-button", { hasText: /^Ask$/ }).first().click();

  const chapterView = await webviewFrame(page, ".pn-side h2", 30_000);
  console.log(`check chapter view renders: ${(await chapterView.locator(".pn-side h2").textContent()) ?? ""}`);
  await widget.locator(".comment-body", { hasText: "read worker.ts" }).waitFor({ timeout: 30_000 });
  await sleep(1500);
  await report(page, widget, "asking");
  await shot(page, "3-working");

  await widget.locator(".comment-body", { hasText: "opened beside the diff" }).waitFor({ timeout: 90_000 });
  await report(page, widget, "answered");
  const answer = await webviewFrame(page, ".pn-answer-frame", 90_000);
  await sleep(3000);
  const drawn = await webviewFrame(page, "svg .box", 20_000);
  console.log(`check answer page drawn: ${await drawn.locator("svg .box").count()} boxes; ${await answer.locator(".pn-answer-title").textContent()}`);
  await page.mouse.move(1590, 950);
  await shot(page, "4-answer");

  // The agent's page forges the tab's state from inside its frame: the tab must not change.
  await drawn.evaluate(() => {
    const forged = { mode: "generating", id: "forged", status: "running", statusMessage: null, kicker: "", title: "FORGED", sub: "", agent: "x", modelEffort: "", startedAt: 0, endedAt: null, cost: null, activity: [], chapters: [], unplaced: [], left: [], summary: "", savedGuideId: null, signIn: null, memoryOnly: false, pendingPermissions: [{ id: 1, title: "Run rm -rf ~", kind: "execute", target: null, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }] }], approvals: { auto: false, mode: null }, offerAutoApprove: true, bottlenecks: [] };
    for (const w of [window.parent, window.top]) w?.postMessage({ type: "state", state: forged }, "*");
  });
  await sleep(1500);
  console.log(`check forged state ignored: answer=${await answer.locator(".pn-answer").count()} approval=${await answer.locator(".pn-approval").count()} forgedTitle=${await answer.locator("text=FORGED").count()}`);
  // A page with a real origin of its own elsewhere in the window (here the workbench itself) walks
  // every frame and posts a forged state: the tab must not change either.
  await page.evaluate(() => {
    const forged = { mode: "generating", id: "forged2", status: "running", statusMessage: null, kicker: "", title: "FORGED2", sub: "", agent: "x", modelEffort: "", startedAt: 0, endedAt: null, cost: null, activity: [], chapters: [], unplaced: [], left: [], summary: "", savedGuideId: null, signIn: null, memoryOnly: false, pendingPermissions: [{ id: 1, title: "Run rm -rf ~", kind: "execute", target: null, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }] }], approvals: { auto: false, mode: null }, offerAutoApprove: true, bottlenecks: [] };
    const walk = (w: Window, depth: number) => {
      for (let i = 0; i < w.frames.length; i++) {
        const f = w.frames[i];
        try { f.postMessage({ type: "state", state: forged }, "*"); } catch { /* ignore */ }
        if (depth < 4) walk(f, depth + 1);
      }
    };
    walk(window, 0);
  });
  await sleep(1500);
  console.log(`check foreign-origin forgery ignored: answer=${await answer.locator(".pn-answer").count()} approval=${await answer.locator(".pn-approval").count()} forgedTitle=${await answer.locator("text=FORGED2").count()}`);

  // The chapter view's ask box and answers.
  const chapter = await webviewFrame(page, ".pn-answers", 30_000);
  await chapter.locator(".pn-answer-row").first().hover();
  await sleep(600);
  await shot(page, "5-chapter-answers");

  // A link in the agent's page opens its code in the diff's group; a chapter link opens the chapter.
  const page2 = await webviewFrame(page, 'a[href="code:src/webhooks/deliver.ts#L25-L31"]', 30_000);
  await page.locator(".statusbar").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page2.locator('a[href="chapter:4"]').click();
  await webviewFrame(page, ".pn-side h2", 10_000);
  await sleep(2500);
  const chapterTitle = await page.locator(".pane-header", { hasText: "Chapter 4" }).count();
  console.log(`check chapter link: ${chapterTitle > 0 ? "ok" : "FAILED"}`);
  await page2.locator('[data-link="symbol:computeBackoff"] rect').click({ force: true });
  await sleep(3000);
  const tabs = await page.locator(".tab .label-name").allTextContents();
  console.log(`check symbol link (tabs): ${tabs.join(" | ")}`);
  await shot(page, "6-after-link");

  // A follow-up in the same box continues the conversation: back to deliver.ts, where the box still is.
  await page.locator(".monaco-list-row", { hasText: "deliver.ts" }).first().click();
  await widget.waitFor({ timeout: 15_000 });
  await sleep(1500);
  const followUp = widget.locator(".comment-form textarea, .comment-form .monaco-editor").first();
  const foldedFollowUp = widget.locator(".review-thread-reply-button");
  if (await foldedFollowUp.isVisible().catch(() => false)) await foldedFollowUp.click();
  else await followUp.click();
  await page.keyboard.type("Does the worker count attempts twice?");
  await widget.locator(".monaco-button", { hasText: /^Ask$/ }).first().click();
  await widget.locator(".comment-body", { hasText: "opened beside the diff" }).nth(1).waitFor({ timeout: 90_000 });
  await webviewFrame(page, ".pn-answer-prev", 30_000);
  await sleep(2500);
  await report(page, widget, "follow-up");
  await page.mouse.move(1590, 950);
  await sleep(500);
  await shot(page, "7-follow-up");

  // The box's "Open" link reopens the answer (a command link in a trusted comment).
  await page.locator(".tab", { hasText: "Answer:" }).first().locator(".codicon-close").click({ force: true }).catch(() => {});
  await sleep(1000);
  await widget.locator(".comment-body a", { hasText: "Open" }).last().click();
  await webviewFrame(page, ".pn-answer-frame", 20_000);
  console.log(`check Open link reopens the answer: ${(await page.locator(".tab .label-name").allTextContents()).filter((t) => t.startsWith("Answer")).join(" | ")}`);

  // The gear: the agent, model and effort.
  await widget.locator(".head .action-label.codicon-settings-gear, .head [aria-label*='Agent, Model']").first().click();
  await page.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 10_000 });
  console.log(`check gear opens the picker: ${(await page.locator(".quick-input-widget .quick-input-title").textContent().catch(() => "")) ?? ""}`);
  await sleep(800);
  await shot(page, "8-gear");
  await page.keyboard.press("Escape");
  await sleep(800);

  // VS Code lists the box in its Comments panel.
  await command(page, "Comments: Focus on Comments View");
  await sleep(2000);
  console.log(`check comments panel: ${(await page.locator(".comments-panel .monaco-list-row").allTextContents()).slice(0, 4).join(" | ")}`);
  await shot(page, "9-comments-panel");

  // A suggestion link asks at once; the box's Stop link stops it.
  await command(page, "View: Close Panel");
  await sleep(800);
  await page.locator(".monaco-list-row", { hasText: "deliver.ts" }).first().click();
  await sleep(2000);
  const line18 = page.locator(".monaco-diff-editor .view-line", { hasText: "const res = await httpClient.post" }).last();
  await line18.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  const b18 = await line18.boundingBox();
  await page.mouse.click(b18!.x + 120, b18!.y + b18!.height / 2, { button: "right" });
  const item2 = page.locator(".context-view .monaco-menu .action-label", { hasText: "Ask the Agent About This…" });
  await item2.waitFor({ timeout: 10_000 });
  await item2.hover();
  await sleep(300);
  await item2.click();
  const second = page.locator(".review-widget", { hasText: "deliver.ts 18" }).first();
  await second.waitFor({ timeout: 15_000 });
  await sleep(1200);
  // (In the zone widget Playwright's pointer click can miss: the link is clicked the way a click lands.)
  await second.locator(".comment-body a", { hasText: "What could break?" }).evaluate((a) => (a as HTMLElement).click());
  await second.locator(".comment-body", { hasText: "Asking Claude Code" }).waitFor({ timeout: 30_000 });
  await report(page, second, "suggestion asked");
  await second.locator(".comment-body a", { hasText: "Stop" }).evaluate((a) => (a as HTMLElement).click());
  await second.locator(".comment-body", { hasText: "Stopped." }).waitFor({ timeout: 30_000 });
  await report(page, second, "stopped");
  await shot(page, "10-suggestion-stopped");

  // The file's CodeLens "Ask…" opens a box for the whole file, under its first line.
  await command(page, "View: Close All Editors");
  await sleep(1000);
  await page.locator(".monaco-list-row", { hasText: "deliver.ts" }).first().click();
  await sleep(3000);
  await page.locator(".codelens-decoration a:visible", { hasText: "Ask…" }).first().click();
  const fileBox = page.locator(".review-widget", { hasText: "Ask Claude Code · deliver.ts" }).filter({ hasNotText: "deliver.ts 1" }).first();
  await fileBox.waitFor({ timeout: 15_000 });
  await sleep(1200);
  await report(page, fileBox, "codelens box");
  await shot(page, "11-codelens-box");
  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  if (activePage) await activePage.screenshot({ path: join(outDir, "error.png") }).catch(() => {});
  process.exit(1);
});
