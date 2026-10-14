/**
 * No test or script may set PLANNOTATOR_BROWSER to a no-op sentinel.
 *
 * packages/server/browser.ts reads `none`, `true`, `false`, `:`, `0` and `1`
 * as "no browser configured" on purpose (#756: Claude Code's agent view sets
 * BROWSER=true and Plannotator must still open its window there), so a session
 * started with PLANNOTATOR_BROWSER=none falls through to the system default
 * and opens a real tab on the developer's screen. Tests set NO_BROWSER from
 * tests/helpers/no-browser.ts instead: a program that exits at once.
 *
 * Also checked here: NO_BROWSER itself is an executable that opens nothing,
 * and the bun test preload gives every test that value.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isNoOpBrowserSentinel } from "../packages/server/browser";
import { NO_BROWSER } from "./helpers/no-browser";
import { SENTINEL_UNDER_TEST_MARK, sentinelBrowserFindings } from "./helpers/no-browser-scan";

const repoRoot = resolve(import.meta.dir, "..");

/** Folders never scanned: dependencies, build output, git metadata and worktrees, the pre-monorepo reference code. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".claude", ".local", "legacy", "coverage", "playwright-report", "test-results"]);

/**
 * A file a test run or a dev reads its environment from: a *.test / *.spec
 * file anywhere, any source or shell/PowerShell script under tests/ or
 * scripts/ or a testing/ folder, a package.json (its scripts), and the CI
 * workflows.
 */
function isGuarded(rel: string): boolean {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) return true;
  if (/(?:^|\/)package\.json$/.test(rel)) return true;
  if (/\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs)$/.test(rel)) return true;
  if (!/\.(?:ts|tsx|mts|js|mjs|cjs|sh|bash|ps1|cmd)$/.test(rel)) return false;
  return /^(?:tests|scripts)\//.test(rel) || /(?:^|\/)(?:testing|test-setup|test-fixtures)\//.test(rel);
}

function sources(dir = repoRoot, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relative(repoRoot, join(dir, entry.name)).split("\\").join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Dot folders are skipped, except the workflows CI runs.
      if (entry.name.startsWith(".") && rel !== ".github" && rel !== ".github/workflows") continue;
      sources(join(dir, entry.name), found);
    } else if (entry.isFile() && isGuarded(rel)) {
      found.push(rel);
    }
  }
  return found;
}

/** The scan's own module and this file hold its fixtures. */
const SCANNER_FILES = new Set(["tests/helpers/no-browser-scan.ts", "tests/no-browser-sentinel.test.ts"]);

