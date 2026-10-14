/**
 * Where a path an agent names files its messages (inbox-project-root.ts):
 * the folder, the repository's toplevel, or, for a linked worktree, its main
 * repository. Proved with real git repositories, worktrees, submodules and
 * bare repositories made in temp folders; the cache and the answers an old
 * or missing git gives through a scripted runner. The user's git config is
 * kept out (GIT_CONFIG_GLOBAL=/dev/null, set and restored per test).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInboxProjectRoots,
  inboxGitRunner,
  inboxProjectRootGitEnv,
  nearestProjectHolding,
  resolveInboxProjectRoot,
  type InboxGitRunner,
} from "./inbox-project-root";

const scratch: string[] = [];
const ENV_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Run git in `cwd` for the test's own setup; fails the test when git fails. */
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** git as a runner, for scripted runners that answer some calls themselves. */
function createRealRunnerFor(): InboxGitRunner {
  return async (args, cwd) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  };
}

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-project-root-")));
  scratch.push(root);
  return root;
}

/** A repository with one commit, a subfolder, and a linked worktree beside it (`../<name>-wt`). */
function repoWithWorktree(root: string, name = "api") {
  const main = join(root, name);
  mkdirSync(join(main, "src"), { recursive: true });
  git(root, "init", "-q", main);
  writeFileSync(join(main, "src", "index.ts"), "export {};\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const worktree = join(root, `${name}-wt`);
  git(main, "worktree", "add", "-q", worktree, "-b", "feature");
  return { main, worktree };
}

describe("resolveInboxProjectRoot", () => {
  test("a folder outside any repository is its own project", async () => {
    const root = tempRoot();
    const notes = join(root, "notes");
    mkdirSync(notes);
    expect(await resolveInboxProjectRoot(notes)).toEqual({ root: notes, name: "notes", folder: notes, worktree: null, settled: true });
  });

  test("a subfolder of a repository files under its toplevel", async () => {
    const { main } = repoWithWorktree(tempRoot());
    const resolved = await resolveInboxProjectRoot(join(main, "src"));
    expect(resolved).toEqual({ root: main, name: "api", folder: join(main, "src"), worktree: null, settled: true });
  });

  test("a linked worktree, and any folder in it, folds into the main repository", async () => {
    const { main, worktree } = repoWithWorktree(tempRoot());
    expect(await resolveInboxProjectRoot(worktree)).toEqual({ root: main, name: "api", folder: worktree, worktree, settled: true });
    mkdirSync(join(worktree, "src", "deep"), { recursive: true });
    expect(await resolveInboxProjectRoot(join(worktree, "src", "deep"))).toEqual({
      root: main,
      name: "api",
      folder: join(worktree, "src", "deep"),
      worktree,
      settled: true,
    });
  });

  test("a Claude Code agent worktree inside the repository folds into it", async () => {
    const { main } = repoWithWorktree(tempRoot());
    const agent = join(main, ".claude", "worktrees", "agent-aa0c12ba3edf0ee3f");
    git(main, "worktree", "add", "-q", agent, "-b", "agent");
    expect(await resolveInboxProjectRoot(agent)).toEqual({ root: main, name: "api", folder: agent, worktree: agent, settled: true });
  });

  test("symlinks on either side: the worktree reached through a link, and a main repository reached through one", async () => {
    const root = tempRoot();
    const real = join(root, "real");
    mkdirSync(real);
    const { main, worktree } = repoWithWorktree(real);
    symlinkSync(worktree, join(root, "wt-link"));
    expect(await resolveInboxProjectRoot(join(root, "wt-link"))).toMatchObject({ root: main, folder: worktree, worktree });
    // A worktree made through a symlinked spelling of the main repository.
    symlinkSync(main, join(root, "main-link"));
    const viaLink = join(root, "wt2");
    git(join(root, "main-link"), "worktree", "add", "-q", viaLink, "-b", "second");
    expect(await resolveInboxProjectRoot(viaLink)).toMatchObject({ root: main, worktree: viaLink });
  });

  test("a submodule is not a worktree: it stays its own project, and its own worktrees fold into it", async () => {
    const root = tempRoot();
    const { main: library } = repoWithWorktree(root, "library");
    const superproject = join(root, "app");
    git(root, "init", "-q", superproject);
    writeFileSync(join(superproject, "README.md"), "app\n");
    git(superproject, "add", ".");
    git(superproject, "commit", "-qm", "init");
    git(superproject, "submodule", "add", "-q", library, "vendor/library");
    git(superproject, "commit", "-qm", "submodule");
    const submodule = join(superproject, "vendor", "library");
    expect(await resolveInboxProjectRoot(submodule)).toMatchObject({ root: submodule, worktree: null });
    expect(await resolveInboxProjectRoot(superproject)).toMatchObject({ root: superproject, worktree: null });
    // A linked worktree of the submodule's own repository: its main worktree
    // is the submodule's checkout (git records it as core.worktree).
    const subWorktree = join(root, "library-sub-wt");
    git(submodule, "worktree", "add", "-q", subWorktree, "-b", "sub-feature");
    expect(await resolveInboxProjectRoot(subWorktree)).toMatchObject({ root: submodule, worktree: subWorktree });
    // The superproject's own worktree carries its own submodule checkout: not folded into anything.
    const appWorktree = join(root, "app-wt");
    git(superproject, "worktree", "add", "-q", appWorktree, "-b", "app-feature");
    expect(await resolveInboxProjectRoot(appWorktree)).toMatchObject({ root: superproject, worktree: appWorktree });
  });

  test("a bare repository's worktrees fold into the repository, or the folder holding a `.bare` one", async () => {
    const root = tempRoot();
    const { main } = repoWithWorktree(root);
    const bare = join(root, "service.git");
    git(root, "clone", "-q", "--bare", main, bare);
    const bareWorktree = join(root, "service-main");
    git(bare, "worktree", "add", "-q", bareWorktree, "main");
    expect(await resolveInboxProjectRoot(bareWorktree)).toMatchObject({ root: bare, worktree: bareWorktree });

    const container = join(root, "tool");
    mkdirSync(container);
    git(container, "clone", "-q", "--bare", main, ".bare");
    writeFileSync(join(container, ".git"), "gitdir: ./.bare\n");
    const branch = join(container, "main");
    git(container, "worktree", "add", "-q", branch, "main");
    expect(await resolveInboxProjectRoot(branch)).toEqual({ root: container, name: "tool", folder: branch, worktree: branch, settled: true });
  });

  test("a main repository that was moved: the worktree is its own project until `git worktree repair`", async () => {
    const root = tempRoot();
    const { main, worktree } = repoWithWorktree(root);
    const moved = join(root, "api-moved");
    renameSync(main, moved);
    // The worktree's link points at the old place: git cannot open it, so the folder (its toplevel) is the project.
    expect(await resolveInboxProjectRoot(worktree)).toEqual({ root: worktree, name: "api-wt", folder: worktree, worktree: null, settled: true });
    git(moved, "worktree", "repair", worktree);
    expect(await resolveInboxProjectRoot(worktree)).toMatchObject({ root: moved, worktree });
  });

  test("a main repository that was deleted: the worktree is its own project", async () => {
    const { main, worktree } = repoWithWorktree(tempRoot());
    rmSync(main, { recursive: true, force: true });
    expect(await resolveInboxProjectRoot(worktree)).toMatchObject({ root: worktree, worktree: null });
  });

  test("a separate git dir (`git init --separate-git-dir`): its worktrees keep their own toplevel", async () => {
    const root = tempRoot();
    const work = join(root, "sep-work");
    git(root, "init", "-q", "--separate-git-dir", join(root, "sep.git"), work);
    writeFileSync(join(work, "a.txt"), "a\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "a");
    expect(await resolveInboxProjectRoot(work)).toMatchObject({ root: work, worktree: null });
    const linked = join(root, "sep-wt");
    git(work, "worktree", "add", "-q", linked, "-b", "s");
    // Nothing in sep.git names sep-work as its work tree, so nothing is guessed.
    expect(await resolveInboxProjectRoot(linked)).toMatchObject({ root: linked, worktree: null });
  });

  test("a path that is not an existing absolute folder is refused", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "file.txt"), "x");
    await expect(resolveInboxProjectRoot("relative/path")).rejects.toThrow("must be an absolute path");
    await expect(resolveInboxProjectRoot(join(root, "missing"))).rejects.toThrow("no such folder");
    await expect(resolveInboxProjectRoot(join(root, "file.txt"))).rejects.toThrow("no such folder");
  });
});

