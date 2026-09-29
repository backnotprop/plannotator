import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startReviewServer as startBun } from "./review";
import { startReviewServer as startPi } from "../../apps/pi-extension/server/serverReview";
import { gitRuntime } from "./vcs";
import { getGitContext, MAX_REVIEW_FILE_CONTENT_BYTES, runGitDiff } from "@plannotator/shared/review-core";
import { contentHash } from "@plannotator/shared/draft";
import { captureReviewProgress, loadReviewProgress, reviewFileFingerprints, saveReviewProgress } from "@plannotator/shared/review-progress";

let root: string;
let cwd: string;
let restoreEnv: () => void;
const servers: Array<{ stop: () => void }> = [];

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeEach(() => {
  const env = { ...process.env };
  restoreEnv = () => {
    for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_REMOTE", "PLANNOTATOR_PORT"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  };
  root = mkdtempSync(join(tmpdir(), "review-progress-"));
  cwd = join(root, "repo");
  mkdirSync(cwd);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  delete process.env.PLANNOTATOR_PORT;
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  for (const file of ["a.txt", "b.txt"]) writeFileSync(join(cwd, file), "before\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("switch", "-c", "feature");
  for (const file of ["a.txt", "b.txt"]) writeFileSync(join(cwd, file), "after\n");
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

async function snapshot() {
  const result = await runGitDiff(gitRuntime, "since-base", "main", cwd, { captureFileIdentities: true });
  const value = await captureReviewProgress({ patch: result.patch, fileIdentities: result.fileIdentities, diffType: "since-base", base: "main", cwd }, gitRuntime.runGit);
  if (!value) throw new Error("Missing progress identity");
  return value;
}

for (const [name, start] of [["Bun", startBun], ["Pi", startPi]] as const) {
  describe(`${name} durable review progress`, () => {
    async function open() {
      const gitContext = await getGitContext(gitRuntime, cwd);
      const diff = await runGitDiff(gitRuntime, "since-base", "main", cwd, { captureFileIdentities: true });
      const server = await start({
        rawPatch: diff.patch, gitRef: diff.label, diffType: "since-base", initialBase: "main",
        initialFileIdentities: diff.fileIdentities,
        gitContext, htmlContent: "<!doctype html><title>Review</title>",
      });
      servers.push(server);
      return server;
    }
    async function progress(url: string) {
      const diff = await (await fetch(`${url}/api/diff`)).json();
      const endpoint = `${url}/api/review-progress?snapshot=${encodeURIComponent(diff.snapshotId)}`;
      const response = await fetch(endpoint);
      expect(response.status).toBe(200);
      return { endpoint, data: await response.json() };
    }
    async function mark(p: Awaited<ReturnType<typeof progress>>, paths: string[], viewed = true) {
      return fetch(p.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: p.data.key, changes: paths.map(path => ({ path, viewed, fingerprint: p.data.fingerprints[path] })) }),
      });
    }

    test("submit, stop, edit one file and reopen: only the changed file is unviewed", async () => {
      const first = await open();
      const p = await progress(first.url);
      expect(p.data.available).toBe(true);
      expect((await mark(p, ["a.txt", "b.txt"])).status).toBe(200);
      // Annotation drafts retain their existing decision-time deletion.
      await fetch(`${first.url}/api/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codeAnnotations: [{ id: "note" }], ts: Date.now() }) });
      expect((await fetch(`${first.url}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback: "Please adjust B", annotations: [] }) })).status).toBe(200);
      await first.waitForDecision();
      first.stop();
      servers.splice(servers.indexOf(first), 1);
      writeFileSync(join(cwd, "b.txt"), "adjusted\n");
      const second = await open();
      const restored = await progress(second.url);
      expect(restored.data.viewedFiles).toEqual(["a.txt"]);
      expect((await mark(restored, ["a.txt"], false)).status).toBe(200);
      expect((await progress(second.url)).data).toMatchObject({ viewedFiles: [], suppressedFiles: ["a.txt"] });
      const third = await open();
      expect((await progress(third.url)).data.viewedFiles).toEqual([]);
    });

    test("view switches preserve their own progress and reject stale writes", async () => {
      git("add", "a.txt");
      const server = await open();
      const initial = await progress(server.url);
      await mark(initial, ["a.txt", "b.txt"]);
      const switchTo = (diffType: string, hideWhitespace = false) => fetch(`${server.url}/api/diff/switch`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ diffType, base: "main", hideWhitespace }),
      });
      expect((await switchTo("staged")).status).toBe(200);
      expect((await progress(server.url)).data.viewedFiles).toEqual([]);
      expect((await mark(initial, ["a.txt"])).status).toBe(409);
      expect((await switchTo("since-base", true)).status).toBe(200);
      expect((await progress(server.url)).data.viewedFiles.sort()).toEqual(["a.txt", "b.txt"]);
      writeFileSync(join(cwd, "a.txt"), "new content\n");
      await switchTo("since-base");
      expect((await progress(server.url)).data.viewedFiles).toEqual(["b.txt"]);
      const p = await progress(server.url);
      const invalid = await fetch(p.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: p.data.key, changes: [{ path: "../escape", fingerprint: "x", viewed: true }] }) });
      expect(invalid.status).toBe(400);
    });
  });
}

