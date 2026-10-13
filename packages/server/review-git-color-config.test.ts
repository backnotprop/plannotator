/**
 * Code review under a user git config that forces color into pipes (#1661),
 * end to end through both review servers (Bun + Pi).
 *
 * Failure caught: with `color.diff = always` every patch line came back wrapped
 * in ANSI escapes, the parser found 0 files, and viewed-file identity capture
 * found 0 identities. `color.ui = never` alone does not fix it (the specific
 * `color.diff` key wins), so this config sets both kinds of key, plus the other
 * settings a dotfiles repo commonly carries (`diff.noprefix`, pagers).
 *
 * Every git and jj call here reads a sandboxed GIT_CONFIG_GLOBAL / JJ_CONFIG;
 * the real user config is never read or written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDiffToFiles } from "../core/diff-files";
import { gitColorFreeEnvironment } from "@plannotator/shared/review-core";
import { startReviewServer as startBunReviewServer } from "./review";
import { getVcsContext as getBunVcsContext, runVcsDiff as runBunVcsDiff } from "./vcs";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import {
  getVcsContext as getPiVcsContext,
  runVcsDiff as runPiVcsDiff,
} from "../../apps/pi-extension/server/vcs";

const HOSTILE_GIT_CONFIG = `[user]
  name = Color Test
  email = color-test@example.invalid
[init]
  defaultBranch = main
[color]
  ui = always
  diff = always
  status = always
  branch = always
[diff]
  noprefix = true
  colorMoved = zebra
[core]
  pager = less -R
[pager]
  diff = true
  log = true
  show = true
`;

const HOSTILE_JJ_CONFIG = `[ui]
color = "always"
paginate = "auto"
[user]
name = "Color Test"
email = "color-test@example.invalid"
`;

const ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "JJ_CONFIG",
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
] as const;
const savedEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

const RUNTIMES = [
  { name: "Bun", start: startBunReviewServer, getVcsContext: getBunVcsContext, runVcsDiff: runBunVcsDiff },
  { name: "Pi", start: startPiReviewServer, getVcsContext: getPiVcsContext, runVcsDiff: runPiVcsDiff },
] as const;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Point every git/jj call at the hostile sandboxed config; restored in afterEach. */
function sandboxConfig(): void {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  const configDir = makeTempDir("plannotator-color-config-");
  const gitConfig = join(configDir, "gitconfig");
  const jjConfig = join(configDir, "jj.toml");
  writeFileSync(gitConfig, HOSTILE_GIT_CONFIG);
  writeFileSync(jjConfig, HOSTILE_JJ_CONFIG);
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.JJ_CONFIG = jjConfig;
  process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-color-data-");
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cmd: string, cwd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf-8", env: process.env });
  if (result.status !== 0) throw new Error(result.stderr || `${cmd} ${args.join(" ")} failed`);
  return result.stdout;
}

/**
 * main: base.txt + a.txt. feature: two commits on top, then one uncommitted
 * edit and one untracked file, so since-base spans all three sections.
 */
