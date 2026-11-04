/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5), through a running Inbox's real doors with a scripted gh / glab
 * (`refRunner`) and a scripted branch reader: no real CLI, git or forge.
 *
 * What regresses:
 *  - anything run (gh, glab, git) while Code review is off, or the routes
 *    answering then;
 *  - a host asked that no CLI here is signed in to, or a query without
 *    `--hostname`;
 *  - PRs of repositories that are not Inbox projects in the list;
 *  - a second forge read inside the fresh window, or none after a refresh;
 *    a rate limit not holding the host, or the last answer lost on a failure;
 *  - a PR not tied to its agent's thread through a card, its URL, or its
 *    branch (and a teammate's PR tied through a branch name);
 *  - a layer review opening another diff than the layer's own, or the whole
 *    stack not running from the stack's base to that layer's head; a diff
 *    asked for a PR the list never named reaching the CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxPullsAnswer } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxPulls, INBOX_PULLS_FRESH_MS, parseGithubPulls, parseGitlabPulls } from "./inbox-pulls";
import type { RefRunner } from "./ref-cards";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const ghPull = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/northwind/billing-svc/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-03T10:00:00Z",
  mergedAt: null,
  baseRefName: "main",
  headRefName: `branch-${number}`,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: "northwind/billing-svc" },
  headRepository: { nameWithOwner: "northwind/billing-svc" },
  author: { login: "dana" },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...fields,
});

const GH_ANSWER = {
  data: {
    viewer: { login: "dana" },
    requested: { nodes: [ghPull(880, { author: { login: "tomas" }, headRefName: "rtl" })] },
    authored: {
      nodes: [
        ghPull(412, { headRefName: "retry/schedule" }),
        ghPull(413, { headRefName: "retry/backoff", baseRefName: "retry/schedule" }),
        // Another repository the person has no Inbox project for: never listed.
        ghPull(9, { repository: { nameWithOwner: "elsewhere/thing" }, url: "https://github.com/elsewhere/thing/pull/9" }),
      ],
    },
    merged: { nodes: [] },
  },
};

interface Forge {
  run: RefRunner;
  calls: { cli: string; args: string[] }[];
  graphql: () => { cli: string; args: string[] }[];
  fail: string | null;
}

/** gh signed in to github.com only; glab signed in nowhere. */
function forge(): Forge {
  const f: Forge = {
    calls: [],
    fail: null,
    graphql: () => f.calls.filter((c) => c.args.includes("graphql")),
    run: async (cli, args) => {
      f.calls.push({ cli, args });
      if (cli === "gh" && args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
      if (cli === "glab" && args[0] === "auth") return { stdout: "", stderr: "No hosts logged in", exitCode: 1 };
      if (cli === "gh" && args.includes("graphql")) {
        if (f.fail) return { stdout: "", stderr: f.fail, exitCode: 1 };
        return { stdout: JSON.stringify(GH_ANSWER), stderr: "", exitCode: 0 };
      }
      if (cli === "gh" && args[0] === "api") return { stdout: `diff of ${args[3]}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    },
  };
  return f;
}

async function world(options: { codeReview?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pulls-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const f = forge();
  const branches: string[] = [];
  const branch = { value: null as string | null };
  const server = await startInboxServer({
    dataDir,
    phones: false,
    ...(options.codeReview === undefined ? {} : { codeReview: options.codeReview }),
    refRunner: f.run,
    readProjectRepo: async () => ({ display: "northwind/billing-svc", host: "github.com" }),
    pullBranch: async (folder) => {
      branches.push(folder);
      return branch.value;
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-pulls-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  const send = async (body: string, thread: string) => {
    const result = (await client.callTool({ name: "send_message", arguments: { project_path: project, body, thread, agent_session: `ses_${thread}`, agent_name: "Claude Code", agent_host: "claude-code" } })) as { structuredContent: { thread_id: string } };
    return result.structuredContent.thread_id;
  };
  const pulls = async (query = "") => fetch(`${base}/api/inbox/pulls${query}`);
  const setCodeReview = (on: boolean) =>
    fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code_review: { on } }) });
  return { root, project, dataDir, base, forge: f, branches, branch, send, pulls, setCodeReview };
}

describe("off", () => {
  test("Code review off (unset): the routes refuse and nothing runs: no gh, no glab, no git", async () => {
    const w = await world();
    // A message carrying a PR link, so linking would have work to do.
    await w.send("Opened https://github.com/northwind/billing-svc/pull/412", "retries");
    const before = w.forge.calls.length;
    const list = await w.pulls();
    expect(list.status).toBe(409);
    expect(((await list.json()) as { code: string }).code).toBe("code_review_off");
    const diff = await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/northwind/billing-svc#412")}&scope=layer`);
    expect(diff.status).toBe(409);
    expect(w.forge.calls.length).toBe(before);
    expect(w.forge.calls.filter((c) => c.args.includes("graphql") || c.args[0] === "api")).toEqual([]);
    expect(w.branches).toEqual([]);
  });

  test("turned off in Settings after a read: the next ask is refused and runs nothing", async () => {
    const w = await world();
    await w.send("Opened https://github.com/northwind/billing-svc/pull/412", "retries");
    expect((await w.setCodeReview(true)).status).toBe(200);
    expect((await w.pulls()).status).toBe(200);
    expect(w.forge.graphql()).toHaveLength(1);
    const asked = w.forge.calls.length;
    const branches = w.branches.length;
    expect((await w.setCodeReview(false)).status).toBe(200);
    expect((await w.pulls("?refresh=1")).status).toBe(409);
    expect(w.forge.calls.length).toBe(asked);
    expect(w.branches.length).toBe(branches);
  });
});

