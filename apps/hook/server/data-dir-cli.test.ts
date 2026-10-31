/**
 * `plannotator data-dir` (#2305): skills ask it for the data directory
 * instead of naming ~/.plannotator. Guards that it prints the folder the
 * runtime really uses (the XDG one on an XDG install, also past a stray
 * ~/.plannotator), creates nothing, and keeps stdout to the bare path an
 * agent can use.
 *
 * Every run gets a temp HOME and XDG_DATA_HOME and no inherited
 * PLANNOTATOR_DATA_DIR, so the real data dir is never resolved.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
let stubs: string[] = [];
beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});

let root = "";
let home = "";
let xdg = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-data-dir-cli-"));
  home = join(root, "home");
  xdg = join(root, "xdg-data");
  mkdirSync(home);
  mkdirSync(xdg);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dataDir(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, "run", entry, "data-dir", ...args], {
    cwd: root,
    stdin: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: xdg,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_UPDATE_CHECK: "0",
      ...extraEnv,
    },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("on an XDG install it prints the XDG folder and creates no ~/.plannotator", () => {
  mkdirSync(join(xdg, "plannotator", "history"), { recursive: true });

  const out = dataDir();

  expect(out.code).toBe(0);
  expect(out.stdout).toBe(`${join(xdg, "plannotator")}\n`);
  expect(existsSync(join(home, ".plannotator"))).toBe(false);
  expect(readdirSync(join(xdg, "plannotator"))).toEqual(["history"]);
}, 30_000);

test("before anything exists it names the folder Plannotator will use, and creates neither", () => {
  const out = dataDir();

  expect(out.code).toBe(0);
  expect(out.stdout.trim()).toBe(join(xdg, "plannotator"));
  expect(existsSync(join(home, ".plannotator"))).toBe(false);
  expect(readdirSync(xdg)).toEqual([]);
}, 30_000);

test("past a stray ~/.plannotator it prints the XDG folder and names the stray one on stderr", () => {
  mkdirSync(join(xdg, "plannotator", "sessions"), { recursive: true });
  mkdirSync(join(home, ".plannotator", "hooks", "compound"), { recursive: true });
  writeFileSync(join(home, ".plannotator", "hooks", "compound", "enterplanmode-improve-hook.txt"), "1. x\n");

  const out = dataDir();

  expect(out.code).toBe(0);
  expect(out.stdout.trim()).toBe(join(xdg, "plannotator"));
  expect(out.stderr).toContain(join(home, ".plannotator"));
  // Pinned on purpose (#2411 review): the note must tell an agent to leave
  // the other folder alone, since it may hold the person's older data.
  expect(out.stderr).toContain("leave it alone");
}, 30_000);

test("PLANNOTATOR_DATA_DIR wins", () => {
  const custom = join(root, "custom");

  const out = dataDir([], { PLANNOTATOR_DATA_DIR: custom });

  expect(out.stdout.trim()).toBe(custom);
  expect(out.stderr).toBe("");
}, 30_000);

test("--help prints usage without resolving, and an extra argument is a usage error", () => {
  const help = dataDir(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("plannotator data-dir");

  const bad = dataDir(["plans"]);
  expect(bad.code).toBe(2);
  expect(bad.stdout).toBe("");
}, 30_000);
