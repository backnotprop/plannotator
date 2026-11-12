import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";
import { detectProjectName } from "./project";
import { generateSlug, PLAN_HISTORY_CONTINUE_WINDOW_MS } from "@plannotator/shared/storage";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_FEEDBACK_HISTORY",
] as const;

const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "plannotator-history-span-"));
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

function slugDatedDaysAgo(plan: string, days: number): string {
  const today = generateSlug(plan);
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  const earlier = date.toISOString().split("T")[0];
  return today.replace(/\d{4}-\d{2}-\d{2}$/, earlier);
}

function seedVersion(dataDir: string, project: string, slug: string, content: string, ageMs = 0): void {
  const dir = join(dataDir, "history", project, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "001.md"), content, "utf-8");
  const when = new Date(Date.now() - ageMs);
  utimesSync(join(dir, "001.md"), when, when);
}

async function planPayload(plan: string): Promise<{
  previousPlan: string | null;
  versionInfo: { version: number; totalVersions: number; project: string };
}> {
  const server = await startPlannotatorServer({
    plan,
    htmlContent: MINIMAL_HTML,
    origin: "claude-code",
  });
  try {
    const response = await fetch(`${server.url}/api/plan`);
    expect(response.status).toBe(200);
    return await response.json();
  } finally {
    await server.stop();
  }
}

describe("plan review spanning a day boundary", () => {
  test("continues yesterday's chain instead of starting a second one", async () => {
    const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
    const project = (await detectProjectName()) ?? "_unknown";
    const plan = "# Inference capacity\n\nRevised after yesterday's annotations.\n";
    const yesterday = "# Inference capacity\n\nThe version the reviewer annotated.\n";

    seedVersion(dataDir, project, slugDatedDaysAgo(plan, 1), yesterday);

    const payload = await planPayload(plan);

    expect(payload.versionInfo.version).toBe(2);
    expect(payload.versionInfo.totalVersions).toBe(2);
    expect(payload.previousPlan).toBe(yesterday);
  });

  test("a revision pushed into the open review stays on the continued chain", async () => {
    const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
    const project = (await detectProjectName()) ?? "_unknown";
    const v1 = "# Pushed revision chain\n\nThe version the reviewer annotated.\n";
    const v2 = "# Pushed revision chain\n\nRevised the next day.\n";
    const v3 = "# Pushed revision chain\n\nRevised again in the same review.\n";
    const chain = slugDatedDaysAgo(v1, 1);
    seedVersion(dataDir, project, chain, v1, 3 * 60 * 60 * 1000);

    const server = await startPlannotatorServer({
      plan: v2,
      htmlContent: MINIMAL_HTML,
      origin: "claude-code",
      planRevisions: true,
    });
    try {
      expect(server.updatePlan(v3)).toMatchObject({ version: 3, unchanged: false });
      const payload = await (await fetch(`${server.url}/api/plan`)).json();
      expect(payload.previousPlan).toBe(v2);
      const versions = await (await fetch(`${server.url}/api/plan/versions`)).json();
      expect(versions.slug).toBe(chain);
      expect(versions.versions).toHaveLength(3);
      expect(existsSync(join(dataDir, "history", project, generateSlug(v1)))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("a same-heading plan after two quiet days starts a new chain", async () => {
    const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
    const project = (await detectProjectName()) ?? "_unknown";
    const plan = "# Implementation Plan\n\nUnrelated work, days later.\n";
    seedVersion(
      dataDir,
      project,
      slugDatedDaysAgo(plan, 3),
      "# Implementation Plan\n\nAn older plan.\n",
      PLAN_HISTORY_CONTINUE_WINDOW_MS + 60 * 60 * 1000,
    );

    const payload = await planPayload(plan);

    expect(payload.versionInfo.version).toBe(1);
    expect(payload.previousPlan).toBeNull();
  });

  for (const decision of ["approve", "deny"] as const) {
    test(`${decision} writes plans/{heading}-{today} while history continues an older chain`, async () => {
      const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
      const project = (await detectProjectName()) ?? "_unknown";
      const v1 = `# Archive split ${decision}\n\n- [ ] First step.\n`;
      const v2 = `# Archive split ${decision}\n\n- [ ] First step, revised.\n`;
      const chain = slugDatedDaysAgo(v1, 1);
      seedVersion(dataDir, project, chain, v1, 2 * 60 * 60 * 1000);

      const server = await startPlannotatorServer({ plan: v2, htmlContent: MINIMAL_HTML, origin: "claude-code" });
      try {
        expect(existsSync(join(dataDir, "history", project, chain, "002.md"))).toBe(true);
        const response = await fetch(`${server.url}/api/${decision}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planSave: { enabled: true }, ...(decision === "deny" ? { feedback: "Change step one." } : {}) }),
        });
        expect(response.status).toBe(200);
        const result = await server.waitForDecision();
        const status = decision === "approve" ? "approved" : "denied";
        expect(result.savedPath).toBe(join(dataDir, "plans", `${generateSlug(v2)}-${status}.md`));
        expect(generateSlug(v2)).not.toBe(chain);
      } finally {
        await server.stop();
      }
    });
  }

  test("still starts at version 1 for a plan with no history", async () => {
    const plan = "# Brand new plan\n\nNothing came before this.\n";

    const payload = await planPayload(plan);

    expect(payload.versionInfo.version).toBe(1);
    expect(payload.versionInfo.totalVersions).toBe(1);
    expect(payload.previousPlan).toBeNull();
  });
});
