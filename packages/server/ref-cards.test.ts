/**
 * Hover cards for issue, PR and MR links (ref-cards.ts): the parsers for both
 * forges, one request per ref, the cache, GitHub's account fallback, rate
 * limits, the quiet errors, and the Inbox's `/api/inbox/ref` route with its
 * guards. Every CLI call goes to a scripted runner: no test runs gh or glab.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgeRefKey, forgeRefLabel, parseForgeRefUrl } from "@plannotator/core/forge-ref-card";
import { forgeRefLinks } from "@plannotator/core/forge-refs";
import {
  createRefCards,
  parseGithubRefAnswer,
  parseGitlabRefAnswer,
  readSignedInHosts,
  refErrorOf,
  AVATAR_CACHE_MAX,
  AVATAR_CACHE_MAX_BYTES,
  REF_AUTH_HOSTS_MS,
  REF_CACHE_MAX,
  REF_FAILURE_MS,
  REF_FRESH_MS,
  REF_MAX_CONCURRENT,
  REF_MAX_WAITING,
  REF_RATE_LIMIT_MS,
  REF_REPO_ACCOUNTS_MAX,
  REF_STALE_MAX_MS,
  type RefCli,
  type RefCommandResult,
  type RefRunner,
} from "./ref-cards";
import { startInboxServer, type InboxServer } from "./inbox";

type Call = { cli: RefCli; args: string[]; env?: Record<string, string> };

const ok = (stdout: unknown): RefCommandResult => ({ stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", exitCode: 0 });
const err = (stderr: string, exitCode = 1): RefCommandResult => ({ stdout: "", stderr, exitCode });

function githubPR(extra: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: "acme/widgets",
        issueOrPullRequest: {
          __typename: "PullRequest",
          number: 12,
          title: "Ship the widget",
          url: "https://github.com/acme/widgets/pull/12",
          state: "OPEN",
          isDraft: false,
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-02T00:00:00Z",
          closedAt: null,
          mergedAt: null,
          body: "Body",
          author: { login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/1?s=48" },
          labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "odd", color: "red;}" }] },
          assignees: { nodes: [] },
          comments: { totalCount: 3, nodes: [{ author: { login: "bob", avatarUrl: "https://evil.example/x.png" }, createdAt: "2026-10-02T00:00:00Z", body: "LGTM" }] },
          baseRefName: "main",
          headRefName: "widget",
          additions: 10,
          deletions: 2,
          changedFiles: 3,
          reviewDecision: "CHANGES_REQUESTED",
          closingIssuesReferences: { nodes: [{ number: 11, title: "Widget missing", url: "u", state: "OPEN" }] },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { totalCount: 3, nodes: [
            { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
            { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
            { __typename: "StatusContext", state: "SUCCESS" },
          ] } } } }] },
          ...extra,
        },
      },
    },
  };
}

function gitlabMR(extra: Record<string, unknown> = {}) {
  return {
    data: {
      project: {
        fullPath: "acme/sub/tools",
        mergeRequest: {
          iid: "7",
          title: "Faster builds",
          webUrl: "https://gitlab.com/acme/sub/tools/-/merge_requests/7",
          state: "opened",
          draft: true,
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-02T00:00:00Z",
          closedAt: null,
          mergedAt: null,
          description: "## What\n\nCache layers.",
          author: { username: "lin", avatarUrl: "/uploads/-/system/user/avatar/1/a.png" },
          labels: { nodes: [{ title: "ci", color: "#6699CC" }] },
          assignees: { nodes: [{ username: "lin", avatarUrl: "https://secure.gravatar.com/avatar/abc?s=80" }] },
          userNotesCount: 2,
          notes: { nodes: [
            { system: false, body: "first", createdAt: "2026-10-01T00:00:00Z", author: { username: "a", avatarUrl: null } },
            { system: false, body: "Please rebase", createdAt: "2026-10-02T00:00:00Z", author: { username: "rev", avatarUrl: "https://elsewhere.example/a.png" } },
            { system: true, body: "added 1 commit", createdAt: "2026-10-03T00:00:00Z", author: { username: "lin", avatarUrl: null } },
          ] },
          sourceBranch: "fast",
          targetBranch: "main",
          diffStatsSummary: { additions: 40, deletions: 5, fileCount: 4 },
          approved: false,
          detailedMergeStatus: "NOT_APPROVED",
          headPipeline: { status: "FAILED", jobs: { nodes: [{ status: "SUCCESS" }, { status: "FAILED" }, { status: "MANUAL" }] } },
          ...extra,
        },
      },
    },
  };
}

/** A scripted runner: `answer` decides each call; every call is recorded. */
function runner(answer: (call: Call) => RefCommandResult | Promise<RefCommandResult>) {
  const calls: Call[] = [];
  const run: RefRunner = async (cli, args, env) => {
    const call = { cli, args, env };
    calls.push(call);
    return answer(call);
  };
  return { run, calls, queries: () => calls.filter((c) => c.args.includes("graphql")) };
}

