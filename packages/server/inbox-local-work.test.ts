/**
 * Reviews' "On this computer" (inbox-local-work.ts), on scratch repositories. What regresses:
 *  - a branch with work of its own and no PR missing from the list, or an old branch, the default branch, one with
 *    nothing of its own or one with an open PR listed;
 *  - a folder's uncommitted changes missing, named by the wrong branch, or dated by anything but its files;
 *  - a repository read twice through its worktrees, or a folder that is gone breaking the whole list;
 *  - any read reaching the network, asking anything, or writing to the repository (the index refreshed, a ref moved,
 *    a checkout), or reading more projects or branches than its caps;
 *  - every read of the list running git again instead of the kept answer;
 *  - a row's diff missing its changes, or a branch's diff checking the branch out;
 *  - a branch hidden by a same-named branch's open PR on another repository, or listed beside its own repository's
 *    open PR (or its fork's); a squash- or rebase-merged branch listed (its upstream gone, or its head a merged PR's);
 *  - a branch diff past its cap drawn cut instead of said too large;
 *  - a background read starting a repository's fsmonitor, gc or maintenance;
 *  - one working tree's uncommitted changes listed under each project inside it.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxProject, InboxPull } from "@plannotator/core/inbox-types";
import type { ReviewGitRuntime } from "@plannotator/shared/review-core";
import { BRANCH_DIFF_MAX_BYTES, BRANCH_GIT_TIMEOUT_MS } from "./inbox-branch-reports";
import { BranchDiffTooLarge, createInboxLocalWork, localBranchInPull, LOCAL_WORK_BRANCHES_MAX, LOCAL_WORK_CACHE_MS, LOCAL_WORK_PROJECTS_MAX } from "./inbox-local-work";
import { runtime } from "./git";

const DAY = 86_400;

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf-8", env: { ...process.env, ...env } });
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
      { project_id: "prj_a", kind: "uncommitted", branch: "main", base: null, at: new Date((now - 600) * 1000).toISOString() },
      { project_id: "prj_a", kind: "branch", branch: "ada/retry-jitter", base: "main", at: new Date((now - 2 * DAY) * 1000).toISOString() },
    ]);
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
  });

  test("a folder whose git can't be read in time counts as unread, and the others still list", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slow = scratchRepo(now);
    const fine = scratchRepo(now);
    writeFileSync(join(slow, "base.txt"), "changed\n");
    const failing: ReviewGitRuntime = { ...runtime, runGit: (args, given) => (args[0] === "status" && given?.cwd === realpathSync(slow) ? Promise.resolve({ stdout: "", stderr: "timed out", exitCode: 124 }) : runtime.runGit(args, given)) };
    const work = createInboxLocalWork({ runtime: failing, projects: () => [project("prj_slow", slow), project("prj_fine", fine)], skip: () => false, now: () => now * 1000 });
    const answer = await work.list();
    expect(answer.unread).toBe(1);
    expect(answer.items.some((item) => item.project_id === "prj_fine" && item.branch === "ada/retry-jitter")).toBe(true);
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
    expect(answer).toMatchObject({ project_id: "prj_a", kind: "branch", branch: "ada/retry-jitter", base: "main" });
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
});
