import { describe, expect, test } from "vitest";
import { scenarioDefinitions, getScenario } from "./index";
import type { ScenarioId } from "./types";

const requiredScenarioIds: ScenarioId[] = [
  "claude-plan-hook",
  "opencode-plan",
  "opencode-review",
  "opencode-annotate",
  "opencode-archive",
  "pi-plan",
  "pi-review",
  "pi-annotate",
  "pi-archive",
  "codex-plan-hook",
  "copilot-plan-hook",
  "gemini-plan-file-hook",
  "cli-review",
  "cli-annotate",
  "cli-annotate-gate",
  "cli-annotate-html",
  "cli-annotate-url",
  "cli-archive",
];

describe("agent simulator scenarios", () => {
  test("covers every accepted fixture-backed scenario", () => {
    expect(scenarioDefinitions.map((scenario) => scenario.id).sort()).toEqual(
      [...requiredScenarioIds].sort(),
    );
  });

  test("every scenario declares protocol metadata and completion mode", () => {
    for (const scenario of scenarioDefinitions) {
      expect(scenario.title).not.toBe("");
      expect(["hook", "plugin", "cli"]).toContain(scenario.kind);
      expect(["plan", "review", "annotate", "archive"]).toContain(scenario.expectedSessionMode);
    }
  });

  test("every scenario builds a runnable command with isolated local fixtures", async () => {
    for (const scenario of scenarioDefinitions) {
      const fixture = await scenario.buildFixture("/repo");
      try {
        const command = scenario.buildCommand("/repo", fixture);
        expect(command.command).toBe("/repo/bin/plannotator.js");
        expect(command.cwd).toBe(fixture.cwd);
        expect(command.env?.PLANNOTATOR_SHARE).toBe("disabled");
        expect(command.env?.PLANNOTATOR_DISABLE_AUTO_INSTALL).toBe("1");
        expect(fixture.cleanup).toEqual(expect.any(Function));
      } finally {
        await fixture.cleanup?.();
      }
    }
  });

  test("builds plugin commands with realistic stdin", async () => {
    const scenario = getScenario("opencode-plan");
    const fixture = await scenario.buildFixture("/repo");
    try {
      const command = scenario.buildCommand("/repo", fixture);
      expect(command.args).toEqual(["plugin", "plan", "--origin", "opencode"]);
      expect(JSON.parse(command.stdin ?? "{}")).toMatchObject({
        origin: "opencode",
        plan: expect.stringContaining("Simulator plan"),
      });
    } finally {
      await fixture.cleanup?.();
    }
  });
});
