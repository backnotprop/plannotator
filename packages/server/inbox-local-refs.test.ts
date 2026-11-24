/**
 * Reviews' "On this computer" +, the server (inbox-local-refs.ts), on scratch repositories. What regresses:
 *  - a worktree folder missing from a project's step, titled by its folder instead of its branch, its detached HEAD not
 *    named by its commit, its uncommitted changes or its commits not on main not said, or the project's own folder
 *    offered as a worktree of itself;
 *  - a branch checked out in a listed folder offered twice; the default branch offered; a branch with nothing beyond
 *    main not counted 0 ("same as main"); 200 branches not all listed (search runs over them in the window), counts
 *    wrong, or more than the cap listed; a git without `%(ahead-behind)` counting more branches than its cap;
 *  - the projects step counting another repository's folders, or offering a folder that is no repository;
 *  - `folder=` taking any path: one outside the project's worktrees, a `..` path, an option-looking value or a `~/`
 *    path with no folder opener behind it accepted (or any git run for a value refused by its form);
 *  - a folder picked through the folder opener not opening, or opening when it is no repository;
 *  - a folder's diff missing its commits not on main, its uncommitted changes or its new files;
 *  - a kept row staying once its branch is in a PR or gone, or a kept branch read through another ref that starts the same;
 *  - a bare repository's own entry (`git clone --bare` with worktrees off it) offered as a folder;
 *  - past the cap of folders, the newest dropped for those git lists first, or a branch checked out in a folder past
 *    the cap offered nowhere (neither folder nor branch), or counted wrong in the projects step;
 *  - a folder kept through "Another folder…" that is a known project's repository not marked as that project's
 *    (the window then shows that work twice), or marked as another project on the same repository than the one
 *    whose folder holds it;
 *  - a worktree on no branch past the cap offered nowhere; one worktree on an unborn branch (all-zero HEAD) or a
 *    commit git can't read throwing the ranking back to git's order;
 *  - a folder row without its real path (the window tells two folders apart by it);
 *  - any read reaching the network, asking anything or writing (refs, HEAD, the index).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxProject } from "@plannotator/core/inbox-types";
import type { ReviewGitRuntime } from "@plannotator/shared/review-core";
import { createInboxLocalRefs, LOCAL_REFS_BRANCHES_MAX, LOCAL_REFS_COUNT_MAX, LOCAL_REFS_FOLDERS_MAX, localFolderFormOk } from "./inbox-local-refs";
import { runtime } from "./git";

const DAY = 86_400;

function git(repo: string, args: string[], env: Record<string, string> = {}, input?: string): string {
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf-8", env: { ...process.env, ...env }, input });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function commitAt(repo: string, file: string, seconds: number): string {
  writeFileSync(join(repo, file), `${file} ${seconds}\n`);
  git(repo, ["add", file]);
  const date = `@${seconds} +0000`;
  git(repo, ["commit", "--quiet", "-m", file], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(repo, ["rev-parse", "HEAD"]);
}

function branchAt(repo: string, name: string, seconds: number, commits = 1) {
  git(repo, ["checkout", "--quiet", "-b", name, "main"]);
  for (let i = 0; i < commits; i++) commitAt(repo, `${name.replace(/\//g, "-")}-${i}.txt`, seconds + i);
  git(repo, ["checkout", "--quiet", "main"]);
}

/**
 * harbor: main, with a remote that does not exist; Charlie's and Ada's branches; release/2.4 with nothing beyond main;
 * worktrees `wt-login` (on fix/login-redirect-loop, changed and a new file), `bob-spike` (detached, one commit) and
 * `wt-onboarding` (on feat/onboarding-v2, same as main).
 */
