/**
 * Reviews' "On this computer" (inbox-local-work.ts), on scratch repositories. What regresses:
 *  - a branch with work of its own and no PR missing from the list, or an old branch, the default branch, one with
 *    nothing of its own or one with an open PR listed;
 *  - a folder's uncommitted changes missing, named by the wrong branch, or dated by anything but its files;
 *  - a repository read twice through its worktrees, or a folder that is gone breaking the whole list;
 *  - any read reaching the network, asking anything, or writing to the repository (the index refreshed, a ref moved,
 *    a checkout), or reading more projects or branches than its caps, or fewer than Branch reviews' safety net (30 of
 *    the newest 120);
 *  - a branch's count of commits not on main missing; a project with nothing not named so (`quiet`), or one with no
 *    git repository here not named so (`not_git`);
 *  - every read of the list running git again instead of the kept answer;
 *  - a row's diff missing its changes, or a branch's diff checking the branch out;
 *  - a branch hidden by a same-named branch's open PR on another repository, or listed beside its own repository's
 *    open PR (or its fork's); a squash- or rebase-merged branch listed (its upstream gone, or its head a merged PR's);
 *  - a branch diff past its cap drawn cut instead of said too large;
 *  - a background read starting a repository's fsmonitor, gc or maintenance;
 *  - one working tree's uncommitted changes listed under each project inside it;
 *  - a branch's diff (the row's, New review's summary) against another base than its count (a stale local main adding
 *    others' merged work); a branch diff that can't be read or is past its cap summed as no changes;
 *  - a list filtered to one project missing its rows because other projects filled the cap;
 *  - a branch reported (or in a PR) from one worktree project listed through another of the same repository;
 *  - a repository whose default is neither main nor master (a local-only `trunk`) listing nothing, or a failed read
 *    named quiet ("nothing") for any project of its repository, or counted unread once per project;
 *  - the uncommitted diff sent whole past the branch diff's cap, or every new file read before the cap is checked;
 *  - a folder whose uncommitted changes can't be read (a slow `git status`) counted unread, though its branches list.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxProject, InboxPull } from "@plannotator/core/inbox-types";
import type { ReviewGitRuntime } from "@plannotator/shared/review-core";
import { BRANCH_DIFF_MAX_BYTES, BRANCH_GIT_TIMEOUT_MS } from "./inbox-branch-reports";
import { BranchDiffTooLarge, createInboxLocalWork, localBranchInPull, LOCAL_WORK_BRANCHES_MAX, LOCAL_WORK_CACHE_MS, LOCAL_WORK_PROJECTS_MAX, LOCAL_WORK_ROWS_MAX, LOCAL_WORK_SCAN_MAX } from "./inbox-local-work";
import { readInboxReviewChanges } from "./inbox-review-changes";
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

/** A branch off main with one commit of its own, left unchecked-out. */
function branchAt(repo: string, name: string, seconds: number) {
  git(repo, ["checkout", "--quiet", "-b", name, "main"]);
  commitAt(repo, `${name.replace(/\//g, "-")}.txt`, seconds);
  git(repo, ["checkout", "--quiet", "main"]);
}

/** main with a remote that does not exist (any fetch would fail loudly), and Ada's and Bob's branches. */
function scratchRepo(now: number) {
  const repo = mkdtempSync(join(tmpdir(), "local-work-"));
  git(repo, ["init", "--quiet", "-b", "main"]);
  git(repo, ["remote", "add", "origin", "https://example.invalid/charlie/never.git"]);
  commitAt(repo, "base.txt", now - 30 * DAY);
  branchAt(repo, "ada/retry-jitter", now - 2 * DAY);
  branchAt(repo, "bob/old-spike", now - 20 * DAY);
  branchAt(repo, "bob/has-a-pr", now - DAY);
  git(repo, ["branch", "same-as-main"]);
  return repo;
}

const project = (id: string, root: string): InboxProject => ({ id, key: `${id}-k`, name: id, root, created_at: "2026-11-01T00:00:00.000Z" });

function watched(): { runtime: ReviewGitRuntime; commands: { args: string[]; cwd?: string; options: Parameters<ReviewGitRuntime["runGit"]>[1] }[] } {
  const commands: { args: string[]; cwd?: string; options: Parameters<ReviewGitRuntime["runGit"]>[1] }[] = [];
  return {
    commands,
    runtime: {
      ...runtime,
      runGit: (args, given) => {
        commands.push({ args, cwd: given?.cwd, options: given });
        return runtime.runGit(args, given);
      },
      runGitBytes: (args, given) => {
        commands.push({ args, cwd: given?.cwd, options: given });
        return runtime.runGitBytes!(args, given);
      },
    },
  };
}

