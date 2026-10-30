/**
 * The Guide tab's hover check (manual, not CI): drives a scratch
 * `code serve-web` (see make-ts-fixture.ts) in headless Chromium, opens the
 * saved guide in the Guide tab, hovers real tokens in its diffs with the
 * mouse (the first hover of each position: cold), then asks the same
 * positions again straight through the reader's bridge (warm, no dwell, no
 * cache), and prints the round trips the reader measured (reader → extension
 * → `vscode.executeHoverProvider` + `executeDefinitionProvider` → reader).
 *
 *   bun tests/screenshots/hover-latency.ts <url> <out dir> [count=50]
 */

import { chromium, type Frame, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, outDir, countArg] = process.argv.slice(2);
if (!url || !outDir) throw new Error("usage: hover-latency.ts <url> <out dir> [count]");
const COUNT = Number(countArg ?? 50);
mkdirSync(outDir, { recursive: true });

const USER_SETTINGS = JSON.stringify({
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "git.openRepositoryInParentFolders": "never",
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
}, null, 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(`>${title}`);
  await sleep(600);
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

const KEYWORDS = new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "import", "export", "from", "class", "new", "type", "interface", "async", "await", "this", "true", "false", "null", "undefined", "string", "number", "boolean", "void", "of", "in", "as", "typeof", "readonly", "private", "public", "static", "default", "case", "switch", "break", "continue", "try", "catch", "finally", "throw"]);