function harbor(now: number) {
  const repo = join(mkdtempSync(join(tmpdir(), "local-refs-")), "harbor");
  mkdirSync(repo);
  git(repo, ["init", "--quiet", "-b", "main"]);
  git(repo, ["remote", "add", "origin", "https://example.invalid/charlie/never.git"]);
  commitAt(repo, "base.txt", now - 60 * DAY);
  branchAt(repo, "charlie/search-ranking", now - 21 * DAY, 6);
  branchAt(repo, "ada/csv-import", now - 22 * DAY, 3);
  branchAt(repo, "fix/login-redirect-loop", now - 600, 1);
  git(repo, ["branch", "release/2.4", "main"]);
  git(repo, ["branch", "feat/onboarding-v2", "main"]);
  const trees = join(mkdtempSync(join(tmpdir(), "local-refs-trees-")));
  const login = join(trees, "wt-login");
  const spike = join(trees, "bob-spike");
  const onboarding = join(trees, "wt-onboarding");
  git(repo, ["worktree", "add", "--quiet", login, "fix/login-redirect-loop"]);
  writeFileSync(join(login, "fix-login-redirect-loop-0.txt"), "changed by Ada Novak\n");
  writeFileSync(join(login, "redirect.test.ts"), "export const loops = 1;\n");
  git(repo, ["worktree", "add", "--quiet", "--detach", spike, "main"]);
  commitAt(spike, "tiles.ts", now - 3600);
  git(repo, ["worktree", "add", "--quiet", onboarding, "feat/onboarding-v2"]);
  return { repo, login, spike, onboarding, spikeHead: git(spike, ["rev-parse", "--short", "HEAD"]) };
}

const project = (id: string, root: string): InboxProject => ({ id, key: `${id}-k`, name: id, root, created_at: "2026-11-01T00:00:00.000Z" });

function watched(base: ReviewGitRuntime = runtime) {
  const commands: { args: string[]; options: Parameters<ReviewGitRuntime["runGit"]>[1] }[] = [];
  return {
    commands,
    runtime: {
      ...base,
      runGit: (args: string[], given?: Parameters<ReviewGitRuntime["runGit"]>[1]) => {
        commands.push({ args, options: given });
        return base.runGit(args, given);
      },
      runGitBytes: (args: string[], given?: Parameters<ReviewGitRuntime["runGit"]>[1]) => {
        commands.push({ args, options: given });
        return base.runGitBytes!(args, given);
      },
    } satisfies ReviewGitRuntime,
  };
}

/** Commands that write or reach out: none may run. */
const WRITES = /^(fetch|pull|push|checkout|switch|reset|commit|merge(?!-base)|rebase|stash|clean|update-ref|update-index|worktree (add|remove|prune)|branch|tag|gc|maintenance|remote|config (?!--get))/;

function onlyGuardedReads(seen: ReturnType<typeof watched>) {
  expect(seen.commands.length).toBeGreaterThan(0);
  for (const { args, options } of seen.commands) {
    const line = args.join(" ");
    if (WRITES.test(line)) throw new Error(`not a read: git ${line}`);
    expect(options?.interaction).toBe("forbid");
    expect(options?.config?.["protocol.allow"]).toBe("never");
    expect(options?.env?.GIT_NO_LAZY_FETCH).toBe("1");
    expect(options?.env?.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(options?.config?.["core.fsmonitor"]).toBe("false");
  }
}

function repoState(repo: string) {
  const index = join(git(repo, ["rev-parse", "--absolute-git-dir"]), "index");
  return { refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), head: git(repo, ["symbolic-ref", "-q", "HEAD"]), index: readFileSync(index).toString("base64"), indexTime: statSync(index).mtimeMs };
}

const service = (seen: ReviewGitRuntime, projects: InboxProject[], extra: Partial<Parameters<typeof createInboxLocalRefs>[0]> = {}) =>
  createInboxLocalRefs({ runtime: seen, projects: () => projects, project: (id) => projects.find((p) => p.id === id) ?? null, skip: () => false, ...extra });

/** Many branches in one process: `count` branches off main, branch i with i % 7 + 1 commits of its own, newest first by name order. */
function manyBranches(repo: string, count: number, now: number, prefix = "bulk") {
  const main = git(repo, ["rev-parse", "main"]);
  let stream = "";
  for (let i = 0; i < count; i++) {
    const commits = (i % 7) + 1;
    for (let c = 0; c < commits; c++) {
      const when = now - (i + 1) * 3600 + c;
      stream += `commit refs/heads/${prefix}/b-${String(i).padStart(3, "0")}\ncommitter Bob Tully <bob@example.invalid> ${when} +0000\ndata 2\nb\n`;
      if (c === 0) stream += `from ${main}\n`;
      stream += `M 644 inline f-${i}-${c}.txt\ndata 2\nx\n\n`;
    }
  }
  git(repo, ["fast-import", "--quiet"], {}, stream);
}