/** The exact read-only commands the list and the diffs may run: anything else (a fetch, a checkout, a write) fails. */
const READ_SHAPES: RegExp[] = [
  /^--version$/,
  /^rev-parse --is-inside-work-tree( --path-format=absolute --show-toplevel --git-common-dir)?$/,
  /^rev-parse --verify --quiet( --short HEAD| --end-of-options \S+\^\{commit\}| HEAD)$/,
  /^rev-parse --verify HEAD$/,
  /^rev-parse --show-toplevel$/,
  /^symbolic-ref (refs\/remotes\/origin\/HEAD|-q --short HEAD)$/,
  /^config --get init\.defaultBranch$/,
  /^show-ref --verify( --quiet)? refs\/(heads|remotes\/origin)\/[\w./-]+$/,
  /^for-each-ref --sort=-committerdate --format=%\(refname\)%00%\(committerdate:unix\)%00%\(objectname\)%00%\(upstream:track\) refs\/heads\/$/,
  /^rev-list --count --end-of-options \S+\.\.refs\/heads\/[\w./-]+$/,
  /^worktree list --porcelain$/,
  /^status --porcelain=v1 -z --no-renames --untracked-files=normal --ignore-submodules=dirty$/,
  /^diff --no-ext-diff --no-textconv --no-relative --no-color --end-of-options \S+\.\.\.refs\/heads\/[\w./-]+$/,
  /^diff --no-textconv --raw -z --no-abbrev --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ --end-of-options HEAD$/,
  /^diff --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ --end-of-options HEAD$/,
  /^cat-file --batch-check=%\(objectname\) %\(objecttype\) %\(objectsize\)$/,
  /^rev-parse --abbrev-ref HEAD$/,
  /^ls-files --others --exclude-standard$/,
  /^diff --no-ext-diff --no-index --src-prefix=a\/ --dst-prefix=b\/ \/dev\/null \S+$/,
];

function onlyGuardedReads(seen: ReturnType<typeof watched>) {
  expect(seen.commands.length).toBeGreaterThan(0);
  for (const { args, options } of seen.commands) {
    const line = args.join(" ");
    if (!READ_SHAPES.some((shape) => shape.test(line))) throw new Error(`not a guarded read: git ${line}`);
    expect(options?.interaction).toBe("forbid");
    expect(options?.config?.["protocol.allow"]).toBe("never");
    expect(options?.env?.GIT_NO_LAZY_FETCH).toBe("1");
    expect(options?.env?.GIT_OPTIONAL_LOCKS).toBe("0");
    // Nothing the repository configures starts from a background read.
    expect(options?.config?.["core.fsmonitor"]).toBe("false");
    expect(options?.config?.["maintenance.auto"]).toBe("false");
    expect(options?.config?.["gc.auto"]).toBe("0");
  }
}

/** What a write would change: every ref, HEAD, the index's bytes and time. */
function repoState(repo: string) {
  const index = join(git(repo, ["rev-parse", "--absolute-git-dir"]), "index");
  return { refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), head: git(repo, ["symbolic-ref", "-q", "HEAD"]), index: readFileSync(index).toString("base64"), indexTime: statSync(index).mtimeMs };
}

