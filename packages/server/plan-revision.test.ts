/**
 * Bun mirror of apps/pi-extension/server/plan-revision.test.ts: revised plans
 * pushed into an open plan review.
 *
 * What regresses if this fails: a host that opts into `planRevisions` pushes
 * a revision the tab never sees, a decision on the replaced text is accepted,
 * or a host that does NOT opt in (Claude Code today) starts advertising
 * `planRevision` and its tab polls for nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

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

function planPair() {
  const title = `# Bun plan revision test ${Math.random().toString(36).slice(2, 10)}`;
  const v1 = `${title}\n\n- [ ] First step.\n`;
  const v2 = `${title}\n\n- [ ] First step, revised.\n`;
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
      // #1001: the history file holding the plan on screen, so Ask AI names it by path.
      const before = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
      expect(before.planPath.startsWith(process.env.PLANNOTATOR_DATA_DIR!)).toBe(true);
      expect(readFileSync(before.planPath, "utf8")).toBe(v1);
      expect(server.updatePlan(v2)).toEqual({ revision: 1, version: 2, unchanged: false });
      const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
      expect(payload).toMatchObject({ plan: v2, planRevision: 1, previousPlan: v1 });
      expect(payload.planPath).not.toBe(before.planPath);
      expect(readFileSync(payload.planPath, "utf8")).toBe(v2);

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

  test("the plan's own file is advertised as planFilePath only while its text is the plan (#1001)", async () => {
    const { v1, v2 } = planPair();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-plan-own-file-")));
    tempDirs.push(dir);
    const own = join(dir, "rollout.md");
    writeFileSync(own, v1);
    const server = await startPlannotatorServer({ plan: v1, htmlContent: MINIMAL_HTML, origin: "claude-code", planRevisions: true, planFilePath: own });
    try {
      const first = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
      expect(first.planFilePath).toBe(own);
      // A revision whose text the file does not hold drops it.
      server.updatePlan(v2);
      const stale = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
      expect("planFilePath" in stale).toBe(false);
      // The agent rewrote its file with the next revision: advertised again.
      const v3 = `${v2}\n- [ ] Third step.\n`;
      writeFileSync(own, v3);
      server.updatePlan(v3);
      const fresh = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
      expect(fresh.planFilePath).toBe(own);
    } finally {
      await server.stop();
    }
  });
});