describe("a project's step", () => {
  test("its worktree folders (titled by their branch, or their commit on none) and its branches, each counted; nothing written", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const before = repoState(h.repo);
    const seen = watched();
    const refs = service(seen.runtime, [project("prj_harbor", h.repo)], { now: () => now * 1000 });
    const answer = (await refs.refs(project("prj_harbor", h.repo)))!;
    expect(answer.base).toBe("main");
    const real = (path: string) => realpathSync(path);
    const folders = answer.folders.map((f) => ({ folder: real(f.folder!), branch: f.branch, head: f.head, ahead: f.ahead, uncommitted: f.uncommitted }));
    expect(folders).toEqual([
      // Newest first: its new file is now.
      { folder: real(h.login), branch: "fix/login-redirect-loop", head: null, ahead: 1, uncommitted: true },
      { folder: real(h.spike), branch: null, head: h.spikeHead, ahead: 1, uncommitted: false },
      { folder: real(h.onboarding), branch: "feat/onboarding-v2", head: null, ahead: 0, uncommitted: false },
    ]);
    // The project's own folder is not a worktree to open; main is not a branch to open; a branch checked out in a
    // listed folder is offered once, as the folder.
    expect(answer.folders.some((f) => real(f.folder!) === real(h.repo))).toBe(false);
    expect(answer.branches.map((b) => [b.branch, b.ahead])).toEqual([
      ["charlie/search-ranking", 6],
      ["ada/csv-import", 3],
      ["release/2.4", 0],
    ]);
    onlyGuardedReads(seen);
    expect(repoState(h.repo)).toEqual(before);
  });

  test("200 branches are all listed with their counts; past the cap the newest are; a git without ahead-behind counts up to its cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = join(mkdtempSync(join(tmpdir(), "local-refs-many-")), "tide");
    mkdirSync(repo);
    git(repo, ["init", "--quiet", "-b", "main"]);
    commitAt(repo, "base.txt", now - 400 * DAY);
    manyBranches(repo, 200, now);
    const refs = service(runtime, [project("prj_tide", repo)], { now: () => now * 1000 });
    const answer = (await refs.refs(project("prj_tide", repo)))!;
    expect(answer.branches).toHaveLength(200);
    expect(answer.branches[0]!.branch).toBe("bulk/b-000");
    expect(answer.branches.every((b, i) => b.ahead === (Number(b.branch!.slice(-3)) % 7) + 1 && (i === 0 || answer.branches[i - 1]!.at >= b.at))).toBe(true);
    // Words in a name find it among them all (the window searches what this lists).
    expect(answer.branches.filter((b) => b.branch!.includes("b-19"))).toHaveLength(10);

    // Past the cap: the newest `LOCAL_REFS_BRANCHES_MAX`.
    manyBranches(repo, LOCAL_REFS_BRANCHES_MAX + 20 - 200, now - 300 * 3600, "older");
    const capped = (await service(runtime, [project("prj_tide", repo)], { now: () => now * 1000 }).refs(project("prj_tide", repo)))!;
    expect(capped.branches).toHaveLength(LOCAL_REFS_BRANCHES_MAX);

    // A git that has no %(ahead-behind): one count each, for the newest `LOCAL_REFS_COUNT_MAX` only.
    const old: ReviewGitRuntime = {
      ...runtime,
      runGit: (args, given) => (args.some((arg) => arg.includes("%(ahead-behind:")) ? Promise.resolve({ stdout: "", stderr: "fatal: unknown field name: ahead-behind", exitCode: 128 }) : runtime.runGit(args, given)),
    };
    const seen = watched(old);
    const slow = (await service(seen.runtime, [project("prj_tide", repo)], { now: () => now * 1000 }).refs(project("prj_tide", repo)))!;
    expect(slow.branches).toHaveLength(LOCAL_REFS_BRANCHES_MAX);
    expect(slow.branches.slice(0, LOCAL_REFS_COUNT_MAX).every((b) => typeof b.ahead === "number" && b.ahead > 0)).toBe(true);
    expect(slow.branches.slice(LOCAL_REFS_COUNT_MAX).every((b) => b.ahead === null)).toBe(true);
    expect(seen.commands.filter((c) => c.args[0] === "rev-list" && c.args[1] === "--count")).toHaveLength(LOCAL_REFS_COUNT_MAX);
  }, 60_000);

  test("the projects step: each project whose folder is a repository here, with its folders and branches; no repository, no project", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const plain = mkdtempSync(join(tmpdir(), "local-refs-plain-"));
    const refs = service(runtime, [project("prj_plain", plain), project("prj_harbor", h.repo)], { anotherFolder: () => true, home: "/home/charlie" });
    expect(await refs.projects()).toEqual({ projects: [{ project_id: "prj_harbor", folders: 3, branches: 3 }], another_folder: true, home: "/home/charlie" });
  });
});