function stats(list: number[]): { n: number; median: number; p95: number; min: number; max: number } {
  const s = [...list].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, median: Math.round(q(0.5)), p95: Math.round(q(0.95)), min: Math.round(s[0]), max: Math.round(s[s.length - 1]) };
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console] ${m.text().slice(0, 300)}`);
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

  await command(page, "Guided Reviews: Open Dashboard");
  const home = await webviewFrame(page, ".pn-home .pn-row", 60_000);
  await sleep(1500);
  const tOpen = Date.now();
  await home.locator(".pn-home .pn-row").first().click();
  const reader = await webviewFrame(page, "[data-reader-strip]", 60_000);
  await reader.locator("[data-guide-section]").first().waitFor({ timeout: 60_000 });
  const openMs = Date.now() - tOpen;
  await sleep(2500);
  await page.screenshot({ path: join(outDir, "reader-open.png") });
  console.log(`guide tab open: ${openMs} ms; highlighter: ${await reader.evaluate(() => document.documentElement.dataset.pnHighlighter)}`);

  // Cold: real mouse hovers on identifier tokens the pointer can reach (hit-tested through
  // Pierre's shadow roots), one position each, scrolling down the guide between rounds.
  const frameBox = await (await reader.frameElement()).boundingBox();
  if (!frameBox) throw new Error("no reader frame box");
  const tried = new Set<string>();
  let shotTaken = false;
  for (let pass = 0; pass < 80 && tried.size < COUNT; pass++) {
    const found = (await reader.evaluate((keywords: string[]) => {
      const kw = new Set(keywords);
      const deepHit = (x: number, y: number): Element | null => {
        let el: Element | null = document.elementFromPoint(x, y);
        while (el?.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === el) break;
          el = inner;
        }
        return el;
      };
      const out: Array<{ x: number; y: number; text: string; key: string }> = [];
      const strip = (document.querySelector("[data-reader-strip]") as HTMLElement | null)?.offsetHeight ?? 0;
      for (const host of Array.from(document.querySelectorAll("[data-guide-file-shell] *"))) {
        const root = (host as Element).shadowRoot;
        if (!root) continue;
        for (const span of Array.from(root.querySelectorAll("span[data-char]"))) {
          const text = span.textContent ?? "";
          if (!/^[A-Za-z_$][\w$]{2,}$/.test(text) || kw.has(text)) continue;
          const r = span.getBoundingClientRect();
          if (r.width < 4 || r.top < strip + 10 || r.bottom > innerHeight - 10) continue;
          const x = r.left + Math.min(r.width / 2, 12);
          const y = r.top + r.height / 2;
          if (deepHit(x, y) !== span) continue;
          const shell = (host as Element).closest("[data-guide-file-shell]")?.getAttribute("data-guide-file-shell") ?? "";
          out.push({ x, y, text, key: `${shell}:${text}:${Math.round(r.top + scrollY)}` });
        }
      }
      return out;
    }, [...KEYWORDS])) as Array<{ x: number; y: number; text: string; key: string }>;
    let used = 0;
    for (const c of found) {
      if (tried.size >= COUNT || used >= 6) break;
      if (tried.has(c.key)) continue;
      tried.add(c.key);
      used++;
      await page.mouse.move(frameBox.x + frameBox.width - 6, frameBox.y + 60);
      await sleep(350);
      await page.mouse.move(frameBox.x + c.x, frameBox.y + c.y);
      await reader.locator("[data-reader-hover-card]").waitFor({ timeout: 5000 }).catch(() => undefined);
      await sleep(200);
      if (!shotTaken && (await reader.locator("[data-reader-hover-card]").count())) {
        await page.screenshot({ path: join(outDir, "hover-card.png") });
        shotTaken = true;
      }
    }
    await page.mouse.move(frameBox.x + frameBox.width - 6, frameBox.y + 60);
    await reader.evaluate(() => window.scrollBy(0, 700));
    await sleep(1200);
  }

  type Timing = { ms: number; serverMs: number | null; at: { path: string; side: string; line: number; character: number; token: string }; ok: boolean; signature: string | null; doc: boolean; def: string | null };
  const cold = (await reader.evaluate(() => (window as unknown as { __pnHoverTimings: unknown[] }).__pnHoverTimings.slice())) as Timing[];
  const positions = cold.map((c) => c.at);
  // Warm: the same positions again, through the bridge (no dwell, no cache in the reader), twice.
  const warm1 = (await reader.evaluate((list) => (window as unknown as { __pnMeasureHover(l: unknown[]): Promise<number[]> }).__pnMeasureHover(list), positions)) as number[];
  const warm2 = (await reader.evaluate((list) => (window as unknown as { __pnMeasureHover(l: unknown[]): Promise<number[]> }).__pnMeasureHover(list), positions)) as number[];
  const all = (await reader.evaluate(() => (window as unknown as { __pnHoverTimings: unknown[] }).__pnHoverTimings.slice())) as Timing[];
  const warmServer = all.slice(cold.length + positions.length).map((t) => t.serverMs ?? 0);

  const result = {
    openMs,
    first: cold[0] ? { ms: Math.round(cold[0].ms), serverMs: cold[0].serverMs, token: cold[0].at.token, path: cold[0].at.path } : null,
    cold: stats(cold.map((c) => c.ms)),
    coldWithoutFirst: stats(cold.slice(1).map((c) => c.ms)),
    coldServer: stats(cold.map((c) => c.serverMs ?? 0)),
    warm: stats(warm2),
    warmFirstRepeat: stats(warm1),
    warmServer: stats(warmServer),
    answered: cold.filter((c) => c.ok).length,
    coldWithSignature: cold.filter((c) => c.signature).length,
    warmWithSignature: all.slice(cold.length + positions.length).filter((c) => c.signature).length,
    files: [...new Set(cold.map((c) => c.at.path))].length,
    samples: cold.map((c, i) => ({ token: c.at.token, path: c.at.path, line: c.at.line, side: c.at.side, coldMs: Math.round(c.ms), warmMs: Math.round(warm2[i] ?? -1), ok: c.ok, coldSignature: c.signature, warmSignature: all[cold.length + positions.length + i]?.signature ?? null, def: all[cold.length + positions.length + i]?.def ?? null })),
  };
  writeFileSync(join(outDir, "hover-latency.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