test("committing preserves identities; another branch/worktree does not inherit marks", async () => {
  const before = await snapshot();
  saveReviewProgress(before, [{ path: "a.txt", fingerprint: before.fingerprints["a.txt"], viewed: true }]);
  git("add", ".");
  git("commit", "-m", "changes");
  const committed = await snapshot();
  expect(committed).toEqual(before);
  expect(loadReviewProgress(committed).viewedFiles).toEqual(["a.txt"]);
  const subdir = join(cwd, "subdir");
  mkdirSync(subdir);
  const fromSubdir = await captureReviewProgress({ patch: "", fileIdentities: {}, diffType: "since-base", base: "main", cwd: subdir }, gitRuntime.runGit);
  expect(fromSubdir?.key).toBe(before.key);
  git("switch", "-c", "another");
  expect(loadReviewProgress(await snapshot()).viewedFiles).toEqual([]);
  const other = join(root, "other");
  git("worktree", "add", "--detach", other, "feature");
  const otherSnapshot = await captureReviewProgress({ patch: "", fileIdentities: {}, diffType: `worktree:${other}:since-base`, base: "main", cwd }, gitRuntime.runGit);
  expect(otherSnapshot?.key).not.toBe(before.key);
});

test("untracked, binary, mode and rename changes have content-sensitive identities", async () => {
  writeFileSync(join(cwd, "new.txt"), "one\n");
  writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  const before = await snapshot();
  expect(before.fingerprints["new.txt"]).toBeDefined();
  expect(before.fingerprints["binary.bin"]).toBeDefined();
  writeFileSync(join(cwd, "new.txt"), "two\n");
  writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 2, 2]));
  const after = await snapshot();
  expect(after.fingerprints["new.txt"]).not.toBe(before.fingerprints["new.txt"]);
  expect(after.fingerprints["binary.bin"]).not.toBe(before.fingerprints["binary.bin"]);
  git("add", ".");
  git("update-index", "--chmod=+x", "a.txt");
  const staged = await runGitDiff(gitRuntime, "staged", "main", cwd, { captureFileIdentities: true });
  expect(reviewFileFingerprints(staged.patch, staged.fileIdentities)["a.txt"]).not.toBe(before.fingerprints["a.txt"]);
  git("mv", "a.txt", "renamed.txt");
  const renamed = await snapshot();
  // A complete rewrite can render as delete + add instead of a rename; either
  // way the old mark must not cover the deletion or the destination.
  expect(renamed.fingerprints["a.txt"]).not.toBe(before.fingerprints["a.txt"]);
  expect(renamed.fingerprints["renamed.txt"]).toBeDefined();
});

test("local unchecked/stale records override platform seeds; different file writes merge", async () => {
  const s = await snapshot();
  saveReviewProgress(s, [{ path: "a.txt", fingerprint: s.fingerprints["a.txt"], viewed: false }]);
  saveReviewProgress(s, [{ path: "b.txt", fingerprint: s.fingerprints["b.txt"], viewed: true }]);
  expect(loadReviewProgress(s, ["a.txt", "b.txt"])).toEqual({ viewedFiles: ["b.txt"], suppressedFiles: ["a.txt"] });
  writeFileSync(join(cwd, "b.txt"), "changed\n");
  expect(loadReviewProgress(await snapshot(), ["a.txt", "b.txt"]).viewedFiles).toEqual([]);
});