describe("folder=", () => {
  test("a worktree git lists for the project's repository opens its whole work: commits not on main, uncommitted changes and new files", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const before = repoState(h.repo);
    const seen = watched();
    const refs = service(seen.runtime, [project("prj_harbor", h.repo)]);
    const login = (await refs.diff(project("prj_harbor", h.repo), h.login))!;
    expect(login).toMatchObject({ kind: "folder", branch: "fix/login-redirect-loop", base: "main", ahead: 1, uncommitted: true, folder: h.login, head: null });
    expect(login.patch).toContain("+changed by Ada Novak");
    expect(login.patch).toContain("redirect.test.ts");
    const spike = (await refs.diff(project("prj_harbor", h.repo), h.spike))!;
    expect(spike).toMatchObject({ kind: "folder", branch: null, head: h.spikeHead, ahead: 1, uncommitted: false });
    expect(spike.patch).toContain("tiles.ts");
    const same = (await refs.diff(project("prj_harbor", h.repo), h.onboarding))!;
    expect(same).toMatchObject({ ahead: 0, uncommitted: false, patch: "" });
    onlyGuardedReads(seen);
    expect(repoState(h.repo)).toEqual(before);
  });

  test("refused: a folder outside the project's worktrees, a `..` path, an option-looking value, a ~/ path with no folder opener", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const other = harbor(now);
    const seen = watched();
    const refs = service(seen.runtime, [project("prj_harbor", h.repo)]);
    const p = project("prj_harbor", h.repo);
    // Another repository, and another repository's worktree: not this project's.
    expect(await refs.diff(p, other.repo)).toBeNull();
    expect(await refs.diff(p, other.login)).toBeNull();
    expect(await refs.allowed(p, other.login)).toBe(false);
    // A listed worktree reached through `..`, values git could read as options, a bare name, a NUL: refused by their
    // form, before any git runs.
    const before = seen.commands.length;
    for (const value of [`${h.login}/../wt-login`, "--output=/tmp/x", "-c", "wt-login", "", "/a\0b"]) {
      expect(localFolderFormOk(value)).toBe(false);
      expect(await refs.diff(p, value)).toBeNull();
    }
    // A `~/` path is only the folder opener's to accept: with none behind it, refused, and no git runs either.
    expect(await refs.diff(p, "~/code/harbor")).toBeNull();
    expect(seen.commands.length).toBe(before);
    // The listed one is accepted.
    expect(await refs.allowed(p, h.login)).toBe(true);
  });

  test("a folder picked through the folder opener opens by its rules, with no project; one that is no repository does not", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const plain = mkdtempSync(join(tmpdir(), "local-refs-plain-"));
    const asked: string[] = [];
    const picked = { "~/code/harbor": h.repo, "~/code/plain": plain } as Record<string, string>;
    const refs = service(runtime, [], {
      pickedFolder: async (folder) => {
        asked.push(folder);
        return picked[folder] ?? null;
      },
    });
    const answer = (await refs.diff(null, "~/code/harbor"))!;
    expect(answer).toMatchObject({ project_id: "", kind: "folder", folder: "~/code/harbor", branch: "main", ahead: 0 });
    expect(await refs.diff(null, "~/code/plain")).toBeNull();
    // The opener refuses it (hidden, a system folder, Launch off): refused here too.
    expect(await refs.diff(null, "~/code/.secret")).toBeNull();
    expect(asked).toEqual(["~/code/harbor", "~/code/plain", "~/code/.secret"]);
  });
});

