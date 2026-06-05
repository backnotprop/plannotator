import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");

describe("plannotator-setup-goal skill", () => {
  test("uses bundled goal setup UI as the default interview path", () => {
    expect(skill).toContain("Build a compact bundle of questions");
    expect(skill).toContain("plannotator setup-goal interview");
    expect(skill).toContain("goals/<slug>/interview.json");
    expect(skill).toContain("goals/<slug>/interview-result.json");
    expect(skill).toContain("Do not ask obvious confirmation questions");
    expect(skill).toContain("Before moving to facts, read every answer and note carefully");
    expect(skill).toContain("be absolutely patient and keep waiting on the user");
    expect(skill).toContain("Do not close, kill, restart, refresh, or open a second copy");
    expect(skill).not.toContain("setup-goal interview -");
  });

  test("allows opt-in grill-first questions before the bundled interview", () => {
    const grillStart = skill.indexOf("**Optional: grill first");
    const bundleStart = skill.indexOf("### 2. Interview Bundle");
    expect(grillStart).toBeGreaterThan(-1);
    expect(bundleStart).toBeGreaterThan(grillStart);

    const grillSection = skill.slice(grillStart, bundleStart);
    expect(grillSection).toContain("This is opt-in");
    expect(grillSection).toContain("Ask the questions one at a time.");
    expect(grillSection).toContain("If a question can be answered by exploring the codebase");
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
