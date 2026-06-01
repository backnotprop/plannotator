import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");

describe("plannotator-setup-goal skill", () => {
  test("uses bundled goal setup UI instead of serial chat questions", () => {
    expect(skill).toContain("Build a compact bundle of questions");
    expect(skill).toContain("plannotator setup-goal interview");
    expect(skill).toContain("goals/<slug>/interview.json");
    expect(skill).toContain("goals/<slug>/interview-result.json");
    expect(skill).toContain("Do not ask obvious confirmation questions");
    expect(skill).toContain("Before moving to facts, read every answer and note carefully");
    expect(skill).toContain("be absolutely patient and keep waiting on the user");
    expect(skill).toContain("Do not close, kill, restart, refresh, or open a second copy");
    expect(skill).not.toContain("setup-goal interview -");
    expect(skill).not.toContain("one at a time");
  });

  test("facts phase captures automated verification selections", () => {
    expect(skill).toContain("plannotator setup-goal facts");
    expect(skill).toContain("goals/<slug>/facts-review.json");
    expect(skill).toContain("goals/<slug>/facts-result.json");
    expect(skill).toContain("facts.meta.json");
    expect(skill).toContain("automatedVerification");
    expect(skill).not.toContain("setup-goal facts -");
  });
});
