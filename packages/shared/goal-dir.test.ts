import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureGoalDir, resolveGoalsRoot, validateGoalSlug } from "./goal-dir";

const cwd = resolve("/work/project");
const home = resolve("/home/person");
const at = (config: { goalsDir?: unknown }, env: Record<string, string | undefined> = {}) =>
  resolveGoalsRoot(config as never, { env, cwd, home });

describe("resolveGoalsRoot precedence", () => {
  test("defaults to goals under the working directory", () => {
    expect(at({})).toBe(join(cwd, "goals"));
  });

  test("config.goalsDir beats the default", () => {
    expect(at({ goalsDir: "plans/goals" })).toBe(join(cwd, "plans/goals"));
  });

  test("PLANNOTATOR_GOALS_DIR beats config.goalsDir", () => {
    expect(at({ goalsDir: "from-config" }, { PLANNOTATOR_GOALS_DIR: "from-env" })).toBe(join(cwd, "from-env"));
  });

  test("an empty env var or blank config value decides nothing", () => {
    expect(at({ goalsDir: "from-config" }, { PLANNOTATOR_GOALS_DIR: "  " })).toBe(join(cwd, "from-config"));
    expect(at({ goalsDir: "   " })).toBe(join(cwd, "goals"));
    expect(at({ goalsDir: 42 })).toBe(join(cwd, "goals"));
  });
});

describe("resolveGoalsRoot path forms", () => {
  test("an absolute path is kept", () => {
    expect(at({}, { PLANNOTATOR_GOALS_DIR: resolve("/srv/goals") })).toBe(resolve("/srv/goals"));
  });

  test("~ and ~/x expand to the home directory", () => {
    expect(at({ goalsDir: "~" })).toBe(home);
    expect(at({ goalsDir: "~/notes/goals" })).toBe(join(home, "notes/goals"));
    expect(at({}, { PLANNOTATOR_GOALS_DIR: "~/g" })).toBe(join(home, "g"));
  });

  test("~name is a relative folder, not another user's home", () => {
    expect(at({ goalsDir: "~other/goals" })).toBe(join(cwd, "~other/goals"));
  });
});

describe("validateGoalSlug", () => {
  test("accepts plain slugs", () => {
    for (const slug of ["fix-login", "a", "v1.2_final"]) {
      expect(validateGoalSlug(slug)).toBeNull();
    }
  });

  test("rejects empty, separators, and dot segments", () => {
    for (const slug of ["", "   ", "a/b", "a\\b", "..", ".", "../x", "x/.."]) {
      expect(validateGoalSlug(slug)).toBeString();
    }
  });
});

describe("ensureGoalDir", () => {
  test("creates <root>/<slug> and returns its absolute path", () => {
    const base = mkdtempSync(join(tmpdir(), "plannotator-goal-dir-"));
    try {
      const out = ensureGoalDir("my-goal", {
        config: { goalsDir: "nested/goals" },
        env: {},
        cwd: base,
        home,
      });
      expect(out).toBe(join(base, "nested/goals/my-goal"));
      expect(statSync(out).isDirectory()).toBe(true);
      // Idempotent: a second call on an existing folder succeeds.
      expect(ensureGoalDir("my-goal", { config: { goalsDir: "nested/goals" }, env: {}, cwd: base, home })).toBe(out);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an invalid slug throws and creates nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "plannotator-goal-dir-"));
    try {
      expect(() => ensureGoalDir("../escape", { config: {}, env: {}, cwd: base, home })).toThrow();
      expect(existsSync(join(base, "goals"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
