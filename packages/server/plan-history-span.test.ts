/**
 * A plan review that spans midnight keeps its version chain.
 *
 * What regresses if this fails: the reviewer annotates a plan, the agent
 * revises it, and the next day's review opens with no Versions tab and no
 * diff — because `generateSlug` stamps the current date into the slug that
 * keys `history/{project}/{slug}/`, so the revision lands in a second
 * directory numbered from 001 again. `versionInfo.totalVersions` is then 1,
 * `previousPlan` is null, and the UI has nothing to compare against.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";
import { detectProjectName } from "./project";
import { generateSlug } from "@plannotator/shared/storage";

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

/** The slug today's review would mint, with its date replaced by an earlier one. */
function slugDatedDaysAgo(plan: string, days: number): string {
  const today = generateSlug(plan);
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  const earlier = date.toISOString().split("T")[0];
  return today.replace(/\d{4}-\d{2}-\d{2}$/, earlier);
}

function seedVersion(dataDir: string, project: string, slug: string, content: string): void {
  const dir = join(dataDir, "history", project, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "001.md"), content, "utf-8");
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

  test("still starts at version 1 for a plan with no history", async () => {
    const plan = "# Brand new plan\n\nNothing came before this.\n";

    const payload = await planPayload(plan);

    expect(payload.versionInfo.version).toBe(1);
    expect(payload.versionInfo.totalVersions).toBe(1);
    expect(payload.previousPlan).toBeNull();
  });
});
