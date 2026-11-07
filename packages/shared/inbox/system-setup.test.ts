/**
 * setup.json on disk. What regresses: a project key that climbs out of `<data dir>/system/` (a write lands
 * elsewhere), a folder made before (by another tool, with a wider mode) left readable by others, or a failed
 * write leaving its temp file beside setup.json.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemSetup } from "@plannotator/core/inbox-system-setup";
import { systemProjectDir, systemSetupPath, writeSystemSetup } from "./system-setup";

let root = "";
let dataDir = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "system-setup-store-"));
  dataDir = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SETUP: SystemSetup = { v: 1, repos: [], docs: [], agent: "claude", model: null, thread_message: null };

test("a key that is not one folder name under system/ is refused, and nothing is written", () => {
  for (const key of ["..", ".", "../escape", "a/b", "a\\b", "", "../../etc"]) {
    expect(() => systemProjectDir(dataDir, key)).toThrow();
    expect(() => systemSetupPath(dataDir, key)).toThrow();
    expect(() => writeSystemSetup(dataDir, key, SETUP)).toThrow();
  }
  // Nothing beside the data dir, nor under it.
  expect(readdirSync(root)).toEqual([]);
  expect(systemProjectDir(dataDir, "app-abc123")).toBe(join(dataDir, "system", "app-abc123"));
});

test("a project folder made before with a wider mode is made private on save", () => {
  const dir = join(dataDir, "system", "app-abc123");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  writeSystemSetup(dataDir, "app-abc123", SETUP);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "setup.json")).mode & 0o777).toBe(0o600);
});

test("a write that fails leaves no temp file behind", () => {
  const dir = join(dataDir, "system", "app-abc123");
  // setup.json is a folder with something in it: the rename over it fails.
  mkdirSync(join(dir, "setup.json"), { recursive: true });
  writeFileSync(join(dir, "setup.json", "keep"), "");
  expect(() => writeSystemSetup(dataDir, "app-abc123", SETUP)).toThrow();
  expect(readdirSync(dir)).toEqual(["setup.json"]);
  expect(existsSync(join(dir, "setup.json", "keep"))).toBe(true);
});
