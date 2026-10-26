import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDashboard } from "./dashboard";
import { parsePullRequestRef, preparePullRequestWorktree } from "./sources/github";
import type { RunResult, Runner } from "./sources/runner";
import { saveDraftRecord, saveFinishedGuide } from "./store";
import { createGuideDraft } from "./core/adapter";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";

type Rule = [RegExp, RunResult | ((cmd: string) => RunResult)];

/** A runner that answers from rules matched against "cmd arg arg …"; anything else fails loudly. */
function scripted(rules: Rule[], calls: string[] = []): Runner {
  return async (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    for (const [re, res] of rules) if (re.test(line)) return typeof res === "function" ? res(line) : res;
    return { code: 1, stdout: "", stderr: `unscripted: ${line}` };
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

const gitRules: Rule[] = [
  [/git .*rev-parse --show-toplevel/, ok("/repo/checkout-service\n")],
  [/git .*rev-parse --abbrev-ref HEAD/, ok("feat/webhook-retries\n")],
  [/git .*rev-parse HEAD$/, ok("9b07e4d9b07e4d9b07e4d9b07e4d9b07e4d9b07e\n")],
  [/git .*remote get-url origin/, ok("git@github.com:northwind/checkout-service.git\n")],
  [/git .*symbolic-ref refs\/remotes\/origin\/HEAD/, ok("refs/remotes/origin/main\n")],
  [/git .*show-ref --verify --quiet refs\/remotes\/origin\/main/, ok("")],
  [/git .*merge-base origin\/main HEAD/, ok("3f2c1a93f2c1a93f2c1a93f2c1a93f2c1a93f2c1\n")],
  [/git .*diff --numstat 3f2c1a9/, ok("12\t3\tsrc/webhooks/deliver.ts\n6\t1\tsrc/webhooks/retryPolicy.ts\n-\t-\tlogo.png\n")],
  [/git .*ls-files --others --exclude-standard/, ok("notes.md\n")],
];

const prList = JSON.stringify([
  { number: 477, title: "Add idempotency keys", url: "https://github.com/northwind/checkout-service/pull/477", author: { login: "li" }, isDraft: false, headRefName: "feat/idem", headRefOid: "aaa", baseRefName: "main", additions: 50, deletions: 2, changedFiles: 4, updatedAt: "2026-10-20T10:00:00Z", reviewRequests: [] },
  { number: 479, title: "Move signing secrets to KMS", url: "https://github.com/northwind/checkout-service/pull/479", author: { login: "dana" }, isDraft: false, headRefName: "feat/kms", headRefOid: "bbb", baseRefName: "main", additions: 30, deletions: 9, changedFiles: 6, updatedAt: "2026-10-19T10:00:00Z", reviewRequests: [{ login: "ramos" }] },
  { number: 482, title: "Retry failed webhook deliveries", url: "https://github.com/northwind/checkout-service/pull/482", author: { login: "ramos" }, isDraft: false, headRefName: "feat/webhook-retries", headRefOid: "9b07e4d", baseRefName: "main", additions: 127, deletions: 19, changedFiles: 8, updatedAt: "2026-10-18T10:00:00Z", reviewRequests: [] },
]);

const waiting = JSON.stringify([
  { number: 212, title: "Format currency per locale", url: "https://github.com/northwind/ledger-ui/pull/212", repository: { nameWithOwner: "northwind/ledger-ui" }, author: { login: "kofi" }, updatedAt: "2026-10-17T00:00:00Z", isDraft: false },
  { number: 214, title: "Keyboard nav for the filter bar", url: "https://github.com/northwind/ledger-ui/pull/214", repository: { nameWithOwner: "northwind/ledger-ui" }, author: { login: "ines" }, updatedAt: "2026-10-21T00:00:00Z", isDraft: false },
]);

describe("dashboard data", () => {
  it("reads this repo, its local changes, its PRs (yours and waiting on you first) and PRs waiting on you", async () => {
    const calls: string[] = [];
    const runner = scripted([
      ...gitRules,
      [/^gh api user --jq \.login$/, ok("ramos\n")],
      [/^gh pr list --state open --limit 30 --json /, ok(prList)],
      [/^gh search prs --review-requested=@me --state=open --limit 15 --json /, ok(waiting)],
    ], calls);
    const model = await loadDashboard(runner, "/repo/checkout-service/src", { now: () => 42 });
    expect(model.repo).toMatchObject({
      root: "/repo/checkout-service",
      displayName: "northwind/checkout-service",
      branch: "feat/webhook-retries",
      defaultBranch: "origin/main",
      repoKey: "github.com__northwind__checkout-service",
    });
    expect(model.local).toEqual({ mode: "since-base", baseSha: "3f2c1a93f2c1a93f2c1a93f2c1a93f2c1a93f2c1", baseLabel: "main", files: 4, additions: 18, deletions: 4, untracked: 1 });
    expect(model.gh).toEqual({ state: "ok", user: "ramos" });
    expect(model.prs.map((p) => [p.number, p.isMine, p.reviewRequested])).toEqual([[482, true, false], [479, false, true], [477, false, false]]);
    expect(model.currentBranchPR?.number).toBe(482);
    expect(model.waiting.map((w) => w.number)).toEqual([214, 212]);
    expect(model.notes).toEqual([]);
    expect(calls.some((c) => c.startsWith("gh") && /--web|checkout|merge|comment|review --/.test(c))).toBe(false);
  });

  it("works without gh: local changes still show, and the state says gh is missing", async () => {
    const runner = scripted([...gitRules, [/^gh /, { code: 127, stdout: "", stderr: "spawn gh ENOENT" }]]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.gh).toEqual({ state: "missing" });
    expect(model.prs).toEqual([]);
    expect(model.local?.files).toBe(4);
  });

  it("says when gh is signed out", async () => {
    const runner = scripted([...gitRules, [/^gh api user/, { code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }]]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.gh.state).toBe("signed-out");
  });

  it("keeps going when listing PRs fails, with a note", async () => {
    const runner = scripted([
      ...gitRules,
      [/^gh api user/, ok("ramos")],
      [/^gh pr list/, { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }],
      [/^gh search prs/, ok("[]")],
    ]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.notes).toEqual(["Could not list pull requests: HTTP 502: Bad Gateway"]);
    expect(model.local).not.toBeNull();
  });

  it("is empty outside a git repository", async () => {
    const runner = scripted([[/^gh api user/, ok("ramos")], [/^gh search prs/, ok(waiting)]]);
    const model = await loadDashboard(runner, "/tmp/not-a-repo");
    expect(model.repo).toBeNull();
    expect(model.local).toBeNull();
    expect(model.waiting).toHaveLength(2);
  });

  it("lists recent guides and drafts, flags a guide whose PR head moved", async () => {
    const repoKey = "github.com__northwind__checkout-service";
    const source = {
      kind: "pr" as const, repoRoot: "/repo", headRoot: "/wt", repoName: "northwind/checkout-service", label: "PR #479",
      headSha: "old-head", baseSha: "base", baseLabel: "main", pr: { number: 479, url: "https://github.com/northwind/checkout-service/pull/479", title: "Move signing secrets" },
    };
    const review = { rawPatch: "diff --git a/a.ts b/a.ts\n", gitRef: "PR #479", source: { kind: "pr" as const, headSha: "old-head" } };
    saveFinishedGuide({
      repoKey,
      snapshot: buildGuideSnapshot({ guide: { title: "Move signing secrets to KMS", intent: "i", sections: [{ title: "s", overview: "o", diffs: [{ file: "a.ts" }] }], unplacedFiles: [] }, reviewed: [], review }),
      source,
      agent: { id: "claude-code", label: "Claude Code" },
      focus: {},
      now: 1000,
    });
    const draft = { ...createGuideDraft({ review }), chapters: [{ id: "c1", title: "x", overview: "y", files: [] }], nextChapter: 2 };
    saveDraftRecord({ v: 1, id: "draft-1-a", repoKey, createdAt: 2000, updatedAt: 2000, status: "stopped", source: { ...source, label: "Local changes", kind: "local", pr: undefined }, agent: { id: "claude-code", label: "Claude Code" }, draft });
    const runner = scripted([...gitRules, [/^gh api user/, ok("ramos")], [/^gh pr list/, ok(prList)], [/^gh search prs/, ok("[]")]]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.recent.map((r) => [r.kind, r.title, r.moved ?? null])).toEqual([
      ["draft", "Draft · Local changes", null],
      ["guide", "Move signing secrets to KMS", true],
    ]);
  });
});

describe("pull request sources", () => {
  it("reads a PR number, #number or a URL of this repo only", () => {
    const repo = { github: { host: "github.com", owner: "northwind", repo: "checkout-service" } } as Parameters<typeof parsePullRequestRef>[1];
    expect(parsePullRequestRef("482", repo)).toBe(482);
    expect(parsePullRequestRef("#482", repo)).toBe(482);
    expect(parsePullRequestRef("https://github.com/northwind/checkout-service/pull/482/files", repo)).toBe(482);
    expect(parsePullRequestRef("https://github.com/other/repo/pull/482", repo)).toBeNull();
    expect(parsePullRequestRef("not a pr", repo)).toBeNull();
  });

  it("fetches the PR head, creates a detached worktree under the extension's storage, and diffs from the merge base", async () => {
    const calls: string[] = [];
    const storage = mkdtempSync(join(tmpdir(), "pn-guides-storage-"));
    const wtPath = join(storage, "worktrees", "key", "pr-482-headsha");
    let fetched = false;
    const runner = scripted([
      [/^git cat-file -e headsha\^\{commit\}/, () => (fetched ? ok("") : { code: 1, stdout: "", stderr: "" })],
      [/^git cat-file -e basesha\^\{commit\}/, ok("")],
      [/^git --no-pager fetch --no-tags --refmap= -- origin refs\/pull\/482\/head$/, () => ((fetched = true), ok(""))],
      [/^git --no-pager merge-base basesha headsha/, ok("mergebase\n")],
      [new RegExp(`^git --no-pager worktree add --force --detach -- ${wtPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} headsha$`), ok("")],
      [/^git --no-pager -c core.quotePath=false diff --no-ext-diff --no-color --src-prefix=a\/ --dst-prefix=b\/ mergebase headsha/, ok("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n a\n+b\n c\n")],
    ], calls);
    const repo = { root: "/repo", repoKey: "key" } as Parameters<typeof preparePullRequestWorktree>[1];
    const pr = { number: 482, title: "t", url: "u", body: "", author: "a", headRefName: "h", headRefOid: "headsha", baseRefName: "main", baseRefOid: "basesha" };
    const steps: string[] = [];
    const wt = await preparePullRequestWorktree(runner, repo, pr, storage, (s) => steps.push(s));
    expect(wt).toMatchObject({ path: wtPath, headSha: "headsha", mergeBase: "mergebase" });
    expect(wt.files).toEqual([{ path: "x.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 1, end: 3 }] }]);
    expect(steps).toEqual(["Fetching PR #482", "Creating a worktree at the PR head"]);
    // Nothing touches the user's own checkout: no checkout, reset, or branch in the repo itself,
    // no `worktree prune` of their worktrees, and no fetch that could move one of their refs.
    expect(calls.some((c) => / (checkout|reset|switch|branch) /.test(c))).toBe(false);
    expect(calls.some((c) => /worktree prune/.test(c))).toBe(false);
    expect(calls.filter((c) => / fetch /.test(c)).every((c) => c.includes("--refmap= --"))).toBe(true);
  });
});

describe("with no folder open", () => {
  it("lists the recent guides of every repository, and finds a PR's guide by its head", async () => {
    const { mkdtempSync: mk, rmSync } = await import("node:fs");
    const { listRecentEverywhere, guideForPullRequest, allRepoKeys } = await import("./store");
    const before = process.env.PLANNOTATOR_DATA_DIR;
    const dir = mk(join(tmpdir(), "pn-everywhere-"));
    process.env.PLANNOTATOR_DATA_DIR = dir;
    try {
      const save = (repoKey: string, number: number, head: string, title: string, now: number) => {
        const review = { rawPatch: "diff --git a/a.ts b/a.ts\n", gitRef: `PR #${number}`, source: { kind: "pr" as const, headSha: head, pr: { number, url: `https://github.com/x/y/pull/${number}`, title } } };
        saveFinishedGuide({
          repoKey,
          snapshot: buildGuideSnapshot({ guide: { title, intent: "i", sections: [{ title: "s", overview: "o", diffs: [{ file: "a.ts" }] }], unplacedFiles: [] }, reviewed: [], review }),
          source: { kind: "pr", repoRoot: "/r", headRoot: "/w", repoName: repoKey, label: `PR #${number}`, headSha: head, baseSha: "b", baseLabel: "main", pr: { number, url: `https://github.com/x/y/pull/${number}`, title } },
          agent: { id: "claude-code", label: "Claude Code" },
          focus: {},
          now,
        });
      };
      save("github.com__northwind__ledger-ui", 212, "head-a", "Format currency", 1000);
      save("github.com__northwind__checkout-service", 482, "head-b", "Retry webhooks", 2000);
      expect(allRepoKeys().sort()).toEqual(["github.com__northwind__checkout-service", "github.com__northwind__ledger-ui"]);
      expect(listRecentEverywhere().map((r) => [r.title, r.repoName])).toEqual([["Retry webhooks", "northwind/checkout-service"], ["Format currency", "northwind/ledger-ui"]]);
      const runner = scripted([[/^gh api user/, ok("ramos")], [/^gh search prs/, ok(waiting)]]);
      const model = await loadDashboard(runner, undefined);
      expect(model.repo).toBeNull();
      expect(model.recent.map((r) => r.repoName)).toEqual(["northwind/checkout-service", "northwind/ledger-ui"]);
      expect(model.waiting.map((w) => w.repo)).toEqual(["northwind/ledger-ui", "northwind/ledger-ui"]);

      expect(guideForPullRequest("github.com__northwind__ledger-ui", 212, "head-a")).not.toBeNull();
      expect(guideForPullRequest("github.com__northwind__ledger-ui", 212, "head-moved")).toBeNull();
      expect(guideForPullRequest("github.com__northwind__ledger-ui", 212, null)).not.toBeNull();
      expect(guideForPullRequest("github.com__northwind__ledger-ui", 999, null)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a pull request of a repository that is not open", () => {
  /** The rules for a repository at `root` whose origin is `remote`. */
  const repoRules = (root: string, remote: string): Rule[] => [
    [/git .*rev-parse --show-toplevel/, ok(`${root}\n`)],
    [/git .*rev-parse --abbrev-ref HEAD/, ok("main\n")],
    [/git .*rev-parse HEAD$/, ok("abc\n")],
    [/git .*remote get-url origin/, ok(`${remote}\n`)],
    [/git .*symbolic-ref/, ok("refs/remotes/origin/main\n")],
    [/git .*show-ref/, ok("")],
  ];

  it("treats the open repository's own PRs as its own, whatever shape its remote has", async () => {
    const { getRepoInfo } = await import("./sources/git");
    const { isOpenRepository, parsePullRequestUrl } = await import("./sources/github");
    const { pullRequestChoice } = await import("./vscode/new-review");
    const table: Array<[string, string, boolean]> = [
      ["git@github-work:org/repo.git", "https://github.com/org/repo/pull/7", true],
      ["https://github.com/Org/Repo.git", "https://github.com/org/repo/pull/7", true],
      ["ssh://git@ssh.github.com:443/org/repo.git", "https://github.com/org/repo/pull/7", true],
      ["git@github.com:org/repo.git", "https://github.com/ORG/REPO/pull/7", true],
      ["git@github.com:org/repo.git", "https://github.com/org/other/pull/7", false],
      ["git@github.com:org/repo.git", "https://github.corp.example/org/repo/pull/7", false],
      ["https://github.corp.example/org/repo.git", "https://github.corp.example/Org/Repo/pull/7", true],
    ];
    for (const [remote, url, same] of table) {
      const repo = await getRepoInfo(scripted(repoRules("/r", remote)), "/r");
      const ref = parsePullRequestUrl(url)!;
      expect([remote, url, isOpenRepository(repo, ref)]).toEqual([remote, url, same]);
      expect([remote, url, pullRequestChoice(url, repo)]).toEqual([remote, url, same ? { kind: "pr", number: 7 } : { kind: "pr", number: 7, repo: ref.host === "github.com" ? `${ref.owner}/${ref.repo}` : `${ref.host}/${ref.owner}/${ref.repo}` }]);
    }
  });

  it("is cloned once into the extension's storage (blobless, no checkout), with gh as the clone's own credential helper", async () => {
    const { ensureRepoClone, ghRepoOfKey, repoClonePath, repoKeyForGhRepo } = await import("./sources/github");
    const { mkdirSync: mkdir, rmSync } = await import("node:fs");
    expect(repoKeyForGhRepo("northwind/ledger-ui")).toBe("github.com__northwind__ledger-ui");
    expect(repoKeyForGhRepo("ghe.corp.example/team/svc")).toBe("ghe.corp.example__team__svc");
    expect(ghRepoOfKey("github.com__northwind__ledger-ui")).toBe("northwind/ledger-ui");
    expect(ghRepoOfKey("ghe.corp.example__team__svc")).toBe("ghe.corp.example/team/svc");
    expect(ghRepoOfKey("my-folder-1a2b3c4d")).toBeNull();

    const storage = mkdtempSync(join(tmpdir(), "pn-clone-"));
    const path = repoClonePath(storage, "github.com__northwind__ledger-ui");
    const calls: string[] = [];
    const runner = scripted([
      [/^gh repo clone /, (line) => { mkdir(join(line.split(" ")[4], ".git"), { recursive: true }); return ok(""); }],
      [/^git --no-pager config --local /, ok("")],
      ...repoRules(path, "https://github.com/northwind/ledger-ui.git"),
    ], calls);
    try {
      const repo = await ensureRepoClone(runner, "northwind/ledger-ui", storage, () => {}, { ghPath: "/opt/gh bin/gh" });
      expect(repo.repoKey).toBe("github.com__northwind__ledger-ui");
      const clone = calls.filter((c) => c.startsWith("gh repo clone"));
      expect(clone).toHaveLength(1);
      expect(clone[0]).toMatch(new RegExp(`^gh repo clone northwind/ledger-ui ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.cloning-\\d+-\\d+ -- --filter=blob:none --no-checkout --quiet$`));
      expect(calls.filter((c) => c.startsWith("git --no-pager config"))).toEqual([
        "git --no-pager config --local credential.https://github.com.helper ",
        "git --no-pager config --local --add credential.https://github.com.helper !'/opt/gh bin/gh' auth git-credential",
      ]);
      expect(readdirSync(storage, { recursive: true }).some((n) => String(n).includes(".cloning-"))).toBe(false);
      await ensureRepoClone(runner, "northwind/ledger-ui", storage);
      expect(calls.filter((c) => c.startsWith("gh repo clone"))).toHaveLength(1);
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("quotes gh's path for git's sh -c so nothing in it expands, the same shape gh auth setup-git writes on Windows", async () => {
    const { shellQuoteForGit } = await import("./sources/github");
    expect(shellQuoteForGit("/opt/homebrew/bin/gh")).toBe("'/opt/homebrew/bin/gh'");
    expect(shellQuoteForGit("C:\\Program Files\\GitHub CLI\\gh.exe")).toBe("'C:\\Program Files\\GitHub CLI\\gh.exe'");
    expect(shellQuoteForGit("/tmp/it's/gh")).toBe("'/tmp/it'\\''s/gh'");
    if (process.platform === "win32") return;
    const { execFileSync } = await import("node:child_process");
    for (const path of ["/opt/a b/gh", "/tmp/$HOME/`id`/gh", "/tmp/it's/$(echo x)/gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]) {
      // What git does with a `!` helper: sh -c "<helper> get". The first word must come back as the path, untouched.
      const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuoteForGit(path)}`], { encoding: "utf8" });
      expect(out).toBe(path);
    }
  });

  it("makes one clone for callers at the same time, and never deletes another window's clone", async () => {
    const { ensureRepoClone, repoClonePath } = await import("./sources/github");
    const { mkdirSync: mkdir, rmSync, existsSync: exists, writeFileSync: write } = await import("node:fs");
    const storage = mkdtempSync(join(tmpdir(), "pn-clone-race-"));
    const path = repoClonePath(storage, "github.com__northwind__ledger-ui");
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runner: Runner = async (command, args) => {
      const line = `${command} ${args.join(" ")}`;
      calls.push(line);
      if (line.startsWith("gh repo clone")) {
        await gate;
        mkdir(join(args[3], ".git"), { recursive: true });
        return ok("");
      }
      for (const [re, res] of repoRules(path, "https://github.com/northwind/ledger-ui.git")) if (re.test(line)) return typeof res === "function" ? res(line) : res;
      return ok("");
    };
    try {
      const a = ensureRepoClone(runner, "northwind/ledger-ui", storage);
      const b = ensureRepoClone(runner, "northwind/ledger-ui", storage);
      // Another window finishes its clone first: its folder is moved in while ours is still cloning.
      mkdir(join(path, ".git"), { recursive: true });
      write(join(path, ".git", "theirs"), "");
      release();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.root).toBe(path);
      expect(rb.root).toBe(path);
      // One clone for both callers; it lost the race to the other window, so its own copy went and theirs stayed.
      expect(calls.filter((c) => c.startsWith("gh repo clone"))).toHaveLength(1);
      expect(exists(join(path, ".git", "theirs"))).toBe(true);
      expect(readdirSync(storage, { recursive: true }).some((n) => String(n).includes(".cloning-"))).toBe(false);
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("moves its clone in when it finishes first, and sweeps clones a closed window left behind", async () => {
    const { ensureRepoClone, repoClonePath } = await import("./sources/github");
    const { mkdirSync: mkdir, rmSync, existsSync: exists, utimesSync } = await import("node:fs");
    const storage = mkdtempSync(join(tmpdir(), "pn-clone-stale-"));
    const path = repoClonePath(storage, "github.com__northwind__ledger-ui");
    const stale = `${path}.cloning-1-1`;
    const fresh = `${path}.cloning-2-2`;
    mkdir(stale, { recursive: true });
    mkdir(fresh, { recursive: true });
    utimesSync(stale, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    const calls: string[] = [];
    const runner = scripted([
      [/^gh repo clone /, (line) => { mkdir(join(line.split(" ")[4], ".git"), { recursive: true }); return ok(""); }],
      ...repoRules(path, "https://github.com/northwind/ledger-ui.git"),
    ], calls);
    try {
      const [ra, rb] = await Promise.all([ensureRepoClone(runner, "northwind/ledger-ui", storage), ensureRepoClone(runner, "northwind/ledger-ui", storage)]);
      expect(ra.root).toBe(path);
      expect(rb.root).toBe(path);
      expect(calls.filter((c) => c.startsWith("gh repo clone"))).toHaveLength(1);
      expect(exists(join(path, ".git"))).toBe(true);
      expect(exists(stale)).toBe(false);
      // Still in progress in another window: left alone.
      expect(exists(fresh)).toBe(true);
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  });
});
