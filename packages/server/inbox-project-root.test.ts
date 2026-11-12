import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInboxProjectRoots,
  INBOX_PROJECT_CONTAINER_SCAN_MAX,
  inboxGitRunner,
  checkoutsHolderOf,
  isHomeOrRootFolder,
  isHomeOrRootShape,
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

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

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
    const subWorktree = join(root, "library-sub-wt");
    git(submodule, "worktree", "add", "-q", subWorktree, "-b", "sub-feature");
    expect(await resolveInboxProjectRoot(subWorktree)).toMatchObject({ root: submodule, worktree: subWorktree });
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

function appnotesLayout(root: string) {
  const folder = join(root, "workspaces", "projects", "appnotes");
  mkdirSync(join(folder, "worktrees"), { recursive: true });
  for (const sub of ["scripts", "art", ".impeccable"]) mkdirSync(join(folder, sub));
  writeFileSync(join(folder, "DESIGN.md"), "# Design\n");
  const main = join(folder, "worktrees", "main");
  git(root, "init", "-q", main);
  writeFileSync(join(main, "README.md"), "appnotes\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const branch = join(folder, "worktrees", "agent-pr-plan-box");
  git(main, "worktree", "add", "-q", branch, "-b", "agent-pr-plan-box");
  return { folder, main, branch };
}

describe("a plain folder that holds one repository's checkouts", () => {
  test("files into that repository's project, as its checkouts do; the folder is kept as the root an older Inbox used", async () => {
    const { folder, main, branch } = appnotesLayout(tempRoot());
    expect(await resolveInboxProjectRoot(folder)).toEqual({ root: main, name: "appnotes", folder, worktree: folder, settled: true });
    expect(await resolveInboxProjectRoot(branch)).toMatchObject({ root: main, worktree: branch });
  });

  test("a plain subfolder files where its checkouts folder's holder does, as far as three folders up", async () => {
    const { folder, main } = appnotesLayout(tempRoot());
    for (const sub of [join(folder, "scripts"), join(folder, "worktrees")]) {
      expect(await resolveInboxProjectRoot(sub)).toEqual({ root: main, name: "appnotes", folder: sub, worktree: sub, settled: true });
    }
    const near = join(folder, "art", "2026", "q4");
    mkdirSync(near, { recursive: true });
    expect(await resolveInboxProjectRoot(near)).toMatchObject({ root: main, worktree: near });
    const far = join(folder, "art", "2026", "q4", "drafts");
    mkdirSync(far, { recursive: true });
    expect(await resolveInboxProjectRoot(far)).toMatchObject({ root: far, worktree: null });
  });

  test("a stray clone of another repository among many checkouts does not split the folder off; a close count does", async () => {
    const root = tempRoot();
    const { folder, main } = appnotesLayout(root);
    for (const branch of ["billing", "docs"]) git(main, "worktree", "add", "-q", join(folder, "worktrees", branch), "-b", branch);
    git(root, "init", "-q", join(folder, "worktrees", "stray-clone"));
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: main, worktree: folder, settled: true });
    git(root, "init", "-q", join(folder, "worktrees", "another-clone"));
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null });
  });

  test("checkouts in `.worktrees` count the same way; checkouts right in a folder do not", async () => {
    const root = tempRoot();
    const dotted = join(root, "tool");
    mkdirSync(join(dotted, ".worktrees"), { recursive: true });
    const { main } = repoWithWorktree(join(dotted, ".worktrees"), "main");
    expect(await resolveInboxProjectRoot(dotted)).toMatchObject({ root: main, worktree: dotted, settled: true });
    const code = join(root, "code");
    mkdirSync(code);
    repoWithWorktree(code);
    expect(await resolveInboxProjectRoot(code)).toMatchObject({ root: code, worktree: null });
  });

  test("checkouts of two repositories leave the folder its own project", async () => {
    const { folder, main } = appnotesLayout(tempRoot());
    const other = join(tempRoot(), "other");
    git(tempRoot(), "init", "-q", other);
    writeFileSync(join(other, "a.txt"), "a\n");
    git(other, "add", ".");
    git(other, "commit", "-qm", "a");
    git(other, "worktree", "add", "-q", join(folder, "worktrees", "other-fix"), "-b", "fix");
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null, settled: true });
    expect(await resolveInboxProjectRoot(join(folder, "worktrees", "main"))).toMatchObject({ root: main });
  });

  test("a lone main checkout in the worktrees folder makes it the repository's; checkouts of a repository elsewhere do not", async () => {
    const root = tempRoot();
    const wrapper = join(root, "wrapper");
    mkdirSync(join(wrapper, "worktrees"), { recursive: true });
    git(wrapper, "init", "-q", join(wrapper, "worktrees", "only"));
    expect(await resolveInboxProjectRoot(wrapper)).toMatchObject({ root: join(wrapper, "worktrees", "only"), worktree: wrapper });
    const { main } = repoWithWorktree(root);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(join(elsewhere, "worktrees"), { recursive: true });
    git(main, "worktree", "add", "-q", join(elsewhere, "worktrees", "x"), "-b", "x");
    expect(await resolveInboxProjectRoot(elsewhere)).toMatchObject({ root: elsewhere, worktree: null });
  });

  test("a worktrees folder with more entries than the scan reads leaves the folder its own project", async () => {
    const { folder } = appnotesLayout(tempRoot());
    for (let i = 0; i < INBOX_PROJECT_CONTAINER_SCAN_MAX; i += 1) mkdirSync(join(folder, "worktrees", `n${i}`));
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null });
  });

  test("without git the folder is its own project; a git that does not answer for the checkout degrades to the main checkout read from disk", async () => {
    const { folder, main } = appnotesLayout(tempRoot());
    const none: InboxGitRunner = async () => ({ exitCode: 127, stdout: "" });
    expect(await resolveInboxProjectRoot(folder, { git: none })).toMatchObject({ root: folder, worktree: null, settled: true });
    const real = createRealRunnerFor();
    const halfway: InboxGitRunner = async (args, cwd) => (cwd === main ? null : real(args, cwd));
    expect(await resolveInboxProjectRoot(folder, { git: halfway })).toMatchObject({ root: main, worktree: folder, settled: true });
  });

  test("~/work holding the repositories api and web beside worktrees/api-feat is a folder of repositories, not api's", async () => {
    const root = tempRoot();
    const work = join(root, "work");
    mkdirSync(join(work, "worktrees"), { recursive: true });
    const { main: api } = repoWithWorktree(work, "api");
    rmSync(join(work, "api-wt"), { recursive: true, force: true });
    git(api, "worktree", "prune");
    git(work, "init", "-q", join(work, "web"));
    git(api, "worktree", "add", "-q", join(work, "worktrees", "api-feat"), "-b", "api-feat");
    expect(await resolveInboxProjectRoot(work)).toMatchObject({ root: work, worktree: null, settled: true });
    expect(await resolveInboxProjectRoot(join(work, "worktrees"))).toMatchObject({ root: join(work, "worktrees"), worktree: null });
  });

  test("~/work holding a repository right in it beside worktrees/api and worktrees/api-feat is a folder of repositories; without it, api's", async () => {
    const root = tempRoot();
    const work = join(root, "work");
    mkdirSync(join(work, "worktrees"), { recursive: true });
    const notes = join(work, "client-docs", "2024");
    mkdirSync(notes, { recursive: true });
    const api = join(work, "worktrees", "api");
    git(root, "init", "-q", api);
    writeFileSync(join(api, "a.txt"), "a\n");
    git(api, "add", ".");
    git(api, "commit", "-qm", "a");
    git(api, "worktree", "add", "-q", join(work, "worktrees", "api-feat"), "-b", "api-feat");
    git(root, "init", "-q", join(work, "web"));
    for (const folder of [work, notes]) expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null, settled: true });
    expect(await resolveInboxProjectRoot(join(work, "web"))).toMatchObject({ root: join(work, "web") });
    expect(await resolveInboxProjectRoot(join(work, "worktrees", "api-feat"))).toMatchObject({ root: api });
    renameSync(join(work, "web"), join(root, "web"));
    expect(await resolveInboxProjectRoot(work)).toMatchObject({ root: api, worktree: work });
    expect(await resolveInboxProjectRoot(notes)).toMatchObject({ root: api, worktree: notes });
  });

  test("a checkout right in the folder splits it off only when it is of another repository, or its `.git` does not read", async () => {
    const { folder, main } = appnotesLayout(tempRoot());
    git(main, "worktree", "add", "-q", join(folder, "scratch-wt"), "-b", "scratch");
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: main, worktree: folder });
    mkdirSync(join(folder, "broken"));
    writeFileSync(join(folder, "broken", ".git"), "not a gitdir line\n");
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null });
    rmSync(join(folder, "broken"), { recursive: true });
    git(folder, "init", "-q", join(folder, "other"));
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null });
  });

  test("files beside the checkouts folder do not count toward the scan; folders past it leave the folder its own project", async () => {
    const { folder, main } = appnotesLayout(tempRoot());
    for (let i = 0; i < 300; i += 1) writeFileSync(join(folder, `note-${i}.md`), "x\n");
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: main, worktree: folder });
    for (let i = 0; i < INBOX_PROJECT_CONTAINER_SCAN_MAX; i += 1) mkdirSync(join(folder, `d${i}`));
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null });
  });

  test("this user's home (injected) holding a worktrees folder is never a checkouts folder, nor walked up to", async () => {
    const root = tempRoot();
    const home = join(root, "me");
    mkdirSync(join(home, "worktrees"), { recursive: true });
    const notes = join(home, "notes");
    mkdirSync(notes);
    const main = join(home, "worktrees", "main");
    git(root, "init", "-q", main);
    expect(isHomeOrRootFolder(home, home)).toBe(true);
    expect(isHomeOrRootFolder(home, null)).toBe(false);
    for (const shaped of ["/home/bob", "/Users/bob"]) expect(isHomeOrRootFolder(shaped, null)).toBe(true);
    for (const folder of [home, notes]) {
      expect(await checkoutsHolderOf(folder, home)).toBeNull();
      expect(await resolveInboxProjectRoot(folder, { home })).toMatchObject({ root: folder, worktree: null, settled: true });
    }
    await expect(createInboxProjectRoots({ home }).resolve(notes)).resolves.toMatchObject({ root: notes, worktree: null });
    expect(await checkoutsHolderOf(notes, null)).toBe(home);
    expect(await resolveInboxProjectRoot(notes, { home: null })).toMatchObject({ root: main, worktree: notes });
  });

  test("a git that does not answer for linked checkouts whose main checkout lies outside leaves the folder its own; only a main checkout is read from disk", async () => {
    const root = tempRoot();
    const { main } = repoWithWorktree(root, "api");
    const folder = join(root, "holder");
    mkdirSync(join(folder, "worktrees"), { recursive: true });
    git(main, "worktree", "add", "-q", join(folder, "worktrees", "x"), "-b", "x");
    const real = createRealRunnerFor();
    const slow: InboxGitRunner = async (args, cwd) => (cwd.startsWith(join(folder, "worktrees")) || cwd === main ? null : real(args, cwd));
    expect(await resolveInboxProjectRoot(folder, { git: slow })).toMatchObject({ root: folder, worktree: null, settled: true });
  });

  test("a checkout git does not confirm as the repository (a separate git dir), or a main checkout moved out, leaves the folder its own", async () => {
    const root = tempRoot();
    const folder = join(root, "tool");
    mkdirSync(join(folder, "worktrees"), { recursive: true });
    const sep = join(folder, "worktrees", "sep");
    git(root, "init", "-q", "--separate-git-dir", join(root, "sep.git"), sep);
    writeFileSync(join(sep, "a.txt"), "a\n");
    git(sep, "add", ".");
    git(sep, "commit", "-qm", "a");
    expect(await resolveInboxProjectRoot(folder)).toMatchObject({ root: folder, worktree: null });
    const other = join(root, "other");
    mkdirSync(join(other, "worktrees"), { recursive: true });
    const { main } = repoWithWorktree(join(other, "worktrees"), "main");
    const moved = join(root, "moved-main");
    renameSync(main, moved);
    git(moved, "worktree", "repair");
    expect(await resolveInboxProjectRoot(other)).toMatchObject({ root: other, worktree: null });
  });

  test("a symlinked worktrees folder is not followed", async () => {
    const root = tempRoot();
    const { folder } = appnotesLayout(root);
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(join(folder, "worktrees"), join(linked, "worktrees"));
    expect(await resolveInboxProjectRoot(linked)).toMatchObject({ root: linked, worktree: null });
  });

  test("a home folder or a filesystem root, by its shape, is never folded or walked up to", () => {
    for (const folder of ["/Users/x", "/home/x", "C:\\Users\\x", "/root", "/", "C:\\", "\\\\server\\share"]) expect(isHomeOrRootShape(folder)).toBe(true);
    for (const folder of ["/Users/x/work", "/home/x/appnotes", "C:\\Users\\x\\src", "/srv/appnotes", "\\\\server\\share\\appnotes"]) expect(isHomeOrRootShape(folder)).toBe(false);
  });
});

describe("the real git runner", () => {
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
    expect((await roots.resolve(worktree)).root).toBe(main);
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
