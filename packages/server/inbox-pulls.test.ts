/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5), through a running Inbox's real doors with a scripted gh / glab
 * (`refRunner`): no real CLI or forge.
 *
 * What regresses:
 *  - anything run (gh, glab, git) while Code review is off, or the routes
 *    answering then;
 *  - a host asked that no CLI here is signed in to, or a query without
 *    `--hostname`;
 *  - PRs of repositories that are not Inbox projects in the list;
 *  - a second forge read inside the fresh window, or none after a refresh;
 *    a rate limit not holding the host, or the last answer lost on a failure;
 *  - a PR not tied to the thread the person handed it to, or to its agent's
 *    own thread through its URL; one tied by anything else (a branch, a
 *    Board card, another project's thread); a Board card shown while the
 *    Board is off;
 *  - a layer review opening another diff than the layer's own, or the whole
 *    stack not running from the stack's base to that layer's head; a diff
 *    asked for a PR the list never named reaching the CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxId, type InboxPullsAnswer } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxPulls, GITHUB_SEARCH_MAX_CHARS, githubPullSearches, INBOX_PULL_DIFF_MAX_BYTES, INBOX_PULLS_FRESH_MS, parseGithubPulls, parseGitlabPulls, safeBranch } from "./inbox-pulls";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import type { RefRunner } from "./ref-cards";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
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
function forge(answer: unknown = GH_ANSWER): Forge {
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
        return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
      }
      if (cli === "gh" && args[0] === "api") return { stdout: `diff of ${args[3]}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    },
  };
  return f;
}

async function world(options: { codeReview?: boolean; answer?: unknown; tailscale?: TailscaleRunner; board?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pulls-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const f = forge(options.answer);
  const server = await startInboxServer({
    dataDir,
    phones: false,
    ...(options.codeReview === undefined ? {} : { codeReview: options.codeReview }),
    ...(options.tailscale ? { tailscale: options.tailscale } : {}),
    ...(options.board === undefined ? {} : { board: options.board }),
    refRunner: f.run,
    readProjectRepo: async () => ({ display: "northwind/billing-svc", host: "github.com" }),
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
  const own = (keys: string[], threadId: string, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/api/inbox/pulls/owner`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys, thread_id: threadId, ...extra }) });
  const check = (keys: string[], projectId: string) =>
    fetch(`${base}/api/inbox/pulls/owner`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys, project_id: projectId, validate_only: true }) });
  return { root, project, dataDir, base, server, forge: f, send, pulls, own, check, setCodeReview };
}