const PR_URL = "https://github.com/acme/widgets/pull/12";

describe("links", () => {
  test("GitHub and GitLab links parse; anything else is not a ref", () => {
    expect(parseForgeRefUrl("https://github.com/acme/widgets/issues/12#issuecomment-1")).toMatchObject({ platform: "github", owner: "acme", repo: "widgets", number: 12, kind: "issue" });
    expect(parseForgeRefUrl("https://github.com/acme/widgets/pull/12/files")).toMatchObject({ kind: "pull" });
    expect(parseForgeRefUrl("https://gitlab.com/acme/sub/tools/-/merge_requests/7")).toMatchObject({ platform: "gitlab", owner: "acme/sub", repo: "tools", number: 7, kind: "pull" });
    expect(parseForgeRefUrl("https://gitlab.com/acme/tools/-/work_items/3")).toMatchObject({ kind: "issue" });
    for (const bad of [
      "http://github.com/a/b/pull/1",
      "https://user:pw@github.com/a/b/pull/1",
      "https://github.com:8443/a/b/pull/1",
      "https://github.com/a/b/pull/0",
      "https://github.com/a/b/blob/main/x.ts",
      "https://example.com/a/b/pull/1",
      "https://gitlab.com/a/-/merge_requests/1",
      "not a url",
    ]) {
      expect(parseForgeRefUrl(bad)).toBeNull();
    }
  });

  test("a web link's host is taken as written: a host that only starts like github.com is no forge", async () => {
    for (const bad of [
      "https://github.com-evil.example/o/r/pull/1",
      "https://github.com.evil.example/o/r/pull/1",
      "https://gitlab.com-evil.example/o/r/-/merge_requests/1",
      "https://ssh.github.com/o/r/pull/1",
    ]) {
      expect(parseForgeRefUrl(bad)).toBeNull();
    }
    // Nothing is fetched for it, not even an "unsupported" card.
    const r = runner(() => ok(githubPR()));
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    expect(await cards.get("https://github.com-evil.example/o/r/pull/1")).toBeNull();
    expect(r.calls).toHaveLength(0);
    // Git remotes keep their SSH aliases: a `github.com-work` remote still links refs to github.com.
    expect(forgeRefLinks({ display: "acme/widgets", host: "github.com-work" })?.issue(3)).toBe("https://github.com/acme/widgets/issues/3");
  });

  test("keys and labels: a GitHub issue link to a PR is one entry; GitLab numbers issues and MRs apart", () => {
    const issue = parseForgeRefUrl("https://github.com/acme/widgets/issues/12")!;
    const pull = parseForgeRefUrl(PR_URL)!;
    expect(forgeRefKey(issue)).toBe(forgeRefKey(pull));
    const mr = parseForgeRefUrl("https://gitlab.com/acme/tools/-/merge_requests/7")!;
    const gi = parseForgeRefUrl("https://gitlab.com/acme/tools/-/issues/7")!;
    expect(forgeRefKey(mr)).not.toBe(forgeRefKey(gi));
    expect(forgeRefLabel(mr)).toBe("!7");
    expect(forgeRefLabel(gi)).toBe("#7");
    expect(forgeRefLabel(pull)).toBe("#12");
  });
});

