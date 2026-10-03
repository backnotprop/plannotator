/**
 * Bun mirror of apps/pi-extension/server/plan-revision.test.ts: revised plans
 * pushed into an open plan review.
 *
 * What regresses if this fails: a host that opts into `planRevisions` pushes
 * a revision the tab never sees, a decision on the replaced text is accepted,
 * or a host that does NOT opt in (Claude Code today) starts advertising
 * `planRevision` and its tab polls for nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";
import { getPlanVersionPath } from "./storage";
import { detectProjectName } from "./project";
import { generateSlug } from "@plannotator/shared/storage";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
const createdPlans: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "plannotator-plan-revision-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  const project = (await detectProjectName()) ?? "_unknown";
  for (const plan of createdPlans) {
    const versionPath = getPlanVersionPath(project, generateSlug(plan), 1);
    if (versionPath) rmSync(join(versionPath, ".."), { recursive: true, force: true });
  }
});

function planPair() {
  const title = `# Bun plan revision test ${Math.random().toString(36).slice(2, 10)}`;
  const v1 = `${title}\n\n- [ ] First step.\n`;
  const v2 = `${title}\n\n- [ ] First step, revised.\n`;
  createdPlans.push(v1);
  return { v1, v2 };
}

const post = (url: string, body: Record<string, unknown>) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("plan server revisions (Bun)", () => {
  test("without planRevisions the tab is not told to poll", async () => {
    const { v1 } = planPair();
    const server = await startPlannotatorServer({ plan: v1, htmlContent: MINIMAL_HTML, origin: "claude-code" });
    try {
      const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, unknown>;
      expect("planRevision" in payload).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("a pushed revision is served, and a decision on the older one is refused", async () => {
    const { v1, v2 } = planPair();
    const server = await startPlannotatorServer({ plan: v1, htmlContent: MINIMAL_HTML, origin: "pi", planRevisions: true });
    try {
      expect(server.updatePlan(v2)).toEqual({ revision: 1, version: 2, unchanged: false });
      const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
      expect(payload).toMatchObject({ plan: v2, planRevision: 1, previousPlan: v1 });

      const stale = await post(`${server.url}/api/approve`, { planRevision: 0, planSave: { enabled: false } });
      expect(stale.status).toBe(409);
      const ok = await post(`${server.url}/api/deny`, { planRevision: 1, feedback: "Split it.", planSave: { enabled: false } });
      expect(ok.status).toBe(200);
      expect(await server.waitForDecision()).toMatchObject({ approved: false, feedback: "Split it." });
      expect(server.updatePlan(`${v2}\nMore.\n`)).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
