/**
 * Claude Code Plan Resolver Tests
 *
 * Run: bun test apps/hook/server/claude-plan.test.ts
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudePlan } from "./claude-plan";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writePlanFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-plans-"));
  tempDirs.push(dir);
  const planFilePath = join(dir, "plan.md");
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
});
