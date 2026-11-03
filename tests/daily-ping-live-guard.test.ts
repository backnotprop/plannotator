/**
 * No test reaches the live daily ping (packages/shared/daily-ping.ts).
 *
 * Three guards:
 *  - the root: only a build release CI marks (`__PLANNOTATOR_RELEASE__`) may
 *    reach the live host, so a child a test spawns with a release
 *    `__CLI_VERSION__` and a replaced environment (no sandbox, no off switch)
 *    still has nowhere to send. No test file may make a marked build;
 *  - the preload turns the ping off for every test and every child that
 *    inherits its environment;
 *  - a test or e2e file that spawns with a release version, or runs the e2e
 *    release binary, must also name NO_ANON_PING or PLANNOTATOR_TEST_SANDBOX.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DAILY_PING_URL } from "../packages/shared/daily-ping";

const repoRoot = resolve(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".wrangler", ".claude", ".turbo"]);
const SELF = relative(repoRoot, import.meta.path);

/** Test files: *.test.*, *.spec.*, and everything under a tests/ or test/ folder. */
function testFiles(dir: string, inTests = false): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return testFiles(full, inTests || name === "tests" || name === "test");
    if (!/\.(?:[cm]?[jt]sx?)$/.test(name)) return [];
    return inTests || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ? [full] : [];
  });
}

const files = () => [...testFiles(join(repoRoot, "apps")), ...testFiles(join(repoRoot, "packages")), ...testFiles(join(repoRoot, "tests"), true), ...testFiles(join(repoRoot, "scripts"))];

/** A child with a release version and the bare environment some tests hand their spawns. */
async function probe(defineRelease: boolean): Promise<{ off: string | null; endpoint: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-ping-guard-"));
  try {
    const script = join(dir, "probe.ts");
    writeFileSync(
      script,
      `import { dailyPingEndpoint, dailyPingOff } from ${JSON.stringify(join(repoRoot, "packages/shared/daily-ping.ts"))};
process.stdout.write(JSON.stringify({ off: dailyPingOff({ version: "0.28.10" }), endpoint: dailyPingEndpoint("0.28.10") }));`,
    );
    const args = ["--define", '__CLI_VERSION__="0.28.10"', ...(defineRelease ? ["--define", "__PLANNOTATOR_RELEASE__=true"] : []), script];
    const child = Bun.spawn([process.execPath, ...args], { env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, PLANNOTATOR_DATA_DIR: join(dir, "data") }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the live daily ping is out of reach of tests", () => {
  test("a child with a release version and a replaced environment has nowhere to send", async () => {
    expect(await probe(false)).toEqual({ off: "dev", endpoint: null });
    // The control: the same child in a build release CI marked would send live. Nothing is sent here.
    expect((await probe(true)).endpoint).toBe(DAILY_PING_URL);
  });

  test("the preload turns the ping off for every test and its children", () => {
    expect(process.env.NO_ANON_PING).toBe("1");
  });

  test("no test file makes a release-marked build", () => {
    const offenders = files()
      .map((f) => relative(repoRoot, f))
      .filter((f) => f !== SELF && readFileSync(join(repoRoot, f), "utf-8").includes("__PLANNOTATOR_RELEASE__"));
    expect(offenders).toEqual([]);
  });

  test("a test that spawns with a release version also turns the ping off or sandboxes it", () => {
    const all = files();
    expect(all.length).toBeGreaterThan(100);
    const releaseSpawn = /__CLI_VERSION__=\\?"(\$\{|\d+\.\d+\.\d+")|PLANNOTATOR_E2E_RELEASE_BINARY/;
    const offenders = all
      .filter((f) => relative(repoRoot, f) !== SELF)
      .filter((f) => {
        const text = readFileSync(f, "utf-8");
        return releaseSpawn.test(text) && !/NO_ANON_PING|PLANNOTATOR_TEST_SANDBOX/.test(text);
      })
      .map((f) => relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
});
