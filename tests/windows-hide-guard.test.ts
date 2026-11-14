/**
 * No child process the Plannotator runtimes start opens a console window on
 * Windows.
 *
 * The Inbox runs in the background with no console of its own, so every
 * console program it starts (gh and glab for pull request cards and states,
 * git, tailscale, agent CLIs, PowerShell) opened a console window for as long
 * as it ran: a window flashing open every few minutes. `windowsHide: true`
 * stops that; Bun and Node both default it to false, and Bun Shell (`$`) has
 * no such option. This scan fails on a spawn without it in the production
 * trees. A call that starts an app window on purpose, or that only runs on
 * macOS or POSIX, carries a `windows-hide-guard: <why>` comment instead.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WINDOWS_HIDE_EXEMPT_MARK, windowsHideFindings } from "./helpers/windows-hide-scan";

const repoRoot = resolve(import.meta.dir, "..");

/** Code that runs inside a Plannotator process (the same trees as tests/child-env-guard.test.ts). */
const PRODUCTION_TREES = [
  "apps/hook/server",
  "apps/hook/hooks",
  "packages/server",
  "packages/shared",
  "packages/ai",
  "packages/t3-code",
  "apps/opencode-plugin",
  "apps/amp-plugin",
  "apps/pi-extension",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "generated", "fixtures", "testing", "test-setup", "test-fixtures", "tests", "test"]);

function isProductionSource(name: string): boolean {
  if (!/\.(?:ts|tsx|mts|js|mjs)$/.test(name) || name.endsWith(".d.ts")) return false;
  return !/\.(?:test|spec|scenarios|typecheck)\.(?:ts|tsx|mts|js|mjs)$/.test(name);
}

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      sources(join(dir, entry.name), found);
    } else if (entry.isFile() && isProductionSource(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

describe("child processes open no console window on Windows", () => {
  test("every Bun or node:child_process spawn in the production trees passes windowsHide: true", () => {
    const files = PRODUCTION_TREES.flatMap((tree) => sources(join(repoRoot, tree)));
    expect(files.length).toBeGreaterThan(200);
    const findings: string[] = [];
    for (const file of files) {
      for (const finding of windowsHideFindings(readFileSync(file, "utf8"))) {
        findings.push(`${relative(repoRoot, file)}:${finding}`);
      }
    }
    expect(findings).toEqual([]);
  });
});

describe("the scan", () => {
  const flagged = (source: string) => windowsHideFindings(source).length;

  test("flags a Bun spawn without windowsHide: true, in either form", () => {
    expect(flagged(`Bun.spawn(["gh", "pr", "view"], { env: childEnv(), stdout: "pipe" });`)).toBe(1);
    expect(flagged(`Bun.spawn({ cmd: ["git"], env: childEnv() });`)).toBe(1);
    expect(flagged(`Bun.spawnSync(["git", "status"]);`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { env: childEnv(), windowsHide: false });`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { env: childEnv(), windowsHide: true });`)).toBe(0);
    expect(flagged(`Bun.spawn({ cmd: ["git"], windowsHide: true });`)).toBe(0);
  });

  test("flags every node:child_process call that starts a process, however it is imported", () => {
    expect(flagged(`import { spawn } from "node:child_process";\nspawn("glab", args, { stdio: "pipe" });`)).toBe(1);
    expect(flagged(`import { execFile as run } from "child_process";\nrun("git", ["log"], (err) => {});`)).toBe(1);
    expect(flagged(`import { execSync } from "node:child_process";\nexecSync("git config user.name");`)).toBe(1);
    expect(flagged(`import * as cp from "node:child_process";\ncp.spawnSync("tailscale", []);`)).toBe(1);
    expect(flagged(`const { spawn } = require("child_process");\nspawn("gh");`)).toBe(1);
    expect(flagged(`import { spawn } from "node:child_process";\nspawn("gh", [], { windowsHide: true });`)).toBe(0);
  });

  test("flags Bun Shell, which cannot hide a window", () => {
    expect(flagged('import { $ } from "bun";\nawait $`git rev-parse --show-toplevel`.quiet();')).toBe(1);
    expect(flagged("await Bun.$`git status`;")).toBe(1);
  });

  test("reads spreads: one that may replace windowsHide is a finding, inline literals without it are not", () => {
    expect(flagged(`Bun.spawn(["git"], { windowsHide: true, ...options });`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], options);`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { ...options, windowsHide: true });`)).toBe(0);
    expect(flagged(`Bun.spawn(["git"], { windowsHide: true, ...(cwd ? { cwd } : {}) });`)).toBe(0);
    expect(flagged(`Bun.spawn(["git"], { windowsHide: true, ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}) });`)).toBe(0);
    expect(flagged(`Bun.spawn(["git"], { windowsHide: true, ...(opts?.cwd && { cwd: opts.cwd }) });`)).toBe(0);
    expect(flagged(`Bun.spawn(["git"], { windowsHide: true, ...(hide ? { windowsHide: false } : {}) });`)).toBe(1);
  });

  test("ignores comments and declarations, and honors the exemption mark", () => {
    expect(flagged(`// Bun.spawn(["git"], {});\n/* spawn("gh") */`)).toBe(0);
    expect(flagged(`import { spawn } from "node:child_process";\nclass Rpc {\n  async spawn(path: string) {}\n}`)).toBe(0);
    expect(flagged(`// ${WINDOWS_HIDE_EXEMPT_MARK} macOS only\nBun.spawn(["/usr/bin/osascript"], { env });`)).toBe(0);
  });
});
