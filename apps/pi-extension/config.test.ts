import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlannotatorConfig, formatTodoList, renderTemplate, resolvePhaseProfile } from "./config.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plannotator config", () => {
  test("loads the shipped internal base config", () => {
    const cwdDir = makeTempDir("plannotator-config-base-");
    process.env.HOME = makeTempDir("plannotator-config-home-base-");

    const loaded = loadPlannotatorConfig(cwdDir);
    const planning = resolvePhaseProfile(loaded.config, "planning");

    expect(loaded.warnings).toEqual([]);
    expect(planning.statusLabel).toBe("⏸ plan");
    expect(planning.activeTools).toEqual(["grep", "find", "ls", "plannotator_submit_plan"]);
  });

  test("allows a project config to clear an inherited phase with null", () => {
    const homeDir = makeTempDir("plannotator-config-home-null-");
    const cwdDir = makeTempDir("plannotator-config-cwd-null-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, "plannotator.json"),
      JSON.stringify({
        phases: { planning: { statusLabel: "global", activeTools: ["bash"] } },
      }),
      "utf-8",
    );
    writeFileSync(
      join(projectConfigDir, "plannotator.json"),
      JSON.stringify({
        phases: { planning: null },
      }),
      "utf-8",
    );

    const loaded = loadPlannotatorConfig(cwdDir);
    const planning = resolvePhaseProfile(loaded.config, "planning");

    expect(loaded.warnings).toEqual([]);
    expect(planning.statusLabel).toBeUndefined();
    expect(planning.activeTools).toBeUndefined();
  });

  test("loads global and project configs with project precedence", () => {
    const homeDir = makeTempDir("plannotator-config-home-");
    const cwdDir = makeTempDir("plannotator-config-cwd-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, "plannotator.json"),
      JSON.stringify({
        defaults: {
          thinking: "low",
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        },
        phases: { planning: { statusLabel: "global", activeTools: ["bash"] } },
      }),
      "utf-8",
    );
    writeFileSync(
      join(projectConfigDir, "plannotator.json"),
      JSON.stringify({
        defaults: { thinking: null, model: null },
        phases: { planning: { statusLabel: "project", activeTools: [] } },
      }),
      "utf-8",
    );

    const loaded = loadPlannotatorConfig(cwdDir);
    const planning = resolvePhaseProfile(loaded.config, "planning");

    expect(loaded.warnings).toEqual([]);
    expect(planning.thinking).toBeUndefined();
    expect(planning.model).toBeUndefined();
    expect(planning.statusLabel).toBe("project");
    expect(planning.activeTools).toEqual([]);
  });

  test("treats empty strings as clearing values", () => {
    const profile = resolvePhaseProfile(
      {
        defaults: { statusLabel: "base", systemPrompt: "base prompt", activeTools: ["bash"] },
        phases: { planning: { statusLabel: "", systemPrompt: "", activeTools: [] } },
      },
      "planning",
    );

    expect(profile.statusLabel).toBeUndefined();
    expect(profile.systemPrompt).toBeUndefined();
    expect(profile.activeTools).toEqual([]);
  });

  test("allows clearing an entire phase with null", () => {
    const profile = resolvePhaseProfile(
      {
        defaults: { thinking: "low", activeTools: ["bash"], statusLabel: "base" },
        phases: { planning: null },
      },
      "planning",
    );

    expect(profile.thinking).toBe("low");
    expect(profile.activeTools).toEqual(["bash"]);
    expect(profile.statusLabel).toBe("base");
  });

  test("renders prompt templates and reports unknown variables", () => {
    const rendered = renderTemplate("Hello ${name} ${missing}", {
      planFilePath: "PLAN.md",
      todoList: "- [ ] A",
      completedCount: 1,
      totalCount: 2,
      remainingCount: 1,
      phase: "planning",
    });

    expect(rendered.text).toBe("Hello  ");
    expect(rendered.unknownVariables).toEqual(["name", "missing"]);
  });

  test("formats todo lists from checklist items", () => {
    const stats = formatTodoList([
      { step: 1, text: "First", completed: true },
      { step: 2, text: "Second", completed: false },
      { step: 3, text: "Third", completed: false },
    ]);

    expect(stats.completedCount).toBe(1);
    expect(stats.totalCount).toBe(3);
    expect(stats.remainingCount).toBe(2);
    expect(stats.todoList).toBe("- [ ] 2. Second\n- [ ] 3. Third");
  });
});
