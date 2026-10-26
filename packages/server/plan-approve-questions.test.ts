/**
 * Plan /api/approve refuses while a question the agent did not settle has no
 * answer in the request, and approves once every one does.
 *
 * What regresses if this fails: a plan with open (or only skipped)
 * `:::question` blocks gets approved — from the Approve button, or from any
 * caller that posts /api/approve without answers — and the agent implements
 * guesses for decisions the reviewer never made.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";
import { getPlanVersionPath } from "./storage";
import { detectProjectName } from "./project";
import { generateSlug } from "@plannotator/shared/storage";
import { findQuestionBlocks } from "@plannotator/shared/question-block";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
const createdPlans: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "plannotator-plan-approve-questions-"));
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

const planWith = (choices: string) => {
  const plan = `# Approve questions test ${Math.random().toString(36).slice(2, 10)}\n\n:::question\nWhich database?\n\n${choices}\n:::\n`;
  createdPlans.push(plan);
  return plan;
};

async function approve(plan: string, body: Record<string, unknown>) {
  const server = await startPlannotatorServer({ plan, htmlContent: MINIMAL_HTML, origin: "claude-code" });
  try {
    const response = await fetch(`${server.url}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planSave: { enabled: false }, ...body }),
    });
    const json = await response.json();
    const decision = response.ok ? await server.waitForDecision() : undefined;
    return { status: response.status, json, decision };
  } finally {
    await server.stop();
  }
}

const answerFor = (plan: string, fields: Record<string, unknown>) => {
  const { question } = findQuestionBlocks(plan)[0];
  return { v: 1, key: question.key, kind: "single", prompt: question.prompt, selected: [], ...fields };
};

describe("plan /api/approve with questions", () => {
  test("an open question without an answer refuses with 422 and names it", async () => {
    const plan = planWith("- [ ] Postgres\n- [ ] SQLite");
    const { status, json, decision } = await approve(plan, {});
    expect(status).toBe(422);
    expect(json.code).toBe("questions_unanswered");
    expect(json.unanswered).toEqual([expect.objectContaining({ number: 1, prompt: "Which database?", status: "open" })]);
    expect(json.error).toContain("Q1. Which database?");
    expect(decision).toBeUndefined();
  });

  test("a skipped answer refuses too", async () => {
    const plan = planWith("- [ ] Postgres\n- [ ] SQLite");
    const { status, json } = await approve(plan, { questionAnswers: [answerFor(plan, { skipped: true })] });
    expect(status).toBe(422);
    expect(json.unanswered[0].status).toBe("skipped");
  });

  test("a picked answer approves", async () => {
    const plan = planWith("- [ ] Postgres\n- [ ] SQLite");
    const { status, decision } = await approve(plan, { questionAnswers: [answerFor(plan, { selected: ["SQLite"] })] });
    expect(status).toBe(200);
    expect(decision?.approved).toBe(true);
  });

  test("a question the agent settled with [x] approves without an answer", async () => {
    const { status, decision } = await approve(planWith("- [x] Postgres\n- [ ] SQLite"), {});
    expect(status).toBe(200);
    expect(decision?.approved).toBe(true);
  });
});