function initGitRepo(): string {
  const repo = makeTempDir("plannotator-color-repo-");
  run("git", repo, ["init", "--quiet"]);
  writeFileSync(join(repo, "a.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(repo, "b.txt"), "keep\n");
  run("git", repo, ["add", "."]);
  run("git", repo, ["commit", "--quiet", "-m", "init"]);
  run("git", repo, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(repo, "a.txt"), "line1\nline2 changed\nline3\n");
  run("git", repo, ["commit", "--quiet", "-am", "feat: change a"]);
  writeFileSync(join(repo, "c.txt"), "new\n");
  run("git", repo, ["add", "c.txt"]);
  run("git", repo, ["commit", "--quiet", "-m", "feat: add c"]);
  writeFileSync(join(repo, "b.txt"), "keep\nuncommitted\n");
  writeFileSync(join(repo, "d.txt"), "untracked\n");
  return repo;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fileSummary(rawPatch: string): string[] {
  return parseDiffToFiles(rawPatch).map((f) => `${f.path} +${f.additions}/-${f.deletions}`);
}

function hasJj(): boolean {
  try {
    return spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
}

describe("code review with color forced on in the user's git config (#1661)", () => {
  test("the sandboxed config really does color a piped git diff", () => {
    // Guards the test itself: without this, a config typo would let every
    // assertion below pass against plain output.
    sandboxConfig();
    const repo = initGitRepo();
    expect(run("git", repo, ["diff"])).toContain("\x1b[");
  });

  test("agent jobs' environment keeps the git they run themselves color-free", () => {
    // Review, tour and guide jobs spawn an agent that runs `git diff` through
    // its own pipe; the job environment carries the color-off settings.
    sandboxConfig();
    const repo = initGitRepo();
    const env = { ...process.env, ...gitColorFreeEnvironment(process.env) };
    const result = spawnSync("git", ["diff", "main"], { cwd: repo, encoding: "utf-8", env });
    expect(result.stdout).toContain("diff --git a.txt a.txt");
    expect(result.stdout).not.toContain("\x1b");
  });

  for (const runtime of RUNTIMES) {
    test(`${runtime.name}: files, identities, commits, sections and expansion all work`, async () => {
      sandboxConfig();
      if (runtime.name === "Pi") process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repo = initGitRepo();

      const gitContext = await runtime.getVcsContext(repo, "git");
      const diff = await runtime.runVcsDiff("since-base", "main", repo, { captureFileIdentities: true });
      expect(diff.patch).not.toContain("\x1b");
      expect(fileSummary(diff.patch)).toEqual(["a.txt +1/-1", "b.txt +1/-0", "c.txt +1/-0", "d.txt +1/-0"]);
      expect(Object.keys(diff.fileIdentities ?? {}).sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);

      const server = await runtime.start({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "since-base",
        gitContext,
        initialBase: "main",
        initialFileIdentities: diff.fileIdentities,
        origin: runtime.name === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        // A switch recomputes the patch, the sections and the identities
        // server-side, through the same runtime the session uses.
        const switched = await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "since-base", base: "main" }),
        }).then((r) => r.json()) as {
          rawPatch: string;
          snapshotId: string;
          sections?: { files: Record<string, { group: string }> };
        };
        expect(switched.rawPatch).not.toContain("\x1b");
        expect(fileSummary(switched.rawPatch)).toEqual(["a.txt +1/-1", "b.txt +1/-0", "c.txt +1/-0", "d.txt +1/-0"]);
        expect(switched.sections?.files).toMatchObject({
          "a.txt": { group: "committed" },
          "c.txt": { group: "committed" },
          "b.txt": { group: "changes" },
          "d.txt": { group: "untracked" },
        });

        const progress = await fetch(`${server.url}/api/review-progress?snapshot=${switched.snapshotId}`)
          .then((r) => r.json()) as { available: boolean; fingerprints?: Record<string, string> };
        expect(progress.available).toBe(true);
        expect(Object.keys(progress.fingerprints ?? {}).sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);

        const commits = await fetch(`${server.url}/api/commits?limit=10`)
          .then((r) => r.json()) as { commits: Array<{ subject: string; shortSha: string }> };
        expect(commits.commits.map((c) => c.subject)).toEqual(["feat: add c", "feat: change a", "init"]);
        expect(commits.commits.every((c) => /^[0-9a-f]+$/.test(c.shortSha))).toBe(true);

        const expanded = await fetch(`${server.url}/api/file-content?path=a.txt`)
          .then((r) => r.json()) as { oldContent: string | null; newContent: string | null };
        expect(expanded).toEqual({ oldContent: "line1\nline2\nline3\n", newContent: "line1\nline2 changed\nline3\n" });
      } finally {
        await fetch(`${server.url}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: false, feedback: "done", annotations: [] }),
        });
        await server.waitForDecision();
        server.stop();
      }
    }, 30_000);
  }

  const testIfJj = hasJj() ? test : test.skip;
  const JJ_MODULES = [
    ["Bun", resolve(import.meta.dir, "vcs.ts")],
    ["Pi", resolve(import.meta.dir, "../../apps/pi-extension/server/vcs.ts")],
  ] as const;
  for (const [name, modulePath] of JJ_MODULES) {
    // Skipped when jj is not installed (CI runners do not ship it).
    testIfJj(`${name}: a jj diff stays parseable with ui.color = "always"`, () => {
      sandboxConfig();
      const repo = makeTempDir("plannotator-color-jj-");
      run("jj", repo, ["git", "init", "--no-colocate", "."]);
      writeFileSync(join(repo, "base.txt"), "base\n");
      run("jj", repo, ["commit", "-m", "base"]);
      writeFileSync(join(repo, "base.txt"), "base\nchanged\n");
      expect(run("jj", repo, ["diff", "--git"])).toContain("\x1b[");

      // A child process, so the runtime's own jj spawns start from the
      // sandboxed environment (Bun.spawn without `env` does not see variables
      // this process set after it started).
      const script = `const m = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
await m.getVcsContext(${JSON.stringify(repo)}, "jj");
const d = await m.runVcsDiff("jj-current", "main", ${JSON.stringify(repo)});
process.stdout.write(JSON.stringify(d.patch));`;
      const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8", env: process.env });
      expect(child.stderr).toBe("");
      const patch = JSON.parse(child.stdout) as string;
      expect(patch).not.toContain("\x1b");
      expect(fileSummary(patch)).toEqual(["base.txt +1/-0"]);
    }, 30_000);
  }
});
