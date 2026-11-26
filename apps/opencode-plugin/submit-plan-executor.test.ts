import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeSubmitPlan } from "./submit-plan-executor";
import { getPlanBackingPath } from "./plan-edits";
import { normalizeWorkflowOptions } from "./workflow";
import { DEFAULT_PLAN_ANSWERED_PROMPT } from "@plannotator/shared/prompts";

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepareDataDir(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "plannotator-submit-plan-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
}

describe("executeSubmitPlan", () => {
  test.each([false, true])("keeps a session's plan when another session's review has approved=%s", async (approved) => {
    prepareDataDir();
    const reviewed: string[] = [];
    const run = (sessionId: string, edits: { start: number; end?: number; content: string }[], approved = false) => executeSubmitPlan({
      edits,
      invokingAgent: "plan",
      sessionId,
      directory: "/workspace/example",
      workflowOptions: normalizeWorkflowOptions(undefined),
    }, {
      reviewPlan: async ({ planContent }) => {
        reviewed.push(planContent);
        return { approved };
      },
      resolveTargetAgent: async () => undefined,
      sendApprovalHandoff: async () => {},
    });

    await run("session-a", [{ start: 1, content: "# Plan A\nOriginal A" }]);
    await run("session-b", [{ start: 1, content: "# Plan B\nOriginal B" }], approved);
    const result = await run("session-a", [{ start: 2, end: 2, content: "Revised A" }]);

    expect(reviewed).toEqual(["# Plan A\nOriginal A", "# Plan B\nOriginal B", "# Plan A\nRevised A"]);
    expect(result).toContain("1| # Plan A\n2| Revised A");
    expect(result).not.toContain("Plan B");
  });

  test.each([{ edits: undefined }, { edits: [] }])("rejects absent or empty edits without creating a plan or opening review (%j)", async ({ edits }) => {
    prepareDataDir();
    const reviewPlan = mock(async () => ({ approved: true }));
    const result = await executeSubmitPlan({
      edits,
      invokingAgent: "plan",
      sessionId: "session-invalid",
      directory: "/workspace/example",
      workflowOptions: normalizeWorkflowOptions(undefined),
    }, {
      reviewPlan,
      resolveTargetAgent: async () => undefined,
      sendApprovalHandoff: async () => {},
    });

    expect(result).toContain("Error: No edits provided");
    expect(reviewPlan).not.toHaveBeenCalled();
    expect(existsSync(getPlanBackingPath("example", "/workspace/example", "session-invalid"))).toBe(false);
  });

  test("supports hosts without cancellation signals", async () => {
    prepareDataDir();
    const reviewPlan = mock(async () => ({ approved: false, feedback: "Add tests" }));

    const result = await executeSubmitPlan({
      edits: [{ start: 1, content: "# Plan\n\nShip it" }],
      invokingAgent: "plan",
      sessionId: "session-1",
      directory: "/workspace/example",
      workflowOptions: normalizeWorkflowOptions(undefined),
    }, {
      reviewPlan,
      resolveTargetAgent: async () => undefined,
      sendApprovalHandoff: async () => {},
    });

    const backingPath = getPlanBackingPath("example", "/workspace/example", "session-1");
    expect(readFileSync(backingPath, "utf-8")).toBe("# Plan\n\nShip it");
    expect(result).toContain("Add tests");
    expect(result).toContain("1| # Plan\n2| \n3| Ship it");
    expect(reviewPlan).toHaveBeenCalledTimes(1);
    expect(reviewPlan).toHaveBeenCalledWith({
      planContent: "# Plan\n\nShip it",
      abortSignal: undefined,
    });
  });

  test("an answers-only deny uses the plan.answered prompt, not the denied one", async () => {
    // What regresses: the agent is told its plan "was not approved" when the
    // reviewer only answered its questions.
    prepareDataDir();
    const run = (answersOnly?: boolean) => executeSubmitPlan({
      edits: [{ start: 1, content: "# Plan\n\nShip it" }],
      invokingAgent: "plan",
      sessionId: "session-answers",
      directory: "/workspace/example",
      workflowOptions: normalizeWorkflowOptions(undefined),
    }, {
      reviewPlan: async () => ({
        approved: false,
        feedback: "## Answers to your questions",
        ...(answersOnly === undefined ? {} : { answersOnly }),
      }),
      resolveTargetAgent: async () => undefined,
      sendApprovalHandoff: async () => {},
    });

    const answered = await run(true);
    const answeredOpening = DEFAULT_PLAN_ANSWERED_PROMPT.slice(0, DEFAULT_PLAN_ANSWERED_PROMPT.indexOf("\n"));
    expect(answered.startsWith(answeredOpening)).toBe(true);
    expect(answered).not.toContain("YOUR PLAN WAS NOT APPROVED");
    expect(answered).toContain("submit_plan");
    expect(answered).toContain("## Answers to your questions");
    // The line-numbered plan still follows, for the targeted-edit resubmit.
    expect(answered).toContain("1| # Plan");

    for (const flag of [undefined, false]) {
      const denied = await run(flag);
      expect(denied.startsWith("YOUR PLAN WAS NOT APPROVED.")).toBe(true);
    }
  });

  test("cleans up approved plans and sends implementation handoff", async () => {
    prepareDataDir();
    const sendApprovalHandoff = mock(async () => {});

    const result = await executeSubmitPlan({
      edits: [{ start: 1, content: "# Approved" }],
      invokingAgent: "plan",
      sessionId: "session-2",
      abortSignal: new AbortController().signal,
      directory: "/workspace/example",
      workflowOptions: normalizeWorkflowOptions(undefined),
    }, {
      reviewPlan: async () => ({ approved: true, agentSwitch: "build" }),
      resolveTargetAgent: async () => "build",
      sendApprovalHandoff,
    });

    expect(existsSync(getPlanBackingPath("example", "/workspace/example", "session-2"))).toBe(false);
    expect(sendApprovalHandoff).toHaveBeenCalledWith({
      sessionId: "session-2",
      targetAgent: "build",
      text: "Proceed with implementation",
    });
    expect(result).toBe("Plan approved!");
  });

  test("preserves backing state when review startup fails", async () => {
    prepareDataDir();

    const result = await executeSubmitPlan({
      edits: [{ start: 1, content: "# Retry later" }],
      invokingAgent: "plan",
      sessionId: "session-3",
      abortSignal: new AbortController().signal,
      directory: "/workspace/example",
      workflowOptions: normalizeWorkflowOptions(undefined),
    }, {
      reviewPlan: async () => { throw new Error("browser unavailable"); },
      resolveTargetAgent: async () => undefined,
      sendApprovalHandoff: async () => {},
    });

    expect(result).toBe("[Plannotator] Failed to open plan review: browser unavailable");
    expect(readFileSync(getPlanBackingPath("example", "/workspace/example", "session-3"), "utf-8")).toBe("# Retry later");
  });

  test("rethrows the host abort reason instead of formatting it as startup failure", async () => {
    prepareDataDir();
    const controller = new AbortController();
    const reason = new DOMException("Cancelled by OpenCode", "AbortError");

    const execution = executeSubmitPlan({
      edits: [{ start: 1, content: "# Cancelled" }],
      invokingAgent: "plan",
      sessionId: "session-4",
      abortSignal: controller.signal,
      directory: "/workspace/example",
      workflowOptions: normalizeWorkflowOptions(undefined),
    }, {
      reviewPlan: async () => {
        controller.abort(reason);
        throw reason;
      },
      resolveTargetAgent: async () => undefined,
      sendApprovalHandoff: async () => {},
    });

    await expect(execution).rejects.toBe(reason);
  });
});
