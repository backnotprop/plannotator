/**
 * Tests for improvement hook reader.
 *
 * Run: bun test packages/shared/improvement-hooks.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We need to override the base dirs used by readImprovementHook.
// Since the module uses homedir() at import time, we mock it via
// a test harness that sets HOME to a temp directory.

const TEST_HOME = join(tmpdir(), `improvement-hooks-test-${Date.now()}`);
const NEW_BASE = join(TEST_HOME, ".plannotator", "hooks");
const LEGACY_BASE = join(TEST_HOME, ".plannotator");
const HOOK_RELATIVE = "compound/enterplanmode-improve-hook.txt";

function setupTestHome() {
  mkdirSync(join(NEW_BASE, "compound"), { recursive: true });
  mkdirSync(join(LEGACY_BASE, "compound"), { recursive: true });
}

function cleanTestHome() {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
}

// Since the module reads homedir() at import time, we need to
// re-import with HOME overridden. Use a helper that spawns a
// small inline script to test each scenario in isolation.
async function runScenario(setup: {
  newPathContent?: string | null;
  legacyPathContent?: string | null;
}): Promise<{ content: string; filePath: string } | null> {
  setupTestHome();

  const newPath = join(NEW_BASE, HOOK_RELATIVE);
  const legacyPath = join(LEGACY_BASE, HOOK_RELATIVE);

  if (setup.newPathContent !== undefined && setup.newPathContent !== null) {
    writeFileSync(newPath, setup.newPathContent);
  }
  if (setup.legacyPathContent !== undefined && setup.legacyPathContent !== null) {
    writeFileSync(legacyPath, setup.legacyPathContent);
  }

  // Run in a subprocess with HOME overridden so homedir() returns TEST_HOME
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
      import { readImprovementHook } from "./packages/shared/improvement-hooks";
      const result = readImprovementHook("enterplanmode-improve");
      console.log(JSON.stringify(result));
    `,
    ],
    {
      // Exercise the fake HOME rather than inheriting the parent test sandbox.
      env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, PLANNOTATOR_DATA_DIR: "" },
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Subprocess failed (exit ${exitCode}): ${stderr}`);
  }

  const parsed = JSON.parse(stdout.trim());
  return parsed;
}

describe("readImprovementHook", () => {
  beforeEach(setupTestHome);
  afterEach(cleanTestHome);

  test("returns content from new path when file exists", async () => {
    const result = await runScenario({
      newPathContent: "Focus on error handling",
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Focus on error handling");
    expect(result!.filePath).toContain(".plannotator/hooks/compound/");
  });

  test("new path wins over legacy path", async () => {
    const result = await runScenario({
      newPathContent: "New instructions",
      legacyPathContent: "Old instructions",
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("New instructions");
    expect(result!.filePath).toContain(".plannotator/hooks/compound/");
  });

  test("falls back to legacy path when new path is absent", async () => {
    const result = await runScenario({
      legacyPathContent: "Legacy instructions",
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Legacy instructions");
    expect(result!.filePath).toContain(".plannotator/compound/");
    expect(result!.filePath).not.toContain(".plannotator/hooks/");
  });

  test("returns null when new path exists but is empty (no legacy fallback)", async () => {
    const result = await runScenario({
      newPathContent: "",
      legacyPathContent: "Legacy instructions",
    });
    expect(result).toBeNull();
  });

  test("returns null when no files exist", async () => {
    const result = await runScenario({});
    expect(result).toBeNull();
  });

  test("returns null when new path is whitespace-only (no legacy fallback)", async () => {
    const result = await runScenario({
      newPathContent: "   \n  \n  ",
      legacyPathContent: "Legacy instructions",
    });
    expect(result).toBeNull();
  });
});