test("identity capture preserves rendered bytes and existing annotation draft keys", async () => {
  writeFileSync(join(cwd, "untracked.txt"), "new\n");
  for (const abbreviation of ["7", "12"]) {
    git("config", "core.abbrev", abbreviation);
    for (const hideWhitespace of [false, true]) {
      const legacy = await runGitDiff(gitRuntime, "since-base", "main", cwd, { hideWhitespace });
      const captured = await runGitDiff(gitRuntime, "since-base", "main", cwd, { hideWhitespace, captureFileIdentities: true });
      expect(captured.patch).toBe(legacy.patch);
      expect(contentHash(captured.patch)).toBe(contentHash(legacy.patch));
      expect(Object.keys(captured.fileIdentities!)).toEqual(["a.txt", "b.txt", "untracked.txt"]);
    }
  }
  writeFileSync(join(cwd, "a.txt"), "before  \n");
  const legacy = await runGitDiff(gitRuntime, "since-base", "main", cwd, { hideWhitespace: true });
  const captured = await runGitDiff(gitRuntime, "since-base", "main", cwd, { hideWhitespace: true, captureFileIdentities: true });
  expect(captured.patch).toBe(legacy.patch);
  expect(captured.patch).not.toContain("\0");
});

test("rebasing unchanged mode/rename patches over new base content invalidates marks", async () => {
  git("restore", ".");
  chmodSync(join(cwd, "a.txt"), 0o755);
  git("mv", "b.txt", "renamed.txt");
  git("add", ".");
  git("commit", "-m", "metadata only");
  const before = await snapshot();
  const beforePatch = (await runGitDiff(gitRuntime, "since-base", "main", cwd)).patch;
  expect(before.fingerprints["a.txt"]).toBeDefined();
  expect(before.fingerprints["renamed.txt"]).toBeDefined();
  saveReviewProgress(before, Object.entries(before.fingerprints).map(([path, fingerprint]) => ({ path, fingerprint, viewed: true })));
  git("switch", "main");
  for (const file of ["a.txt", "b.txt"]) writeFileSync(join(cwd, file), "different base content\n");
  git("add", ".");
  git("commit", "-m", "base changed");
  git("switch", "feature");
  git("rebase", "main");
  const after = await snapshot();
  expect((await runGitDiff(gitRuntime, "since-base", "main", cwd)).patch).toBe(beforePatch);
  expect(after.fingerprints["a.txt"]).not.toBe(before.fingerprints["a.txt"]);
  expect(after.fingerprints["renamed.txt"]).not.toBe(before.fingerprints["renamed.txt"]);
  expect(loadReviewProgress(after).viewedFiles).toEqual([]);
});

test("oversized untracked files stay bounded and cannot restore viewed marks", async () => {
  writeFileSync(join(cwd, "large.bin"), Buffer.alloc(MAX_REVIEW_FILE_CONTENT_BYTES + 1));
  const hashCalls: string[][] = [];
  const runtime = { ...gitRuntime, runGit: async (...args: Parameters<typeof gitRuntime.runGit>) => {
    if (args[0][0] === "hash-object") hashCalls.push(args[0]);
    return gitRuntime.runGit(...args);
  } };
  const result = await runGitDiff(runtime, "since-base", "main", cwd, { captureFileIdentities: true });
  expect(result.patch).toContain("large.bin");
  expect(result.fileIdentities!["large.bin"]).toBeUndefined();
  expect(hashCalls.some(args => args.some(arg => arg.includes("large.bin")))).toBe(false);
});

test("an edit between diff rendering and worktree identity capture cannot restore a newer version", async () => {
  const runtime = { ...gitRuntime, runGit: async (...args: Parameters<typeof gitRuntime.runGit>) => {
    if (args[0][0] === "hash-object" && args[0].includes("--path=a.txt")) {
      writeFileSync(join(cwd, "a.txt"), "edited after rendering\n");
    }
    return gitRuntime.runGit(...args);
  } };
  const result = await runGitDiff(runtime, "since-base", "main", cwd, { captureFileIdentities: true });
  expect(result.patch).toContain("+after");
  expect(result.fileIdentities!["a.txt"]).toBeUndefined();
  expect(result.fileIdentities!["b.txt"]).toBeDefined();
});

test("workspace and non-Git reviews retain legacy draft persistence", async () => {
  const input = { patch: "", fileIdentities: {}, diffType: "uncommitted", base: "main", cwd };
  for (const vcsType of ["jj", "p4", "gitbutler"]) {
    expect(await captureReviewProgress({ ...input, vcsType }, gitRuntime.runGit)).toBeNull();
  }
  expect(await captureReviewProgress({ ...input, workspaceRoot: cwd }, gitRuntime.runGit)).toBeNull();
});
