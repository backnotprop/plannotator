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
 *    release binary, must also name NO_ANON_PING or PLANNOTATOR_TEST_SANDBOX;
 *    so must a script or workflow that runs a binary under `env -i` (which
 *    drops CI's variables).
 * And the other way: release.yml still marks every artifact it ships, so
 * real users' pings are not silently lost.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { YAML } from "bun";
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

  // Only this file may name the mark: to check release.yml (below) and to build the probe's control.
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

  test("a script or workflow that runs under env -i (no CI variables) turns the ping off", () => {
    const shells = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        if (SKIP_DIRS.has(name)) return [];
        const full = join(dir, name);
        return statSync(full).isDirectory() ? shells(full) : name.endsWith(".sh") ? [full] : [];
      });
    const offenders = [...shells(join(repoRoot, "scripts")), ...shells(join(repoRoot, "apps")), ...workflowFiles()]
      .filter((f) => {
        const text = readFileSync(f, "utf-8");
        return /\benv -i\b/.test(text) && !text.includes("NO_ANON_PING=1");
      })
      .map((f) => relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
});

const workflowDir = join(repoRoot, ".github", "workflows");
const workflowFiles = () => readdirSync(workflowDir).map((n) => join(workflowDir, n));

interface Step {
  name?: string;
  run?: string;
}
const releaseJobs = () => (YAML.parse(readFileSync(join(workflowDir, "release.yml"), "utf-8")) as { jobs: Record<string, { steps?: Step[] }> }).jobs;
/** A step's `run:` commands, one per line, shell comments dropped. */
const commands = (step: Step) =>
  (step.run ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

describe("release CI marks every artifact that pings (else real users' pings are silently lost)", () => {
  test("every compile of the CLI defines __PLANNOTATOR_RELEASE__=true", () => {
    const compiles = Object.values(releaseJobs())
      .flatMap((job) => job.steps ?? [])
      .flatMap(commands)
      .filter((c) => c.includes("apps/hook/server/index.ts") && c.includes("--compile"));
    expect(compiles.length).toBeGreaterThanOrEqual(6);
    expect(compiles.filter((c) => !c.includes("--define __PLANNOTATOR_RELEASE__=true"))).toEqual([]);
  });

  test("npm-package writes the OpenCode and Pi release.json after the build and before each pack", () => {
    const steps = releaseJobs()["npm-package"]?.steps ?? [];
    const at = (pred: (s: Step) => boolean, what: string) => {
      const i = steps.findIndex(pred);
      expect(i, what).toBeGreaterThan(-1);
      return i;
    };
    const build = at((s) => commands(s).includes("bun run build:opencode"), "the build step");
    const markOpenCode = at((s) => commands(s).some((c) => c.endsWith("> apps/opencode-plugin/dist/release.json")), "the OpenCode mark");
    const markPi = at((s) => commands(s).some((c) => c.endsWith("> apps/pi-extension/release.json")), "the Pi mark");
    const packOpenCode = at((s) => s.name === "Pack @plannotator/opencode", "the OpenCode pack");
    const packPi = at((s) => s.name === "Pack @plannotator/pi-extension", "the Pi pack");
    expect(build).toBeLessThan(markOpenCode);
    expect(build).toBeLessThan(markPi);
    expect(markOpenCode).toBeLessThan(packOpenCode);
    expect(markPi).toBeLessThan(packPi);
  });

  test("no other workflow marks a build (a CI or e2e binary is never a release)", () => {
    const marking = workflowFiles().filter((f) => !f.endsWith("/release.yml") && readFileSync(f, "utf-8").includes("__PLANNOTATOR_RELEASE__"));
    expect(marking).toEqual([]);
  });

  test("the Pi package ships its release.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/pi-extension/package.json"), "utf-8")) as { files: string[] };
    expect(pkg.files).toContain("release.json");
  });
});
