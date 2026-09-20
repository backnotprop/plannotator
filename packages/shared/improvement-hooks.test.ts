/**
 * Tests for improvement hook reader.
 *
 * Run: bun test packages/shared/improvement-hooks.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// Imported statically and BEFORE any PLANNOTATOR_DATA_DIR is set: the module's
// import-time side effects used to freeze the data directory, so a later env
// change was silently ignored and every read kept hitting the old location.
import { getImprovementHookExpectedPath, readImprovementHook } from "./improvement-hooks";

import { createTestEnvironment } from "../../tests/helpers/environment";

const env = createTestEnvironment(["PLANNOTATOR_DATA_DIR"], "plannotator-improvement-hooks-");

const HOOK_RELATIVE = "compound/enterplanmode-improve-hook.txt";

let dataDir = "";

function writeHook(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

beforeEach(() => {
  env.reset();
  dataDir = env.makeTempDir();
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => env.restore());

describe("readImprovementHook", () => {
  test("returns content from new path when file exists", () => {
    const newPath = join(dataDir, "hooks", HOOK_RELATIVE);
    writeHook(newPath, "Focus on error handling");

    const result = readImprovementHook("enterplanmode-improve");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Focus on error handling");
    expect(result!.filePath).toBe(newPath);
  });

  test("new path wins over legacy path", () => {
    writeHook(join(dataDir, "hooks", HOOK_RELATIVE), "New instructions");
    writeHook(join(dataDir, HOOK_RELATIVE), "Old instructions");

    const result = readImprovementHook("enterplanmode-improve");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("New instructions");
    expect(result!.filePath).toBe(join(dataDir, "hooks", HOOK_RELATIVE));
  });

  test("falls back to legacy path when new path is absent", () => {
    const legacyPath = join(dataDir, HOOK_RELATIVE);
    writeHook(legacyPath, "Legacy instructions");

    const result = readImprovementHook("enterplanmode-improve");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Legacy instructions");
    expect(result!.filePath).toBe(legacyPath);
  });

  test("returns null when new path exists but is empty (no legacy fallback)", () => {
    writeHook(join(dataDir, "hooks", HOOK_RELATIVE), "");
    writeHook(join(dataDir, HOOK_RELATIVE), "Legacy instructions");

    expect(readImprovementHook("enterplanmode-improve")).toBeNull();
  });

  test("returns null when no files exist", () => {
    expect(readImprovementHook("enterplanmode-improve")).toBeNull();
  });

  test("returns null when new path is whitespace-only (no legacy fallback)", () => {
    writeHook(join(dataDir, "hooks", HOOK_RELATIVE), "   \n  \n  ");
    writeHook(join(dataDir, HOOK_RELATIVE), "Legacy instructions");

    expect(readImprovementHook("enterplanmode-improve")).toBeNull();
  });
});

describe("data directory resolution", () => {
  test("resolves PLANNOTATOR_DATA_DIR set after import", () => {
    expect(getImprovementHookExpectedPath("enterplanmode-improve")).toBe(
      join(dataDir, "hooks", HOOK_RELATIVE),
    );
  });

  test("follows a later change to PLANNOTATOR_DATA_DIR", () => {
    expect(getImprovementHookExpectedPath("enterplanmode-improve")).toBe(
      join(dataDir, "hooks", HOOK_RELATIVE),
    );

    const second = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = second;
    const secondHook = join(second, "hooks", HOOK_RELATIVE);
    writeHook(secondHook, "Second location");

    expect(getImprovementHookExpectedPath("enterplanmode-improve")).toBe(secondHook);
    expect(readImprovementHook("enterplanmode-improve")!.filePath).toBe(secondHook);
  });
});
