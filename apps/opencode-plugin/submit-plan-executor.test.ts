import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeSubmitPlan } from "./submit-plan-executor";
import { getPlanBackingPath } from "./plan-edits";
import { normalizeWorkflowOptions } from "./workflow";

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

    const backingPath = getPlanBackingPath("example");
    expect(readFileSync(backingPath, "utf-8")).toBe("# Plan\n\nShip it");
    expect(result).toContain("Add tests");
    expect(result).toContain("1| # Plan\n2| \n3| Ship it");
    expect(reviewPlan).toHaveBeenCalledTimes(1);
    expect(reviewPlan).toHaveBeenCalledWith({
      planContent: "# Plan\n\nShip it",
      abortSignal: undefined,
    });
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

    expect(existsSync(getPlanBackingPath("example"))).toBe(false);
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
    expect(readFileSync(getPlanBackingPath("example"), "utf-8")).toBe("# Retry later");
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