describe("the real git runner", () => {
  /** Run `body` with PATH holding only `bin`, restored after. */
  async function withPath<T>(bin: string, body: () => Promise<T>): Promise<T> {
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      return await body();
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  }

  test("a git that runs past the time limit is killed and gives no answer; the resolution is not settled", async () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 5\n");
    chmodSync(join(bin, "git"), 0o755);
    const folder = join(root, "work");
    mkdirSync(folder);
    const started = Date.now();
    const resolved = await withPath(bin, () => resolveInboxProjectRoot(folder, { git: inboxGitRunner(200) }));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(resolved).toMatchObject({ root: folder, worktree: null, settled: false });
  });

  test("no git on this machine is an answer: the folder is the project, settled", async () => {
    const root = tempRoot();
    const empty = join(root, "empty-bin");
    mkdirSync(empty);
    // A worktree, so a git that still ran would fold it and the test would see it.
    const { worktree } = repoWithWorktree(root);
    const resolved = await withPath(empty, () => resolveInboxProjectRoot(worktree, { git: inboxGitRunner(2_000) }));
    expect(resolved).toMatchObject({ root: worktree, worktree: null, settled: true });
  });

  test("GIT_DIR and its kin in the Inbox's environment are cleared: the folder's own repository answers", async () => {
    const root = tempRoot();
    const { main, worktree } = repoWithWorktree(root);
    const { main: other } = repoWithWorktree(root, "other");
    const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = join(other, ".git", "index");
    process.env.GIT_COMMON_DIR = join(other, ".git");
    try {
      expect(await resolveInboxProjectRoot(worktree)).toMatchObject({ root: main, worktree, settled: true });
      expect(inboxProjectRootGitEnv()).not.toHaveProperty("GIT_DIR");
      // Config injected for one run goes too; the config file pointers stay.
      expect(
        inboxProjectRootGitEnv({
          PATH: "/usr/bin",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_PARAMETERS: "'core.worktree'='/elsewhere'",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.worktree",
          GIT_CONFIG_VALUE_0: "/elsewhere",
        }),
      ).toEqual({ PATH: "/usr/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

describe("git answers that do not fit", () => {
  test("a git too old for --git-common-dir echoes the flag back: the toplevel is the project", async () => {
    const { main, worktree } = repoWithWorktree(tempRoot());
    const oldGit: InboxGitRunner = async (args) =>
      args.includes("--git-common-dir") ? { exitCode: 0, stdout: `${worktree}\n${join(main, ".git", "worktrees", "api-wt")}\n--git-common-dir\n` } : null;
    expect(await resolveInboxProjectRoot(worktree, { git: oldGit })).toMatchObject({ root: worktree, worktree: null });
  });

  test("git gives no answer: the folder is the guess, marked unsettled", async () => {
    const { worktree } = repoWithWorktree(tempRoot());
    const none: InboxGitRunner = async () => null;
    expect(await resolveInboxProjectRoot(join(worktree, "src"), { git: none })).toMatchObject({ root: join(worktree, "src"), worktree: null, settled: false });
  });

  test("the worktree answered but its main repository's git did not: the worktree's toplevel, unsettled", async () => {
    const { main, worktree } = repoWithWorktree(tempRoot());
    const real = createRealRunnerFor();
    const halfway: InboxGitRunner = async (args, cwd) => (cwd === main ? null : real(args, cwd));
    expect(await resolveInboxProjectRoot(worktree, { git: halfway })).toMatchObject({ root: worktree, worktree: null, settled: false });
  });

  test("nearestProjectHolding picks the deepest project root that holds the folder", () => {
    const projects = [{ root: "/r" }, { root: "/r/api" }, { root: "/r/api-wt" }, { root: "/other" }];
    expect(nearestProjectHolding(projects, "/r/api/src")).toEqual({ root: "/r/api" });
    expect(nearestProjectHolding(projects, "/r/api-wt")).toEqual({ root: "/r/api-wt" });
    expect(nearestProjectHolding(projects, "/r/apiary")).toEqual({ root: "/r" });
    expect(nearestProjectHolding(projects, "/elsewhere")).toBeNull();
  });
});

describe("createInboxProjectRoots", () => {
  /** A runner that counts calls and can be switched off. */
  function countingGit() {
    const real = createRealRunnerFor();
    const state = { calls: 0, down: false };
    const runner: InboxGitRunner = async (args, cwd) => {
      state.calls += 1;
      return state.down ? null : real(args, cwd);
    };
    return { runner, state };
  }

  test("each folder asks git once; a fresh answer is used as it is", async () => {
    const { main, worktree } = repoWithWorktree(tempRoot());
    const { runner, state } = countingGit();
    const roots = createInboxProjectRoots({ git: runner });
    const [a, b] = await Promise.all([roots.resolve(worktree), roots.resolve(worktree)]);
    expect(a.root).toBe(main);
    expect(b).toEqual(a);
    const asked = state.calls;
    expect(asked).toBeGreaterThan(0);
    expect((await roots.resolve(`${worktree}/`)).root).toBe(main);
    expect(state.calls).toBe(asked);
  });

  test("a stale answer is used while a refresh runs; the refresh lands for the next call", async () => {
    const root = tempRoot();
    const { main, worktree } = repoWithWorktree(root);
    let now = 1_000;
    const { runner } = countingGit();
    const roots = createInboxProjectRoots({ git: runner, ttlMs: 100, now: () => now });
    expect((await roots.resolve(worktree)).root).toBe(main);
    rmSync(main, { recursive: true, force: true });
    now += 200;
    // Stale: answered from memory at once.
    expect((await roots.resolve(worktree)).root).toBe(main);
    // The background refresh saw the deleted main repository.
    await Bun.sleep(200);
    expect((await roots.resolve(worktree)).root).toBe(worktree);
  });

  test("an answer git could not give is used once and never cached", async () => {
    const { main, worktree } = repoWithWorktree(tempRoot());
    const { runner, state } = countingGit();
    const roots = createInboxProjectRoots({ git: runner });
    state.down = true;
    expect((await roots.resolve(worktree)).root).toBe(worktree);
    state.down = false;
    expect((await roots.resolve(worktree)).root).toBe(main);
  });

  test("the oldest folder leaves once the cache is full", async () => {
    const root = tempRoot();
    const { runner, state } = countingGit();
    const roots = createInboxProjectRoots({ git: runner, max: 2 });
    const folders = ["a", "b", "c"].map((name) => {
      mkdirSync(join(root, name));
      return join(root, name);
    });
    for (const folder of folders) await roots.resolve(folder);
    const asked = state.calls;
    await roots.resolve(folders[2]!);
    expect(state.calls).toBe(asked);
    await roots.resolve(folders[0]!);
    expect(state.calls).toBeGreaterThan(asked);
  });

  test("validation errors come before the cache", async () => {
    const roots = createInboxProjectRoots({ git: async () => null });
    await expect(roots.resolve("not/absolute")).rejects.toThrow("must be an absolute path");
  });
});
