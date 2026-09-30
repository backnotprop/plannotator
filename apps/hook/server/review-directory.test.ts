/** A directory must own the whole review, including writes, not just its first diff. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  // API-only CLI tests need the import-time HTML assets, even without a UI build.
  stubs = ["index.html", "review.html"].map(name => join(distDir, name)).filter(path => !existsSync(path));
  mkdirSync(distDir, { recursive: true });
  for (const path of stubs) writeFileSync(path, "<!doctype html><title>test</title>");
});
afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function initRepo(path: string, label: string) {
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.name", `${label} author`);
  git(path, "config", "user.email", "test@example.invalid");
  writeFileSync(join(path, "app.ts"), `export const ${label} = 1;\n`);
  git(path, "add", ".");
  git(path, "commit", "-qm", "initial");
  writeFileSync(join(path, "app.ts"), `export const ${label} = 2;\n`);
}

function fixture() {
  // realpath: macOS tmpdir is a symlink, and git reports the resolved toplevel.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-review-directory-")));
  roots.push(root);
  const caller = join(root, "caller");
  const target = join(root, "selected repo");
  const dataDir = join(root, "data");
  initRepo(caller, "caller");
  initRepo(target, "selected");
  git(target, "checkout", "-qb", "selected-branch");
  git(target, "remote", "add", "origin", "https://github.com/example/selected.git");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ reviewAnalysis: { semanticDiff: false, callFlow: false } }));
  return { root, caller, target, dataDir };
}

async function launch(cwd: string, args: string[], dataDir: string, bridge = false, invocationCwd = cwd) {
  const ready = join(dataDir, `ready-${crypto.randomUUID()}.json`);
  const proc = Bun.spawn([process.execPath, "run", entry, ...(bridge ? ["opencode-review-directory"] : ["review", ...args, "--json"])], {
    cwd,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: invocationCwd,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_PORT: "0",
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_AI: "disabled",
      PLANNOTATOR_SHARE: "disabled",
      PLANNOTATOR_GIT_REMOTE_CHECK: "0",
      PLANNOTATOR_REVIEW_PROGRESS: "1",
      PLANNOTATOR_FEEDBACK_HISTORY: "1",
    },
    stdin: bridge ? new TextEncoder().encode(JSON.stringify({ arguments: args.map(arg => `"${arg}"`).join(" ") })) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  for (let i = 0; i < 200; i++) {
    if (existsSync(ready)) {
      const { url } = JSON.parse(readFileSync(ready, "utf8"));
      return {
        async api(path: string, body?: unknown) {
          const response = await fetch(`${url}${path}`, body === undefined ? undefined : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          expect(response.status).toBe(200);
          return response.json();
        },
        async finish() {
          expect(await proc.exited).toBe(0);
          return JSON.parse((await stdout).trim());
        },
        stop: () => proc.kill(),
      };
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error(`Review did not start: ${await stderr}`);
}

for (const bridge of [false, true]) {
  test(`${bridge ? "OpenCode bridge" : "CLI"}: selected repo owns reads, staging, refresh, progress, and feedback`, async () => {
    const { caller, target, dataDir } = fixture();
    const hostCwd = process.cwd();
    // This ref only exists in the target: --base validation must move there too.
    git(target, "branch", "target-base");
    const session = await launch(caller, [relative(caller, target), "--base", "target-base", "--diff-type", "since-base"], dataDir, bridge);
    try {
      let diff = await session.api("/api/diff");
      expect(diff.rawPatch).toContain("+export const selected = 2;");
      expect(diff.rawPatch).not.toContain("caller");
      expect(diff.base).toBe("target-base");
      expect(diff.repoInfo).toMatchObject({ display: "example/selected", branch: "selected-branch" });
      expect(diff.serverConfig.gitUser).toBe("selected author");
      expect(await session.api("/api/file-content?path=app.ts")).toMatchObject({
        oldContent: "export const selected = 1;\n", newContent: "export const selected = 2;\n",
      });
      // Code navigation uses the same cwd resolver as Ask AI and review jobs.
      expect(await session.api("/api/code-nav/file?path=app.ts")).toMatchObject({ content: "export const selected = 2;\n" });
      await session.api("/api/git-add", { filePath: "app.ts" });
      expect(git(target, "diff", "--cached")).toContain("selected = 2");
      expect(git(caller, "diff", "--cached")).toBe("");
      await session.api("/api/git-add", { filePath: "app.ts", undo: true });
      expect(git(target, "diff", "--cached")).toBe("");

      writeFileSync(join(target, "app.ts"), "export const selected = 3;\n");
      expect(await session.api(`/api/diff/fresh?snapshot=${diff.snapshotId}`)).toMatchObject({ fresh: false });
      diff = await session.api("/api/diff/switch", { diffType: "since-base", base: "target-base" });
      expect(diff.rawPatch).toContain("+export const selected = 3;");
      const progressPath = `/api/review-progress?snapshot=${diff.snapshotId}`;
      const progress = await session.api(progressPath);
      expect(progress.available).toBe(true);
      await session.api(progressPath, {
        key: progress.key,
        changes: [{ path: "app.ts", fingerprint: progress.fingerprints["app.ts"], viewed: true }],
      });
      await session.api("/api/feedback", { feedback: "Check the selected change.", annotations: [] });
      const output = await session.finish();
      expect(output.feedback ?? output.message).toContain(`Review directory: ${target}`);
      expect(output.feedback ?? output.message).toContain("Check the selected change.");
      const archived = JSON.parse(readFileSync(join(dataDir, "feedback", "selected-repo", "index.jsonl"), "utf8").trim());
      expect(archived.target.review.cwd).toBe(target);
      expect(archived.feedback).toBe("Check the selected change.");
      expect(existsSync(join(dataDir, "feedback", "caller"))).toBe(false);
    } finally {
      session.stop();
    }
    // Opening B from B without a target must restore the very same progress.
    const reopened = await launch(target, ["--base", "target-base", "--diff-type", "since-base"], dataDir, bridge);
    try {
      const diff = await reopened.api("/api/diff");
      expect(await reopened.api(`/api/review-progress?snapshot=${diff.snapshotId}`)).toMatchObject({ viewedFiles: ["app.ts"] });
      await reopened.api("/api/exit", {});
      await reopened.finish();
    } finally {
      reopened.stop();
    }
    expect(readFileSync(join(caller, "app.ts"), "utf8")).toBe("export const caller = 2;\n");
    expect(process.cwd()).toBe(hostCwd);
  }, 30_000);

  test(`${bridge ? "OpenCode bridge" : "CLI"}: subdirectory targets normalize to the repo and feedback follows a worktree switch`, async () => {
    const { root, caller, target, dataDir } = fixture();
    mkdirSync(join(target, "src"));
    writeFileSync(join(target, "src/nested.ts"), "export const nested = 1;\n");
    const worktree = join(root, "another worktree");
    git(target, "worktree", "add", "-qb", "another-branch", worktree);
    writeFileSync(join(worktree, "app.ts"), "export const switched = 42;\n");
    const session = await launch(caller, [relative(caller, join(target, "src"))], dataDir, bridge);
    try {
      const diff = await session.api("/api/diff");
      expect(diff.gitContext.cwd).toBe(target);
      expect(await session.api("/api/code-nav/file?path=src/nested.ts")).toMatchObject({ content: "export const nested = 1;\n" });
      const switched = await session.api("/api/diff/switch", { diffType: `worktree:${worktree}:uncommitted` });
      expect(switched.rawPatch).toContain("switched = 42");
      await session.api("/api/feedback", { feedback: "Check app.ts.", annotations: [], approved: true });
      const output = await session.finish();
      expect(output.feedback ?? output.message).toContain(`Review directory: ${worktree}`);
      expect(output.feedback ?? output.message).not.toContain(`Review directory: ${target}`);
    } finally {
      session.stop();
    }
  }, 15_000);
}

test("direct CLI honors PLANNOTATOR_CWD only for an explicit directory", async () => {
  const { root, caller, target, dataDir } = fixture();
  for (const [args, expected] of [[["selected repo"], "selected = 2"], [[], "caller = 2"]] as const) {
    const session = await launch(caller, [...args], dataDir, false, root);
    try {
      expect((await session.api("/api/diff")).rawPatch).toContain(expected);
      await session.api("/api/exit", {});
      await session.finish();
    } finally {
      session.stop();
    }
  }
}, 15_000);

test("a selected linked worktree and a multi-repo parent use existing discovery", async () => {
  const { root, caller, target, dataDir } = fixture();
  const worktree = join(root, "feature worktree");
  git(target, "worktree", "add", "-qb", "feature", worktree);
  writeFileSync(join(worktree, "app.ts"), "export const worktree = 42;\n");
  for (const [directory, expected] of [[worktree, "worktree = 42"], [root, "caller/app.ts"]]) {
    const session = await launch(caller, [directory], dataDir);
    try {
      const diff = await session.api("/api/diff");
      expect(diff.rawPatch).toContain(expected);
      if (directory === worktree) expect(diff.rawPatch).not.toContain("selected = 2");
      else expect(diff.mode).toBe("workspace");
      await session.api("/api/exit", {});
      await session.finish();
    } finally {
      session.stop();
    }
  }
}, 30_000);

test("invalid targets exit before opening the invoking repository", async () => {
  const { caller, dataDir } = fixture();
  const ready = join(dataDir, "unexpected-ready.json");
  for (const args of [["./missing-directory"], ["app.ts"], [".", "../selected repo"]]) {
    const proc = Bun.spawn([process.execPath, "run", entry, "review", ...args], {
      cwd: caller,
      env: {
        ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_READY_FILE: ready,
        PLANNOTATOR_SKIP_BROWSER_OPEN: "1", PLANNOTATOR_AI: "disabled",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/does not exist|not a directory|only one directory/);
      expect(existsSync(ready)).toBe(false);
    } finally {
      proc.kill();
    }
  }
}, 15_000);
