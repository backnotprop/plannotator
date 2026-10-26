/**
 * Screenshots of the Guided Reviews dashboard tab, with a folder open and with
 * none: the built webview bundle (`bun run build` first) in headless Chromium,
 * with VS Code's Dark Modern colors and canned dashboard states. No VS Code,
 * git or gh run here. Manual check, not CI:
 *
 *   bun tests/screenshots/dashboard.ts <out dir>
 */

import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HomeViewState } from "../../src/guides/webview-protocol";
import { THEME } from "./theme";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: dashboard.ts <out dir>");
mkdirSync(outDir, { recursive: true });
const dist = join(import.meta.dir, "..", "..", "dist");

const defaults = { agent: "Claude Code", model: "Sonnet", effort: "low effort" };
const waiting: HomeViewState["waiting"] = [
  { url: "https://github.com/northwind/ledger-ui/pull/214", number: 214, title: "Keyboard nav for the filter bar", sub: "northwind/ledger-ui · @ines", inThisRepo: false },
  { url: "https://github.com/northwind/checkout-service/pull/479", number: 479, title: "Move signing secrets to KMS", sub: "northwind/checkout-service · @dana", inThisRepo: true },
  { url: "https://github.com/northwind/ledger-ui/pull/212", number: 212, title: "Format currency per locale", sub: "northwind/ledger-ui · @kofi", inThisRepo: false },
];

const withFolder: HomeViewState = {
  mode: "home",
  repo: { name: "northwind/checkout-service", branch: "feat/webhook-retries", host: "GitHub" },
  defaults,
  ghNote: null,
  cards: {
    pr: { open: 3, waiting: 1, current: { number: 482, title: "Retry failed webhook deliveries" } },
    local: { files: 4, additions: 18, deletions: 4, baseLabel: "main" },
  },
  recent: [
    { kind: "guide", id: "g1", title: "Retry failed webhook deliveries", sub: "checkout-service · PR #482", progress: { reviewed: 2, total: 5 }, note: null, warn: false, when: "2h ago" },
    { kind: "draft", id: "d1", title: "Draft · Local changes", sub: "checkout-service · Local changes", progress: null, note: "Draft · 2 chapters · 3 files left", warn: false, when: "yesterday" },
    { kind: "guide", id: "g2", title: "Add idempotency keys", sub: "checkout-service · PR #477", progress: null, note: "head moved since the guide", warn: true, when: "Mon" },
  ],
  waiting,
  notes: [],
};

const noFolder: HomeViewState = {
  mode: "home",
  repo: null,
  defaults,
  ghNote: null,
  cards: { pr: null, local: null },
  recent: [
    { kind: "guide", id: "g1", title: "Retry failed webhook deliveries", sub: "northwind/checkout-service · PR #482", progress: { reviewed: 2, total: 5 }, note: null, warn: false, when: "2h ago" },
    { kind: "guide", id: "g3", title: "Format currency per locale", sub: "northwind/ledger-ui · PR #212", progress: { reviewed: 5, total: 5 }, note: null, warn: false, when: "yesterday" },
    { kind: "draft", id: "d2", title: "Draft · PR #31", sub: "acme/infra · PR #31", progress: null, note: "Draft · 1 chapter · 6 files left", warn: false, when: "Oct 14" },
  ],
  waiting,
  notes: [],
};

const shots: Array<{ name: string; state: HomeViewState }> = [
  { name: "dashboard-with-folder", state: withFolder },
  { name: "dashboard-no-folder", state: noFolder },
];

const work = mkdtempSync(join(tmpdir(), "pn-dashboard-shots-"));
try {
  const html = join(work, "index.html");
  writeFileSync(html, `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${THEME}</style>
<link rel="stylesheet" href="${pathToFileURL(join(dist, "codicons", "codicon.css"))}">
<link rel="stylesheet" href="${pathToFileURL(join(dist, "guides-webview.css"))}">
</head><body class="pn-mode-home"><div id="root"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script>
<script src="${pathToFileURL(join(dist, "guides-webview.js"))}"></script>
</body></html>`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(html).toString());
    for (const shot of shots) {
      await page.evaluate((state) => window.postMessage({ type: "state", state }, "*"), shot.state as unknown as Record<string, unknown>);
      await page.waitForTimeout(150);
      const path = join(outDir, `${shot.name}.png`);
      await page.screenshot({ path, fullPage: true });
      console.log(path);
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