describe("parsing", () => {
  test("a GitHub PR: checks tallied, review decision, untrusted fields cleaned", () => {
    const d = parseGithubRefAnswer(JSON.stringify(githubPR()));
    if (!d || d === "not_found") throw new Error("expected data");
    expect(d).toMatchObject({ platform: "github", kind: "pull", state: "open", comments: 3 });
    expect(d.pull).toMatchObject({ base: "main", head: "widget", additions: 10, review: "changes_requested", checks: { state: "failure", failed: 1, pending: 1, passed: 1, total: 3 } });
    expect(d.labels.map((l) => l.color)).toEqual(["d73a4a", "888888"]);
    expect(d.lastComment?.author?.avatarUrl).toBeNull(); // not GitHub's avatar host
    expect(d.linked).toEqual([{ number: 11, title: "Widget missing", url: "u", state: "open" }]);
    expect(parseGithubRefAnswer(JSON.stringify(githubPR({ isDraft: true })))).toMatchObject({ state: "draft" });
    expect(parseGithubRefAnswer(JSON.stringify(githubPR({ state: "MERGED", mergedAt: "2026-10-03T00:00:00Z" })))).toMatchObject({ state: "merged", closedAt: "2026-10-03T00:00:00Z" });
    expect(parseGithubRefAnswer(JSON.stringify({ data: { repository: { issueOrPullRequest: null } } }))).toBe("not_found");
    expect(parseGithubRefAnswer("garbage")).toBeNull();
  });

  test("a GitHub issue: completed, not planned, the body cut", () => {
    const issue = (extra: Record<string, unknown>) =>
      JSON.stringify({ data: { repository: { nameWithOwner: "acme/widgets", issueOrPullRequest: { __typename: "Issue", number: 3, state: "CLOSED", stateReason: "COMPLETED", body: "x".repeat(5000), ...extra } } } });
    const done = parseGithubRefAnswer(issue({}));
    if (!done || done === "not_found") throw new Error("expected data");
    expect(done).toMatchObject({ kind: "issue", state: "completed", bodyCut: true });
    expect(done.body.length).toBeLessThanOrEqual(4001);
    expect(parseGithubRefAnswer(issue({ stateReason: "NOT_PLANNED" }))).toMatchObject({ state: "not_planned" });
    expect(parseGithubRefAnswer(issue({ state: "OPEN" }))).toMatchObject({ state: "open" });
  });

  test("a GitLab MR: draft, pipeline jobs, approvals, the latest person's note, avatars from GitLab only", () => {
    const d = parseGitlabRefAnswer(JSON.stringify(gitlabMR()), "gitlab.com", "pull");
    if (!d || d === "not_found") throw new Error("expected data");
    expect(d).toMatchObject({ platform: "gitlab", kind: "pull", number: 7, repo: "acme/sub/tools", state: "draft", comments: 2, linked: [] });
    expect(d.pull).toMatchObject({ base: "main", head: "fast", additions: 40, deletions: 5, files: 4, review: "review_required", checks: { state: "failure", passed: 2, failed: 1, total: 3 } });
    expect(d.author?.avatarUrl).toBe("https://gitlab.com/uploads/-/system/user/avatar/1/a.png");
    expect(d.assignees[0].avatarUrl).toBe("https://secure.gravatar.com/avatar/abc?s=80");
    expect(d.lastComment).toMatchObject({ body: "Please rebase", author: { login: "rev", avatarUrl: null } });
    expect(d.labels).toEqual([{ name: "ci", color: "6699cc" }]);
    const merged = parseGitlabRefAnswer(JSON.stringify(gitlabMR({ state: "merged", draft: false, approved: true, detailedMergeStatus: "NOT_OPEN", headPipeline: { status: "SUCCESS", jobs: { nodes: [] } } })), "gitlab.com", "pull");
    expect(merged).toMatchObject({ state: "merged", pull: { review: "approved", checks: { state: "success" } } });
    const noPipeline = parseGitlabRefAnswer(JSON.stringify(gitlabMR({ headPipeline: null, detailedMergeStatus: "REQUESTED_CHANGES" })), "gitlab.com", "pull");
    expect(noPipeline).toMatchObject({ pull: { checks: null, review: "changes_requested" } });
    expect(parseGitlabRefAnswer(JSON.stringify({ data: { project: { mergeRequest: null } } }), "gitlab.com", "pull")).toBe("not_found");
    expect(parseGitlabRefAnswer(JSON.stringify({ data: { project: null } }), "gitlab.com", "issue")).toBe("not_found");
  });

  test("a GitLab issue: opened and closed", () => {
    const issue = (state: string) => JSON.stringify({ data: { project: { fullPath: "acme/tools", issue: { iid: "3", state, title: "t", webUrl: "u", userNotesCount: 0, notes: { nodes: [] } } } } });
    expect(parseGitlabRefAnswer(issue("opened"), "gitlab.com", "issue")).toMatchObject({ kind: "issue", state: "open" });
    expect(parseGitlabRefAnswer(issue("closed"), "gitlab.com", "issue")).toMatchObject({ state: "completed" });
  });

  test("errors read quietly", () => {
    expect(refErrorOf("gh", err("", 127))).toBe("cli_missing");
    expect(refErrorOf("gh", err("gh: not found"))).toBe("cli_missing");
    // A 404 is the forge saying no, never "gh is not installed".
    expect(refErrorOf("gh", err("HTTP 404: Not Found (https://api.github.com/graphql)"))).toBe("refused");
    expect(refErrorOf("gh", err("To get started with GitHub CLI, please run:  gh auth login", 4))).toBe("signed_out");
    expect(refErrorOf("gh", err("GraphQL: API rate limit exceeded for user ID 1."))).toBe("rate_limited");
    expect(refErrorOf("gh", err("GraphQL: Could not resolve to a Repository with the name 'acme/secret'."))).toBe("refused");
    expect(refErrorOf("glab", err("glab: 401 Unauthorized"))).toBe("signed_out");
    expect(refErrorOf("glab", err("glab: 429 Too Many Requests"))).toBe("rate_limited");
    expect(refErrorOf("glab", err("dial tcp: lookup gitlab.com: no such host"))).toBe("unavailable");
  });
});

