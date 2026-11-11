/**
 * Which review interactions may contact the git remote: an idle session issues no remote call after the startup probes however long the freshness poll runs; `baseBehindRemote` rides every freshness response from cache; `/api/diff/switch` probes once the interval has elapsed; with the remote check off there are zero ls-remote calls and an explicit Fetch stays reachable.
 * A `git` shim first on PATH records every `ls-remote` argv, then execs the real git.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { getVcsContext, runVcsDiff } from "./vcs";
import { REMOTE_BASE_CHECK_INTERVAL_MS } from "@plannotator/shared/review-core";

const RUNTIMES = [
  ["Bun", startBunReviewServer],
  ["Pi", startPiReviewServer],
] as const;

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

const REAL_GIT = (() => {
  const which = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" });
  return which.stdout.trim();
})();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync(REAL_GIT, args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function initRepoBehindRemote(): string {
  const repoDir = makeTempDir("plannotator-remote-check-repo-");
  const bareDir = makeTempDir("plannotator-remote-check-origin-");
  spawnSync(REAL_GIT, ["init", "-q", "--bare", "-b", "main", bareDir], { encoding: "utf-8" });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "README.md"), "# repo\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "initial"]);
  git(repoDir, ["remote", "add", "origin", bareDir]);
  git(repoDir, ["push", "-q", "-u", "origin", "main"]);
  const behindSha = git(repoDir, ["rev-parse", "HEAD"]);
  writeFileSync(join(repoDir, "remote-only.txt"), "landed on the remote\n");
  git(repoDir, ["add", "remote-only.txt"]);
  git(repoDir, ["commit", "-q", "-m", "remote work"]);
  git(repoDir, ["push", "-q", "origin", "main"]);
  git(repoDir, ["update-ref", "refs/remotes/origin/main", behindSha]);
  git(repoDir, ["reset", "-q", "--hard", behindSha]);
  writeFileSync(join(repoDir, "local-work.txt"), "in progress\n");
  return repoDir;
}

function installLsRemoteCounter(): string {
  const binDir = makeTempDir("plannotator-remote-check-bin-");
  const log = join(binDir, "ls-remote.log");
  const shim = join(binDir, "git");
  writeFileSync(
    shim,
    `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = "ls-remote" ]; then
    echo "$*" >> ${JSON.stringify(log)}
    break
  fi
done
exec ${JSON.stringify(REAL_GIT)} "$@"
`,
    "utf-8",
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  return log;
}

function lsRemoteCount(log: string): number {
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf-8").split("\n").filter(Boolean).length;
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

async function finishSession(server: {
  url: string;
  waitForDecision: () => Promise<unknown>;
}): Promise<void> {
  await fetch(`${server.url}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: false, feedback: "done", annotations: [] }),
  });
  await server.waitForDecision();
}

type FreshResponse = { fresh: boolean; baseBehindRemote?: boolean };
type DiffResponse = { base?: string; baseBehindRemote?: boolean; snapshotId?: string };

async function fetchDiff(url: string): Promise<DiffResponse> {
  return (await fetch(`${url}/api/diff`).then((r) => r.json())) as DiffResponse;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function settleStartupProbes(url: string, log: string): Promise<number> {
  await fetchDiff(url);
  await waitFor(async () => (await fetchDiff(url)).baseBehindRemote === true, 10_000);
  let stable = lsRemoteCount(log);
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(100);
    const now = lsRemoteCount(log);
    if (now === stable) return stable;
    stable = now;
  }
  return stable;
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.PLANNOTATOR_GIT_REMOTE_CHECK;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("review remote-check traffic", () => {
  for (const [runtime, startServer] of RUNTIMES) {
    test(`${runtime}: an idle session issues no remote invocation beyond startup`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-remote-check-data-");
      await preparePiPort(runtime);
      const log = installLsRemoteCounter();
      const repoDir = initRepoBehindRemote();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("since-base", "origin/main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "since-base",
        gitContext,
        initialBase: "origin/main",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      const realNow = Date.now;
      try {
        const afterStartup = await settleStartupProbes(server.url, log);
        expect(afterStartup).toBeGreaterThan(0);
        const snapshotId = (await fetchDiff(server.url)).snapshotId;

        // The clock is pushed well past the probe interval so a fast poll is not quiet only because of the rate limit.
        const skew = REMOTE_BASE_CHECK_INTERVAL_MS * 4;
        Date.now = () => realNow() + skew;

        const behind: Array<boolean | undefined> = [];
        for (let i = 0; i < 12; i++) {
          const res = (await fetch(
            `${server.url}/api/diff/fresh${snapshotId ? `?snapshot=${snapshotId}` : ""}`,
          ).then((r) => r.json())) as FreshResponse;
          behind.push(res.baseBehindRemote);
          await Bun.sleep(20);
        }
        await Bun.sleep(400);
        Date.now = realNow;

        expect(lsRemoteCount(log)).toBe(afterStartup);
        expect(behind).toEqual(new Array(12).fill(true));
        await finishSession(server);
      } finally {
        Date.now = realNow;
        server.stop();
      }
    }, 30_000);

    test(`${runtime}: a diff switch probes the remote once the interval has elapsed`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-remote-check-data-");
      await preparePiPort(runtime);
      const log = installLsRemoteCounter();
      const repoDir = initRepoBehindRemote();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("since-base", "origin/main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "since-base",
        gitContext,
        initialBase: "origin/main",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      const realNow = Date.now;
      try {
        const afterStartup = await settleStartupProbes(server.url, log);

        await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "uncommitted" }),
        });
        await Bun.sleep(300);
        expect(lsRemoteCount(log)).toBe(afterStartup);

        // The clock is faked: the gate reads Date.now() and the server runs in this process.
        const skew = REMOTE_BASE_CHECK_INTERVAL_MS + 5_000;
        Date.now = () => realNow() + skew;
        await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "since-base", base: "origin/main" }),
        });
        const probed = await waitFor(() => lsRemoteCount(log) > afterStartup, 10_000);
        Date.now = realNow;

        expect(probed).toBe(true);
        expect(lsRemoteCount(log)).toBe(afterStartup + 1);
        await finishSession(server);
      } finally {
        Date.now = realNow;
        server.stop();
      }
    }, 30_000);

    test(`${runtime}: gitRemoteCheck off makes the whole session network-free`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-remote-check-data-");
      await preparePiPort(runtime);
      const log = installLsRemoteCounter();
      const repoDir = initRepoBehindRemote();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("since-base", "origin/main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "since-base",
        gitContext,
        initialBase: "origin/main",
        gitRemoteCheck: false,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      const realNow = Date.now;
      try {
        const payload = await fetchDiff(server.url);
        expect(payload.base).toBe("origin/main");
        expect(payload.baseBehindRemote).toBeUndefined();

        for (let i = 0; i < 6; i++) {
          const res = (await fetch(
            `${server.url}/api/diff/fresh${payload.snapshotId ? `?snapshot=${payload.snapshotId}` : ""}`,
          ).then((r) => r.json())) as FreshResponse;
          expect(res.baseBehindRemote).toBeUndefined();
          await Bun.sleep(20);
        }

        Date.now = () => realNow() + REMOTE_BASE_CHECK_INTERVAL_MS + 5_000;
        await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "since-base", base: "origin/main" }),
        });
        await Bun.sleep(400);
        Date.now = realNow;

        expect(lsRemoteCount(log)).toBe(0);

        // An explicit Fetch is the user asking for the network, so it stays
        // reachable — the opt-out governs the automatic probes only.
        const fetchBase = await fetch(`${server.url}/api/fetch-base`, { method: "POST" });
        expect(fetchBase.status).toBe(200);
        await finishSession(server);
      } finally {
        Date.now = realNow;
        server.stop();
      }
    }, 30_000);
  }
});