describe("on", () => {
  test("one query to the signed-in host, with --hostname; only the projects' repositories; links by URL", async () => {
    const w = await world({ codeReview: true });
    const thread = await w.send("Ready for review: https://github.com/northwind/billing-svc/pull/413", "retries");
    const answer = (await (await w.pulls()).json()) as InboxPullsAnswer;
    const queries = w.forge.graphql();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.cli).toBe("gh");
    expect(queries[0]!.args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
    // No project is on GitLab, so glab is not even asked whether it is signed in.
    expect(w.forge.calls.filter((c) => c.cli === "glab")).toEqual([]);
    expect(answer.pulls.map((p) => p.number).sort()).toEqual([412, 413, 880]);
    expect(answer.hosts).toEqual([{ cli: "gh", host: "github.com", login: "dana" }]);
    expect(answer.links["github.com/northwind/billing-svc#413"]?.thread_id).toBe(thread);
    expect(answer.links["github.com/northwind/billing-svc#413"]?.via).toBe("url");
    expect(answer.links["github.com/northwind/billing-svc#413"]?.agent?.host).toBe("claude-code");
    // The teammate's PR is never tied through a branch.
    expect(answer.links["github.com/northwind/billing-svc#880"]).toBeUndefined();

    // Asked again at once: the cache answers, no second query.
    await w.pulls();
    expect(w.forge.graphql()).toHaveLength(1);
  });

  test("a branch checked out in an agent thread's folder ties the person's PR to that thread", async () => {
    const w = await world({ codeReview: true });
    const thread = await w.send("Working on the retry table.", "schedule");
    w.branch.value = "retry/schedule";
    const answer = (await (await w.pulls()).json()) as InboxPullsAnswer;
    expect(answer.links["github.com/northwind/billing-svc#412"]).toMatchObject({ via: "branch", thread_id: thread });
    expect(w.branches).toEqual([w.project]);
  });

  test("a layer's diff is its own; the whole stack runs from the stack's base to that layer's head; an unlisted PR runs nothing", async () => {
    const w = await world({ codeReview: true });
    await w.send("Stack is up.", "retries");
    expect(((await (await w.pulls()).json()) as InboxPullsAnswer).pulls).toHaveLength(3);
    const before = w.forge.calls.length;
    const layer = await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/northwind/billing-svc#413")}&scope=layer`);
    expect(layer.status).toBe(200);
    const layerAnswer = (await layer.json()) as { patch: string; base: string; head: string };
    expect(layerAnswer.patch).toBe("diff of repos/northwind/billing-svc/pulls/413\n");
    const stack = await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/northwind/billing-svc#413")}&scope=stack`);
    const stackAnswer = (await stack.json()) as { patch: string; base: string; head: string };
    expect(stackAnswer.patch).toBe("diff of repos/northwind/billing-svc/compare/main...retry/backoff\n");
    expect(stackAnswer).toMatchObject({ base: "main", head: "retry/backoff" });
    const diffCalls = w.forge.calls.slice(before);
    expect(diffCalls.every((c) => c.args.includes("--hostname") && c.args[c.args.indexOf("--hostname") + 1] === "github.com")).toBe(true);

    const unknown = await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/elsewhere/thing#9")}&scope=layer`);
    expect(unknown.status).toBe(404);
    expect(w.forge.calls.length).toBe(before + 2);
  });
});