describe("kept rows", () => {
  test("a kept branch and folder are read again; one in a PR, gone, refused or only a ref that starts the same is left out", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    branchAt(h.repo, "fix/other", now - DAY);
    let inPull = "";
    const refs = createInboxLocalRefs({
      runtime,
      projects: () => [project("prj_harbor", h.repo)],
      project: (id) => (id === "prj_harbor" ? project("prj_harbor", h.repo) : null),
      skip: (_p, branch) => branch === inPull,
      now: () => Date.now(),
    });
    const rows = await refs.kept(["prj_harbor:charlie/search-ranking", `prj_harbor::${h.spike}`, "prj_harbor:gone/branch", "prj_harbor:fix", `prj_harbor::${tmpdir()}`, "prj_other:charlie/search-ranking", "prj_harbor:"]);
    expect(rows.map((row) => [row.kind, row.branch ?? row.head, row.ahead])).toEqual([
      ["branch", "charlie/search-ranking", 6],
      ["folder", h.spikeHead, 1],
    ]);
    // It got a PR: it leaves (a fresh service: answers are kept a while).
    inPull = "charlie/search-ranking";
    const again = createInboxLocalRefs({ runtime, projects: () => [], project: (id) => (id === "prj_harbor" ? project("prj_harbor", h.repo) : null), skip: (_p, branch) => branch === inPull });
    expect((await again.kept(["prj_harbor:charlie/search-ranking"])).length).toBe(0);
  });
});

describe("worktrees: bare, and past the cap", () => {
  test("a bare clone with worktrees: its bare entry is no folder; the worktrees are", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "local-refs-bare-")));
    const bare = join(root, "harbor.git");
    spawnSync("git", ["clone", "--quiet", "--bare", h.repo, bare], { encoding: "utf-8" });
    const main = join(root, "main");
    const feature = join(root, "feature");
    git(bare, ["worktree", "add", "--quiet", main, "main"]);
    git(bare, ["worktree", "add", "--quiet", feature, "charlie/search-ranking"]);
    // git lists the bare repository first, with a `bare` line.
    expect(git(bare, ["worktree", "list", "--porcelain"])).toContain("bare");
    const answer = (await service(runtime, [project("prj_bare", main)]).refs(project("prj_bare", main)))!;
    expect(answer.folders.map((row) => [row.branch, row.folder])).toEqual([["charlie/search-ranking", feature]]);
    expect(answer.folders.some((row) => row.folder === bare)).toBe(false);
    const steps = await service(runtime, [project("prj_bare", main)]).projects();
    expect(steps.projects.map((p) => p.folders)).toEqual([1]);
  });

  test("25 worktrees: the 20 newest listed, newest first; a branch in a folder past the cap is a branch row; the projects step agrees", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = join(mkdtempSync(join(tmpdir(), "local-refs-many-trees-")), "harbor");
    mkdirSync(repo);
    git(repo, ["init", "--quiet", "-b", "main"]);
    commitAt(repo, "base.txt", now - 90 * DAY);
    const trees = mkdtempSync(join(tmpdir(), "local-refs-many-trees-wt-"));
    // Worktree i: branch wt/i, one commit i days old, added oldest first, so git lists the oldest first.
    for (let i = 24; i >= 0; i--) {
      branchAt(repo, `wt/${String(i).padStart(2, "0")}`, now - (i + 1) * DAY);
      git(repo, ["worktree", "add", "--quiet", join(trees, `tree-${String(i).padStart(2, "0")}`), `wt/${String(i).padStart(2, "0")}`]);
    }
    const p = project("prj_many", repo);
    const answer = (await service(runtime, [p]).refs(p))!;
    expect(LOCAL_REFS_FOLDERS_MAX).toBe(20);
    expect(answer.folders.map((row) => row.branch)).toEqual(Array.from({ length: 20 }, (_, i) => `wt/${String(i).padStart(2, "0")}`));
    // The five oldest folders' branches are offered as branches, not lost.
    expect(answer.branches.map((row) => row.branch)).toEqual(["wt/20", "wt/21", "wt/22", "wt/23", "wt/24"]);
    const steps = await service(runtime, [p]).projects();
    expect(steps.projects).toEqual([{ project_id: "prj_many", folders: 20, branches: 5 }]);
  });
});

