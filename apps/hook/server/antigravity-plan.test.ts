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

  test("recognizes artifacts with RequestFeedback and workspace plan paths", () => {
    // Artifact with custom name but RequestFeedback metadata
    expect(
      getAntigravityPlan(
        event("write_to_file", {
          TargetFile: join(artifacts, "auth_migration.md"),
          CodeContent: "# Auth Plan",
          ArtifactMetadata: { RequestFeedback: true, UserFacing: true },
        })
      )
    ).toBe("# Auth Plan");

    // Workspace .agents/plans/ path
    const workspacePlan = resolve("workspace", ".agents", "plans", "feature.md");
    expect(
      getAntigravityPlan(
        event("write_to_file", {
          TargetFile: workspacePlan,
          CodeContent: "# Feature Plan",
        })
      )
    ).toBe("# Feature Plan");

    // Direct submit_plan MCP tool
    expect(
      getAntigravityPlan({
        conversationId: "conv",
        toolCall: { name: "submit_plan", args: { title: "my-plan", plan: "# Direct Plan" } },
      })
    ).toBe("# Direct Plan");
  });

  test("abstains for ordinary files, other conversations, and unrelated tools", () => {
    expect(getAntigravityPlan(event("write_to_file", { TargetFile: join(artifacts, "task.txt") }))).toBeNull();
    expect(getAntigravityPlan(event("write_to_file", { TargetFile: resolve("workspace", "src", "index.ts") }))).toBeNull();
    expect(getAntigravityPlan(event("run_command", { CommandLine: "npm test" }))).toBeNull();
  });

  test("rejects incomplete payloads instead of approving an unreviewed plan", () => {
    for (const input of [
      null,
      {},
      { toolCall: [] },
      event("write_to_file", { TargetFile: null }),
      event("write_to_file", { CodeContent: "  " }),
      event("write_to_file", { CodeContent: 42 }),
      { ...event(), artifactDirectoryPath: "relative" },
    ]) {
      expect(() => getAntigravityPlan(input)).toThrow();
    }
  });

  test("requires full resubmission for incremental plan revisions", () => {
    for (const tool of ["replace_file_content", "multi_replace_file_content"]) {
      expect(() => getAntigravityPlan(event(tool))).toThrow("Resubmit the complete revised implementation plan");
      expect(getAntigravityPlan(event(tool, { TargetFile: resolve("workspace", "src", "app.ts") }))).toBeNull();
    }
  });

  test("returns native allow/deny decisions and preserves review feedback", () => {
    expect(formatAntigravityDecision({ approved: true })).toEqual({ decision: "allow" });
    expect(formatAntigravityDecision({ approved: true, feedback: "Keep compatibility" })).toEqual({
      decision: "allow",
      reason: "Keep compatibility",
    });

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

      // Permission modes and reasoning effort
      const approvedAcceptEdits = formatAntigravityDecision({
        approved: true,
        permissionMode: "acceptEdits",
        reasoningEffort: "high",
        feedback: "LGTM",
      });
      expect(approvedAcceptEdits.decision).toBe("allow");
      expect(approvedAcceptEdits.permissionOverrides).toEqual([
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
      ]);
      expect(approvedAcceptEdits.reason).toContain("Reasoning effort: high.");
      expect(approvedAcceptEdits.reason).toContain("LGTM");

      const approvedBypass = formatAntigravityDecision({
        approved: true,
        permissionMode: "bypassPermissions",
      });
      expect(approvedBypass.decision).toBe("allow");
      expect(approvedBypass.permissionOverrides).toEqual(["*"]);
    } finally {
      if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("enforces deterministic planning lock against source code modifications", () => {
    const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
    const previousCwd = process.env.PLANNOTATOR_CWD;
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-agy-lock-"));
    const workspace = resolve("test-workspace");
    try {
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      process.env.PLANNOTATOR_CWD = workspace;

      const {
        getAntigravityPlanningLockDenial,
        setPlanningLock,
        clearPlanningLock,
      } = require("./antigravity-plan");

      const sourceFileEvent = event("replace_file_content", {
        TargetFile: resolve(workspace, "src", "index.ts"),
      });
      const planFileEvent = event("write_to_file", {
        TargetFile: resolve(workspace, ".agents", "plans", "feature.md"),
      });

      // 1. Without lock: source file modification is allowed (not denied by lock)
      expect(getAntigravityPlanningLockDenial(sourceFileEvent)).toBeNull();

      // 2. Lock is set (e.g. plan denied with feedback)
      setPlanningLock(workspace, resolve(workspace, ".agents", "plans", "feature.md"), "denied", "Add more unit tests");

      // Source file modification is now deterministically blocked!
      const denial = getAntigravityPlanningLockDenial(sourceFileEvent);
      expect(denial).not.toBeNull();
      expect(denial).toContain("Deterministic Planning Lock");
      expect(denial).toContain("index.ts");
      expect(denial).toContain("feature.md");
      expect(denial).toContain("Add more unit tests");

      // Plan file modification is NOT blocked by the lock (it needs to be written to be reviewed)
      expect(getAntigravityPlanningLockDenial(planFileEvent)).toBeNull();

      // 3. Clear lock on approval
      clearPlanningLock(workspace);
      expect(getAntigravityPlanningLockDenial(sourceFileEvent)).toBeNull();
    } finally {
      if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
      if (previousCwd === undefined) delete process.env.PLANNOTATOR_CWD;
      else process.env.PLANNOTATOR_CWD = previousCwd;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("strictly isolates hook execution to Antigravity CLI and abstains on 2.0 Desktop and IDE", () => {
    const {
      getAntigravityPlanTarget,
      getAntigravityPlanningLockDenial,
    } = require("./antigravity-plan");

    const cliArtifacts = resolve(".gemini", "antigravity-cli", "brain", "session-cli");
    const desktopArtifacts = resolve(".gemini", "antigravity", "brain", "session-desktop");
    const ideArtifacts = resolve(".gemini", "antigravity-ide", "brain", "session-ide");

    const cliEvent = {
      conversationId: "cli-conv",
      artifactDirectoryPath: cliArtifacts,
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: join(cliArtifacts, "implementation_plan.md"),
          CodeContent: "# CLI Plan",
          Overwrite: true,
        },
      },
    };

    const desktopEvent = {
      conversationId: "desktop-conv",
      artifactDirectoryPath: desktopArtifacts,
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: join(desktopArtifacts, "implementation_plan.md"),
          CodeContent: "# Desktop Plan",
          Overwrite: true,
        },
      },
    };

    const ideEvent = {
      conversationId: "ide-conv",
      artifactDirectoryPath: ideArtifacts,
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: join(ideArtifacts, "implementation_plan.md"),
          CodeContent: "# IDE Plan",
          Overwrite: true,
        },
      },
    };

    // 1. Antigravity CLI triggers normally
    expect(getAntigravityPlan(cliEvent)).toBe("# CLI Plan");
    expect(getAntigravityPlanTarget(cliEvent)).toBe(join(cliArtifacts, "implementation_plan.md"));

    // 2. Antigravity 2.0 Desktop immediately abstains (returns null)
    expect(getAntigravityPlan(desktopEvent)).toBeNull();
    expect(getAntigravityPlanTarget(desktopEvent)).toBeNull();
    expect(getAntigravityPlanningLockDenial(desktopEvent)).toBeNull();

    // 3. Antigravity IDE immediately abstains (returns null)
    expect(getAntigravityPlan(ideEvent)).toBeNull();
    expect(getAntigravityPlanTarget(ideEvent)).toBeNull();
    expect(getAntigravityPlanningLockDenial(ideEvent)).toBeNull();
  });
});

