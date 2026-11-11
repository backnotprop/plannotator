/** Caller-pinned open state (--base / --diff-type): the pinned base is served and echoed verbatim, startup does not rewrite an explicit local name to origin/*, resolveReviewBase canonicalization stays off, `openStatePinned` rides /api/diff only when set, and nothing is written to config.json. */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

function initRepo(): string {
  const repoDir = makeTempDir("plannotator-open-state-repo-");
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "README.md"), "# repo\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "initial"]);
  return repoDir;
}

function initRepoWithOrigin(): string {
  const repoDir = initRepo();
  const bareDir = makeTempDir("plannotator-open-state-origin-");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bareDir], { encoding: "utf-8" });
  git(repoDir, ["remote", "add", "origin", bareDir]);
  git(repoDir, ["push", "-q", "-u", "origin", "main"]);
  git(repoDir, ["checkout", "-q", "-b", "feature/x"]);
  writeFileSync(join(repoDir, "feature.txt"), "feature\n");
  git(repoDir, ["add", "feature.txt"]);
  git(repoDir, ["commit", "-q", "-m", "feature"]);
  return repoDir;
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

async function preparePiPort(runtime: "Bun" | "Pi"): Promise<void> {
  if (runtime === "Pi") process.env.PLANNOTATOR_PORT = String(await reservePort());
}

async function finishSession(server: { url: string; waitForDecision: () => Promise<unknown> }): Promise<void> {
  await fetch(`${server.url}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: false, feedback: "done", annotations: [] }),
  });
  await server.waitForDecision();
}

async function fetchDiff(url: string): Promise<{ base?: string; openStatePinned?: boolean; gitContext?: { defaultBranch: string } }> {
  return (await fetch(`${url}/api/diff`).then((r) => r.json())) as {
    base?: string;
    openStatePinned?: boolean;
    gitContext?: { defaultBranch: string };
  };
}

async function waitForBase(
  url: string,
  predicate: (base: string | undefined) => boolean,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let base: string | undefined;
  while (Date.now() < deadline) {
    base = (await fetchDiff(url)).base;
    if (predicate(base)) return base;
    await Bun.sleep(100);
  }
  return base;
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("caller-pinned review open state", () => {
  for (const [runtime, startServer] of RUNTIMES) {
    test(`${runtime}: initialBase + explicit is served verbatim over the detected default`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-open-state-data-");
      await preparePiPort(runtime);
      const repoDir = initRepo();
      git(repoDir, ["checkout", "-q", "-b", "develop"]);
      writeFileSync(join(repoDir, "develop.txt"), "develop\n");
      git(repoDir, ["add", "develop.txt"]);
      git(repoDir, ["commit", "-q", "-m", "develop"]);
      git(repoDir, ["checkout", "-q", "-b", "feature/x"]);

      const gitContext = await getVcsContext(repoDir, "git");
      expect(gitContext.defaultBranch).toBe("main");
      const diff = await runVcsDiff("branch", "develop", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "branch",
        gitContext,
        initialBase: "develop",
        initialBaseExplicit: true,
        openStatePinned: true,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        const payload = await fetchDiff(server.url);
        expect(payload.base).toBe("develop");
        expect(payload.gitContext?.defaultBranch).toBe("main");
        expect(payload.openStatePinned).toBe(true);
        await finishSession(server);
      } finally {
        server.stop();
      }
    }, 15_000);

    test(`${runtime}: startup upgrade honors the explicit bit and canonicalization stays off`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-open-state-data-");
      await preparePiPort(runtime);
      const repoDir = initRepoWithOrigin();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("branch", "main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "branch",
        gitContext,
        initialBase: "main",
        initialBaseExplicit: true,
        openStatePinned: true,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        // Time for the startup probe to have fired.
        await Bun.sleep(1_500);
        expect((await fetchDiff(server.url)).base).toBe("main");

        const switched = (await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "branch", base: "main" }),
        }).then((r) => r.json())) as { base?: string };
        expect(switched.base).toBe("main");
        await finishSession(server);
      } finally {
        server.stop();
      }
    }, 20_000);

    test(`${runtime}: without the explicit bit a forwarded local name still upgrades`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-open-state-data-");
      await preparePiPort(runtime);
      const repoDir = initRepoWithOrigin();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("branch", "main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "branch",
        gitContext,
        initialBase: "main",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        const base = await waitForBase(server.url, (b) => b === "origin/main", 10_000);
        expect(base).toBe("origin/main");
        await finishSession(server);
      } finally {
        server.stop();
      }
    }, 20_000);

    test(`${runtime}: openStatePinned is absent for ordinary sessions`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-open-state-data-");
      await preparePiPort(runtime);
      const repoDir = initRepo();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("uncommitted", "main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "uncommitted",
        gitContext,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        const payload = await fetchDiff(server.url);
        expect(payload.openStatePinned).toBeUndefined();
        await finishSession(server);
      } finally {
        server.stop();
      }
    }, 15_000);

    test(`${runtime}: a pinned session leaves config.json byte-identical`, async () => {
      const dataDir = makeTempDir("plannotator-open-state-data-");
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      await preparePiPort(runtime);
      const configPath = join(dataDir, "config.json");
      mkdirSync(dataDir, { recursive: true });
      const configBytes = JSON.stringify({ displayName: "Reviewer" }, null, 2);
      writeFileSync(configPath, configBytes);

      const repoDir = initRepoWithOrigin();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("merge-base", "main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "merge-base",
        gitContext,
        initialBase: "main",
        initialBaseExplicit: true,
        openStatePinned: true,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        await Bun.sleep(500);
        await finishSession(server);
      } finally {
        server.stop();
      }
      expect(readFileSync(configPath, "utf-8")).toBe(configBytes);
    }, 15_000);
  }
});
