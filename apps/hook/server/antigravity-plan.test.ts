import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getAntigravityPlan, formatAntigravityDecision } from "./antigravity-plan";
import { getAgentName } from "../../../packages/core/agents";

const artifacts = resolve("test-artifacts", "conversation");
const event = (name = "write_to_file", args: Record<string, unknown> = {}) => ({
  conversationId: "conversation",
  artifactDirectoryPath: artifacts,
  toolCall: { name, args: { TargetFile: join(artifacts, "implementation_plan.md"), CodeContent: "# Plan\n\nShip it.", ...args } },
});

describe("Antigravity plan adapter", () => {
  test("uses the native camelCase payload and the exact proposed content", () => {
    expect(getAntigravityPlan(event())).toBe("# Plan\n\nShip it.");
    expect(getAntigravityPlan(event("write_to_file", { Overwrite: true, CodeContent: "# Plan\n\nRevised." }))).toBe("# Plan\n\nRevised.");
    expect(getAgentName("antigravity")).toBe("Antigravity");
  });

  test("abstains for ordinary files, other conversations, and unrelated tools", () => {
    expect(getAntigravityPlan(event("write_to_file", { TargetFile: join(artifacts, "task.md") }))).toBeNull();
    expect(getAntigravityPlan(event("write_to_file", { TargetFile: join(artifacts, "..", "other", "implementation_plan.md") }))).toBeNull();
    expect(getAntigravityPlan(event("write_to_file", { TargetFile: join(artifacts, "nested", "implementation_plan.md") }))).toBeNull();
    expect(getAntigravityPlan(event("run_command"))).toBeNull();
  });

  test("rejects incomplete payloads instead of approving an unreviewed plan", () => {
    for (const input of [null, {}, { toolCall: [] }, event("write_to_file", { TargetFile: null }), event("write_to_file", { CodeContent: "  " }), event("write_to_file", { CodeContent: 42 }), { ...event(), artifactDirectoryPath: "relative" }, event("write_to_file", { TargetFile: "implementation_plan.md" })]) {
      expect(() => getAntigravityPlan(input)).toThrow();
    }
  });

  test("requires full resubmission for incremental plan revisions", () => {
    for (const tool of ["replace_file_content", "multi_replace_file_content"]) {
      expect(() => getAntigravityPlan(event(tool))).toThrow("Resubmit the complete revised implementation plan");
      expect(getAntigravityPlan(event(tool, { TargetFile: join(artifacts, "other.md") }))).toBeNull();
    }
  });

  test("returns native allow/deny decisions and preserves review feedback", () => {
    expect(formatAntigravityDecision({ approved: true })).toEqual({ decision: "allow" });
    expect(formatAntigravityDecision({ approved: true, feedback: "Keep compatibility" })).toEqual({ decision: "allow", reason: "Keep compatibility" });
    const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-agy-prompts-"));
    try {
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      const denied = formatAntigravityDecision({ approved: false, feedback: "Add rollback steps" });
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toContain("Add rollback steps");
      expect(denied.reason).toContain("write_to_file");
      expect(denied.reason).toContain("rejected write did not run");
      expect(denied.reason).not.toContain("exit_plan_mode");
    } finally {
      if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