describe("fetching", () => {
  test("one query per ref: concurrent hovers share it, a fresh answer is reused", async () => {
    let resolve!: (r: RefCommandResult) => void;
    const r = runner(() => new Promise((res) => (resolve = res)));
    const cards = createRefCards({ run: r.run, avatar: async () => "data:image/png;base64,AA==" });
    const a = cards.get(PR_URL);
    const b = cards.get("https://github.com/acme/widgets/issues/12");
    await Bun.sleep(0);
    resolve(ok(githubPR()));
    const [x, y] = await Promise.all([a, b]);
    expect(x).toEqual(y);
    expect(r.queries()).toHaveLength(1);
    const q = r.queries()[0];
    expect(q.cli).toBe("gh");
    expect(q.args.find((s) => s.startsWith("query="))!.startsWith("query=query(")).toBe(true);
    expect(q.args).toContain("number=12");
    if (!x?.ok) throw new Error("expected data");
    expect(x.data.author?.avatarUrl).toBe("data:image/png;base64,AA==");
    await cards.get(PR_URL);
    expect(r.queries()).toHaveLength(1);
  });

  test("a stale answer is served at once and refreshed behind; a failure never replaces it; a failure is kept briefly", async () => {
    let now = 1_000;
    let answer: RefCommandResult = ok(githubPR());
    const r = runner(() => answer);
    const cards = createRefCards({ run: r.run, now: () => now, avatar: async () => null });
    expect((await cards.get(PR_URL))?.ok).toBe(true);
    now += REF_FRESH_MS + 1;
    answer = err("dial tcp: i/o timeout");
    const stale = await cards.get(PR_URL);
    expect(stale?.ok).toBe(true);
    await Bun.sleep(0);
    expect(r.queries()).toHaveLength(2);
    // The failed refresh kept the good answer, and holds off the next one for REF_FAILURE_MS.
    expect((await cards.get(PR_URL))?.ok).toBe(true);
    await Bun.sleep(0);
    expect(r.queries()).toHaveLength(2);
    now += REF_FAILURE_MS + 1;
    await cards.get(PR_URL);
    await Bun.sleep(0);
    expect(r.queries()).toHaveLength(3);
    // Past the stale window a failure shows, then is kept for REF_FAILURE_MS.
    now += REF_STALE_MAX_MS + 1;
    expect(await cards.get(PR_URL)).toMatchObject({ ok: false, error: "unavailable" });
    const before = r.queries().length;
    now += REF_FAILURE_MS - 1;
    await cards.get(PR_URL);
    expect(r.queries()).toHaveLength(before);
    now += 2;
    await cards.get(PR_URL);
    expect(r.queries()).toHaveLength(before + 1);
  });

  test("account fallback: GitHub refuses the active account, another signed-in account sees it, and is remembered", async () => {
    const r = runner(({ args, env }) => {
      if (args[0] === "auth" && args[1] === "status") {
        return ok({ hosts: { "github.com": [
          { login: "personal", active: true, state: "success", tokenSource: "keyring" },
          { login: "work", active: false, state: "success", tokenSource: "keyring" },
          { login: "broken", active: false, state: "error", tokenSource: "keyring" },
        ] } });
      }
      if (args[0] === "auth" && args[1] === "token") return args.includes("work") ? ok("gho_work\n") : err("no token");
      // The work account reads acme/widgets only; nobody reads acme/secret.
      if (env?.GH_TOKEN === "gho_work" && args.includes("repo=widgets")) return ok(githubPR());
      return err("GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)");
    });
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    const first = await cards.get(PR_URL);
    expect(first?.ok).toBe(true);
    // The broken login is never asked for a token; the working one is used for that child only.
    expect(r.calls.some((c) => c.args.includes("broken"))).toBe(false);
    expect(r.queries().map((c) => c.env?.GH_TOKEN)).toEqual([undefined, "gho_work"]);
    // Another ref in the same repo starts with the remembered account.
    await cards.get("https://github.com/acme/widgets/pull/13");
    expect(r.queries().at(-1)?.env?.GH_TOKEN).toBe("gho_work");
    // No account can see a private repo: not found, quietly.
    const other = await cards.get("https://github.com/acme/secret/pull/1");
    expect(other).toMatchObject({ ok: false, error: "not_found" });
  });

  test("account fallback on a gh without --json reads the text form", async () => {
    const r = runner(({ args, env }) => {
      if (args[0] === "auth" && args[1] === "status") {
        return args.includes("--json")
          ? err("unknown flag: --json")
          : { stdout: "", stderr: "github.com\n  ✓ Logged in to github.com account personal (keyring)\n  - Active account: true\n  ✓ Logged in to github.com account work (keyring)\n  - Active account: false\n", exitCode: 0 };
      }
      if (args[1] === "token") return ok("gho_work");
      return env?.GH_TOKEN === "gho_work" ? ok(githubPR()) : err("HTTP 404: Not Found");
    });
    expect((await createRefCards({ run: r.run, avatar: async () => null }).get(PR_URL))?.ok).toBe(true);
  });

  test("rate limits pause that host for a minute, then it is asked again", async () => {
    let now = 1_000;
    let limited = true;
    const r = runner(({ cli }) => (limited ? err(cli === "gh" ? "GraphQL: API rate limit exceeded" : "429 Too Many Requests") : ok(githubPR())));
    const cards = createRefCards({ run: r.run, now: () => now, avatar: async () => null });
    expect(await cards.get(PR_URL)).toMatchObject({ ok: false, error: "rate_limited" });
    // Another ref on the same host is not asked while the pause lasts.
    expect(await cards.get("https://github.com/acme/widgets/pull/99")).toMatchObject({ error: "rate_limited" });
    expect(r.queries()).toHaveLength(1);
    // GitLab is another host: still asked.
    await cards.get("https://gitlab.com/acme/tools/-/merge_requests/7");
    expect(r.queries()).toHaveLength(2);
    limited = false;
    now += REF_RATE_LIMIT_MS + 1;
    expect((await cards.get("https://github.com/acme/widgets/pull/99"))?.ok).toBe(true);
  });

  test("GitLab through glab: the MR query for an MR link, --hostname for a host glab is signed in to, signed out quietly", async () => {
    const r = runner(({ args }) => {
      if (args[0] === "auth") return { stdout: "", stderr: "gitlab.acme.dev\n  ✓ Logged in to gitlab.acme.dev as lin (/home/lin/.config/glab-cli/config.yml)\n", exitCode: 0 };
      return args.includes("gitlab.acme.dev") ? err("glab: 401 Unauthorized") : ok(gitlabMR());
    });
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    const mr = await cards.get("https://gitlab.com/acme/sub/tools/-/merge_requests/7");
    expect(mr).toMatchObject({ ok: true, data: { platform: "gitlab", state: "draft" } });
    const q = r.queries()[0];
    expect(q.cli).toBe("glab");
    expect(q.args.slice(0, 4)).toEqual(["api", "--hostname", "gitlab.com", "graphql"]);
    expect(q.args).toContain("path=acme/sub/tools");
    expect(q.args).toContain("iid=7");
    expect(q.args.find((s) => s.startsWith("query="))).toContain("mergeRequest(iid: $iid)");
    expect(await cards.get("https://gitlab.acme.dev/acme/tools/-/issues/3")).toMatchObject({ ok: false, error: "signed_out" });
    const self = r.queries()[1];
    expect(self.args.slice(0, 3)).toEqual(["api", "--hostname", "gitlab.acme.dev"]);
    expect(self.args.find((s) => s.startsWith("query="))).toContain("issue(iid: $iid)");
  });

  test("an unknown host is never fetched; the CLI missing reads quietly", async () => {
    const r = runner(() => err("", 127));
    const cards = createRefCards({ run: r.run });
    expect(await cards.get("https://github.acme.dev/acme/widgets/pull/1")).toMatchObject({ ok: false, error: "unsupported" });
    expect(await cards.get("https://example.com/acme/widgets/pull/1")).toBeNull();
    expect(r.queries()).toHaveLength(0);
    expect(await cards.get(PR_URL)).toMatchObject({ ok: false, error: "cli_missing" });
  });

  test("a host the CLI is not signed in to is never fetched, so its token never goes there (a cloned repo's origin github.evil.example)", async () => {
    const r = runner(({ cli, args }) => {
      if (cli === "gh" && args[0] === "auth") {
        return ok({ hosts: {
          "github.com": [{ login: "ada", active: true, state: "success" }],
          "github.acme.dev": [{ login: "ada", active: true, state: "success" }],
          "github.broken.dev": [{ login: "ada", active: true, state: "error" }],
        } });
      }
      if (cli === "glab" && args[0] === "auth") return err("glab: no hosts configured", 1);
      return ok(githubPR());
    });
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    for (const href of [
      "https://github.evil.example/acme/widgets/pull/1",
      "https://github.broken.dev/acme/widgets/pull/1",
      "https://gitlab.evil.example/acme/tools/-/merge_requests/1",
      "https://tools.gitlab.evil.example/acme/tools/-/issues/1",
    ]) {
      expect(await cards.get(href)).toMatchObject({ ok: false, error: "unsupported" });
    }
    expect(r.queries()).toHaveLength(0);
    // A host gh is signed in to (GitHub Enterprise) is fetched, with --hostname.
    expect(await cards.get("https://github.acme.dev/acme/widgets/pull/12")).toMatchObject({ ok: true });
    expect(r.queries()[0].args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.acme.dev"]);
    // The signed-in hosts are read once per CLI, not per hover.
    expect(r.calls.filter((c) => c.args[0] === "auth").map((c) => c.cli).sort()).toEqual(["gh", "glab"]);
  });

  test("gh's JSON: an account with no state, or a state other than success, does not make its host signed in", async () => {
    const gh: RefRunner = async () =>
      ok({ hosts: {
        "github.com": [{ login: "ada", active: true, state: "success" }],
        "ghe.nostate.dev": [{ login: "ada", active: true }],
        "ghe.error.dev": [{ login: "ada", active: true, state: "error" }],
        "ghe.null.dev": [null],
      } });
    expect([...(await readSignedInHosts(gh, "gh"))]).toEqual(["github.com"]);
  });

  test("the signed-in hosts: gh's JSON, gh's text form, glab's status lines", async () => {
    const ghText: RefRunner = async (_cli, args) =>
      args.includes("--json")
        ? err("unknown flag: --json")
        : { stdout: "", stderr: "github.com\n  ✓ Logged in to github.com account ada (keyring)\nghe.acme.dev\n  ✓ Logged in to ghe.acme.dev account ada (keyring)\n", exitCode: 0 };
    expect([...(await readSignedInHosts(ghText, "gh"))].sort()).toEqual(["ghe.acme.dev", "github.com"]);
    const glab: RefRunner = async () => ({ stdout: "", stderr: "gitlab.com\n  ✓ Logged in to gitlab.com as lin\ngitlab.acme.dev\n  x gitlab.acme.dev: api call failed\n", exitCode: 1 });
    expect([...(await readSignedInHosts(glab, "glab"))]).toEqual(["gitlab.com"]);
    expect([...(await readSignedInHosts(async () => err("", 127), "glab"))]).toEqual([]);
  });

  test("--hostname is always passed, github.com and gitlab.com too, so GH_HOST, GITLAB_HOST or the folder's remote never pick the host", async () => {
    const r = runner(({ cli }) => ok(cli === "gh" ? githubPR() : gitlabMR()));
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    await cards.get(PR_URL);
    await cards.get("https://gitlab.com/acme/sub/tools/-/merge_requests/7");
    const [gh, glab] = r.queries();
    expect(gh.cli).toBe("gh");
    expect(gh.args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
    expect(glab.cli).toBe("glab");
    expect(glab.args.slice(0, 4)).toEqual(["api", "--hostname", "gitlab.com", "graphql"]);
  });

  test("a failed or timed-out `auth status` is kept for REF_FAILURE_MS, not REF_AUTH_HOSTS_MS", async () => {
    let t = 1_000_000;
    let signedIn = false;
    const r = runner(({ cli, args }) => {
      if (cli === "gh" && args[0] === "auth") {
        return signedIn ? ok({ hosts: { "github.acme.dev": [{ login: "ada", active: true, state: "success" }] } }) : err("timed out", 1);
      }
      return ok(githubPR());
    });
    const cards = createRefCards({ run: r.run, now: () => t, avatar: async () => null });
    const ghe = "https://github.acme.dev/acme/widgets/pull/12";
    expect(await cards.get(ghe)).toMatchObject({ ok: false, error: "unsupported" });
    signedIn = true;
    t += REF_FAILURE_MS - 1;
    expect(await cards.get(ghe)).toMatchObject({ ok: false, error: "unsupported" });
    t += 2;
    expect(await cards.get(ghe)).toMatchObject({ ok: true });
    const authCalls = r.calls.filter((c) => c.args[0] === "auth");
    // Failed: the JSON form, then the text form; then once more after REF_FAILURE_MS.
    expect(authCalls).toHaveLength(3);
    // A host set that has hosts is kept for REF_AUTH_HOSTS_MS.
    t += REF_AUTH_HOSTS_MS - 1;
    await cards.get("https://github.acme.dev/acme/widgets/pull/13");
    expect(r.calls.filter((c) => c.args[0] === "auth")).toHaveLength(3);
  });

  test("owner and repo go as strings: a repo named 2048, true or null stays a string", async () => {
    const r = runner(() => ok(githubPR()));
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    await cards.get("https://github.com/user/2048/pull/5");
    await cards.get("https://github.com/true/null/issues/6");
    for (const q of r.queries()) {
      const pairs = q.args.flatMap((a, i) => (a === "-f" || a === "-F" ? [`${a} ${q.args[i + 1].split("=")[0]}`] : []));
      expect(pairs).toEqual(["-f query", "-f owner", "-f repo", "-F number"]);
    }
    expect(r.queries()[0].args).toContain("repo=2048");
    expect(r.queries()[1].args).toContain("owner=true");
    expect(r.queries()[1].args).toContain("repo=null");
  });
});

describe("bounded memory", () => {
  /** gh's answer for whatever `number=` asks, with an avatar URL of its own. */
  const numbered = ({ args }: Call) => {
    const n = Number(args.find((a) => a.startsWith("number="))?.slice("number=".length));
    return ok(githubPR({ number: n, author: { login: `u${n}`, avatarUrl: `https://avatars.githubusercontent.com/u/${n}` } }));
  };
  const pr = (n: number, repo = "widgets") => `https://github.com/acme/${repo}/pull/${n}`;

  test("the ref cache stops at REF_CACHE_MAX and drops the least recently used ref first", async () => {
    const r = runner(numbered);
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    for (let n = 1; n <= REF_CACHE_MAX + 50; n++) {
      await cards.get(pr(n));
      // Ref 1 is read again all along, so it stays.
      if (n % 100 === 0) await cards.get(pr(1));
    }
    expect(cards.sizes().refs).toBe(REF_CACHE_MAX);
    const asked = r.queries().length;
    expect(asked).toBe(REF_CACHE_MAX + 50);
    // Kept: the one read again, and the newest. Dropped: the oldest unread ones, asked again.
    await cards.get(pr(1));
    await cards.get(pr(REF_CACHE_MAX + 50));
    expect(r.queries()).toHaveLength(asked);
    await cards.get(pr(2));
    expect(r.queries()).toHaveLength(asked + 1);
    expect(cards.sizes().refs).toBe(REF_CACHE_MAX);
  });

  test("answers and failures no longer worth serving are dropped, with their holds", async () => {
    let now = 1_000;
    let up = true;
    // No other account to fall back to: a refusal is a quiet not_found.
    const r = runner(({ args }) => (args[0] === "auth" ? err("no") : up ? ok(githubPR()) : err("HTTP 404: Not Found")));
    const cards = createRefCards({ run: r.run, now: () => now, avatar: async () => null });
    for (let n = 1; n <= 20; n++) await cards.get(pr(n));
    up = false;
    for (let n = 21; n <= 40; n++) await cards.get(pr(n));
    expect(cards.sizes()).toMatchObject({ refs: 40, retries: 0 });
    // Past the fresh window, so past the failure window too: a stale answer's refresh fails and
    // holds off the next one, and the 20 failures go with that fetch.
    now += REF_FRESH_MS + 1;
    await cards.get(pr(1));
    await Bun.sleep(0);
    expect(cards.sizes()).toMatchObject({ refs: 20, retries: 1 });
    // Past the hold: it goes with the next fetch.
    now += REF_FAILURE_MS + 1;
    up = true;
    await cards.get(pr(41));
    expect(cards.sizes()).toMatchObject({ refs: 21, retries: 0 });
    // Past the stale window: every old answer goes too.
    now += REF_STALE_MAX_MS;
    await cards.get(pr(42));
    expect(cards.sizes()).toMatchObject({ refs: 1, retries: 0 });
  });

  test("remembered GitHub accounts stop at REF_REPO_ACCOUNTS_MAX, oldest dropped first", async () => {
    const r = runner(({ args, env }) => {
      if (args[0] === "auth" && args[1] === "status") {
        return ok({ hosts: { "github.com": [{ login: "personal", active: true, state: "success" }, { login: "work", active: false, state: "success" }] } });
      }
      if (args[0] === "auth" && args[1] === "token") return ok("gho_work");
      return env?.GH_TOKEN === "gho_work" ? ok(githubPR()) : err("HTTP 404: Not Found");
    });
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    for (let i = 0; i < REF_REPO_ACCOUNTS_MAX + 10; i++) expect((await cards.get(pr(1, `repo${i}`)))?.ok).toBe(true);
    expect(cards.sizes().repoAccounts).toBe(REF_REPO_ACCOUNTS_MAX);
    // The newest repo starts with its account; the oldest was forgotten and starts with the active one again.
    await cards.get(pr(2, `repo${REF_REPO_ACCOUNTS_MAX + 9}`));
    expect(r.queries().at(-1)?.env?.GH_TOKEN).toBe("gho_work");
    const before = r.queries().length;
    expect((await cards.get(pr(2, "repo0")))?.ok).toBe(true);
    expect(r.queries()[before].env?.GH_TOKEN).toBeUndefined();
  });

  test("avatars stop at AVATAR_CACHE_MAX entries and AVATAR_CACHE_MAX_BYTES in all", async () => {
    const small = runner(numbered);
    const few = createRefCards({ run: small.run, avatar: async () => "data:image/png;base64,AA==" });
    for (let n = 1; n <= AVATAR_CACHE_MAX + 20; n++) await few.get(pr(n));
    expect(few.sizes().avatars).toBe(AVATAR_CACHE_MAX);

    const big = runner(numbered);
    const uri = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
    const heavy = createRefCards({ run: big.run, avatar: async () => uri });
    for (let n = 1; n <= 20; n++) expect(await heavy.get(pr(n))).toMatchObject({ ok: true, data: { author: { avatarUrl: uri } } });
    const { avatars, avatarBytes } = heavy.sizes();
    expect(avatarBytes).toBeLessThanOrEqual(AVATAR_CACHE_MAX_BYTES);
    expect(avatarBytes).toBe(avatars * uri.length);
    expect(avatars).toBe(Math.floor(AVATAR_CACHE_MAX_BYTES / uri.length));
  });

  test("at most REF_MAX_WAITING lookups wait for a CLI; one more answers unavailable at once and is not kept", async () => {
    const gates: (() => void)[] = [];
    let block = true;
    const r = runner((call) => (block ? new Promise<RefCommandResult>((resolve) => gates.push(() => resolve(numbered(call)))) : numbered(call)));
    const cards = createRefCards({ run: r.run, avatar: async () => null });
    const queued = Array.from({ length: REF_MAX_CONCURRENT + REF_MAX_WAITING }, (_, i) => cards.get(pr(i + 1)));
    await Bun.sleep(0);
    expect(cards.sizes().waiting).toBe(REF_MAX_WAITING);
    const extra = pr(REF_MAX_CONCURRENT + REF_MAX_WAITING + 1);
    expect(await cards.get(extra)).toMatchObject({ ok: false, error: "unavailable" });
    expect(cards.sizes().refs).toBe(0);
    block = false;
    while (gates.length) gates.shift()!();
    for (const result of await Promise.all(queued)) expect(result?.ok).toBe(true);
    expect(cards.sizes().waiting).toBe(0);
    // Nothing was kept for the refused one: the next hover asks.
    expect((await cards.get(extra))?.ok).toBe(true);
  });
});

describe("the Inbox route", () => {
  const roots: string[] = [];
  const servers: InboxServer[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function inbox(run: RefRunner, extra: Partial<Parameters<typeof startInboxServer>[0]> = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-ref-cards-")));
    roots.push(root);
    const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, refRunner: run, ...extra });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    return {
      get: (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }),
      post: (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    };
  }

  test("answers the card, refuses another site, a bad url and a phone", async () => {
    const r = runner(() => ok(githubPR()));
    const { get, post } = await inbox(r.run, { phones: true });
    const card = await get(`/api/inbox/ref?url=${encodeURIComponent(PR_URL)}`);
    expect(card.status).toBe(200);
    expect(card.headers.get("cache-control")).toBe("no-store");
    expect(await card.json()).toMatchObject({ ok: true, data: { title: "Ship the widget" } });
    expect((await get(`/api/inbox/ref?url=${encodeURIComponent(PR_URL)}`, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await get(`/api/inbox/ref?url=${encodeURIComponent(PR_URL)}`, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await get(`/api/inbox/ref?url=${encodeURIComponent("https://example.com/x")}`)).status).toBe(422);
    // Not on the device door: a paired phone (and so the relay) is refused the route, and nothing runs.
    const offer = (await (await post("/api/inbox/pairing", {})).json()) as { offer: { code: string } };
    const paired = await post("/api/inbox/device/pair", { code: offer.offer.code, name: "iPhone", platform: "ios" });
    expect(paired.status).toBe(201);
    const token = ((await paired.json()) as { token: string }).token;
    const auth = { Authorization: `Bearer ${token}` };
    expect((await get("/api/inbox/device/threads", auth)).status).toBe(200); // the token works on the door
    const door = await get(`/api/inbox/device/ref?url=${encodeURIComponent(PR_URL)}`, auth);
    expect(door.status).toBe(404);
    expect(((await door.json()) as { code: string }).code).toBe("device_route_not_found");
    expect(r.queries()).toHaveLength(1);
  });
});