describe("PLANNOTATOR_BROWSER in tests and scripts", () => {
  const files = sources();

  test("finds the files it guards", () => {
    // Sentinels: if the walk stops reaching these, the scan proves nothing.
    for (const known of ["tests/helpers/inbox-world.ts", "tests/e2e/inbox-order.spec.ts", "tests/e2e/playwright.config.ts", "apps/hook/server/annotate-cli.test.ts", "scripts/dast/target.ts", "tests/manual/local/test-sessions.sh", ".github/workflows/test.yml", "package.json"]) {
      expect(files).toContain(known);
    }
  });

  test("no test or script sets PLANNOTATOR_BROWSER (or --browser) to a no-op sentinel", () => {
    const findings = files
      .filter((file) => !SCANNER_FILES.has(file))
      .flatMap((file) => sentinelBrowserFindings(readFileSync(join(repoRoot, file), "utf8"), file).map((finding) => `${file}:${finding}`));
    // A sentinel (none, true, false, 0, 1, :) is read as "unset" by
    // packages/server/browser.ts (#756), which then opens the SYSTEM DEFAULT
    // browser: real tabs on the developer's screen. Use NO_BROWSER from
    // tests/helpers/no-browser.ts. A line that tests the sentinel handling
    // itself, in process, may carry `${SENTINEL_UNDER_TEST_MARK}`.
    expect(findings).toEqual([]);
  });

  test("the scan catches what it is for (fixtures in memory)", () => {
    const one = (source: string, file?: string) => sentinelBrowserFindings(source, file);
    // TypeScript.
    expect(one("const env = { PLANNOTATOR_BROWSER: 'none' };")).toHaveLength(1);
    expect(one('const env = { PLANNOTATOR_BROWSER: "None" };')).toHaveLength(1);
    expect(one('const env = { PLANNOTATOR_BROWSER: " true " };')).toHaveLength(1);
    expect(one('const env = { "PLANNOTATOR_BROWSER": "0" };')).toHaveLength(1);
    expect(one("const env = { PLANNOTATOR_BROWSER: `:` };")).toHaveLength(1);
    expect(one('process.env.PLANNOTATOR_BROWSER = "false";')).toHaveLength(1);
    expect(one('process.env["PLANNOTATOR_BROWSER"] = "1";')).toHaveLength(1);
    expect(one('spawn(bin, ["plan", "--browser", "none"]);')).toHaveLength(1);
    expect(one("execSync(`PLANNOTATOR_BROWSER=none ${bin} review`);")).toHaveLength(1);
    // Shell, YAML, PowerShell.
    expect(one("PLANNOTATOR_BROWSER=none plannotator review\n", "x.sh")).toHaveLength(1);
    expect(one("export PLANNOTATOR_BROWSER=true\n", "x.sh")).toHaveLength(1);
    expect(one("plannotator review --browser=none\n", "x.sh")).toHaveLength(1);
    expect(one("        env:\n          PLANNOTATOR_BROWSER: none\n", "x.yml")).toHaveLength(1);
    expect(one('$env:PLANNOTATOR_BROWSER = "none"\n', "x.ps1")).toHaveLength(1);
    expect(one('{ "scripts": { "e2e": "PLANNOTATOR_BROWSER=none playwright test" } }', "package.json")).toHaveLength(1);
    // Not sentinels, or not a setting.
    expect(one("const env = { PLANNOTATOR_BROWSER: NO_BROWSER };")).toEqual([]);
    expect(one("const env = { PLANNOTATOR_BROWSER: '/usr/bin/true' };")).toEqual([]);
    expect(one("const env = { PLANNOTATOR_BROWSER: 'nonexistent-browser' };")).toEqual([]);
    expect(one("const env = { PLANNOTATOR_BROWSER: '10' };")).toEqual([]);
    expect(one("PLANNOTATOR_BROWSER=/usr/bin/true plannotator\n", "x.sh")).toEqual([]);
    expect(one('if (process.env.PLANNOTATOR_BROWSER === "none") skip();')).toEqual([]);
    expect(one('expect(process.env.PLANNOTATOR_BROWSER !== "none").toBe(true);')).toEqual([]);
    expect(one("// never PLANNOTATOR_BROWSER: 'none', it opens a real tab")).toEqual([]);
    expect(one("# never PLANNOTATOR_BROWSER=none\n", "x.sh")).toEqual([]);
    expect(one(`// ${SENTINEL_UNDER_TEST_MARK}\nprocess.env.PLANNOTATOR_BROWSER = "none";`)).toEqual([]);
  });

  test("every value the scan matches is one browser.ts reads as unset", () => {
    for (const value of ["none", "None", " true ", "false", "0", "1", ":"]) {
      expect(isNoOpBrowserSentinel(value)).toBe(true);
    }
    // If browser.ts gains a sentinel, add it to tests/helpers/no-browser-scan.ts too.
    expect(isNoOpBrowserSentinel(NO_BROWSER)).toBe(false);
  });
});

describe("NO_BROWSER", () => {
  test("is an absolute path to a program that exits 0 with a URL argument", () => {
    expect(NO_BROWSER === resolve(NO_BROWSER)).toBe(true);
    const run = spawnSync(NO_BROWSER, ["http://127.0.0.1:9/never-opened"], { encoding: "utf8", timeout: 10_000 });
    // whoami.exe on Windows refuses the argument (cmd.exe's `start` still returns 0).
    if (process.platform !== "win32") expect(run.status).toBe(0);
    expect(run.error).toBeUndefined();
  });

  test("is not a path openBrowser would hand to `open -a` on macOS (no .app, has a slash)", () => {
    expect(NO_BROWSER.endsWith(".app")).toBe(false);
    expect(NO_BROWSER.includes("/") || NO_BROWSER.includes("\\")).toBe(true);
  });

  test("is what the bun test preload sets, so every test and every child that inherits the env opens no browser", () => {
    // tests/setup/feedback-archive-off.ts. A test of the browser launch may
    // change it in its body, but must restore it before the next test.
    expect(process.env.PLANNOTATOR_BROWSER).toBe(NO_BROWSER);
  });
});
