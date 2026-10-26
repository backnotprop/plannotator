/**
 * The tripwire `gh` (tests/setup/gh-tripwire.ts) is what every test reaches,
 * whichever way it spawns, and a test that reaches it fails.
 *
 * The in-process cases run the tripwire on purpose and take their own calls
 * (takeGhTripwireCalls), so the preload's afterEach check passes here; the
 * last case runs a child `bun test` that does not, and must fail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GH_FAKE_TOKEN, GH_TRIPWIRE_BIN, GH_TRIPWIRE_CONFIG_DIR, takeGhTripwireCalls } from "./setup/gh-tripwire";

const repoRoot = resolve(import.meta.dir, "..");
const posix = process.platform !== "win32";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectOneCall(args: string): void {
  const calls = takeGhTripwireCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith(`gh ${args}`);
}

describe("the tripwire gh", () => {
  test("is the gh on PATH, for Bun.which and for a child's own lookup", () => {
    expect(dirname(Bun.which("gh")!)).toBe(GH_TRIPWIRE_BIN);
    if (posix) expect(dirname(Bun.spawnSync(["sh", "-c", "command -v gh"]).stdout.toString().trim())).toBe(GH_TRIPWIRE_BIN);
  });

  test("answers Bun.spawnSync without env: logs, says so, exits 1, never the real gh", () => {
    const result = Bun.spawnSync(["gh", "api", "user"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("plannotator test tripwire");
    expectOneCall("api user");
  });

  test("answers Bun.spawn without env (the PR runtime's form)", async () => {
    const proc = Bun.spawn(["gh", "pr", "view", "42"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    expectOneCall("pr view 42");
    const options = Bun.spawn({ cmd: ["gh", "auth", "status"], stdout: "pipe", stderr: "pipe" });
    expect(await options.exited).toBe(1);
    expectOneCall("auth status");
  });

  test("answers node's spawnSync, execFileSync and spawn", async () => {
    expect(nodeSpawnSync("gh", ["--version"]).status).toBe(1);
    expectOneCall("--version");
    expect(() => execFileSync("gh", ["repo", "view"], { stdio: "pipe" })).toThrow();
    expectOneCall("repo view");
    const child = nodeSpawn("gh", ["api", "graphql"], { stdio: "ignore" });
    expect(await new Promise((done) => child.on("close", done))).toBe(1);
    expectOneCall("api graphql");
  });

  test("keeps a multi-line argument on one log line", () => {
    if (!posix) return;
    Bun.spawnSync(["gh", "api", "graphql", "-f", "query=\n  query {\n    viewer\n  }\n"]);
    const calls = takeGhTripwireCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^gh api graphql -f query= +query \{ +viewer +\}/);
  });
});

describe("gh's config and tokens", () => {
  test("GH_CONFIG_DIR is an empty scratch folder, never the real one", () => {
    expect(process.env.GH_CONFIG_DIR).toBe(GH_TRIPWIRE_CONFIG_DIR);
    expect(GH_TRIPWIRE_CONFIG_DIR.startsWith(resolve(tmpdir())) || GH_TRIPWIRE_CONFIG_DIR.startsWith("/private/")).toBe(true);
    expect(readdirSync(GH_TRIPWIRE_CONFIG_DIR)).toEqual([]);
  });

  test("only the fake token reaches this process or a child spawned without env", () => {
    // GH_TOKEN / GH_ENTERPRISE_TOKEN hold a fake, so gh never falls back to the
    // keyring; GITHUB_TOKEN / GITHUB_ENTERPRISE_TOKEN are unset.
    expect(process.env.GH_TOKEN).toBe(GH_FAKE_TOKEN);
    expect(process.env.GH_ENTERPRISE_TOKEN).toBe(GH_FAKE_TOKEN);
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(process.env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    if (!posix) return;
    const out = Bun.spawnSync(["sh", "-c", 'echo "${GH_TOKEN-unset} ${GH_ENTERPRISE_TOKEN-unset} ${GITHUB_TOKEN-unset} ${GITHUB_ENTERPRISE_TOKEN-unset} $GH_CONFIG_DIR"']);
    expect(out.stdout.toString().trim()).toBe(`${GH_FAKE_TOKEN} ${GH_FAKE_TOKEN} unset unset ${GH_TRIPWIRE_CONFIG_DIR}`);
  });
});

describe("a test that runs gh fails", () => {
  test("a child bun test whose test reaches gh fails, naming the test and the command", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-gh-tripwire-fixture-"));
    tempDirs.push(dir);
    const fixture = join(dir, "runs-gh.test.ts");
    writeFileSync(
      fixture,
      [
        'import { test } from "bun:test";',
        'test("asks gh who the user is", () => { Bun.spawnSync(["gh", "api", "user", "--jq", ".login"]); });',
        'test("runs nothing", () => {});',
        "",
      ].join("\n"),
    );
    const result = Bun.spawnSync([process.execPath, "test", fixture], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("plannotator test tripwire");
    expect(output).toContain("gh api user --jq .login");
    expect(output).toMatch(/\(fail\) asks gh who the user is/);
    expect(output).toMatch(/\b1 pass\b[\s\S]*\b1 fail\b/);
    // The child's tripwire is its own: nothing reached this run's log.
    expect(takeGhTripwireCalls()).toEqual([]);
  });
});
