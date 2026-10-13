/**
 * Claude Code Plan Resolver Tests
 *
 * Run: bun test apps/hook/server/claude-plan.test.ts
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/shared/annotatable";
import { readPlanFile } from "@plannotator/shared/doc-resolve";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudePlan } from "./claude-plan";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-plans-"));
  tempDirs.push(dir);
  return dir;
}

function writePlanFile(content: string, name = "plan.md"): string {
  const planFilePath = join(tempDir(), name);
  writeFileSync(planFilePath, content);
  return planFilePath;
}

describe("resolveClaudePlan", () => {
  test("prefers the plan file over a stale inline snapshot", () => {
    // The model edited the plan file in the same message as ExitPlanMode, so
    // the inline `plan` Claude Code captured predates the edit.
    const planFilePath = writePlanFile("# Plan\n\nRevised after feedback.\n");

    expect(resolveClaudePlan({ plan: "# Plan\n\nFirst draft.\n", planFilePath })).toBe(
      "# Plan\n\nRevised after feedback.\n",
    );
  });

  test("uses the inline plan when no plan file path is sent", () => {
    expect(resolveClaudePlan({ plan: "# Inline plan" })).toBe("# Inline plan");
  });

  test("falls back to the inline plan when the plan file cannot be read", () => {
    const planFilePath = join(tmpdir(), "claude-plans-missing", "plan.md");

    expect(resolveClaudePlan({ plan: "# Inline plan", planFilePath })).toBe("# Inline plan");
  });

  test("falls back to the inline plan when the plan file is empty", () => {
    const planFilePath = writePlanFile("");

    expect(resolveClaudePlan({ plan: "# Inline plan", planFilePath })).toBe("# Inline plan");
  });

  test("returns an empty plan when neither source has content", () => {
    expect(resolveClaudePlan({})).toBe("");
    expect(resolveClaudePlan(undefined)).toBe("");
  });

  test("a plan read from the file passes the server's plan-file trust check", () => {
    // /api/doc serves the plan's linked documents only when readPlanFile sees
    // the file's contents equal the plan; a file-sourced plan must satisfy it.
    const planFilePath = writePlanFile("# Plan\n\nSee [notes](notes.md).\n");
    const plan = resolveClaudePlan({ plan: "# Plan\n\nstale\n", planFilePath });
    expect(readPlanFile(planFilePath, plan)).not.toBeNull();
  });

  // The hook reads whatever path the payload names, so it is gated like
  // readPlanFile: anything else falls back to the inline plan.
  test("ignores a plan file path that is not an absolute .md file", () => {
    const notMarkdown = writePlanFile("# From file", "plan.txt");
    expect(resolveClaudePlan({ plan: "# Inline plan", planFilePath: notMarkdown })).toBe("# Inline plan");
    expect(resolveClaudePlan({ plan: "# Inline plan", planFilePath: "plan.md" })).toBe("# Inline plan");
  });

  test("ignores a plan file over the annotate size cap", () => {
    const planFilePath = writePlanFile("x".repeat(MAX_ANNOTATABLE_FILE_BYTES + 1));
    expect(resolveClaudePlan({ plan: "# Inline plan", planFilePath })).toBe("# Inline plan");
  });

  test.skipIf(process.platform === "win32")("does not block on a FIFO named like a plan file", () => {
    // Reading a FIFO with no writer blocks forever; this would hang the hook.
    const fifo = join(tempDir(), "plan.md");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(resolveClaudePlan({ plan: "# Inline plan", planFilePath: fifo })).toBe("# Inline plan");
  });
});
