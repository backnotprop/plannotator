/**
 * Plan /api/deny carries `answersOnly` through to the decision, and the
 * decision picks the `plan.answered` prompt.
 *
 * What regresses if this fails: the reviewer answers the plan's questions,
 * clicks Send answers, and the agent reads "YOUR PLAN WAS NOT APPROVED"
 * (the flag was dropped on the way to the hook output), or an ordinary deny
 * starts reading as answers (a truthy non-boolean flag was honored).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";
import { getPlanVersionPath } from "./storage";
import { detectProjectName } from "./project";
import { generateSlug } from "@plannotator/shared/storage";
import { composePlanDeniedMessage, getPlanDeniedPrompt, getPlanToolName } from "@plannotator/shared/prompts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
const createdPlans: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "plannotator-plan-answered-"));
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
  // Plan version history is written through storage.ts, whose data dir is
  // fixed at import time; remove the slugs these tests created there.
  const project = (await detectProjectName()) ?? "_unknown";
  for (const plan of createdPlans) {
    const versionPath = getPlanVersionPath(project, generateSlug(plan), 1);
    if (versionPath) rmSync(join(versionPath, ".."), { recursive: true, force: true });
  }
});

async function denyWith(body: Record<string, unknown>) {
  const plan = `# Plan answered test ${Math.random().toString(36).slice(2, 10)}\n\nStep one.\n`;
  createdPlans.push(plan);
  const server = await startPlannotatorServer({ plan, htmlContent: MINIMAL_HTML, origin: "claude-code" });
  try {
    const response = await fetch(`${server.url}/api/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planSave: { enabled: false }, ...body }),
    });
    expect(response.status).toBe(200);
    return await server.waitForDecision();
  } finally {
    await server.stop();
  }
}

const hookMessage = (decision: { feedback?: string; answersOnly?: boolean }) =>
  composePlanDeniedMessage("claude-code", {}, {
    toolName: getPlanToolName("claude-code"),
    planFileRule: "",
    feedback: decision.feedback || "Plan changes requested",
  }, { answersOnly: decision.answersOnly });

describe("plan /api/deny answersOnly", () => {
  const answers = "# Plan Feedback\n\n## Answers to your questions\n\n1 of 1 question answered.\n";

  test("answersOnly: true reaches the decision and selects the answered prompt", async () => {
    const decision = await denyWith({ feedback: answers, answersOnly: true });
    expect(decision.approved).toBe(false);
    expect(decision.answersOnly).toBe(true);
    const message = hookMessage(decision);
    expect(message).not.toContain("NOT APPROVED");
    expect(message).toContain("answered the questions");
    expect(message).toContain(answers);
  });

  test("an ordinary deny carries no flag and its message is the denied prompt, unchanged", async () => {
    const decision = await denyWith({ feedback: "Split step one." });
    expect("answersOnly" in decision).toBe(false);
    expect(hookMessage(decision)).toBe(getPlanDeniedPrompt("claude-code", {}, {
      toolName: "ExitPlanMode",
      planFileRule: "",
      feedback: "Split step one.",
    }));
  });

  test("only a boolean true counts", async () => {
    const decision = await denyWith({ feedback: answers, answersOnly: "true" });
    expect("answersOnly" in decision).toBe(false);
  });
});