describe("the list", () => {
  test("branches with work of their own and no PR, and the folder's uncommitted changes dated by its files; nothing written", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    writeFileSync(join(repo, "base.txt"), "changed\n");
    writeFileSync(join(repo, "new-note.md"), "Charlie Dunn's note\n");
    utimesSync(join(repo, "base.txt"), now - 3600, now - 3600);
    utimesSync(join(repo, "new-note.md"), now - 600, now - 600);
    const before = repoState(repo);
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [project("prj_a", repo)], skip: (_project, branch) => branch === "bob/has-a-pr", now: () => now * 1000 });
    const answer = await work.list();
    expect(answer.unread).toBe(0);
    expect(answer.items).toEqual([
      { project_id: "prj_a", kind: "uncommitted", branch: "main", base: null, at: new Date((now - 600) * 1000).toISOString(), ahead: null },
      { project_id: "prj_a", kind: "branch", branch: "ada/retry-jitter", base: "main", at: new Date((now - 2 * DAY) * 1000).toISOString(), ahead: 1 },
    ]);
    // It has work: not "nothing" for a list filtered to it.
    expect(answer.quiet).toEqual([]);
    expect(answer.not_git).toEqual([]);
    onlyGuardedReads(seen);
    for (const { options } of seen.commands) expect(options?.timeoutMs).toBeLessThanOrEqual(BRANCH_GIT_TIMEOUT_MS);
    expect(repoState(repo)).toEqual(before);
  });

  test("a clean folder has no uncommitted row; a detached HEAD is named by its commit", async () => {
    const now = Math.floor(Date.now() / 1000);
    const clean = scratchRepo(now);
    const detached = scratchRepo(now);
    git(detached, ["checkout", "--quiet", "--detach", "main"]);
    writeFileSync(join(detached, "base.txt"), "changed\n");
    const short = git(detached, ["rev-parse", "--short", "HEAD"]);
    const work = createInboxLocalWork({ runtime, projects: () => [project("prj_clean", clean), project("prj_detached", detached)], skip: () => false, now: () => now * 1000 });
    const { items } = await work.list();
    expect(items.filter((item) => item.kind === "uncommitted")).toEqual([expect.objectContaining({ project_id: "prj_detached", branch: short })]);
  });

  test("a repository's worktrees list its branches once and each folder's own changes; a gone folder or no repository is skipped", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    const tree = join(mkdtempSync(join(tmpdir(), "local-work-tree-")), "wt");
    git(repo, ["worktree", "add", "--quiet", tree, "ada/retry-jitter"]);
    writeFileSync(join(tree, "jitter-note.txt"), "Ada Novak\n");
    const gone = join(tmpdir(), "local-work-gone-never-made");
    const plain = mkdtempSync(join(tmpdir(), "local-work-plain-"));
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [project("prj_gone", gone), project("prj_plain", plain), project("prj_main", repo), project("prj_tree", tree)], skip: () => false, now: () => now * 1000 });
    const answer = await work.list();
    expect(answer.unread).toBe(0);
    const branches = answer.items.filter((item) => item.kind === "branch").map((item) => `${item.project_id} ${item.branch}`);
    expect(branches.sort()).toEqual(["prj_main ada/retry-jitter", "prj_main bob/has-a-pr"]);
    expect(answer.items.filter((item) => item.kind === "uncommitted")).toEqual([expect.objectContaining({ project_id: "prj_tree", branch: "ada/retry-jitter" })]);
    // The folder that is gone: no git ran there at all.
    expect(seen.commands.some((command) => command.cwd === gone)).toBe(false);
    // What a list filtered to one of them says: no git repository here for the gone folder and the plain one; the
    // repository's two folders have work, so neither is "nothing".
    expect([...(answer.not_git ?? [])].sort()).toEqual(["prj_gone", "prj_plain"]);
    expect(answer.quiet).toEqual([]);
  });

  test("a project whose repository has nothing is named quiet; its count of commits not on main is on each branch", async () => {
    const now = Math.floor(Date.now() / 1000);
    const still = mkdtempSync(join(tmpdir(), "local-work-still-"));
    git(still, ["init", "--quiet", "-b", "main"]);
    commitAt(still, "base.txt", now - 30 * DAY);
    git(still, ["branch", "same-as-main"]);
    const busy = mkdtempSync(join(tmpdir(), "local-work-busy-"));
    git(busy, ["init", "--quiet", "-b", "main"]);
    commitAt(busy, "base.txt", now - 30 * DAY);
    git(busy, ["checkout", "--quiet", "-b", "ada/three"]);
    for (const [i, at] of [now - 3 * DAY, now - 2 * DAY, now - DAY].entries()) commitAt(busy, `three-${i}.txt`, at);
    git(busy, ["checkout", "--quiet", "main"]);
    const work = createInboxLocalWork({ runtime, projects: () => [project("prj_still", still), project("prj_busy", busy)], skip: () => false, now: () => now * 1000 });
    const answer = await work.list();
    expect(answer.quiet).toEqual(["prj_still"]);
    expect(answer.not_git).toEqual([]);
    expect(answer.items).toEqual([expect.objectContaining({ project_id: "prj_busy", branch: "ada/three", ahead: 3 })]);
  });

  test("a folder whose uncommitted changes can't be read in time has no uncommitted row; its branches list and it is not unread", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slow = scratchRepo(now);
    const fine = scratchRepo(now);
    writeFileSync(join(slow, "base.txt"), "changed\n");
    writeFileSync(join(fine, "base.txt"), "changed\n");
    const failing: ReviewGitRuntime = { ...runtime, runGit: (args, given) => (args[0] === "status" && given?.cwd === realpathSync(slow) ? Promise.resolve({ stdout: "", stderr: "timed out", exitCode: 124 }) : runtime.runGit(args, given)) };
    const work = createInboxLocalWork({ runtime: failing, projects: () => [project("prj_slow", slow), project("prj_fine", fine)], skip: () => false, now: () => now * 1000 });
    const answer = await work.list();
    expect(answer.unread).toBe(0);
    expect(answer.unread_projects).toEqual([]);
    const rows = answer.items.map((item) => `${item.project_id} ${item.kind} ${item.branch}`);
    expect(rows).toContain("prj_slow branch ada/retry-jitter");
    expect(rows).not.toContain("prj_slow uncommitted main");
    expect(rows).toContain("prj_fine uncommitted main");
    expect(rows).toContain("prj_fine branch ada/retry-jitter");
  });

  test("caps: the newest branches per repository, the first projects; one kept answer serves reads until it is old", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = mkdtempSync(join(tmpdir(), "local-work-many-"));
    git(repo, ["init", "--quiet", "-b", "main"]);
    commitAt(repo, "base.txt", now - 30 * DAY);
    for (let i = 0; i < LOCAL_WORK_BRANCHES_MAX + 3; i++) branchAt(repo, `bob/spike-${i}`, now - DAY - i * 60);
    const many = Array.from({ length: LOCAL_WORK_PROJECTS_MAX + 4 }, (_, i) => project(`prj_${i}`, join(tmpdir(), `local-work-absent-${i}`)));
    let clock = now * 1000;
    const seen = watched();
    let asked = 0;
    const work = createInboxLocalWork({
      runtime: seen.runtime,
      projects: () => {
        asked += 1;
        return [project("prj_many", repo), ...many];
      },
      skip: () => false,
      now: () => clock,
    });
    const first = await work.list();
    expect(first.items.map((item) => item.branch)).toEqual(Array.from({ length: LOCAL_WORK_BRANCHES_MAX }, (_, i) => `bob/spike-${i}`));
    const ran = seen.commands.length;
    clock += LOCAL_WORK_CACHE_MS - 1;
    expect(await work.list()).toBe(first);
    expect(seen.commands.length).toBe(ran);
    clock += 2;
    await work.list();
    expect(seen.commands.length).toBeGreaterThan(ran);
    expect(asked).toBe(2);
  });

  test("caps as Branch reviews' safety net had: 30 branches listed, from the newest 120 looked at", async () => {
    expect(LOCAL_WORK_BRANCHES_MAX).toBe(30);
    expect(LOCAL_WORK_SCAN_MAX).toBe(120);
    const now = Math.floor(Date.now() / 1000);
    const repo = mkdtempSync(join(tmpdir(), "local-work-scan-"));
    git(repo, ["init", "--quiet", "-b", "main"]);
    commitAt(repo, "base.txt", now - 5 * DAY);
    // Charlie's branch with work of its own, older than main's next commit...
    branchAt(repo, "charlie/older-work", now - 3 * DAY);
    commitAt(repo, "main-later.txt", now - DAY);
    // ...and newer branches with nothing of their own (at main's tip): the scan looks at the newest first.
    const empties = (count: number) => git(repo, ["update-ref", "--stdin"], {}, Array.from({ length: count }, (_, i) => `create refs/heads/empty-${i} main\n`).join(""));
    const listed = async () => (await createInboxLocalWork({ runtime, projects: () => [project("prj_scan", repo)], skip: () => false, now: () => now * 1000 }).list()).items.map((item) => item.branch);
    empties(LOCAL_WORK_SCAN_MAX - 1);
    // 119 newer (main itself is never looked at): Charlie's is the 120th.
    expect(await listed()).toEqual(["charlie/older-work"]);
    git(repo, ["update-ref", "refs/heads/empty-extra", "main"]);
    // 120 newer: past the scan.
    expect(await listed()).toEqual([]);
  });

  test("two reads at once share one read", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [project("prj_a", repo)], skip: () => false, now: () => now * 1000 });
    const [a, b] = await Promise.all([work.list(), work.list()]);
    expect(a).toBe(b);
    expect(seen.commands.filter((command) => command.args[0] === "for-each-ref")).toHaveLength(1);
  });
});

