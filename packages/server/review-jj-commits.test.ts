/**
 * The Commits panel in a jj session, end to end through both review servers
 * (Bun + Pi): `/api/commits` answers with the jj rail, a `jj-commit:<id>`
 * switch serves that revision's first-parent diff with its description card,
 * and hunk expansion reads the same two revisions.
 *
 * Failure caught: either runtime still gating `/api/commits` to git (the
 * reported "Commits view is gone" on jj), or one runtime drifting from the
 * other in how it answers a jj-commit switch.
 *
 * Skipped when `jj` is not installed (CI runners do not ship it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { getVcsContext, runVcsDiff } from "./vcs";

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const tempDirs: string[] = [];

const RUNTIMES = [
  ["Bun", startBunReviewServer],
  ["Pi", startPiReviewServer],
] as const;

function hasJj(): boolean {
  try {
    return spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function jj(cwd: string, args: string[]): string {
  const result = spawnSync("jj", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `jj ${args.join(" ")} failed`);
  return result.stdout.trim();
}

/** base -> one -> two -> @ (blank), pure jj. */
function initJjRepo(): { repoDir: string; one: string; two: string } {
  const repoDir = makeTempDir("plannotator-jj-commits-repo-");
  jj(repoDir, ["git", "init", "--no-colocate", "."]);
  jj(repoDir, ["config", "set", "--repo", "user.name", "Rail Test"]);
  jj(repoDir, ["config", "set", "--repo", "user.email", "rail-test@example.invalid"]);
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  jj(repoDir, ["commit", "-m", "base"]);
  writeFileSync(join(repoDir, "one.txt"), "one\n");
  jj(repoDir, ["commit", "-m", "feature one\n\nThe body, in **markdown**.\n"]);
  const one = jj(repoDir, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);
  writeFileSync(join(repoDir, "one.txt"), "one, revised\n");
  jj(repoDir, ["commit", "-m", "feature two"]);
  const two = jj(repoDir, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);
  return { repoDir, one, two };
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

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Commits panel in a jj review session", () => {
  const testIfJj = hasJj() ? test : test.skip;

  for (const [runtime, startServer] of RUNTIMES) {
    testIfJj(`${runtime}: lists the jj rail and opens a jj-commit diff`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-jj-commits-data-");
      if (runtime === "Pi") process.env.PLANNOTATOR_PORT = String(await reservePort());
      const { repoDir, one, two } = initJjRepo();
      const gitContext = await getVcsContext(repoDir, "jj");
      const diff = await runVcsDiff("jj-current", gitContext.defaultBranch, repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "jj-current",
        gitContext,
        initialBase: gitContext.defaultBranch,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        const rail = await fetch(`${server.url}/api/commits?limit=50`);
        expect(rail.status).toBe(200);
        const page = await rail.json() as { commits: Array<{ sha: string; subject: string }>; hasMore: boolean };
        expect(page.commits.map((c) => c.subject)).toEqual(["feature two", "feature one", "base"]);
        expect(page.commits[0].sha).toBe(two);

        const switched = await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: `jj-commit:${one}` }),
        }).then((r) => r.json()) as {
          diffType: string;
          rawPatch: string;
          commitInfo?: { sha: string; subject: string; body: string };
        };
        expect(switched.diffType).toBe(`jj-commit:${one}`);
        expect(switched.rawPatch).toContain("+one");
        expect(switched.rawPatch).not.toContain("base.txt");
        expect(switched.commitInfo).toMatchObject({ sha: one, subject: "feature one", body: "The body, in **markdown**." });
        // Same-cwd commit switch: the context recompute is skipped, so no
        // gitContext rides the response (the client keeps its own).
        expect("gitContext" in switched).toBe(false);

        const expanded = await fetch(`${server.url}/api/file-content?path=one.txt`).then((r) => r.json()) as {
          oldContent: string | null;
          newContent: string | null;
        };
        expect(expanded).toEqual({ oldContent: null, newContent: "one\n" });

        // Leaving the detour: a normal jj diff type still switches.
        const back = await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "jj-current" }),
        }).then((r) => r.json()) as { diffType: string; commitInfo?: unknown };
        expect(back.diffType).toBe("jj-current");
        expect(back.commitInfo).toBeUndefined();
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
});
