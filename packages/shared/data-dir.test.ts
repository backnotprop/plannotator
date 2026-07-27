import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun resolves homedir() from the environment captured at process start, so
// mutating process.env.HOME inside this test process has no effect. Each case
// therefore runs the resolver in a subprocess with a fully controlled
// environment (fake HOME, explicit PLANNOTATOR_DATA_DIR / XDG_DATA_HOME).
const MODULE_PATH = join(import.meta.dir, "data-dir.ts");

let fakeHome = "";

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "plannotator-data-dir-home-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function resolveDataDir(env: Record<string, string>): string {
  const script = `console.log(require(${JSON.stringify(MODULE_PATH)}).getPlannotatorDataDir());`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    env: { PATH: process.env.PATH ?? "", HOME: fakeHome, ...env },
  });
  if (result.exitCode !== 0) {
    throw new Error(`resolver subprocess failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

describe("getPlannotatorDataDir", () => {
  test("PLANNOTATOR_DATA_DIR wins over the legacy directory and XDG_DATA_HOME", () => {
    mkdirSync(join(fakeHome, ".plannotator"));

    const dir = resolveDataDir({
      PLANNOTATOR_DATA_DIR: join(fakeHome, "custom-data"),
      XDG_DATA_HOME: join(fakeHome, "xdg-data"),
    });

    expect(dir).toBe(join(fakeHome, "custom-data"));
  });

  test("PLANNOTATOR_DATA_DIR expands a leading ~", () => {
    const dir = resolveDataDir({ PLANNOTATOR_DATA_DIR: "~/relocated" });

    expect(dir).toBe(join(fakeHome, "relocated"));
  });

  test("an existing ~/.plannotator wins over XDG_DATA_HOME", () => {
    mkdirSync(join(fakeHome, ".plannotator"));

    const dir = resolveDataDir({ XDG_DATA_HOME: join(fakeHome, "xdg-data") });

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });

  test("XDG_DATA_HOME applies when set and ~/.plannotator does not exist", () => {
    const dir = resolveDataDir({ XDG_DATA_HOME: join(fakeHome, "xdg-data") });

    expect(dir).toBe(join(fakeHome, "xdg-data", "plannotator"));
  });

  test("a relative XDG_DATA_HOME is ignored", () => {
    const dir = resolveDataDir({ XDG_DATA_HOME: "relative/xdg-data" });

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });

  test("an empty XDG_DATA_HOME is ignored", () => {
    const dir = resolveDataDir({ XDG_DATA_HOME: "  " });

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });

  test("defaults to ~/.plannotator when nothing is set", () => {
    const dir = resolveDataDir({});

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });
});