describe("work already merged, and one working tree", () => {
  test("a branch whose upstream is gone (merged and deleted on the remote) is not listed; one with its upstream is", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    // ada's upstream was deleted after a squash merge: configured, but no remote-tracking ref (no fetch is made).
    git(repo, ["config", "branch.ada/retry-jitter.remote", "origin"]);
    git(repo, ["config", "branch.ada/retry-jitter.merge", "refs/heads/ada/retry-jitter"]);
    // bob's is still there.
    git(repo, ["update-ref", "refs/remotes/origin/bob/has-a-pr", "main"]);
    git(repo, ["config", "branch.bob/has-a-pr.remote", "origin"]);
    git(repo, ["config", "branch.bob/has-a-pr.merge", "refs/heads/bob/has-a-pr"]);
    const work = createInboxLocalWork({ runtime, projects: () => [project("prj_a", repo)], skip: () => false, now: () => now * 1000 });
    const branches = (await work.list()).items.filter((item) => item.kind === "branch").map((item) => item.branch);
    expect(branches).toEqual(["bob/has-a-pr"]);
  });

  test("a branch whose head is a merged PR's head on its repository is not listed; elsewhere, or another commit, it is", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    const ada = git(repo, ["rev-parse", "refs/heads/ada/retry-jitter"]);
    const projectsByRepo = new Map([["github.com/charlie-dunn/plannotator", ["prj_a"]], ["github.com/charlie-dunn/spaces-site", ["prj_b"]]]);
    const merged = (repo: string, head_sha: string) => ({ host: "github.com", repo, head: "squashed-elsewhere", head_repo: repo, head_sha, state: "merged" }) as InboxPull;
    const list = async (pulls: InboxPull[]) => {
      const work = createInboxLocalWork({ runtime, projects: () => [project("prj_a", repo)], skip: (id, branch, head) => localBranchInPull(pulls, projectsByRepo, id, branch, head), now: () => now * 1000 });
      return (await work.list()).items.filter((item) => item.kind === "branch").map((item) => item.branch).sort();
    };
    expect(await list([merged("charlie-dunn/plannotator", ada)])).toEqual(["bob/has-a-pr"]);
    expect(await list([merged("charlie-dunn/spaces-site", ada)])).toEqual(["ada/retry-jitter", "bob/has-a-pr"]);
    expect(await list([merged("charlie-dunn/plannotator", "0".repeat(40))])).toEqual(["ada/retry-jitter", "bob/has-a-pr"]);
  });

  test("a folder inside another project's working tree: its uncommitted changes listed once, under the tree's own project", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    mkdirSync(join(repo, "packages", "web"), { recursive: true });
    writeFileSync(join(repo, "packages", "web", "page.ts"), "export const page = 1;\n");
    const seen = watched();
    // The inner folder is the newer project, read first.
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [project("prj_web", join(repo, "packages", "web")), project("prj_repo", repo)], skip: () => false, now: () => now * 1000 });
    const answer = await work.list();
    expect(answer.items.filter((item) => item.kind === "uncommitted")).toEqual([expect.objectContaining({ project_id: "prj_repo" })]);
    expect(seen.commands.filter((command) => command.args[0] === "status")).toHaveLength(1);
  });
});