describe("a folder kept through Another folder…", () => {
  test("a known project's repository (its folder or a worktree) is marked as that project's; another repository is not", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const other = join(mkdtempSync(join(tmpdir(), "local-refs-other-")), "notes");
    mkdirSync(other);
    git(other, ["init", "--quiet", "-b", "main"]);
    commitAt(other, "notes.txt", now - DAY);
    const picked = { "~/code/harbor": h.repo, "~/code/wt-login": h.login, "~/code/notes": other } as Record<string, string>;
    const refs = service(runtime, [project("prj_harbor", h.repo)], { pickedFolder: async (folder) => picked[folder] ?? null });
    const rows = await refs.kept(["::~/code/harbor", "::~/code/wt-login", "::~/code/notes"]);
    expect(rows.map((row) => [row.project_id, row.folder, row.branch, row.in_project ?? null])).toEqual([
      ["", "~/code/harbor", "main", "prj_harbor"],
      ["", "~/code/wt-login", "fix/login-redirect-loop", "prj_harbor"],
      ["", "~/code/notes", "main", null],
    ]);
  });
});

describe("past the cap: on no branch, an unborn branch", () => {
  test("a worktree on an unborn branch among them ranks oldest and the rest keep their order; one on no branch past the cap is listed unread", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "local-refs-orphan-"))), "harbor");
    mkdirSync(repo);
    git(repo, ["init", "--quiet", "-b", "main"]);
    commitAt(repo, "base.txt", now - 90 * DAY);
    const trees = realpathSync(mkdtempSync(join(tmpdir(), "local-refs-orphan-wt-")));
    // An unborn branch first in git's list (`--orphan`: HEAD all zeros), then 20 worktrees, newest added first so
    // git's order is the reverse of the newest-first order.
    git(repo, ["worktree", "add", "--quiet", "--orphan", "-b", "empty/start", join(trees, "a-orphan")]);
    for (let i = 0; i < 20; i++) {
      const name = `wt/${String(i).padStart(2, "0")}`;
      branchAt(repo, name, now - (i + 1) * DAY);
      git(repo, ["worktree", "add", "--quiet", join(trees, `tree-${String(i).padStart(2, "0")}`), name]);
    }
    // Two worktrees on no branch, older than all 20: past the cap.
    const spike = join(trees, "z-spike");
    git(repo, ["worktree", "add", "--quiet", "--detach", spike, "main"]);
    commitAt(spike, "spike.txt", now - 40 * DAY);
    const plain = join(trees, "z-plain");
    git(repo, ["worktree", "add", "--quiet", "--detach", plain, "main"]);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(`HEAD ${"0".repeat(40)}`);
    const p = project("prj_orphan", repo);
    const answer = (await service(runtime, [p]).refs(p))!;
    // Read whole: the 20 newest, newest first (the unborn one is the oldest, so past the cap and, on a branch, not listed).
    const whole = answer.folders.filter((row) => row.ahead !== null);
    expect(whole.map((row) => row.branch)).toEqual(Array.from({ length: 20 }, (_, i) => `wt/${String(i).padStart(2, "0")}`));
    // Past them, on no branch: listed unread, newest first, each with its commit and real path, and opens.
    const unread = answer.folders.filter((row) => row.ahead === null);
    expect(unread.map((row) => [row.folder, row.branch, row.head?.length, row.folder_real])).toEqual([
      [spike, null, 7, spike],
      [plain, null, 7, plain],
    ]);
    expect(await service(runtime, [p]).allowed(p, spike)).toBe(true);
    expect((await service(runtime, [p]).projects()).projects).toEqual([{ project_id: "prj_orphan", folders: 22, branches: 0 }]);
    // Every folder row says its real path.
    expect(whole.every((row) => row.folder_real === row.folder)).toBe(true);
  });
});

describe("two projects on one repository", () => {
  test("a folder kept through Another folder… is marked as the project whose folder holds it", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = harbor(now);
    const picked = { "~/code/harbor": h.repo, "~/code/wt-login": h.login } as Record<string, string>;
    // The worktree's project is listed second: the folder that holds it wins, not the first on the repository.
    const projects = [project("prj_harbor", h.repo), project("prj_login", h.login)];
    const refs = service(runtime, projects, { pickedFolder: async (folder) => picked[folder] ?? null });
    const rows = await refs.kept(["::~/code/wt-login", "::~/code/harbor"]);
    expect(rows.map((row) => [row.folder, row.in_project])).toEqual([
      ["~/code/wt-login", "prj_login"],
      ["~/code/harbor", "prj_harbor"],
    ]);
  });
});
