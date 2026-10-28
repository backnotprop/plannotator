/**
 * Screenshots of the run view's approvals and bottleneck notices: the built
 * webview bundle (`bun run build` first) in headless Chromium, with VS Code's
 * Dark Modern colors and canned run states. No agent and no VS Code run here.
 * Manual check, not CI:
 *
 *   bun tests/screenshots/approvals.ts <out dir>
 */

import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GeneratingViewState } from "../../src/guides/webview-protocol";
import { THEME } from "./theme";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: approvals.ts <out dir>");
mkdirSync(outDir, { recursive: true });
const dist = join(import.meta.dir, "..", "..", "dist");

const base: GeneratingViewState = {
  mode: "generating",
  id: "draft-1",
  status: "running",
  statusMessage: null,
  kicker: "Building guided review · PR #482",
  title: "Retry failed webhook deliveries",
  sub: "github.com/northwind/checkout-service/pull/482 · in a worktree at 9b07e4d",
  agent: "Claude Code",
  modelEffort: "Sonnet · Low",
  startedAt: Date.now() - 74_000,
  endedAt: null,
  cost: "$0.06",
  activity: [
    { id: 1, at: "0:00", kind: "info", title: "Starting Claude Code", detail: "With your own settings: you approve what it asks about." },
    { id: 2, at: "0:04", kind: "message", title: "Reading the change first: the retry policy, then the delivery loop." },
    { id: 3, at: "0:09", kind: "tool", title: "Read src/retryPolicy.ts", status: "completed", locations: [{ path: "src/retryPolicy.ts", line: 1 }] },
    { id: 4, at: "0:15", kind: "builder", title: "guide_set_header", detail: "title and intent", status: "completed" },
    { id: 5, at: "0:21", kind: "builder", title: "guide_add_chapter", detail: "1 · The retry budget", status: "completed" },
    { id: 6, at: "1:12", kind: "permission", title: "Waiting for your approval: Run npm test -- retryPolicy", detail: "npm test -- retryPolicy", status: "pending" },
  ],
  chapters: [
    { n: 1, id: "c1", title: "The retry budget", added: true, files: [{ path: "src/retryPolicy.ts", name: "retryPolicy.ts", movedFrom: null }] },
    { n: 2, id: "c2", title: "Delivery loop learns to back off", added: false, files: [] },
  ],
  unplaced: [],
  left: ["src/deliver.ts", "src/deliver.test.ts"],
  summary: "2 chapters · 1 of 3 files placed",
  savedGuideId: null,
  signIn: null,
  memoryOnly: false,
  pendingPermissions: [
    {
      id: 1,
      title: "Run npm test -- retryPolicy",
      kind: "execute",
      target: "npm test -- retryPolicy",
      options: [
        { optionId: "allow", name: "Yes", kind: "allow_once" },
        { optionId: "allow_always", name: "Yes, and don't ask again for npm test", kind: "allow_always" },
        { optionId: "reject", name: "No", kind: "reject_once" },
      ],
    },
  ],
  approvals: { auto: false, mode: null },
  offerAutoApprove: true,
  bottlenecks: [],
};

const shots: Array<{ name: string; state: GeneratingViewState; element?: string }> = [
  { name: "permission-prompt", state: base },
  { name: "opt-in-offer", state: base, element: "[data-offer='auto-approve']" },
  {
    name: "auto-approve-on",
    state: {
      ...base,
      pendingPermissions: [],
      offerAutoApprove: false,
      approvals: { auto: true, mode: "acceptEdits" },
      activity: [
        ...base.activity.slice(0, 5),
        { id: 6, at: "1:12", kind: "info", title: "Approving the agent's requests automatically for the rest of this run" },
        { id: 7, at: "1:12", kind: "info", title: "Switched Claude Code to acceptEdits for automatic approval" },
        { id: 8, at: "1:13", kind: "permission", title: "Allowed: Run npm test -- retryPolicy", detail: "Yes", status: "completed" },
      ],
    },
  },
  {
    name: "bottleneck",
    state: {
      ...base,
      agent: "Codex",
      modelEffort: "gpt-5.5-codex · Low",
      cost: null,
      pendingPermissions: [],
      offerAutoApprove: false,
      activity: [
        { id: 1, at: "0:00", kind: "info", title: "Starting Codex", detail: "With your own settings: you approve what it asks about." },
        { id: 2, at: "0:05", kind: "message", title: "I'll read the retry policy and the delivery loop, then group them into chapters." },
        { id: 3, at: "0:08", kind: "tool", title: "Read src/retryPolicy.ts", status: "completed", locations: [{ path: "src/retryPolicy.ts", line: 1 }] },
        { id: 4, at: "0:14", kind: "builder", title: "guide_set_header", detail: "title and intent", status: "completed" },
        { id: 5, at: "0:20", kind: "builder", title: "guide_add_chapter", detail: "1 · The retry budget", status: "completed" },
        { id: 6, at: "0:51", kind: "permission", title: "Turned down: Run npm test -- retryPolicy", detail: "No", status: "failed" },
        { id: 7, at: "0:58", kind: "tool", title: "Run git fetch", status: "failed", isError: true },
        { id: 8, at: "0:58", kind: "info", title: "Codex's sandbox blocked Run git fetch", isError: true },
      ],
      bottlenecks: [
        { key: "turned-down", title: "You turned down Run npm test -- retryPolicy", detail: "Codex will try another way. Approve automatically to let its requests through for the rest of this run.", action: "approveRun" },
        { key: "blocked:sandbox:Run git fetch", title: "Codex's sandbox blocked Run git fetch", detail: "\"error: cannot open .git/FETCH_HEAD: Read-only file system\" The guide can still be written without it. Approving automatically switches Codex to a mode that lets it run, where it has one.", action: "approveRun" },
      ],
    },
  },
  {
    name: "bottleneck-stopped",
    state: {
      ...base,
      kicker: "Draft guided review · PR #482",
      status: "stopped",
      endedAt: Date.now(),
      statusMessage: "The agent ended its turn without calling guide_finish.",
      pendingPermissions: [],
      offerAutoApprove: false,
      activity: [
        ...base.activity.slice(0, 5),
        { id: 6, at: "1:12", kind: "permission", title: "Turned down: Run npm test -- retryPolicy", detail: "No", status: "failed" },
        { id: 7, at: "1:13", kind: "info", title: "You turned down Run npm test -- retryPolicy", isError: true },
        { id: 8, at: "1:40", kind: "info", title: "The agent ended its turn without calling guide_finish." },
      ],
      bottlenecks: [
        { key: "turned-down", title: "You turned down Run npm test -- retryPolicy", detail: "Claude Code will try another way. Approve automatically to let its requests through for the rest of this run.", action: "approveRun" },
        { key: "ended-blocked", title: "The run ended after requests were turned down", detail: "Resume it with automatic approval to let the agent's requests through.", action: "resumeWithApproval" },
      ],
    },
  },
];