describe("a row's diff", () => {
  test("a branch's whole diff against the default branch, read by ref: nothing checked out, nothing written", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    const before = repoState(repo);
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [], skip: () => false });
    const answer = await work.diff(project("prj_a", repo), "ada/retry-jitter");
    expect(answer).toMatchObject({ project_id: "prj_a", kind: "branch", branch: "ada/retry-jitter", base: "main", ahead: 1 });
    expect(answer!.patch).toContain("+++ b/ada-retry-jitter.txt");
    expect(answer!.patch).not.toContain("bob-has-a-pr.txt");
    onlyGuardedReads(seen);
    expect(repoState(repo)).toEqual(before);
  });

  test("the folder's uncommitted changes, new files too, as `plannotator review` reads them; nothing written", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    mkdirSync(join(repo, "notes"));
    writeFileSync(join(repo, "base.txt"), "changed by Bob Tully\n");
    writeFileSync(join(repo, "notes", "new.md"), "new\n");
    const before = repoState(repo);
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [], skip: () => false });
    const answer = await work.diff(project("prj_a", repo), null);
    expect(answer).toMatchObject({ kind: "uncommitted", branch: "main", base: "HEAD" });
    expect(answer!.patch).toContain("+changed by Bob Tully");
    expect(answer!.patch).toContain("+++ b/notes/new.md");
    onlyGuardedReads(seen);
    expect(repoState(repo)).toEqual(before);
  });

  test("a branch that isn't here says so; a folder that is gone is no repository", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    const work = createInboxLocalWork({ runtime, projects: () => [], skip: () => false });
    await expect(work.diff(project("prj_a", repo), "ada/never-made")).rejects.toThrow("ada/never-made");
    expect(await work.diff(project("prj_gone", join(tmpdir(), "local-work-gone-never-made")), null)).toBeNull();
  });

  test("an open PR hides the branch on its own repository only (its own, or its fork's), never a same-named one elsewhere", () => {
    const projectsByRepo = new Map([
      ["github.com/charlie-dunn/plannotator", ["prj_plannotator"]],
      ["github.com/charlie-dunn/spaces-site", ["prj_spaces"]],
      ["github.com/ada-novak/plannotator", ["prj_fork"]],
    ]);
    const pull = (repo: string, head: string, extra: Partial<InboxPull> = {}) => ({ host: "github.com", repo, head, head_repo: repo, state: "open", ...extra }) as InboxPull;
    const spacesPull = [pull("charlie-dunn/spaces-site", "fix/readme")];
    // Another repository's open PR on a branch of the same name: this project's branch stays listed.
    expect(localBranchInPull(spacesPull, projectsByRepo, "prj_plannotator", "fix/readme", "")).toBe(false);
    // Its own repository's: hidden, on that repository's project only.
    expect(localBranchInPull(spacesPull, projectsByRepo, "prj_spaces", "fix/readme", "")).toBe(true);
    // A fork's PR into the upstream: the fork's clone (its head's repository) and the upstream's both have it.
    const forkPull = [pull("charlie-dunn/plannotator", "feat/share", { head_repo: "Ada-Novak/plannotator" })];
    expect(localBranchInPull(forkPull, projectsByRepo, "prj_fork", "feat/share", "")).toBe(true);
    expect(localBranchInPull(forkPull, projectsByRepo, "prj_plannotator", "feat/share", "")).toBe(true);
    expect(localBranchInPull(forkPull, projectsByRepo, "prj_spaces", "feat/share", "")).toBe(false);
    // A closed or merged PR hides nothing; another branch's PR hides nothing.
    expect(localBranchInPull([pull("charlie-dunn/spaces-site", "fix/readme", { state: "merged" })], projectsByRepo, "prj_spaces", "fix/readme", "")).toBe(false);
    expect(localBranchInPull(spacesPull, projectsByRepo, "prj_spaces", "fix/other", "")).toBe(false);
  });

  test("a branch diff past its cap is said too large, never drawn cut", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    git(repo, ["checkout", "--quiet", "-b", "bob/huge", "main"]);
    // Over the cap once a diff: 9 MB of lines.
    const line = "export const filler = \"Bob Tully's generated fixture line\";\n";
    writeFileSync(join(repo, "huge.ts"), line.repeat(Math.ceil((BRANCH_DIFF_MAX_BYTES + 1024 * 1024) / line.length)));
    git(repo, ["add", "huge.ts"]);
    git(repo, ["commit", "--quiet", "-m", "huge"]);
    git(repo, ["checkout", "--quiet", "main"]);
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [], skip: () => false });
    const read = work.diff(project("prj_a", repo), "bob/huge");
    await expect(read).rejects.toBeInstanceOf(BranchDiffTooLarge);
    await expect(read).rejects.toThrow("This diff is too large to read here.");
    // Read through the capped reader, at the cap.
    expect(seen.commands.find((command) => command.args[0] === "diff")?.options?.maxOutputBytes).toBe(BRANCH_DIFF_MAX_BYTES);
    // Under the cap, the whole diff as before.
    expect((await work.diff(project("prj_a", repo), "ada/retry-jitter"))!.patch).toContain("ada-retry-jitter.txt");
  });

  test("the folder's uncommitted changes past the branch diff's cap are said too large, never sent whole", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    // Two new files under the per-file limit, over the cap together.
    const line = "export const filler = \"Ada Novak's generated fixture line\";\n";
    for (const name of ["gen-a.ts", "gen-b.ts"]) writeFileSync(join(repo, name), line.repeat(Math.ceil((4.5 * 1024 * 1024) / line.length)));
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [], skip: () => false });
    await expect(work.diff(project("prj_a", repo), null)).rejects.toBeInstanceOf(BranchDiffTooLarge);
    // Every diff read through the capped reader, at most at the cap: none held whole.
    const diffs = seen.commands.filter((command) => command.args[0] === "diff");
    expect(diffs.length).toBeGreaterThan(0);
    for (const command of diffs) {
      expect(command.options?.maxOutputBytes).toBeGreaterThan(0);
      expect(command.options?.maxOutputBytes).toBeLessThanOrEqual(BRANCH_DIFF_MAX_BYTES);
    }
  });

  test("the uncommitted diff's new files stop being read once together they are past the cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    // Eight new files, each under the per-file limit and under the cap alone; any two are past it.
    const line = "export const filler = \"Charlie Dunn's generated fixture line\";\n";
    const files = Array.from({ length: 8 }, (_, i) => `gen-${i}.ts`);
    for (const name of files) writeFileSync(join(repo, name), line.repeat(Math.ceil((4.2 * 1024 * 1024) / line.length)));
    const seen = watched();
    const work = createInboxLocalWork({ runtime: seen.runtime, projects: () => [], skip: () => false });
    const read = work.diff(project("prj_a", repo), null);
    await expect(read).rejects.toBeInstanceOf(BranchDiffTooLarge);
    await expect(read).rejects.toThrow("This diff is too large to read here.");
    // Each new file is one `git diff --no-index`: the ones started once the total was past the cap were never run.
    const started = seen.commands.filter((command) => command.args[0] === "diff" && command.args.includes("--no-index"));
    expect(started.length).toBeGreaterThan(0);
    expect(started.length).toBeLessThan(files.length);
  });
});