describe("off", () => {
  test("Code review off (unset): the routes refuse and nothing runs: no gh, no glab", async () => {
    const w = await world();
    // A message carrying a PR link, so linking would have work to do.
    await w.send("Opened https://github.com/northwind/billing-svc/pull/412", "retries");
    const before = w.forge.calls.length;
    const list = await w.pulls();
    expect(list.status).toBe(409);
    expect(((await list.json()) as { code: string }).code).toBe("code_review_off");
    const diff = await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/northwind/billing-svc#412")}&scope=layer`);
    expect(diff.status).toBe(409);
    const thread = await w.send("Working.", "other");
    expect((await w.own(["github.com/northwind/billing-svc#412"], thread)).status).toBe(409);
    expect(w.forge.calls.length).toBe(before);
    expect(w.forge.calls.filter((c) => c.args.includes("graphql") || c.args[0] === "api")).toEqual([]);
  });

  test("turned off in Settings after a read: the next ask is refused and runs nothing", async () => {
    const w = await world();
    await w.send("Opened https://github.com/northwind/billing-svc/pull/412", "retries");
    expect((await w.setCodeReview(true)).status).toBe(200);
    expect((await w.pulls()).status).toBe(200);
    expect(w.forge.graphql()).toHaveLength(1);
    const asked = w.forge.calls.length;
    expect((await w.setCodeReview(false)).status).toBe(200);
    expect((await w.pulls("?refresh=1")).status).toBe(409);
    expect(w.forge.calls.length).toBe(asked);
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
    // Nothing else ties a PR: no thread for the others.
    expect(answer.links["github.com/northwind/billing-svc#412"]).toBeUndefined();
    expect(answer.links["github.com/northwind/billing-svc#880"]).toBeUndefined();

    // Asked again at once: the cache answers, no second query.
    await w.pulls();
    expect(w.forge.graphql()).toHaveLength(1);
  });

  test("Hand to an agent: the person's choice ties the PRs to that thread, over an agent's URL, and outlives a restart", async () => {
    const w = await world({ codeReview: true });
    const opened = await w.send("Opened https://github.com/northwind/billing-svc/pull/413", "retries");
    const handed = await w.send("Ready for work.", "handed");
    expect(((await (await w.pulls()).json()) as InboxPullsAnswer).links["github.com/northwind/billing-svc#412"]).toBeUndefined();
    const keys = ["github.com/northwind/billing-svc#412", "github.com/northwind/billing-svc#413"];
    expect((await w.own(keys, handed)).status).toBe(200);
    const answer = (await (await w.pulls()).json()) as InboxPullsAnswer;
    for (const key of keys) expect(answer.links[key]).toMatchObject({ via: "owner", thread_id: handed });
    expect(opened).not.toBe(handed);
    // Kept on disk, so a new Inbox on the same folder still knows it.
    const saved = JSON.parse(await Bun.file(join(w.dataDir, "inbox", "pull-links.json")).text()) as { links: Record<string, { thread_id: string }> };
    expect(saved.links[keys[0]!]?.thread_id).toBe(handed);
  });

  test("the hand-off's ask is kept with the owner and served on its link", async () => {
    const w = await world({ codeReview: true });
    const handed = await w.send("Ready.", "handed");
    await w.pulls();
    expect((await w.own(["github.com/northwind/billing-svc#412"], handed, { ask: "custom" })).status).toBe(200);
    expect((await w.own(["github.com/northwind/billing-svc#413"], handed, { ask: "anything" })).status).toBe(422);
    const answer = (await (await w.pulls()).json()) as InboxPullsAnswer;
    expect(answer.links["github.com/northwind/billing-svc#412"]).toMatchObject({ via: "owner", ask: "custom" });
  });

  test("a thread handed only a teammate's PR reads as such (its reviews take no verdict); one of the person's own PRs ends that", async () => {
    const w = await world({ codeReview: true });
    const theirs = await w.send("Ready.", "theirs");
    const own = await w.send("Ready.", "own");
    await w.pulls();
    const thread = async (id: string) => ((await (await fetch(`${w.base}/api/inbox/threads/${id}`)).json()) as { thread: { pull_theirs?: true } }).thread;
    expect((await w.own(["github.com/northwind/billing-svc#880"], theirs)).status).toBe(200);
    expect((await w.own(["github.com/northwind/billing-svc#412"], own)).status).toBe(200);
    expect((await thread(theirs)).pull_theirs).toBe(true);
    expect((await thread(own)).pull_theirs).toBeUndefined();
    // The person hands one of their own PRs to the same thread: it is theirs to give a verdict in again.
    expect((await w.own(["github.com/northwind/billing-svc#413"], theirs)).status).toBe(200);
    expect((await thread(theirs)).pull_theirs).toBeUndefined();
  });

  test("checked before the send: validate_only writes nothing, refuses another project, and needs no thread", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "handed");
    await w.pulls();
    const projectId = w.server.store.allProjects()[0]!.id;
    expect((await w.check(["github.com/northwind/billing-svc#412"], projectId)).status).toBe(200);
    expect((await w.check(["github.com/northwind/billing-svc#412"], "prj_01M4H6G73M9H3Z32T859E72NOP")).status).toBe(422);
    expect(await Bun.file(join(w.dataDir, "inbox", "pull-links.json")).exists()).toBe(false);
  });

  test("after a restart, before the window read the list again: the owner route reads it and keeps the owner", async () => {
    const w = await world({ codeReview: true });
    const handed = await w.send("Ready.", "handed");
    // A new Inbox has not read the forge yet: the key is unknown to it until the route reads the list once.
    expect(w.forge.graphql()).toHaveLength(0);
    expect((await w.own(["github.com/northwind/billing-svc#412"], handed)).status).toBe(200);
    expect(w.forge.graphql()).toHaveLength(1);
  });

  test("a draft started from Launch an agent keeps its pull requests", async () => {
    const w = await world({ codeReview: true });
    const pulls = { keys: ["github.com/northwind/billing-svc#412"], projects: ["prj_1"], ask_line: "/review-curate" };
    const saved = await fetch(`${w.base}/api/inbox/drafts/${inboxId("drf")}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "Own it", to: null, project: null, files: [], base: null, pulls }) });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { draft: { pulls?: unknown } }).draft.pulls).toEqual(pulls);
    const bad = await fetch(`${w.base}/api/inbox/drafts/${inboxId("drf")}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "x", to: null, project: null, files: [], base: null, pulls: { keys: [] } }) });
    expect(bad.status).toBe(422);
  });

  test("Hand to an agent refuses a PR the list never named, a thread that is not there, and no PR at all", async () => {
    const w = await world({ codeReview: true });
    const thread = await w.send("Ready.", "handed");
    await w.pulls();
    expect((await w.own(["github.com/elsewhere/thing#9"], thread)).status).toBe(404);
    expect((await w.own(["github.com/northwind/billing-svc#412"], "msg_01M4H6G73M9H3Z32T859E72NOP")).status).toBe(422);
    expect((await w.own([], thread)).status).toBe(422);
    expect(await Bun.file(join(w.dataDir, "inbox", "pull-links.json")).exists()).toBe(false);
  });

  test("the Board is optional: a card that links a PR shows only while the Board is on, and never ties a thread", async () => {
    for (const board of [false, true]) {
      const w = await world({ codeReview: true, board });
      await w.send("Working.", "retries");
      const project = w.server.store.allProjects()[0]!;
      w.server.store.createCard({ project_id: project.id, by: { kind: "person" }, title: "Retries", prs: ["northwind/billing-svc#412"] });
      const answer = (await (await w.pulls()).json()) as InboxPullsAnswer;
      expect(answer.links["github.com/northwind/billing-svc#412"]).toBeUndefined();
      if (board) expect(answer.cards["github.com/northwind/billing-svc#412"]).toMatchObject({ title: "Retries" });
      else expect(answer.cards).toEqual({});
    }
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

// --- the review's findings (#2590): links stay in their project and repository, forks, stacks, guests ---

/** Several projects: `billing-svc` and its second clone `billing-svc-2` (one origin), and `web-app` (another). */
async function projects(answer: unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pulls-many-")));
  roots.push(root);
  const dirs: Record<string, string> = {};
  for (const name of ["billing-svc", "billing-svc-2", "web-app"]) {
    dirs[name] = join(root, name);
    mkdirSync(dirs[name]!, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: dirs[name]!, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  }
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const f = forge(answer);
  const server = await startInboxServer({
    dataDir,
    phones: false,
    codeReview: true,
    refRunner: f.run,
    readProjectRepo: async (dir) => ({ display: dir.endsWith("web-app") ? "northwind/web-app" : "northwind/billing-svc", host: "github.com" }),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-pulls-many", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  const send = async (project: string, body: string, thread: string) => {
    const result = (await client.callTool({ name: "send_message", arguments: { project_path: dirs[project], body, thread, agent_session: `ses_${thread}`, agent_name: "Claude Code", agent_host: "claude-code" } })) as { structuredContent: { thread_id: string } };
    return result.structuredContent.thread_id;
  };
  const list = async () => (await (await fetch(`${base}/api/inbox/pulls`)).json()) as InboxPullsAnswer;
  const own = (keys: string[], threadId: string) =>
    fetch(`${base}/api/inbox/pulls/owner`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys, thread_id: threadId }) });
  return { dirs, f, send, list, own, base };
}

const answerOf = (authored: unknown[], requested: unknown[] = [], merged: unknown[] = []) => ({ data: { viewer: { login: "dana" }, requested: { nodes: requested }, authored: { nodes: authored }, merged: { nodes: merged } } });

describe("links (findings D, E and two clones)", () => {
  test("a PR URL quoted in another project's thread does not link it; one in its own project's does", async () => {
    const w = await projects(answerOf([ghPull(7, { headRefName: "feat-7" })]));
    await w.send("web-app", "Depends on https://github.com/northwind/billing-svc/pull/7 landing first.", "web-thread");
    expect((await w.list()).links["github.com/northwind/billing-svc#7"]).toBeUndefined();
    const own = await w.send("billing-svc", "Opened https://github.com/northwind/billing-svc/pull/7", "own-thread");
    await new Promise((done) => setTimeout(done, 5));
    const fresh = await fetch(`${w.base}/api/inbox/pulls?refresh=1`);
    expect(((await fresh.json()) as InboxPullsAnswer).links["github.com/northwind/billing-svc#7"]).toMatchObject({ via: "url", thread_id: own });
  });

  test("a fork's PR, or one from main, is never tied to whatever thread is open: only its URL or the person's choice ties it", async () => {
    const w = await projects(
      answerOf([
        ghPull(8, { headRefName: "main", headRepository: { nameWithOwner: "dana/billing-svc" } }),
        ghPull(9, { headRefName: "feat-9", headRepository: { nameWithOwner: "dana/billing-svc" } }),
        ghPull(10, { headRefName: "main" }),
      ]),
    );
    const docs = await w.send("billing-svc", "Working on the docs on main, and feat-9.", "docs");
    const links = (await w.list()).links;
    expect(Object.keys(links)).toEqual([]);
    // Handed over by the person, the fork's PR is that thread's.
    expect((await w.own(["github.com/northwind/billing-svc#9"], docs)).status).toBe(200);
    expect((await w.list()).links["github.com/northwind/billing-svc#9"]).toMatchObject({ via: "owner", thread_id: docs });
  });

  test("Hand to an agent takes only a thread in a project of the PR's repository: a second clone's yes, another repository's no", async () => {
    const w = await projects(answerOf([ghPull(14, { headRefName: "feat-14" })]));
    const web = await w.send("web-app", "Ready.", "web");
    const clone = await w.send("billing-svc-2", "Ready.", "clone");
    await w.list();
    expect((await w.own(["github.com/northwind/billing-svc#14"], web)).status).toBe(422);
    expect((await w.own(["github.com/northwind/billing-svc#14"], clone)).status).toBe(200);
    expect((await w.list()).links["github.com/northwind/billing-svc#14"]).toMatchObject({ via: "owner", thread_id: clone });
  });

  test("two clones of one origin: a thread in the second clone links by URL", async () => {
    const w = await projects(answerOf([ghPull(12, { headRefName: "feat-12" })]));
    const byUrl = await w.send("billing-svc-2", "Up for review: https://github.com/northwind/billing-svc/pull/12", "clone-url");
    await w.send("billing-svc", "Unrelated.", "first-clone");
    const answer = await w.list();
    expect(answer.links["github.com/northwind/billing-svc#12"]).toMatchObject({ via: "url", thread_id: byUrl });
    expect(answer.projects["github.com/northwind/billing-svc"]).toHaveLength(2);
  });
});

describe("the whole stack's diff (finding C and merged layers)", () => {
  const stackAnswer = answerOf(
    [
      ghPull(21, { headRefName: "feat", baseRefName: "charge-client" }),
      ghPull(22, { headRefName: "feat-2", baseRefName: "feat", headRepository: { nameWithOwner: "dana/billing-svc" } }),
    ],
    [],
    [ghPull(20, { state: "MERGED", headRefName: "charge-client", mergedAt: "2026-11-02T10:00:00Z" })],
  );

  test("a fork layer's head is owner:branch, never the same-named upstream branch; it runs from the lowest open layer's base", async () => {
    const w = await world({ codeReview: true, answer: stackAnswer });
    await w.send("Stack is up.", "stack");
    await w.pulls();
    const before = w.forge.calls.length;
    const answer = (await (await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/northwind/billing-svc#22")}&scope=stack`)).json()) as { head: string; base: string };
    const call = w.forge.calls[before]!;
    expect(call.args[3]).toBe("repos/northwind/billing-svc/compare/charge-client...dana:feat-2");
    expect(answer).toMatchObject({ base: "charge-client", head: "dana:feat-2" });
  });

  test("the lowest open layer's base gone (a merged branch deleted): the stack's own base", async () => {
    const f = forge(stackAnswer);
    const run: typeof f.run = async (cli, args, env) => {
      if (args[3]?.includes("compare/charge-client...")) {
        f.calls.push({ cli, args });
        return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
      }
      return f.run(cli, args, env);
    };
    const pulls = createInboxPulls({ run });
    await pulls.list([{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }]);
    const answer = await pulls.diff("github.com/northwind/billing-svc#21", "stack");
    expect(answer.base).toBe("main");
    expect(f.calls.filter((c) => c.args[0] === "api" && c.args[1] === "--hostname").map((c) => c.args[3])).toEqual([
      "repos/northwind/billing-svc/compare/charge-client...feat",
      "repos/northwind/billing-svc/compare/main...feat",
    ]);
  });

  test("GitLab: a fork layer's whole stack is refused with a note, and nothing runs", async () => {
    const mr = {
      iid: "5", title: "MR 5", webUrl: "https://gitlab.com/northwind/ledger/-/merge_requests/5", state: "opened", draft: false, updatedAt: "2026-11-03T10:00:00Z", mergedAt: null,
      sourceBranch: "feat", targetBranch: "main", approved: false, detailedMergeStatus: "NOT_APPROVED", diffStatsSummary: { additions: 1, deletions: 0, fileCount: 1 },
      headPipeline: null, project: { fullPath: "northwind/ledger" }, sourceProject: { fullPath: "dana/ledger" }, author: { username: "dana" }, approvedBy: { nodes: [] }, reviewers: { nodes: [] },
    };
    const calls: string[][] = [];
    const run = async (cli: string, args: string[]) => {
      calls.push([cli, ...args]);
      if (cli === "glab" && args[0] === "auth") return { stdout: "  ✓ Logged in to gitlab.com as dana", stderr: "", exitCode: 0 };
      if (cli === "glab" && args.includes("graphql")) return { stdout: JSON.stringify({ data: { currentUser: { username: "dana", requested: { nodes: [] }, authored: { nodes: [mr] }, merged: { nodes: [] } } } }), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const pulls = createInboxPulls({ run: run as never });
    expect((await pulls.list([{ host: "gitlab.com", repo: "northwind/ledger", project_id: "prj_1" }])).pulls).toHaveLength(1);
    const before = calls.length;
    await expect(pulls.diff("gitlab.com/northwind/ledger#5:pull", "stack")).rejects.toMatchObject({ code: "pull_diff_fork" });
    expect(calls.length).toBe(before);
  });

  test("a diff past the cap is refused as too large", async () => {
    const f = forge();
    const run: typeof f.run = async (cli, args, env) =>
      args[0] === "api" && args[1] === "--hostname" ? { stdout: "x".repeat(INBOX_PULL_DIFF_MAX_BYTES + 1), stderr: "", exitCode: 0 } : f.run(cli, args, env);
    const pulls = createInboxPulls({ run });
    await pulls.list([{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }]);
    await expect(pulls.diff("github.com/northwind/billing-svc#412", "layer")).rejects.toMatchObject({ code: "pull_diff_too_large" });
  });

  test("branch names a compare would misread are refused", () => {
    for (const bad of ["-x", "/x", "a..b", "a:b", "a~1", "a^", "a b", "a@{1}", ""]) expect(safeBranch(bad)).toBe(false);
    for (const good of ["retry/schedule", "feat-2", "release_1.2"]) expect(safeBranch(good)).toBe(true);
  });
});

describe("the searches (scoped to the projects' repositories)", () => {
  test("repo: qualifiers while they fit, newest first; past GitHub's limit, unscoped", () => {
    const scoped = githubPullSearches(Date.parse("2026-11-03T00:00:00Z"), ["northwind/billing-svc", "Northwind/Web-App"]);
    for (const q of Object.values(scoped)) {
      expect(q).toContain("sort:updated-desc");
      expect(q).toContain("repo:northwind/billing-svc repo:northwind/web-app");
      expect(q.length).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_CHARS);
    }
    const many = Array.from({ length: 12 }, (_, i) => `northwind/service-number-${i}`);
    for (const q of Object.values(githubPullSearches(0, many))) expect(q).not.toContain("repo:");
  });

  test("the query carries the projects' repositories", async () => {
    const w = await world({ codeReview: true });
    await w.send("Hello.", "hello");
    await w.pulls();
    const args = w.forge.graphql()[0]!.args;
    expect(args.find((a) => a.startsWith("authored="))).toContain("repo:northwind/billing-svc");
  });
});

describe("who may read it", () => {
  test("a tailnet guest is refused and runs nothing; the owner over the tailnet reads", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const GUEST = "guest@example.com";
    const savedTailscale = process.env.PLANNOTATOR_INBOX_TAILSCALE;
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    try {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pulls-guest-")));
      roots.push(root);
      const dataDir = join(root, "data");
      mkdirSync(dataDir, { recursive: true });
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxTailscaleAllow: [GUEST], inboxCodeReview: true }));
      const f = forge();
      const serve = new Map<number, string>();
      const tailscale: TailscaleRunner = (args) => {
        const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
        if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
        if (args[1] === "status") {
          if (serve.size === 0) return ok("{}");
          return ok(JSON.stringify({ TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])), Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])) }));
        }
        const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
        if (args.includes("off")) serve.delete(httpsPort);
        else serve.set(httpsPort, args.at(-1)!);
        return ok(`https://${MAGIC}:${httpsPort}/\n`);
      };
      const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, refRunner: f.run, readProjectRepo: async () => null });
      servers.push(server);
      const listener = server.tailscale.listenerPort();
      expect(listener).not.toBeNull();
      const through = (login: string) =>
        fetch(`http://127.0.0.1:${listener}/api/inbox/pulls`, { headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login } });
      const guest = await through(GUEST);
      expect(guest.status).toBe(403);
      expect(((await guest.json()) as { code: string }).code).toBe("local_only");
      // Nor may a guest hand a PR to an agent.
      const handGuest = await fetch(`http://127.0.0.1:${listener}/api/inbox/pulls/owner`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": GUEST, "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["github.com/northwind/billing-svc#412"], thread_id: "msg_01M4H6G73M9H3Z32T859E72NOP" }),
      });
      expect(handGuest.status).toBe(403);
      expect(f.calls).toEqual([]);
      expect((await through(OWNER)).status).toBe(200);
      // The owner over the tailnet may hand a PR over: past the guards, the route answers on the request itself.
      const handOwner = await fetch(`http://127.0.0.1:${listener}/api/inbox/pulls/owner`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["github.com/northwind/billing-svc#412"], thread_id: "msg_01M4H6G73M9H3Z32T859E72NOP" }),
      });
      expect(handOwner.status).toBe(422);
      expect(((await handOwner.json()) as { field?: string; code?: string }).code).not.toBe("local_only");
    } finally {
      if (savedTailscale === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
      else process.env.PLANNOTATOR_INBOX_TAILSCALE = savedTailscale;
    }
  });
});