/**
 * A MOCK of the start flow's last Quick Pick step (VS Code draws the real one;
 * the item texts are the ones `pickModelAndEffort` in new-review.ts builds).
 */
const QUICK_PICK_MOCK = `
<div class="qp">
  <div class="qp-title"><span>New Guided Review</span><span class="qp-step">4/4</span></div>
  <div class="qp-input">Effort for Sonnet</div>
  <div class="qp-item qp-active"><span>Low</span><span class="qp-desc">default</span></div>
  <div class="qp-item"><span>Medium</span></div>
  <div class="qp-item"><span>High</span></div>
  <div class="qp-sep"></div>
  <div class="qp-item qp-two"><div><span class="codicon codicon-edit"></span> Add instructions for this guide… <span class="qp-desc">optional</span></div><div class="qp-detail">Standing instructions: none (set them in Plannotator's web app)</div></div>
  <div class="qp-item qp-two"><div><span class="codicon codicon-lock"></span> Approve the agent's requests automatically: off <span class="qp-desc">you approve each request</span></div><div class="qp-detail">Off: Claude Code runs with your own settings and you answer what it asks about. Pick to turn on for this guide.</div></div>
</div>
<div class="qp-note">Mock of VS Code's Quick Pick: the start flow's effort step with the automatic-approval toggle.</div>
<style>
.qp { width: 640px; margin: 24px auto 8px; background: #252526; border: 1px solid #454545; border-radius: 6px; box-shadow: 0 8px 24px #0008; font-size: 13px; color: #cccccc; padding-bottom: 6px; }
.qp-title { display: flex; justify-content: space-between; padding: 6px 10px; font-weight: 600; }
.qp-step { color: #9d9d9d; font-weight: 400; }
.qp-input { margin: 0 8px 6px; padding: 4px 6px; border: 1px solid #0078d4; border-radius: 2px; color: #8b8b8b; background: #313131; }
.qp-item { padding: 3px 12px; display: flex; gap: 8px; }
.qp-two { display: block; padding: 4px 12px; }
.qp-active { background: #04395e; outline: 1px solid #0078d4; }
.qp-desc { color: #9d9d9d; font-size: 12px; margin-left: 6px; }
.qp-detail { color: #9d9d9d; font-size: 12px; margin-left: 20px; }
.qp-sep { border-top: 1px solid #454545; margin: 4px 0; }
.qp-note { text-align: center; color: #9d9d9d; font-size: 12px; }
</style>`;

const work = mkdtempSync(join(tmpdir(), "pn-approvals-shots-"));
try {
  const html = join(work, "index.html");
  writeFileSync(html, `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${THEME}</style>
<link rel="stylesheet" href="${pathToFileURL(join(dist, "codicons", "codicon.css"))}">
<link rel="stylesheet" href="${pathToFileURL(join(dist, "guides-webview.css"))}">
</head><body class="pn-mode-generating"><div id="root"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script>
<script src="${pathToFileURL(join(dist, "guides-webview.js"))}"></script>
</body></html>`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(html).toString());
    for (const shot of shots) {
      await page.evaluate((state) => window.postMessage({ type: "state", state }, "*"), shot.state as unknown as Record<string, unknown>);
      await page.waitForTimeout(150);
      const path = join(outDir, `${shot.name}.png`);
      if (shot.element) await page.locator(shot.element).screenshot({ path });
      else await page.screenshot({ path, fullPage: true });
      console.log(path);
    }
    await page.setContent(`<html><head><link rel="stylesheet" href="${pathToFileURL(join(dist, "codicons", "codicon.css"))}"><style>${THEME}</style></head><body><div id="mock">${QUICK_PICK_MOCK}</div></body></html>`);
    await page.waitForTimeout(150);
    const mockPath = join(outDir, "start-flow-quickpick-mock.png");
    await page.locator("#mock").screenshot({ path: mockPath });
    console.log(mockPath);
  } finally {
    await browser.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