/** `count` branches off main, `<prefix>-<i>`, one commit each, the newest at `newest` and each a minute older. */
function branchesAt(repo: string, prefix: string, count: number, newest: number) {
  const tree = git(repo, ["rev-parse", "main^{tree}"]);
  const lines = Array.from({ length: count }, (_, i) => {
    const date = `@${newest - i * 60} +0000`;
    const sha = git(repo, ["commit-tree", tree, "-p", "main", "-m", `${prefix} ${i}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return `create refs/heads/${prefix}-${i} ${sha}\n`;
  });
  git(repo, ["update-ref", "--stdin"], {}, lines.join(""));
}

describe("one base, every project, every repository", () => {
  test("a stale local main: the row's count, its diff and New review's summary are all against origin/main", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = mkdtempSync(join(tmpdir(), "local-work-stale-"));
    git(repo, ["init", "--quiet", "-b", "main"]);
    git(repo, ["remote", "add", "origin", "https://example.invalid/charlie/never.git"]);
    commitAt(repo, "base.txt", now - 30 * DAY);
    // Others' work merged upstream since this clone's main last moved: on origin/main only.
    git(repo, ["checkout", "--quiet", "--detach"]);
    commitAt(repo, "merged-by-ada.txt", now - 5 * DAY);
    commitAt(repo, "merged-by-bob.txt", now - 4 * DAY);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    // Charlie's fix, started from origin/main: one commit of its own.
    git(repo, ["checkout", "--quiet", "-b", "charlie/fix", "refs/remotes/origin/main"]);
    commitAt(repo, "charlie-fix.txt", now - DAY);
    git(repo, ["checkout", "--quiet", "main"]);
    const work = createInboxLocalWork({ runtime, projects: () => [project("prj_a", repo)], skip: () => false, now: () => now * 1000 });
    expect((await work.list()).items).toEqual([expect.objectContaining({ kind: "branch", branch: "charlie/fix", base: "main", ahead: 1 })]);
    const diff = await work.diff(project("prj_a", repo), "charlie/fix");
    expect(diff).toMatchObject({ base: "main", ahead: 1 });
    expect(diff!.patch).toContain("+++ b/charlie-fix.txt");
    expect(diff!.patch).not.toContain("merged-by-");
    expect(await readInboxReviewChanges(repo, "branch", "charlie/fix", runtime)).toMatchObject({ git: true, files: 1, branch: "charlie/fix", base: "main" });
  });

  test("New review's summary of a branch past its cap, or not here, is no answer, never no changes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    git(repo, ["checkout", "--quiet", "-b", "bob/huge", "main"]);
    const line = "export const filler = \"Bob Tully's generated fixture line\";\n";
    writeFileSync(join(repo, "huge.ts"), line.repeat(Math.ceil((BRANCH_DIFF_MAX_BYTES + 1024 * 1024) / line.length)));
    git(repo, ["add", "huge.ts"]);
    git(repo, ["commit", "--quiet", "-m", "huge"]);
    git(repo, ["checkout", "--quiet", "main"]);
    await expect(readInboxReviewChanges(repo, "branch", "bob/huge", runtime)).rejects.toBeInstanceOf(BranchDiffTooLarge);
    await expect(readInboxReviewChanges(repo, "branch", "ada/never-made", runtime)).rejects.toThrow("isn't in the project's checkout");
    expect(await readInboxReviewChanges(repo, "branch", "ada/retry-jitter", runtime)).toMatchObject({ git: true, files: 1 });
  });

  test("a list filtered to one project has all of its rows, though two busy projects fill the whole list's cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const busy = (name: string) => {
      const repo = mkdtempSync(join(tmpdir(), `local-work-busy-${name}-`));
      git(repo, ["init", "--quiet", "-b", "main"]);
      commitAt(repo, "base.txt", now - 30 * DAY);
      branchesAt(repo, `bob/${name}`, LOCAL_WORK_BRANCHES_MAX, now - DAY);
      return repo;
    };
    const third = mkdtempSync(join(tmpdir(), "local-work-third-"));
    git(third, ["init", "--quiet", "-b", "main"]);
    commitAt(third, "base.txt", now - 30 * DAY);
    branchAt(third, "ada/older-work", now - 3 * DAY);
    const work = createInboxLocalWork({ runtime, projects: () => [project("prj_a", busy("a")), project("prj_b", busy("b")), project("prj_c", third)], skip: () => false, now: () => now * 1000 });
    expect(LOCAL_WORK_ROWS_MAX).toBe(2 * LOCAL_WORK_BRANCHES_MAX);
    const all = await work.list();
    expect(all.items).toHaveLength(LOCAL_WORK_ROWS_MAX);
    expect(all.items.some((item) => item.project_id === "prj_c")).toBe(false);
    expect(all.quiet).toEqual([]);
    expect((await work.list("prj_c")).items).toEqual([expect.objectContaining({ project_id: "prj_c", branch: "ada/older-work", ahead: 1 })]);
    expect((await work.list("prj_a")).items.every((item) => item.project_id === "prj_a")).toBe(true);
    // One read served all three.
    expect(await work.list()).toBe(all);
  });

  test("a branch in a PR or reported from one worktree project is left out, though it lists under another project of its repository", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = scratchRepo(now);
    const tree = join(mkdtempSync(join(tmpdir(), "local-work-tree-")), "wt");
    git(repo, ["worktree", "add", "--quiet", tree, "ada/retry-jitter"]);
    const asked = new Set<string>();
    const work = createInboxLocalWork({
      runtime,
      projects: () => [project("prj_main", repo), project("prj_tree", tree)],
      skip: (id, branch) => (asked.add(id), id === "prj_tree" && branch === "bob/has-a-pr"),
      now: () => now * 1000,
    });
    const branches = (await work.list()).items.filter((item) => item.kind === "branch").map((item) => `${item.project_id} ${item.branch}`);
    expect(branches).toEqual(["prj_main ada/retry-jitter"]);
    expect([...asked].sort()).toEqual(["prj_main", "prj_tree"]);
  });

  test("a repository whose default is neither main nor master lists its branches against its own default", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repoOn = (name: string) => {
      const repo = mkdtempSync(join(tmpdir(), `local-work-${name}-`));
      git(repo, ["init", "--quiet", "-b", name]);
      commitAt(repo, "base.txt", now - 30 * DAY);
      git(repo, ["checkout", "--quiet", "-b", "ada/feature"]);
      commitAt(repo, "feature.txt", now - DAY);
      git(repo, ["checkout", "--quiet", name]);
      return repo;
    };
    // A local-only trunk (no origin); and a name no list knows, checked out in the main worktree.
    for (const name of ["trunk", "stable"]) {
      const repo = repoOn(name);
      const work = createInboxLocalWork({ runtime, projects: () => [project(`prj_${name}`, repo)], skip: () => false, now: () => now * 1000 });
      const answer = await work.list();
      expect(answer.unread).toBe(0);
      expect(answer.items).toEqual([expect.objectContaining({ kind: "branch", branch: "ada/feature", base: name, ahead: 1 })]);
      const diff = await work.diff(project(`prj_${name}`, repo), "ada/feature");
      expect(diff).toMatchObject({ base: name, ahead: 1 });
      expect(diff!.patch).toContain("+++ b/feature.txt");
    }
  });

  test("a repository whose branches can't be read: each of its projects says so, none is named quiet, and it counts once", async () => {
    const now = Math.floor(Date.now() / 1000);
    const repo = mkdtempSync(join(tmpdir(), "local-work-unlisted-"));
    git(repo, ["init", "--quiet", "-b", "main"]);
    commitAt(repo, "base.txt", now - 30 * DAY);
    git(repo, ["branch", "same-as-main"]);
    const tree = join(mkdtempSync(join(tmpdir(), "local-work-tree-")), "wt");
    git(repo, ["worktree", "add", "--quiet", tree, "same-as-main"]);
    const fine = mkdtempSync(join(tmpdir(), "local-work-fine-"));
    git(fine, ["init", "--quiet", "-b", "main"]);
    commitAt(fine, "base.txt", now - 30 * DAY);
    const failing: ReviewGitRuntime = { ...runtime, runGit: (args, given) => (args[0] === "for-each-ref" && given?.cwd !== realpathSync(fine) ? Promise.resolve({ stdout: "", stderr: "timed out", exitCode: 124 }) : runtime.runGit(args, given)) };
    const work = createInboxLocalWork({ runtime: failing, projects: () => [project("prj_main", repo), project("prj_tree", tree), project("prj_fine", fine)], skip: () => false, now: () => now * 1000 });
    const answer = await work.list();
    expect(answer.unread).toBe(1);
    expect(answer.unread_projects).toEqual(["prj_main", "prj_tree"]);
    expect(answer.quiet).toEqual(["prj_fine"]);
  });
});
