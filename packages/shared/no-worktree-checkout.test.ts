import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { ReviewGitRuntime } from "./review-core";
import type { PRMetadata } from "./pr-types";
import { checkoutPRHead } from "./pr-stack";

// Exercises the git mechanics behind `plannotator review --no-worktree` — the
// in-place PR checkout that skips `git worktree add`. Uses REAL git against a
// local bare "origin" that carries a GitHub-style `refs/pull/<N>/head` ref, so
// checkoutPRHead's `git fetch origin refs/pull/<N>/head` works fully offline.
// This proves the checkout/restore/guard mechanics; the CLI wiring (inPlace
// gate, isSameRepo detection, agentCwd handoff) is covered by the live/manual
// layer documented in the PR.
const gitRuntime: ReviewGitRuntime = {
  async runGit(args, options) {
    const proc = Bun.spawn(["git", "-c", "core.quotePath=false", ...args], {
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  },
  async readTextFile() {
    return null;
  },
};

const git = (args: string[], cwd: string) => gitRuntime.runGit(args, { cwd });
const out = async (args: string[], cwd: string) => (await git(args, cwd)).stdout.trim();

// The fixture drives real git (init/commit/clone) — generous timeouts so a cold
// run (slow first-time disk / AV scan on macOS/CI) doesn't flake on the 5s default.
const SETUP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

let dir: string;
let clone: string;
let BASE_SHA: string;
let HEAD_SHA: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pln-nowt-"));
  const originBare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  clone = path.join(dir, "clone");

  const cfg = async (repo: string) => {
    await git(["config", "user.email", "t@t"], repo);
    await git(["config", "user.name", "t"], repo);
  };

  await git(["init", "--bare", "-b", "main", originBare], dir);
  await git(["init", "-b", "main", seed], dir);
  await cfg(seed);

  await Bun.write(path.join(seed, "f.txt"), "base\n");
  await git(["add", "."], seed);
  await git(["commit", "-m", "base"], seed);
  BASE_SHA = await out(["rev-parse", "HEAD"], seed);

  await git(["checkout", "-b", "pr-head"], seed);
  await Bun.write(path.join(seed, "f.txt"), "base\npr change\n");
  await git(["add", "."], seed);
  await git(["commit", "-m", "pr work"], seed);
  HEAD_SHA = await out(["rev-parse", "HEAD"], seed);

  await git(["remote", "add", "origin", originBare], seed);
  await git(["push", "origin", "main"], seed);
  // The GitHub-style pull ref that checkoutPRHead fetches.
  await git(["push", "origin", "pr-head:refs/pull/992/head"], seed);

  await git(["clone", originBare, clone], dir);
  await cfg(clone);
}, SETUP_TIMEOUT_MS);

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const meta = (over: Partial<PRMetadata> = {}): PRMetadata => ({
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 992,
  title: "t",
  author: "a",
  baseBranch: "main",
  headBranch: "pr-head",
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  url: "https://github.com/acme/widgets/pull/992",
  ...over,
}) as PRMetadata;

describe("no-worktree in-place checkout — git mechanics", () => {
  test("moves HEAD to the PR head without adding a worktree", async () => {
    const before = (await out(["worktree", "list"], clone)).split("\n").length;
    expect(await checkoutPRHead(gitRuntime, meta(), clone)).toBe(true);
    expect(await out(["rev-parse", "HEAD"], clone)).toBe(HEAD_SHA);
    expect((await out(["worktree", "list"], clone)).split("\n").length).toBe(before);
  }, TEST_TIMEOUT_MS);

  test("captured original ref can be restored after checkout", async () => {
    const origRef = await out(["symbolic-ref", "--quiet", "--short", "HEAD"], clone);
    expect(origRef).toBe("main");

    await checkoutPRHead(gitRuntime, meta(), clone);
    expect(await out(["rev-parse", "HEAD"], clone)).toBe(HEAD_SHA);

    // What the restore closure does on session exit.
    await git(["checkout", origRef], clone);
    expect(await out(["symbolic-ref", "--quiet", "--short", "HEAD"], clone)).toBe("main");
    expect(await out(["rev-parse", "HEAD"], clone)).toBe(BASE_SHA);
  }, TEST_TIMEOUT_MS);

  test("dirty working tree is detectable via status --porcelain", async () => {
    await Bun.write(path.join(clone, "f.txt"), "dirty\n");
    expect(await out(["status", "--porcelain"], clone)).not.toBe("");
    // Guard leaves HEAD untouched.
    expect(await out(["symbolic-ref", "--quiet", "--short", "HEAD"], clone)).toBe("main");
  }, TEST_TIMEOUT_MS);

  test("unreachable PR ref → checkoutPRHead returns false, HEAD unchanged", async () => {
    expect(await checkoutPRHead(gitRuntime, meta({ number: 999999 } as Partial<PRMetadata>), clone)).toBe(false);
    expect(await out(["rev-parse", "HEAD"], clone)).toBe(BASE_SHA);
  }, TEST_TIMEOUT_MS);
});
