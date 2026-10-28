/**
 * Every child process the Plannotator runtimes start gets the LIVE
 * environment, never Bun's startup environment.
 *
 * On Bun, `Bun.spawn`, `Bun.spawnSync` and node:child_process's synchronous
 * calls give a child the environment the process started with when `env` is
 * missing or undefined, so the variables the CLI scrubs at startup (the pull
 * bridge token, the host result and messages files, the review id) would
 * still reach git, gh and agent CLIs. `Bun.which` without `{ PATH }` searches
 * the startup PATH. This scan fails on either in the production trees; the
 * fix is `env: childEnv()` (packages/shared/child-env.ts) or `{ PATH:
 * childPath() }`. apps/hook/server/scrubbed-env-cli.test.ts proves the
 * behavior end to end on the real CLI.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CHILD_ENV_EXEMPT_MARK, childEnvFindings } from "./helpers/child-env-scan";

const repoRoot = resolve(import.meta.dir, "..");

/** Code that runs inside a Plannotator process (the Bun CLI and servers, and the plugins that host or vendor them). */
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

describe("child processes get the live environment", () => {
  test("no Bun or synchronous spawn without env, and no Bun.which without PATH, in the production trees", () => {
    const files = PRODUCTION_TREES.flatMap((tree) => sources(join(repoRoot, tree)));
    expect(files.length).toBeGreaterThan(200);
    const findings: string[] = [];
    for (const file of files) {
      for (const finding of childEnvFindings(readFileSync(file, "utf8"))) {
        findings.push(`${relative(repoRoot, file)}:${finding}`);
      }
    }
    expect(findings).toEqual([]);
  });
});

describe("the scan", () => {
  const flagged = (source: string) => childEnvFindings(source).length;

  test("flags a Bun spawn with no env, in either form", () => {
    expect(flagged(`Bun.spawn(["git", "status"], { cwd, stdout: "pipe" });`)).toBe(1);
    expect(flagged(`Bun.spawn({ cmd: ["git"], stdout: "pipe" });`)).toBe(1);
    expect(flagged(`Bun.spawnSync(["rm", "-rf", dir]);`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { env: undefined });`)).toBe(1);
  });

  test("flags an env that is an optional field", () => {
    expect(flagged(`Bun.spawn(["git"], { env: command.env });`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { env: opts?.env });`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { env: command.env ?? childEnv() });`)).toBe(0);
  });

  test("flags node's synchronous calls, however they are imported, but not the async ones", () => {
    expect(flagged(`import { spawnSync } from "node:child_process";\nspawnSync("git", ["status"], { cwd });`)).toBe(1);
    expect(flagged(`import { execFileSync as run } from "child_process";\nrun("git", ["log"]);`)).toBe(1);
    expect(flagged(`import { execSync } from "node:child_process";\nexecSync("git config user.name", { cwd });`)).toBe(1);
    expect(flagged(`import * as cp from "node:child_process";\ncp.spawnSync("ps", []);`)).toBe(1);
    expect(flagged(`const { spawnSync } = require("child_process");\nspawnSync("ps");`)).toBe(1);
    expect(flagged(`import { spawn, execFile } from "node:child_process";\nspawn("git", []);\nexecFile("git", []);`)).toBe(0);
  });

  test("passes a spawn that names its env", () => {
    expect(flagged(`Bun.spawn(["git"], { cwd, env: childEnv() });`)).toBe(0);
    expect(flagged(`Bun.spawn(["git"], { env: { ...process.env, A: "1" } });`)).toBe(0);
    expect(flagged(`Bun.spawn(["git"], { env });`)).toBe(0);
    expect(flagged(`import { spawnSync } from "node:child_process";\nspawnSync("git", args, { env: process.env });`)).toBe(0);
  });

  test("flags options it cannot read", () => {
    expect(flagged(`Bun.spawn(["git"], options);`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { ...options, stdout: "pipe" });`)).toBe(1);
    // A spread after env may replace it; one before it cannot.
    expect(flagged(`Bun.spawn(["git"], { env: childEnv(), ...options });`)).toBe(1);
    expect(flagged(`Bun.spawn(["git"], { ...options, env: childEnv() });`)).toBe(0);
  });

  test("flags a Bun.which whose options name no PATH", () => {
    expect(flagged(`const p = Bun.which("node");`)).toBe(1);
    expect(flagged(`const p = Bun.which("node", { PATH: childPath() });`)).toBe(0);
    // The options must name PATH: a cwd alone, a variable, or a spread after PATH do not.
    expect(flagged(`const p = Bun.which("node", { cwd });`)).toBe(1);
    expect(flagged(`const p = Bun.which("node", options);`)).toBe(1);
    expect(flagged(`const p = Bun.which("node", { PATH: childPath(), ...options });`)).toBe(1);
  });

  test("ignores comments and honors the exemption mark", () => {
    expect(flagged(`// Bun.spawn(["git"], {});\n/* Bun.which("x") */`)).toBe(0);
    expect(flagged(`// ${CHILD_ENV_EXEMPT_MARK} only the test's own stub\nBun.spawn(["git"], { cwd });`)).toBe(0);
  });
});