describe("the reader", () => {
  const repos = [{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }];

  test("fresh, then read again on a refresh; a failure keeps the last answer; a rate limit holds the host", async () => {
    let now = 1_000_000;
    const f = forge();
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    expect((await pulls.list(repos)).pulls).toHaveLength(3);
    now += INBOX_PULLS_FRESH_MS - 1;
    await pulls.list(repos);
    expect(f.graphql()).toHaveLength(1);
    now += 30_000;
    await pulls.list(repos, { refresh: true });
    expect(f.graphql()).toHaveLength(2);

    f.fail = "API rate limit exceeded for user";
    now += INBOX_PULLS_FRESH_MS;
    const limited = await pulls.list(repos);
    expect(limited.pulls).toHaveLength(3);
    expect(limited.hosts[0]!.error).toBe("rate_limited");
    expect(f.graphql()).toHaveLength(3);
    // Held: asked again only after the hold, even on a refresh.
    now += 31_000;
    f.fail = null;
    await pulls.list(repos, { refresh: true });
    expect(f.graphql()).toHaveLength(3);
    now += 31_000;
    await pulls.list(repos, { refresh: true });
    expect(f.graphql()).toHaveLength(4);
  });

  test("a host no CLI here is signed in to is never queried", async () => {
    const f = forge();
    const pulls = createInboxPulls({ run: f.run });
    const answer = await pulls.list([{ host: "gitlab.com", repo: "northwind/ledger", project_id: "prj_2" }]);
    expect(answer.pulls).toEqual([]);
    expect(f.graphql()).toEqual([]);
    expect(f.calls.every((c) => c.args[0] === "auth")).toBe(true);
  });

  test("no repository, no call at all", async () => {
    const f = forge();
    const pulls = createInboxPulls({ run: f.run });
    expect(await pulls.list([])).toEqual({ fetched_at: null, hosts: [], pulls: [] });
    expect(f.calls).toEqual([]);
  });
});

describe("parsing", () => {
  test("GitHub: requested from the person, theirs, approver, checks, draft and merged", () => {
    const answer = parseGithubPulls(
      JSON.stringify({
        data: {
          viewer: { login: "dana" },
          requested: { nodes: [ghPull(880, { author: { login: "tomas" } })] },
          authored: {
            nodes: [
              ghPull(872, { reviewDecision: "APPROVED", latestReviews: { nodes: [{ state: "APPROVED", author: { login: "priya" } }] } }),
              ghPull(414, { isDraft: true, commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } }),
            ],
          },
          merged: { nodes: [ghPull(411, { state: "MERGED", mergedAt: "2026-11-02T10:00:00Z" })] },
        },
      }),
      "github.com",
    )!;
    const by = Object.fromEntries(answer.pulls.map((p) => [p.number, p]));
    expect(answer.login).toBe("dana");
    expect(by[880]).toMatchObject({ requested: true, mine: false, author: "tomas" });
    expect(by[872]).toMatchObject({ mine: true, review: "approved", approved_by: "priya", checks: "success" });
    expect(by[414]).toMatchObject({ state: "draft", checks: "pending" });
    expect(by[411]).toMatchObject({ state: "merged", merged_at: "2026-11-02T10:00:00Z" });
    expect(by[880]!.key).toBe("github.com/northwind/billing-svc#880");
  });

  test("GitLab: a nested group's project, the pipeline, approvals", () => {
    const mr = (iid: number, fields: Record<string, unknown> = {}) => ({
      iid: String(iid),
      title: `MR ${iid}`,
      webUrl: `https://gitlab.com/northwind/data/ledger/-/merge_requests/${iid}`,
      state: "opened",
      draft: false,
      updatedAt: "2026-11-03T10:00:00Z",
      mergedAt: null,
      sourceBranch: `b${iid}`,
      targetBranch: "main",
      approved: false,
      detailedMergeStatus: "NOT_APPROVED",
      diffStatsSummary: { additions: 3, deletions: 1, fileCount: 2 },
      headPipeline: { status: "RUNNING" },
      project: { fullPath: "northwind/data/ledger" },
      sourceProject: { fullPath: "northwind/data/ledger" },
      author: { username: "dana" },
      approvedBy: { nodes: [] },
      reviewers: { nodes: [{ username: "jun" }] },
      ...fields,
    });
    const answer = parseGitlabPulls(
      JSON.stringify({ data: { currentUser: { username: "dana", requested: { nodes: [] }, authored: { nodes: [mr(61), mr(57, { approved: true, headPipeline: { status: "SUCCESS" }, approvedBy: { nodes: [{ username: "jun" }] } })] }, merged: { nodes: [] } } } }),
      "gitlab.com",
    )!;
    const by = Object.fromEntries(answer.pulls.map((p) => [p.number, p]));
    expect(by[61]).toMatchObject({ repo: "northwind/data/ledger", checks: "pending", review: "review_required", reviewers: ["jun"], key: "gitlab.com/northwind/data/ledger#61:pull" });
    expect(by[57]).toMatchObject({ review: "approved", approved_by: "jun", checks: "success", reviewers: [] });
  });
});
