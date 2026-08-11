import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptVariables, loadPlannotatorConfig, formatTodoList, renderTemplate, resolveExecutionMode, resolvePhaseProfile } from "./config.ts";

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
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
    expect(planning.statusLabel).toBe("⏸ plan");
    expect(planning.activeTools).toEqual(["grep", "find", "ls", "plannotator_submit_plan"]);
    expect(planning.instructions).not.toContain("Available tools:");
  });

  test("defaults to automatic execution", () => {
    expect(resolveExecutionMode({})).toBe("automatic");
  });

  test("loads external execution mode with project precedence", () => {
    const homeDir = makeTempDir("plannotator-config-home-execution-");
    const cwdDir = makeTempDir("plannotator-config-cwd-execution-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "external" }), "utf-8");
    writeFileSync(join(projectConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "automatic" }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir);

    expect(loaded.warnings).toEqual([]);
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
  });

  test("allows a project config to clear inherited external execution with null", () => {
    const homeDir = makeTempDir("plannotator-config-home-execution-null-");
    const cwdDir = makeTempDir("plannotator-config-cwd-execution-null-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "external" }), "utf-8");
    writeFileSync(join(projectConfigDir, "plannotator.json"), JSON.stringify({ executionMode: null }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir);

    expect(loaded.warnings).toEqual([]);
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
  });

  test("warns and falls back to automatic for an unrecognized executionMode", () => {
    const homeDir = makeTempDir("plannotator-config-home-execution-bad-");
    const cwdDir = makeTempDir("plannotator-config-cwd-execution-bad-");
    process.env.HOME = homeDir;

    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "handoff" }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir);

    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain('Ignoring unknown executionMode "handoff"');
    expect(loaded.warnings[0]).toContain("Falling back to automatic");
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
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
        defaults: { statusLabel: "base", instructions: "base instructions", activeTools: ["bash"] },
        phases: { planning: { statusLabel: "", instructions: "", activeTools: [] } },
      },
      "planning",
    );

    expect(profile.statusLabel).toBeUndefined();
    expect(profile.instructions).toBeUndefined();
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

  test("renders buildPromptVariables output into instruction templates", () => {
    const vars = buildPromptVariables({
      planFilePath: "PLAN.md",
      phase: "executing",
      totalCount: 2,
      completedCount: 1,
      todoList: "- [ ] 2. Second",
    });

    const rendered = renderTemplate("Plan ${planFilePath}: ${completedCount}/${totalCount}\n${todoList}", vars);

    expect(rendered.text).toBe("Plan PLAN.md: 1/2\n- [ ] 2. Second");
    expect(rendered.unknownVariables).toEqual([]);
  });

  test("shipped phase instructions carry the framing contract", () => {
    const cwdDir = makeTempDir("plannotator-config-shipped-instructions-");
    process.env.HOME = makeTempDir("plannotator-config-home-shipped-instructions-");

    const loaded = loadPlannotatorConfig(cwdDir);
    const planning = resolvePhaseProfile(loaded.config, "planning");
    const executing = resolvePhaseProfile(loaded.config, "executing");

    expect(loaded.warnings).toEqual([]);
    expect(planning.instructions).toContain("[PLANNOTATOR - PLANNING PHASE]");
    // The framing is a conversation message, never a system prompt, so the
    // retired composition variable must not appear anywhere.
    expect(planning.instructions).not.toContain("${baseSystemPrompt}");
    expect(executing.instructions).not.toContain("${baseSystemPrompt}");
    // Executing framing supersedes the stale planning rules in history and
    // carries an entry-time todo snapshot.
    expect(executing.instructions).toContain("planning phase is over");
    expect(executing.instructions).toContain("${planFilePath}");
    expect(executing.instructions).toContain("${todoList}");
  });

  test("warns about and ignores the obsolete systemPrompt config key", () => {
    const homeDir = makeTempDir("plannotator-config-home-obsolete-");
    const cwdDir = makeTempDir("plannotator-config-cwd-obsolete-");
    process.env.HOME = homeDir;

    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "plannotator.json"),
      JSON.stringify({
        defaults: { systemPrompt: "OLD DEFAULT" },
        phases: { executing: { systemPrompt: "OLD EXECUTING" } },
      }),
      "utf-8",
    );

    const loaded = loadPlannotatorConfig(cwdDir);
    const executing = resolvePhaseProfile(loaded.config, "executing");

    // The obsolete key is ignored: the shipped instructions still apply.
    expect(executing.instructions).toContain("[PLANNOTATOR - EXECUTING PLAN]");
    expect(executing.instructions).not.toContain("OLD EXECUTING");
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain('obsolete "systemPrompt"');
    expect(loaded.warnings[0]).toContain("defaults, phases.executing");
    expect(loaded.warnings[0]).toContain("instructions");
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
