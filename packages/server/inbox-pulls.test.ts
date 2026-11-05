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
 *  - an Others search run unscoped, past GitHub's length limit or past its
 *    few searches (the most active repositories first); Others failing or
 *    timing out taking the person's own lists with it, or read more often
 *    than every 5 min while its view is closed; a GraphQL error read as a
 *    whole answer; Others' PRs marked as the person's or asked of them; an
 *    assigned PR losing its mark; the GraphQL budget's hold blocking diffs;
 *  - a PR not tied to the thread the person handed it to, or to its agent's
 *    own thread through its URL; one tied by anything else (a branch, a
 *    Board card, another project's thread); a Board card shown while the
 *    Board is off;
 *  - a layer review opening another diff than the layer's own, or the whole
 *    stack not running from the stack's base to that layer's head; a diff
 *    asked for a PR the list never named reaching the CLI.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_REPO_TTL_MS, inboxId, type InboxPullsAnswer } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import {
  compareBranch,
  createInboxPulls,
  type InboxPulls,
  GITHUB_SEARCH_MAX_CHARS,
  githubPullSearches,
  byActivity,
  githubOthersSearches,
  GITLAB_PROJECTS_PER_QUERY,
  gitlabOthersQueries,
  INBOX_PULL_DIFF_MAX_BYTES,
  INBOX_PULLS_FRESH_MS,
  INBOX_PULLS_OTHERS_CALLS_MAX,
  INBOX_PULLS_OTHERS_DEADLINE_MS,
  INBOX_PULLS_OTHERS_FRESH_MS,
  INBOX_PULLS_RATE_FLOOR,
  linkInboxPulls,
  parseGithubPulls,
  parseGitlabPulls,
  previewOf,
  safeBranch,
} from "./inbox-pulls";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import type { RefRunner } from "./ref-cards";
import type { PRRuntime } from "@plannotator/shared/pr-provider";
import type { PullAvatarOptions } from "./inbox-pull-avatars";

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
  headRefOid: String(number).padStart(40, "a"),
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

/** A call of the Others read (its own query), apart from the person's own lists. */
const othersCall = (args: readonly string[]) => args.some((a) => a.startsWith("query=query InboxPullsOthers"));

/** The background reads finish (the fakes answer at once): what the next list sees. */
const settle = () => new Promise((done) => setTimeout(done, 0));
/** One list, its background Others read let finish, then the next list: what the window gets on its next read. */
async function listSettled(pulls: InboxPulls, repos: Parameters<InboxPulls["list"]>[0], options?: Parameters<InboxPulls["list"]>[1]) {
  await pulls.list(repos, options);
  await settle();
  return pulls.list(repos, options);
}

interface Forge {
  run: RefRunner;
  calls: { cli: string; args: string[] }[];
  /** The person's own list reads. */
  graphql: () => { cli: string; args: string[] }[];
  /** The Others reads. */
  others: () => { cli: string; args: string[] }[];
  fail: string | null;
  /** What an Others read answers (default: nothing open); `othersFail` fails it (stderr). */
  othersAnswer: unknown;
  othersFail: string | null;
  /** How long a GitHub Others read takes, in ms (default: at once). */
  othersDelayMs?: number;
  /** The head commit `gh api … pulls/N --jq .head.sha` answers (default: the list's `headRefOid`); a list: one per read. */
  heads: string[] | null;
  /** The commits GitHub says the PR has; null, that read fails. */
  prCommits?: string[] | null;
}

/** gh signed in to github.com only; glab signed in nowhere. */
function forge(answer: unknown = GH_ANSWER): Forge {
  const f: Forge = {
    calls: [],
    fail: null,
    othersAnswer: { data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } },
    othersFail: null,
    heads: null,
    graphql: () => f.calls.filter((c) => c.args.includes("graphql") && !othersCall(c.args)),
    others: () => f.calls.filter((c) => othersCall(c.args)),
    run: async (cli, args) => {
      f.calls.push({ cli, args });
      if (cli === "gh" && args.some((a) => a.includes("/commits?"))) return f.prCommits ? { stdout: `${f.prCommits.join("\n")}\n`, stderr: "", exitCode: 0 } : { stdout: "", stderr: "HTTP 502", exitCode: 1 };
      if (cli === "gh" && args.includes("--jq")) return { stdout: `${f.heads ? f.heads.shift() ?? "" : String(args[3]!.split("/").at(-1)).padStart(40, "a")}\n`, stderr: "", exitCode: 0 };
      if (cli === "gh" && args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
      if (cli === "glab" && args[0] === "auth") return { stdout: "", stderr: "No hosts logged in", exitCode: 1 };
      if (cli === "gh" && othersCall(args)) {
        if (f.othersDelayMs) await Bun.sleep(f.othersDelayMs);
        if (f.othersFail) return { stdout: "", stderr: f.othersFail, exitCode: 1 };
        return { stdout: JSON.stringify(f.othersAnswer), stderr: "", exitCode: 0 };
      }
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

/** The `gh` / `glab` a posted review runs through: each call kept (its stdin parsed), answered by `answer`. */
interface PostForge {
  runtime: PRRuntime;
  calls: { cmd: string; args: string[]; input?: unknown }[];
  answer: (cmd: string, args: string[], input?: unknown) => { stdout: string; stderr: string; exitCode: number };
}

function postForge(): PostForge {
  const f: PostForge = {
    calls: [],
    answer: () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
    runtime: {
      runCommand: async (cmd, args) => {
        f.calls.push({ cmd, args });
        return f.answer(cmd, args);
      },
      runCommandWithInput: async (cmd, args, input) => {
        const parsed = JSON.parse(input) as unknown;
        f.calls.push({ cmd, args, input: parsed });
        return f.answer(cmd, args, parsed);
      },
    },
  };
  return f;
}

async function world(options: { codeReview?: boolean; answer?: unknown; tailscale?: TailscaleRunner; board?: boolean; gitlab?: boolean; avatars?: Partial<PullAvatarOptions> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pulls-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const f = options.gitlab ? gitlabForge() : forge(options.answer);
  const post = postForge();
  // The project's origin as git reads it; `setRepo` changes it (read again at the project's next message).
  let repo: { display: string; host: string } | null = options.gitlab ? { display: "northwind/data/ledger", host: "gitlab.com" } : { display: "northwind/billing-svc", host: "github.com" };
  const setRepo = (next: typeof repo) => {
    repo = next;
  };
  const server = await startInboxServer({
    dataDir,
    phones: false,
    prRuntime: post.runtime,
    ...(options.codeReview === undefined ? {} : { codeReview: options.codeReview }),
    ...(options.tailscale ? { tailscale: options.tailscale } : {}),
    ...(options.board === undefined ? {} : { board: options.board }),
    ...(options.avatars ? { pullAvatars: options.avatars } : {}),
    refRunner: f.run,
    readProjectRepo: async () => repo,
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
  const review = (fields: Record<string, unknown>) =>
    fetch(`${base}/api/inbox/pulls/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
  return { root, project, dataDir, base, server, forge: f, post, send, pulls, own, check, review, setCodeReview, setRepo };
}

const GL_MR = (iid: number, fields: Record<string, unknown> = {}) => ({
  iid: String(iid),
  title: `MR ${iid}`,
  webUrl: `https://gitlab.com/northwind/data/ledger/-/merge_requests/${iid}`,
  state: "opened",
  draft: false,
  updatedAt: "2026-11-03T10:00:00Z",
  mergedAt: null,
  sourceBranch: `b${iid}`,
  targetBranch: "main",
  diffHeadSha: String(iid).padStart(40, "b"),
  approved: false,
  detailedMergeStatus: "NOT_APPROVED",
  diffStatsSummary: { additions: 3, deletions: 1, fileCount: 2 },
  headPipeline: { status: "SUCCESS" },
  project: { fullPath: "northwind/data/ledger" },
  sourceProject: { fullPath: "northwind/data/ledger" },
  author: { username: "jun" },
  approvedBy: { nodes: [] },
  reviewers: { nodes: [{ username: "dana" }] },
  ...fields,
});

/** glab signed in to gitlab.com only; gh signed in nowhere. One MR, !61, by jun, asking dana for a review. */
function gitlabForge(): Forge {
  const f: Forge = {
    calls: [],
    fail: null,
    othersAnswer: { data: { currentUser: { username: "dana" }, p0: { mergeRequests: { count: 1, nodes: [GL_MR(61)] } } } },
    othersFail: null,
    heads: null,
    graphql: () => f.calls.filter((c) => c.args.includes("graphql") && !othersCall(c.args)),
    others: () => f.calls.filter((c) => othersCall(c.args)),
    run: async (cli, args) => {
      f.calls.push({ cli, args });
      if (cli === "glab" && args[0] === "auth") return { stdout: "gitlab.com\n  ✓ Logged in to gitlab.com as dana (keyring)\n", stderr: "", exitCode: 0 };
      if (cli === "gh" && args[0] === "auth") return { stdout: "", stderr: "not logged in", exitCode: 1 };
      if (cli === "glab" && othersCall(args)) {
        if (f.othersFail) return { stdout: "", stderr: f.othersFail, exitCode: 1 };
        return { stdout: JSON.stringify(f.othersAnswer), stderr: "", exitCode: 0 };
      }
      if (cli === "glab" && args.includes("graphql")) {
        return { stdout: JSON.stringify({ data: { currentUser: { username: "dana", requested: { nodes: [GL_MR(61)] }, authored: { nodes: [] }, merged: { nodes: [] } } } }), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    },
  };
  return f;
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
    // Others is read in the background, never waited for: the answer says it is on its way.
    expect(answer.hosts).toEqual([{ cli: "gh", host: "github.com", login: "dana", others_pending: true }]);
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

  test("after a restart, an Others PR: the owner route waits for the Others read in flight, then finds it", async () => {
    const w = await world({ codeReview: true });
    const handed = await w.send("Look at Mei's.", "handed");
    w.forge.othersAnswer = { data: { viewer: { login: "dana" }, others0: { issueCount: 1, nodes: [ghPull(900, { author: { login: "mei" } })] } } };
    w.forge.othersDelayMs = 150;
    // The list answers before Others lands (it never waits); the route waits for that read instead of a 404.
    expect((await w.own(["github.com/northwind/billing-svc#900"], handed)).status).toBe(200);
    expect(w.forge.others()).toHaveLength(1);
    // A key no read names is still unknown, with no new Others read.
    const unknown = await w.own(["github.com/northwind/billing-svc#999"], handed);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("pull_unknown");
    expect(w.forge.others()).toHaveLength(1);
  });

  test("after a restart, the review route waits for the Others read in flight before saying an Others PR is unknown", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "handed");
    w.forge.othersAnswer = { data: { viewer: { login: "dana" }, others0: { issueCount: 1, nodes: [ghPull(900, { author: { login: "mei" } })] } } };
    w.forge.othersDelayMs = 150;
    const res = await w.review({ key: "github.com/northwind/billing-svc#900", action: "comment", body: "Looks fine.", head_sha: "nope" });
    // Found (and open), so the answer is about the commit, never pull_unknown.
    expect(((await res.json()) as { code: string }).code).toBe("pull_moved");
  });

  test("a draft started from Launch an agent keeps its pull requests", async () => {
    const w = await world({ codeReview: true });
    const pulls = { keys: ["github.com/northwind/billing-svc#412"], projects: ["prj_1"], ask_line: "1. Send me a guided review of its diff against main, using /review-curate (its instructions are at the end of this message)." };
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
    const layerAnswer = (await layer.json()) as { patch: string; base: string; head: string; head_sha: string | null };
    expect(layerAnswer.patch).toBe("diff of repos/northwind/billing-svc/pulls/413\n");
    // The layer's head, read before and after its patch.
    expect(layerAnswer.head_sha).toBe("413".padStart(40, "a"));
    const stack = await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/northwind/billing-svc#413")}&scope=stack`);
    const stackAnswer = (await stack.json()) as { patch: string; base: string; head: string };
    expect(stackAnswer.patch).toBe("diff of repos/northwind/billing-svc/compare/main...retry/backoff\n");
    expect(stackAnswer).toMatchObject({ base: "main", head: "retry/backoff", head_sha: "413".padStart(40, "a") });
    const diffCalls = w.forge.calls.slice(before);
    expect(diffCalls.every((c) => c.args.includes("--hostname") && c.args[c.args.indexOf("--hostname") + 1] === "github.com")).toBe(true);

    const unknown = await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent("github.com/elsewhere/thing#9")}&scope=layer`);
    expect(unknown.status).toBe(404);
    // Each: its head, its patch, its head again.
    expect(w.forge.calls.length).toBe(before + 6);
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
    expect(await pulls.list([])).toEqual({ fetched_at: null, hosts: [], pulls: [], clis: {}, unsigned: [] });
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
    const call = w.forge.calls.slice(before).find((c) => !c.args.includes("--jq"))!;
    expect(call.args[3]).toBe("repos/northwind/billing-svc/compare/charge-client...dana:feat-2");
    expect(answer).toMatchObject({ base: "charge-client", head: "dana:feat-2" });
  });

  test("names the head its compare ended at, read around it: the list can be behind, a push during the read leaves it unknown", async () => {
    const f = forge(stackAnswer);
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list([{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }]);
    const pushed = "b".repeat(40);
    f.heads = [pushed, pushed];
    expect((await pulls.diff("github.com/northwind/billing-svc#22", "stack")).head_sha).toBe(pushed);
    f.heads = [pushed, "c".repeat(40)];
    expect((await pulls.diff("github.com/northwind/billing-svc#21", "stack")).head_sha).toBeNull();
    // The commit the person read, so a whole stack's review can be pinned to it.
    expect(pulls.readHead("github.com/northwind/billing-svc#22")).toBe(pushed);
  });

  test("a head the forge did not pin down is asked again, not kept; an answer older than the last head read is not served", async () => {
    const f = forge(stackAnswer);
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list([{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }]);
    const key = "github.com/northwind/billing-svc#22";
    const newer = "b".repeat(40);
    f.heads = ["", ""];
    expect((await pulls.diff(key, "layer")).head_sha).toBeNull();
    f.heads = [newer, newer];
    expect((await pulls.diff(key, "layer")).head_sha).toBe(newer);
    const old = "c".repeat(40);
    f.heads = [old, old];
    expect((await pulls.diff(key, "stack")).head_sha).toBe(old);
    // This scope's cached answer named another head than the last one read: asked again.
    f.heads = [newer, newer];
    expect((await pulls.diff(key, "layer")).head_sha).toBe(newer);
    expect(f.heads).toEqual([]);
  });

  test("a label moving updated_at reads nothing again; a new head does", async () => {
    const at = (updatedAt: string, headRefOid: string) => answerOf([ghPull(21, { headRefName: "feat", baseRefName: "charge-client", updatedAt, headRefOid })], [], [ghPull(20, { state: "MERGED", headRefName: "charge-client", mergedAt: "2026-11-02T10:00:00Z" })]);
    let answer = at("2026-11-03T10:00:00Z", "a".repeat(40));
    const f = forge();
    const run: typeof f.run = async (cli, args, env) => {
      if (cli === "gh" && args.includes("graphql")) {
        f.calls.push({ cli, args });
        return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
      }
      return f.run(cli, args, env);
    };
    let clock = 1_000_000;
    const pulls = createInboxPulls({ run, now: () => clock });
    const repos = [{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }];
    const reread = async (next: unknown) => {
      answer = next as typeof answer;
      clock += INBOX_PULLS_FRESH_MS;
      await pulls.list(repos);
    };
    await pulls.list(repos);
    await pulls.diff("github.com/northwind/billing-svc#21", "stack");
    await reread(at("2026-11-03T11:00:00Z", "a".repeat(40)));
    const asked = f.calls.length;
    await pulls.diff("github.com/northwind/billing-svc#21", "stack");
    expect(f.calls.length).toBe(asked);
    await reread(at("2026-11-03T12:00:00Z", "b".repeat(40)));
    const before = f.calls.length;
    await pulls.diff("github.com/northwind/billing-svc#21", "stack");
    expect(f.calls.length).toBe(before + 3);
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
    expect(f.calls.filter((c) => c.args[0] === "api" && c.args[1] === "--hostname" && !c.args.includes("--jq")).map((c) => c.args[3])).toEqual([
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

// --- the worst-case stress test (break-ui on #2590): what the list must say when it can't read everything ---

describe("the worst case (break-ui on #2590)", () => {
  const repos = [{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }];

  test("a host that times out on the first read: marked unavailable with no last read (its PRs aren't shown); after one answer, a failure says when that answer was read", async () => {
    let now = 1_000_000;
    const f = forge();
    // gh stopped at the list's time limit: nothing it said names a cause.
    f.fail = "context deadline exceeded";
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    const first = await pulls.list(repos);
    expect(first.pulls).toEqual([]);
    expect(first.hosts).toEqual([{ cli: "gh", host: "github.com", login: null, error: "unavailable", others_pending: true }]);
    now += 31_000;
    f.fail = null;
    expect((await pulls.list(repos)).pulls).toHaveLength(3);
    const readAt = new Date(now).toISOString();
    now += INBOX_PULLS_FRESH_MS;
    f.fail = "GraphQL: API rate limit already exceeded for user ID 48213.";
    const limited = await pulls.list(repos);
    expect(limited.pulls).toHaveLength(3);
    expect(limited.hosts[0]).toMatchObject({ error: "rate_limited", last_read: readAt });
  });

  test("gh not installed is told apart from gh signed out; the host it would have asked is listed as unsigned", async () => {
    const missing: RefRunner = async (cli) => ({ stdout: "", stderr: `${cli}: not found`, exitCode: 127 });
    const none = await createInboxPulls({ run: missing }).list(repos);
    expect(none.clis).toEqual({ gh: "missing", glab: "missing" });
    expect(none.unsigned).toEqual(["github.com"]);
    const signedOut: RefRunner = async (cli) => ({ stdout: "", stderr: cli === "gh" ? "You are not logged into any GitHub hosts. To log in, run: gh auth login" : "No GitLab instance is authenticated", exitCode: 1 });
    const out = await createInboxPulls({ run: signedOut }).list(repos);
    expect(out.clis).toEqual({ gh: "signed_out", glab: "signed_out" });
    expect(out.unsigned).toEqual(["github.com"]);
    expect(out.hosts).toEqual([]);
  });

  test("more open PRs than the searches answer: the host says how many the list shows, of how many (searches limited to the projects)", async () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ghPull(from + i, { headRefName: `b${from + i}` }));
    const answer = { data: { viewer: { login: "dana" }, requested: { issueCount: 61, nodes: many(2000, 50) }, authored: { issueCount: 72, nodes: many(1000, 50) }, merged: { nodes: [] } } };
    const f = forge(answer);
    const listed = await createInboxPulls({ run: f.run }).list(repos);
    // The searches were limited to the project's repository (`repo:`): every PR they found is the project's.
    expect(f.graphql()[0]!.args.some((a) => a.startsWith("authored=") && a.includes(" repo:northwind/billing-svc"))).toBe(true);
    expect(listed.hosts[0]!.capped).toEqual({ shown: 100, total: 133 });
    // Nothing left out: no count said.
    expect(parseGithubPulls(JSON.stringify(GH_ANSWER), "github.com")!.capped).toBeUndefined();
    expect((await createInboxPulls({ run: forge().run }).list(repos)).hosts[0]!.capped).toBeUndefined();
  });

  test("the count says what the list shows: searches not limited to the projects (GitLab) give no total", async () => {
    // jun's MRs: two found in the project, the rest of the 60 anywhere on gitlab.com.
    const answer = {
      data: {
        currentUser: {
          username: "dana",
          requested: { count: 40, nodes: [GL_MR(1), GL_MR(2, { project: { fullPath: "elsewhere/thing" }, webUrl: "https://gitlab.com/elsewhere/thing/-/merge_requests/2" })] },
          authored: { count: 20, nodes: [GL_MR(3, { author: { username: "dana" } })] },
          merged: { nodes: [] },
        },
      },
    };
    const parsed = parseGitlabPulls(JSON.stringify(answer), "gitlab.com")!;
    expect(parsed.capped).toEqual({ shown: 3, total: 60 });
    const run: RefRunner = async (cli, args) => {
      if (cli === "glab" && args[0] === "auth") return { stdout: "gitlab.com\n  ✓ Logged in to gitlab.com as dana (keyring)\n", stderr: "", exitCode: 0 };
      // Others has no answer (it failed): only the person's own searches' count is known.
      if (cli === "glab" && othersCall(args)) return { stdout: "", stderr: "boom", exitCode: 1 };
      if (cli === "glab" && args.includes("graphql")) return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "not logged in", exitCode: 1 };
    };
    const listed = await createInboxPulls({ run }).list([{ host: "gitlab.com", repo: "northwind/data/ledger", project_id: "prj_1" }]);
    expect(listed.pulls.map((p) => p.number).sort()).toEqual([1, 3]);
    // Two shown, not "3 of 60": how many of the other 57 are the project's is not known.
    expect(listed.hosts[0]!.capped).toEqual({ shown: 2, total: null });
  });

  test("two lists at once each keep their own CLI states: a second list never wipes what the first found", async () => {
    // gh is not installed. glab is signed in to gitlab.com, and its graphql answers only when let go. The first list
    // covers github.com (gh missing) and gitlab.com; while glab's graphql is held, a second list for gitlab.com starts.
    // Were the CLI states shared, the second would reset them and the first would say nothing of gh (which the window
    // reads as "gh isn't signed in").
    let letGo: () => void = () => {};
    const held = new Promise<void>((done) => (letGo = done));
    let graphqlAsked = false;
    const answer = { data: { currentUser: { username: "dana", requested: { nodes: [] }, authored: { nodes: [GL_MR(1, { author: { username: "dana" } })] }, merged: { nodes: [] } } } };
    const run: RefRunner = async (cli, args) => {
      if (cli === "gh") return { stdout: "", stderr: "gh: not found", exitCode: 127 };
      if (args[0] === "auth") return { stdout: "gitlab.com\n  ✓ Logged in to gitlab.com as dana (keyring)\n", stderr: "", exitCode: 0 };
      if (args.includes("graphql")) {
        graphqlAsked = true;
        await held;
        return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    };
    const ledger = { host: "gitlab.com", repo: "northwind/data/ledger", project_id: "prj_2" };
    const pulls = createInboxPulls({ run });
    const firstList = pulls.list([...repos, ledger]);
    while (!graphqlAsked) await new Promise((done) => setTimeout(done, 1));
    const secondList = pulls.list([ledger]);
    await new Promise((done) => setTimeout(done, 5));
    letGo();
    const [first, second] = await Promise.all([firstList, secondList]);
    expect(first.clis.gh).toBe("missing");
    expect(first.clis.glab).toBe("signed_in");
    expect(first.unsigned).toEqual(["github.com"]);
    expect(second.clis).toEqual({ glab: "signed_in" });
    expect(second.unsigned).toEqual([]);
  });

  test("the repository's default branch is read (GitHub `defaultBranchRef`, GitLab `rootRef`); absent when the forge does not say", () => {
    const gh = parseGithubPulls(JSON.stringify(answerOf([ghPull(1, { baseRepository: { defaultBranchRef: { name: "next" } } }), ghPull(2)])), "github.com")!;
    expect(gh.pulls.find((p) => p.number === 1)!.default_branch).toBe("next");
    expect("default_branch" in gh.pulls.find((p) => p.number === 2)!).toBe(false);
    const gl = parseGitlabPulls(
      JSON.stringify({ data: { currentUser: { username: "dana", requested: { nodes: [] }, authored: { nodes: [GL_MR(4, { project: { fullPath: "northwind/data/ledger", repository: { rootRef: "trunk" } } })] }, merged: { nodes: [] } } } }),
      "gitlab.com",
    )!;
    expect(gl.pulls[0]!.default_branch).toBe("trunk");
  });

  test("authors' pictures stay on the server: only the authors of PRs the list shows, GitLab's relative paths made absolute", async () => {
    const gl = parseGitlabPulls(
      JSON.stringify({ data: { currentUser: { username: "dana", requested: { nodes: [GL_MR(5, { author: { username: "jun", avatarUrl: "/uploads/-/system/user/avatar/7/a.png" } })] }, authored: { nodes: [] }, merged: { nodes: [] } } } }),
      "gitlab.example.org",
    )!;
    expect(gl.avatars).toEqual({ jun: "https://gitlab.example.org/uploads/-/system/user/avatar/7/a.png" });
    const answer = answerOf(
      [ghPull(1, { author: { login: "dana", avatarUrl: "https://avatars.githubusercontent.com/u/1" } }), ghPull(9, { author: { login: "outsider", avatarUrl: "https://avatars.githubusercontent.com/u/9" }, repository: { nameWithOwner: "elsewhere/thing" } })],
      [ghPull(2, { author: { login: "tomas", avatarUrl: "https://avatars.githubusercontent.com/u/2" } })],
    );
    const pulls = createInboxPulls({ run: forge(answer).run });
    const listed = await pulls.list(repos);
    // The answer itself carries no URL: the window asks the Inbox.
    expect(JSON.stringify(listed)).not.toContain("avatars.githubusercontent.com");
    expect(pulls.avatarUrls("github.com")).toEqual({ dana: "https://avatars.githubusercontent.com/u/1", tomas: "https://avatars.githubusercontent.com/u/2" });
    expect(pulls.avatarUrls("gitlab.com")).toEqual({});
  });

  test("a conflicting PR says so (GitHub `mergeable`, GitLab `conflicts`); an unknown one says nothing", () => {
    const gh = parseGithubPulls(JSON.stringify(answerOf([ghPull(1, { mergeable: "CONFLICTING" }), ghPull(2, { mergeable: "UNKNOWN" }), ghPull(3, { mergeable: "MERGEABLE" })])), "github.com")!;
    const by = Object.fromEntries(gh.pulls.map((p) => [p.number, p]));
    expect(by[1]!.conflicts).toBe(true);
    expect(by[2]!.conflicts).toBeUndefined();
    expect(by[3]!.conflicts).toBe(false);
    const gl = parseGitlabPulls(JSON.stringify({ data: { currentUser: { username: "dana", requested: { nodes: [] }, authored: { nodes: [GL_MR(4, { conflicts: true })] }, merged: { nodes: [] } } } }), "gitlab.com")!;
    expect(gl.pulls[0]!.conflicts).toBe(true);
  });

  test("a non-ASCII branch (a valid git branch) is compared, percent-encoded; one git refuses is still refused and runs nothing", async () => {
    const answer = answerOf([
      ghPull(330, { headRefName: "übersetzung/fehlermeldungen" }),
      ghPull(331, { headRefName: "fehlermeldungen-im-dashboard", baseRefName: "übersetzung/fehlermeldungen" }),
      ghPull(340, { headRefName: "bad..name" }),
      ghPull(341, { headRefName: "on-bad", baseRefName: "bad..name" }),
    ]);
    const f = forge(answer);
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list(repos);
    const diff = await pulls.diff("github.com/northwind/billing-svc#331", "stack");
    expect(diff.patch).toBe("diff of repos/northwind/billing-svc/compare/main...fehlermeldungen-im-dashboard\n");
    await pulls.diff("github.com/northwind/billing-svc#330", "stack");
    expect(f.calls.filter((c) => !c.args.includes("--jq")).at(-1)!.args[3]).toBe("repos/northwind/billing-svc/compare/main...%C3%BCbersetzung/fehlermeldungen");
    const before = f.calls.length;
    await expect(pulls.diff("github.com/northwind/billing-svc#340", "stack")).rejects.toMatchObject({ code: "pull_diff_failed" });
    expect(f.calls.length).toBe(before);
    for (const bad of ["-x", "a..b", "a:b", "a~1", "a b", "a@{1}", "x.lock", "a//b", "‮evil", ""]) expect(compareBranch(bad)).toBe(false);
    for (const good of ["übersetzung/fehlermeldungen", "日本語/ブランチ", "feat#12", "release/2026.10"]) expect(compareBranch(good)).toBe(true);
  });

  test("the last words keep code as written: no underscore or backtick turned into a space", () => {
    expect(previewOf("Layer 3 fails `settle_batch()` on EUR→JPY. Rebased from `main`.")).toBe("Layer 3 fails settle_batch() on EUR→JPY. Rebased from main.");
    expect(previewOf("## Status\n\n> **Done:** the _retry_ layer, see [the PR](https://x.test/1)\n- one\n- two")).toBe("Status Done: the retry layer, see the PR one two");
    expect(previewOf("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });

  test("an agent that sent with a wake and polls no more is marked ended; a live one and an MCP-only one are not", () => {
    const pull = parseGithubPulls(JSON.stringify(answerOf([ghPull(1), ghPull(2), ghPull(3)])), "github.com")!.pulls;
    const message = (id: string, thread: string, n: number, session: string, wakes: boolean) => ({
      id,
      thread_id: thread,
      project_id: "prj_1",
      created_at: "2026-11-03T10:00:00.000Z",
      author: { kind: "agent", host: "opencode", session, name: "OpenCode" },
      body: `Up: https://github.com/northwind/billing-svc/pull/${n}`,
      ...(wakes ? { wakes: true } : {}),
    });
    const messages = new Map([
      ["m1", message("m1", "t1", 1, "ses_gone", true)],
      ["m2", message("m2", "t2", 2, "ses_live", true)],
      ["m3", message("m3", "t3", 3, "ses_mcp", false)],
    ]);
    const store = {
      threadsOf: () => [...messages.values()].map((m) => ({ thread_id: m.thread_id, last_at: m.created_at })),
      threadMessageIds: (thread: string) => [...messages.values()].filter((m) => m.thread_id === thread).map((m) => m.id),
      message: (id: string) => (messages.get(id) as never) ?? null,
      threadSubject: () => "Subject",
      threadProject: () => "prj_1",
      sessionLive: (session: string) => session === "ses_live",
    };
    const links = linkInboxPulls(pull, store, new Map([["github.com/northwind/billing-svc", ["prj_1"]]]));
    expect(links["github.com/northwind/billing-svc#1"]!.agent).toMatchObject({ session: "ses_gone", ended: true });
    expect(links["github.com/northwind/billing-svc#2"]!.agent!.ended).toBeUndefined();
    expect(links["github.com/northwind/billing-svc#3"]!.agent!.ended).toBeUndefined();
  });
});

describe("the searches (scoped to the projects' repositories)", () => {
  test("repo: qualifiers while they fit, newest first; past GitHub's limit, unscoped", () => {
    const own = githubPullSearches(Date.parse("2026-11-03T00:00:00Z"), ["northwind/billing-svc", "Northwind/Web-App"]);
    for (const q of Object.values(own)) {
      expect(q).toContain("sort:updated-desc");
      expect(q).toContain("repo:northwind/billing-svc repo:northwind/web-app");
      expect(q.length).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_CHARS);
    }
    expect(own.assigned).toContain("assignee:@me");
    const many = Array.from({ length: 12 }, (_, i) => `northwind/service-number-${i}`);
    for (const q of Object.values(githubPullSearches(0, many))) expect(q).not.toContain("repo:");
  });

  test("Others: never unscoped, at most a few searches under GitHub's limit, the repositories in the order given (each once); none without repositories", () => {
    const many = Array.from({ length: 500 }, (_, i) => `northwind/service-number-${i}`);
    const { searches, covered } = githubOthersSearches(many);
    expect(searches).toHaveLength(INBOX_PULLS_OTHERS_CALLS_MAX);
    const named: string[] = [];
    for (const q of searches) {
      expect(q.length).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_CHARS);
      expect(q).toMatch(/^is:pr is:open archived:false sort:updated-desc repo:/);
      expect(q).not.toContain("@me");
      named.push(...q.split(" ").filter((t) => t.startsWith("repo:")));
    }
    // The first repositories (the most active, as the reader orders them), each once; the rest not read.
    expect(named.sort()).toEqual(covered.map((r) => `repo:${r}`).sort());
    expect(covered).toEqual(many.slice(0, covered.length));
    expect(covered.length).toBeLessThan(many.length);
    const few = githubOthersSearches(["northwind/a", "northwind/b"]);
    expect(few).toEqual({ searches: ["is:pr is:open archived:false sort:updated-desc repo:northwind/a repo:northwind/b"], covered: ["northwind/a", "northwind/b"] });
    expect(githubOthersSearches([])).toEqual({ searches: [], covered: [] });
  });

  test("GitLab Others: a few projects to a query, at most a few queries, numbered across them; a path is only ever a string", () => {
    const projects = Array.from({ length: 100 }, (_, i) => `northwind/p-${i}`);
    const { queries, covered } = gitlabOthersQueries(projects);
    expect(queries).toHaveLength(INBOX_PULLS_OTHERS_CALLS_MAX);
    expect(covered).toEqual(projects.slice(0, GITLAB_PROJECTS_PER_QUERY * INBOX_PULLS_OTHERS_CALLS_MAX));
    for (const q of queries) expect(q).toContain("currentUser { username }");
    expect(queries[1]).toContain(`p${GITLAB_PROJECTS_PER_QUERY}: project(fullPath: "northwind/p-${GITLAB_PROJECTS_PER_QUERY}")`);
    expect(gitlabOthersQueries(['a/b") { x } q: project(fullPath: "c']).queries[0]).toContain('p0: project(fullPath: "a/bxqprojectfullpathc")');
    expect(gitlabOthersQueries([]).queries).toEqual([]);
  });

  test("the most recently active repositories first, then the ones nothing is known of, by name", () => {
    const pulls = [
      { repo: "northwind/old", updated_at: "2026-10-01T00:00:00Z" },
      { repo: "Northwind/Hot", updated_at: "2026-11-03T00:00:00Z" },
      { repo: "northwind/old", updated_at: "2026-10-20T00:00:00Z" },
    ];
    expect(byActivity(["northwind/zeta", "northwind/old", "northwind/alpha", "northwind/hot"], pulls)).toEqual(["northwind/hot", "northwind/old", "northwind/alpha", "northwind/zeta"]);
  });

  test("the person's own query carries the projects' repositories and nothing of Others; Others is its own call", async () => {
    const w = await world({ codeReview: true });
    await w.send("Hello.", "hello");
    await w.pulls();
    const args = w.forge.graphql()[0]!.args;
    expect(args.find((a) => a.startsWith("authored="))).toContain("repo:northwind/billing-svc");
    expect(args.find((a) => a.startsWith("assigned="))).toContain("assignee:@me");
    expect(args.some((a) => a.startsWith("others"))).toBe(false);
    expect(args.find((a) => a.startsWith("query="))).not.toContain("others0");
    const others = w.forge.others();
    expect(others).toHaveLength(1);
    expect(others[0]!.args.find((a) => a.startsWith("others0="))).toContain("repo:northwind/billing-svc");
    expect(others[0]!.args.some((a) => a.startsWith("others1="))).toBe(false);
  });

  test("the route honours ?others=1: with the Others view open, Others is read as the list is; without it, not before 5 min", async () => {
    const w = await world({ codeReview: true });
    await w.send("Hello.", "hello");
    await w.pulls();
    await settle();
    expect(w.forge.others()).toHaveLength(1);
    setSystemTime(new Date(Date.now() + INBOX_PULLS_FRESH_MS + 1_000));
    try {
      await w.pulls();
      expect(w.forge.graphql()).toHaveLength(2);
      expect(w.forge.others()).toHaveLength(1);
      await w.pulls("?others=1");
      expect(w.forge.others()).toHaveLength(2);
    } finally {
      setSystemTime();
    }
  });
});

describe("Mine, To review and Others (the list's filters)", () => {
  const repos = [{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }];
  const othersOf = (issueCount: number, nodes: unknown[]) => ({ data: { viewer: { login: "dana" }, others0: { issueCount, nodes } } });

  test("GitHub: Others' PRs are neither the person's nor asked of them; the person's own lists say what one is to them", async () => {
    const own = {
      data: {
        viewer: { login: "dana" },
        requested: { nodes: [ghPull(880, { author: { login: "tomas" } })] },
        assigned: { nodes: [ghPull(891, { author: { login: "jun" } })] },
        authored: { nodes: [ghPull(412)] },
        merged: { nodes: [] },
      },
    };
    const others = othersOf(4, [ghPull(900, { author: { login: "mei" } }), ghPull(880, { author: { login: "tomas" } }), ghPull(891, { author: { login: "jun" } }), ghPull(412)]);
    const parsed = parseGithubPulls(JSON.stringify(others), "github.com", "others")!;
    expect(parsed.open_total).toBe(4);
    expect(parsed.pulls.every((p) => !p.requested && !p.assigned)).toBe(true);
    // The person's own answer read as Others: nothing of theirs is taken from it.
    expect(parseGithubPulls(JSON.stringify(own), "github.com", "others")!.pulls).toEqual([]);
    const f = forge(own);
    f.othersAnswer = others;
    const listed = await listSettled(createInboxPulls({ run: f.run }), repos);
    const by = Object.fromEntries(listed.pulls.map((p) => [p.number, p]));
    expect(listed.pulls).toHaveLength(4);
    expect(by[900]).toMatchObject({ mine: false, requested: false });
    expect(by[900]!.assigned).toBeUndefined();
    expect(by[880]).toMatchObject({ mine: false, requested: true });
    expect(by[891]).toMatchObject({ mine: false, requested: false, assigned: true });
    expect(by[412]).toMatchObject({ mine: true, requested: false });
  });

  test("GitLab: the projects' MRs merge across the Others queries; the person's own lists keep assigned", () => {
    const user = { data: { currentUser: { username: "dana", requested: { nodes: [] }, authored: { nodes: [] }, assigned: { nodes: [GL_MR(64)] }, merged: { nodes: [] } } } };
    const first = { data: { currentUser: { username: "dana" }, p0: { mergeRequests: { count: 2, nodes: [GL_MR(64), GL_MR(58)] } } } };
    const more = { data: { currentUser: { username: "dana" }, p1: { mergeRequests: { count: 3, nodes: [GL_MR(7, { project: { fullPath: "northwind/web" }, webUrl: "https://gitlab.com/northwind/web/-/merge_requests/7" })] } } } };
    const parsed = parseGitlabPulls([JSON.stringify(first), JSON.stringify(more)], "gitlab.com", "others")!;
    expect(parsed.pulls.map((p) => p.number).sort((a, b) => a - b)).toEqual([7, 58, 64]);
    expect(parsed.open_total).toBe(5);
    // One query's answer not one: the whole Others read is not.
    expect(parseGitlabPulls([JSON.stringify(first), "not json"], "gitlab.com", "others")).toBeNull();
    expect(parseGitlabPulls(JSON.stringify(user), "gitlab.com")!.pulls[0]).toMatchObject({ assigned: true, mine: false });
  });

  test("a GraphQL error is a failed read, even with data: the last answer stays, never a list missing a part", async () => {
    const withError = { ...GH_ANSWER, errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", path: ["authored"], message: "Resource limits exceeded" }] };
    expect(parseGithubPulls(JSON.stringify(withError), "github.com")).toBeNull();
    expect(parseGitlabPulls(JSON.stringify({ data: { currentUser: { username: "dana" } }, errors: [{ message: "Query has complexity of 300" }] }), "gitlab.com")).toBeNull();
    let now = 1_000_000;
    let answer: unknown = GH_ANSWER;
    const f = forge();
    const run: RefRunner = async (cli, args, env) =>
      cli === "gh" && args.includes("graphql") && !othersCall(args) ? (f.calls.push({ cli, args }), { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 }) : f.run(cli, args, env);
    const pulls = createInboxPulls({ run, now: () => now });
    expect((await pulls.list(repos)).pulls).toHaveLength(3);
    answer = withError;
    now += INBOX_PULLS_FRESH_MS;
    const failed = await pulls.list(repos);
    expect(failed.hosts[0]!.error).toBe("unavailable");
    expect(failed.pulls).toHaveLength(3);
  });

  test("Others failing (an error, a GraphQL error) never fails the person's own lists; its last answer stays", async () => {
    let now = 1_000_000;
    const f = forge();
    f.othersAnswer = othersOf(1, [ghPull(900, { author: { login: "mei" } })]);
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    const first = await listSettled(pulls, repos);
    expect(first.pulls.map((p) => p.number).sort()).toEqual([412, 413, 880, 900]);

    // Others answers a GraphQL error: the own lists are read and shown; Others' last answer is kept and said.
    f.othersAnswer = { ...othersOf(1, []), errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "Resource limits exceeded" }] };
    now += INBOX_PULLS_OTHERS_FRESH_MS;
    const second = await listSettled(pulls, repos);
    expect(f.graphql()).toHaveLength(2);
    expect(f.others()).toHaveLength(2);
    expect(second.hosts[0]!.error).toBeUndefined();
    expect(second.hosts[0]!).toMatchObject({ others_error: "unavailable", others_last_read: new Date(1_000_000).toISOString() });
    expect(second.pulls.map((p) => p.number).sort()).toEqual([412, 413, 880, 900]);

    // Others never answered at all: the own lists stand alone, and the host says Others is missing (no last read).
    const fresh = forge();
    fresh.othersFail = "HTTP 502: Bad Gateway";
    const alone = await listSettled(createInboxPulls({ run: fresh.run }), repos);
    expect(alone.pulls).toHaveLength(3);
    expect(alone.hosts[0]!.error).toBeUndefined();
    expect(alone.hosts[0]!.others_error).toBe("unavailable");
    expect(alone.hosts[0]!.others_last_read).toBeUndefined();
  });

  test("a hung Others read never holds the list: the own lists answer at once (the real deadline), Others' last answer with them", async () => {
    let now = 1_000_000;
    const f = forge();
    f.othersAnswer = othersOf(1, [ghPull(900, { author: { login: "mei" } })]);
    let hang = false;
    let letGo: () => void = () => {};
    const hung = new Promise<void>((done) => (letGo = done));
    const run: RefRunner = async (cli, args, env) => {
      if (othersCall(args) && hang) await hung;
      return f.run(cli, args, env);
    };
    const pulls = createInboxPulls({ run, now: () => now });
    try {
      await listSettled(pulls, repos);
      hang = true;
      now += INBOX_PULLS_OTHERS_FRESH_MS;
      const started = performance.now();
      const listed = await pulls.list(repos, { refresh: true, others: true });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(f.graphql()).toHaveLength(2);
      // The own lists, and Others' last answer (#900), while the new Others read hangs.
      expect(listed.pulls.map((p) => p.number).sort()).toEqual([412, 413, 880, 900]);
      expect(listed.hosts[0]).toMatchObject({ others_pending: true });
      expect(listed.hosts[0]!.error).toBeUndefined();
    } finally {
      letGo();
    }
  });

  test("the whole Others read has one deadline: past it, Others is said as failed and its read can run again", async () => {
    const f = forge();
    let asked = 0;
    let letGo: () => void = () => {};
    const hung = new Promise<void>((done) => (letGo = done));
    const run: RefRunner = async (cli, args, env) => {
      if (othersCall(args)) {
        asked += 1;
        // Hangs past the deadline.
        await hung;
      }
      return f.run(cli, args, env);
    };
    const realSetTimeout = globalThis.setTimeout;
    // The deadline's timer fires at once; every other timer as asked.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, ms === INBOX_PULLS_OTHERS_DEADLINE_MS ? 1 : ms)) as unknown as typeof setTimeout;
    try {
      const pulls = createInboxPulls({ run });
      const first = await pulls.list(repos);
      expect(first.pulls).toHaveLength(3);
      expect(first.hosts[0]).toMatchObject({ others_pending: true });
      await new Promise((done) => realSetTimeout(done, 20));
      const listed = await pulls.list(repos);
      expect(asked).toBe(1);
      expect(listed.pulls).toHaveLength(3);
      expect(listed.hosts[0]!.error).toBeUndefined();
      expect(listed.hosts[0]!.others_error).toBe("unavailable");
      expect(listed.hosts[0]!.others_pending).toBeUndefined();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      letGo();
    }
  });

  test("Others is read every 5 min at most, or as often as the list while the Others view is open; a new repository set reads it again", async () => {
    let now = 1_000_000;
    const f = forge();
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    await pulls.list(repos);
    expect(f.others()).toHaveLength(1);
    now += INBOX_PULLS_FRESH_MS;
    await pulls.list(repos, { refresh: true });
    expect(f.graphql()).toHaveLength(2);
    expect(f.others()).toHaveLength(1);
    // The Others view is open: Others is read as the list is.
    now += INBOX_PULLS_FRESH_MS;
    await pulls.list(repos, { others: true });
    expect(f.others()).toHaveLength(2);
    await pulls.list(repos, { others: true });
    expect(f.others()).toHaveLength(2);
    // The view closed: the 5 minutes again.
    now += INBOX_PULLS_FRESH_MS;
    await pulls.list(repos);
    expect(f.others()).toHaveLength(2);
    now += INBOX_PULLS_OTHERS_FRESH_MS;
    await pulls.list(repos);
    expect(f.others()).toHaveLength(3);
    await pulls.list([...repos, { host: "github.com", repo: "northwind/web-app", project_id: "prj_2" }]);
    expect(f.others()).toHaveLength(4);
  });

  test("a big Others read is bounded: 500 repositories, one request of at most 3 searches, the most active repositories first", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ host: "github.com", repo: `northwind/service-number-${i}`, project_id: "prj_1" }));
    // The person's own PR is in the last repository by name: the most active, so it is searched first.
    const hot = many.at(-1)!.repo;
    const f = forge({ data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [ghPull(412, { repository: { nameWithOwner: hot }, url: `https://github.com/${hot}/pull/412` })] }, assigned: { nodes: [] }, merged: { nodes: [] } } });
    const listed = await listSettled(createInboxPulls({ run: f.run }), many);
    const others = f.others();
    expect(others).toHaveLength(1);
    const searches = others[0]!.args.filter((a) => /^others\d+=/.test(a));
    expect(searches.length).toBeLessThanOrEqual(INBOX_PULLS_OTHERS_CALLS_MAX);
    expect(searches[0]).toContain(`repo:${hot} `);
    // Not every repository was read: how many open PRs there are is not known.
    // Only Others left PRs out: the person's own lists are whole (`of: "others"`).
    expect(listed.hosts[0]!.capped).toEqual({ shown: 1, total: null, of: "others" });
  });

  test("the Others count is the whole when every repository was searched: more open PRs than came back says how many the list shows, of how many", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ghPull(3000 + i, { author: { login: "mei" }, headRefName: `o${i}` }));
    const own = { data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [ghPull(412)] }, assigned: { nodes: [] }, merged: { nodes: [] } } };
    const f = forge(own);
    f.othersAnswer = othersOf(140, many);
    expect((await listSettled(createInboxPulls({ run: f.run }), repos)).hosts[0]!.capped).toEqual({ shown: 101, total: 140, of: "others" });
    const all = forge(own);
    all.othersAnswer = othersOf(2, [ghPull(900, { author: { login: "mei" } }), ghPull(412)]);
    expect((await listSettled(createInboxPulls({ run: all.run }), repos)).hosts[0]!.capped).toBeUndefined();
  });

  test("a new set of repositories whose Others read fails shows no count from the old set", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ghPull(3000 + i, { author: { login: "mei" }, headRefName: `o${i}` }));
    const own = { data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [ghPull(412)] }, assigned: { nodes: [] }, merged: { nodes: [] } } };
    const f = forge(own);
    f.othersAnswer = othersOf(140, many);
    const pulls = createInboxPulls({ run: f.run });
    expect((await listSettled(pulls, repos)).hosts[0]!.capped).toEqual({ shown: 101, total: 140, of: "others" });
    f.othersFail = "HTTP 502: Bad Gateway";
    const more = [...repos, { host: "github.com", repo: "northwind/web-app", project_id: "prj_2" }];
    const after = await listSettled(pulls, more);
    expect(after.hosts[0]!.others_error).toBe("unavailable");
    expect(after.hosts[0]!.capped).toBeUndefined();
  });

  test("GitHub's budget nearly spent: list reads wait until it fills, the answer still shown; a layer's diff is not held", async () => {
    let now = Date.parse("2026-11-03T10:00:00Z");
    const reset = new Date(now + 20 * 60_000).toISOString();
    const f = forge({ ...GH_ANSWER, data: { ...GH_ANSWER.data, rateLimit: { cost: 9, remaining: INBOX_PULLS_RATE_FLOOR - 1, resetAt: reset } } });
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    await pulls.list(repos);
    const othersBefore = f.others().length;
    now += INBOX_PULLS_FRESH_MS;
    const held = await pulls.list(repos, { refresh: true, others: true });
    expect(f.graphql()).toHaveLength(1);
    expect(f.others()).toHaveLength(othersBefore);
    expect(held.hosts[0]!.error).toBe("rate_limited");
    expect(held.pulls).toHaveLength(3);
    // Diffs are REST, not the GraphQL budget: still read.
    const diff = await pulls.diff("github.com/northwind/billing-svc#412", "layer");
    expect(diff.patch).toContain("diff of");
    now = Date.parse(reset) + 1;
    await pulls.list(repos, { refresh: true });
    expect(f.graphql()).toHaveLength(2);
  });
});

describe("Post to GitHub/GitLab (the owner's answer C: the person chooses at the end)", () => {
  const PR412 = "github.com/northwind/billing-svc#412";
  const SHA412 = "412".padStart(40, "a");

  test("GitHub: one review on the PR, pinned to the commit read, as the review app's provider posts it", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const comment = { path: "src/retry.ts", line: 12, side: "RIGHT", body: "Cap the backoff.", start_line: 10, start_side: "RIGHT" };
    const res = await w.review({ key: PR412, head_sha: SHA412, action: "request_changes", body: "Two things.", fileComments: [comment] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, prUrl: "https://github.com/northwind/billing-svc/pull/412", submission: { status: "complete" } });
    expect(w.post.calls).toEqual([
      {
        cmd: "gh",
        args: ["api", "repos/northwind/billing-svc/pulls/412/reviews", "--method", "POST", "--input", "-"],
        input: { commit_id: SHA412, body: "Two things.", event: "REQUEST_CHANGES", comments: [comment] },
      },
    ]);
  });

  test("an identical second post is refused (409 already_posted) and runs nothing; another body still posts", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const review = { key: PR412, head_sha: SHA412, action: "approve", body: "Ship it." };
    expect((await w.review(review)).status).toBe(200);
    const again = await w.review(review);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("already_posted");
    expect(w.post.calls).toHaveLength(1);
    expect((await w.review({ ...review, body: "Ship it, and watch the retries." })).status).toBe(200);
    expect(w.post.calls).toHaveLength(2);
  });

  test("a second review at the same head with the same main comment but another line comment posts (200)", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const one = { path: "src/retry.ts", line: 12, side: "RIGHT", body: "Cap the backoff." };
    const two = { path: "src/retry.ts", line: 20, side: "RIGHT", body: "Log the attempt." };
    const review = { key: PR412, head_sha: SHA412, action: "comment", body: "See inline comments." };
    expect((await w.review({ ...review, fileComments: [one] })).status).toBe(200);
    expect((await w.review({ ...review, fileComments: [two] })).status).toBe(200);
    expect(w.post.calls).toHaveLength(2);
  });

  test("posted at the head of the patch the person read, which the forge moved past the list; a commit not on the PR is refused for the page to fall back", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const pushed = "b".repeat(40);
    w.forge.heads = [pushed, pushed];
    const diff = (await (await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent(PR412)}&scope=layer`)).json()) as { head_sha: string | null };
    expect(diff.head_sha).toBe(pushed);
    const res = await w.review({ key: PR412, head_sha: pushed, action: "comment", body: "On the pushed commit.", fileComments: [{ path: "src/retry.ts", line: 3, side: "RIGHT", body: "Here." }] });
    expect(res.status).toBe(200);
    expect((w.post.calls[0]!.input as { commit_id: string }).commit_id).toBe(pushed);
    w.forge.prCommits = [SHA412, pushed];
    const never = await w.review({ key: PR412, head_sha: "c".repeat(40), action: "approve", body: "" });
    expect(((await never.json()) as { code: string }).code).toBe("pull_commit_gone");
    expect(w.post.calls).toHaveLength(1);
  });

  test("a push between the head reads leaves the patch's head unknown", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    w.forge.heads = ["b".repeat(40), "c".repeat(40)];
    const diff = (await (await fetch(`${w.base}/api/inbox/pulls/diff?key=${encodeURIComponent(PR412)}&scope=layer`)).json()) as { head_sha: string | null };
    expect(diff.head_sha).toBeNull();
    // Neither read is kept as a head the person read: the page sends neither (it posts nothing at a null head), and
    // one the PR does not have is refused with nothing run.
    w.forge.prCommits = [SHA412];
    for (const sha of ["b".repeat(40), "c".repeat(40)]) {
      const res = await w.review({ key: PR412, head_sha: sha, action: "approve", body: "" });
      expect(((await res.json()) as { code: string }).code).toBe("pull_commit_gone");
    }
    expect(w.post.calls).toEqual([]);
  });

  test("a merged PR is refused (409 pull_closed) and runs nothing", async () => {
    const merged = { data: { ...GH_ANSWER.data, merged: { nodes: [ghPull(411, { state: "MERGED", mergedAt: "2026-11-02T10:00:00Z" })] } } };
    const w = await world({ codeReview: true, answer: merged });
    await w.send("Ready.", "posting");
    await w.pulls();
    const res = await w.review({ key: "github.com/northwind/billing-svc#411", head_sha: "411".padStart(40, "a"), action: "approve", body: "" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("pull_closed");
    expect(w.post.calls).toEqual([]);
  });

  test("GitLab: a note, a discussion per line comment, then the approval", async () => {
    const w = await world({ codeReview: true, gitlab: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const key = "gitlab.com/northwind/data/ledger#61:pull";
    const sha = "61".padStart(40, "b");
    w.post.answer = (cmd, args) =>
      cmd === "glab" && args[1] === "projects/northwind%2Fdata%2Fledger/merge_requests/61" && args.length === 2
        ? { stdout: JSON.stringify({ diff_refs: { base_sha: "c".repeat(40), start_sha: "d".repeat(40), head_sha: sha } }), stderr: "", exitCode: 0 }
        : { stdout: "{}", stderr: "", exitCode: 0 };
    const res = await w.review({ key, head_sha: sha, action: "approve", body: "Looks right.", fileComments: [{ path: "ledger.py", line: 4, side: "RIGHT", body: "Nit." }] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { submission: { status: string } }).submission.status).toBe("complete");
    const posts = w.post.calls.filter((c) => c.args.includes("POST"));
    expect(posts.map((c) => c.args[1])).toEqual([
      "projects/northwind%2Fdata%2Fledger/merge_requests/61/notes",
      "projects/northwind%2Fdata%2Fledger/merge_requests/61/discussions",
      "projects/northwind%2Fdata%2Fledger/merge_requests/61/approve",
    ]);
    expect(posts[0]!.input).toEqual({ body: "Looks right." });
    expect(posts[1]!.input).toEqual({
      body: "Nit.",
      position: { position_type: "text", base_sha: "c".repeat(40), head_sha: sha, start_sha: "d".repeat(40), new_path: "ledger.py", old_path: "ledger.py", new_line: 4 },
    });
  });

  test("a partial failure comes back as the provider says it, with the narrowed retry", async () => {
    const w = await world({ codeReview: true, gitlab: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const key = "gitlab.com/northwind/data/ledger#61:pull";
    const sha = "61".padStart(40, "b");
    w.post.answer = (cmd, args, input) => {
      if (args.length === 2) return { stdout: JSON.stringify({ diff_refs: { base_sha: "c".repeat(40), start_sha: "d".repeat(40), head_sha: sha } }), stderr: "", exitCode: 0 };
      if (String(args[1]).endsWith("/discussions") && (input as { body?: string }).body === "Broken.") return { stdout: "", stderr: "400 line_code can't be blank", exitCode: 1 };
      return { stdout: "{}", stderr: "", exitCode: 0 };
    };
    const res = await w.review({
      key,
      head_sha: sha,
      action: "comment",
      body: "Notes.",
      fileComments: [
        { path: "a.py", line: 1, side: "RIGHT", body: "Fine." },
        { path: "b.py", line: 2, side: "RIGHT", body: "Broken." },
      ],
    });
    expect(res.status).toBe(200);
    const { submission } = (await res.json()) as { submission: { status: string; postedFileCommentCount: number; failedFileComments: { comment: { body: string } }[]; retry: { action: string; fileComments: { body: string }[] } } };
    expect(submission.status).toBe("partial");
    expect(submission.postedFileCommentCount).toBe(1);
    expect(submission.failedFileComments.map((f) => f.comment.body)).toEqual(["Broken."]);
    expect(submission.retry).toMatchObject({ action: "comment", fileComments: [{ body: "Broken." }] });
  });

  test("refused before anything runs: a moved head, an unknown PR, a bad action, and Code review off", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    w.forge.prCommits = [SHA412];
    const moved = await w.review({ key: PR412, head_sha: "f".repeat(40), action: "approve", body: "" });
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as { code: string }).code).toBe("pull_commit_gone");
    const notACommit = await w.review({ key: PR412, head_sha: "not a sha", action: "approve", body: "" });
    expect(((await notACommit.json()) as { code: string }).code).toBe("pull_moved");
    expect((await w.review({ key: "github.com/northwind/billing-svc#999", head_sha: SHA412, action: "approve" })).status).toBe(404);
    expect((await w.review({ key: PR412, head_sha: SHA412, action: "merge" })).status).toBe(422);
    expect((await w.review({ key: PR412, head_sha: SHA412, action: "comment", fileComments: [{ path: "a", line: 0, side: "RIGHT", body: "x" }] })).status).toBe(422);
    expect(w.post.calls).toEqual([]);
    const off = await world();
    const refused = await off.review({ key: PR412, head_sha: SHA412, action: "approve" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("code_review_off");
    expect(off.post.calls).toEqual([]);
  });

  test("GitHub: an older commit of the PR takes the review at that commit, in that commit's lines", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const older = "e".repeat(40);
    w.forge.prCommits = [older, SHA412];
    const res = await w.review({ key: PR412, head_sha: older, action: "comment", body: "", fileComments: [{ path: "src/retry.ts", line: 3, side: "RIGHT", body: "On what I read." }] });
    expect(res.status).toBe(200);
    expect(w.post.calls[0]!.input).toMatchObject({ commit_id: older, comments: [{ line: 3, side: "RIGHT", body: "On what I read." }] });
  });

  test("GitHub: when it cannot say what the PR has, GitHub decides; its 422 at an older commit is the fallback, not an error", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    w.forge.prCommits = null;
    w.post.answer = () => ({ stdout: "", stderr: "HTTP 422: Unprocessable Entity (commit_id is not part of the pull request)", exitCode: 1 });
    const res = await w.review({ key: PR412, head_sha: "e".repeat(40), action: "comment", body: "", fileComments: [{ path: "src/retry.ts", line: 3, side: "RIGHT", body: "x" }] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("pull_commit_gone");
    expect(w.post.calls).toHaveLength(1);
  });

  for (const reason of ["HTTP 422: No commit found for SHA", "gh: Validation Failed (HTTP 422): commit_id is invalid", "HTTP 422: pull_request_review_thread.line must be part of the diff", "gh: Validation Failed (HTTP 422): Path could not be resolved", "HTTP 422: start_line must be part of the same hunk as the line."]) {
    test(`GitHub at an older commit, a refusal of the commit or its lines is the fallback: ${reason}`, async () => {
      const w = await world({ codeReview: true });
      await w.send("Ready.", "posting");
      await w.pulls();
      const older = "e".repeat(40);
      w.forge.prCommits = [older, SHA412];
      w.post.answer = () => ({ stdout: "", stderr: reason, exitCode: 1 });
      const res = await w.review({ key: PR412, head_sha: older, action: "comment", body: "x" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("pull_commit_gone");
    });
  }

  for (const reason of ["gh: Unprocessable Entity (HTTP 422): Can not approve your own pull request", "HTTP 422: User can only have one pending review per pull request", "HTTP 422: Unprocessable Entity (was submitted too quickly)", "HTTP 422: Reference could not be resolved"]) {
    test(`GitHub at an older commit, a refusal that is not about the commit stays an error: ${reason}`, async () => {
      const w = await world({ codeReview: true });
      await w.send("Ready.", "posting");
      await w.pulls();
      const older = "e".repeat(40);
      w.forge.prCommits = [older, SHA412];
      w.post.answer = () => ({ stdout: "", stderr: reason, exitCode: 1 });
      const res = await w.review({ key: PR412, head_sha: older, action: "comment", body: "x" });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: "pull_review_failed" });
    });
  }

  test("GitHub's 422 giving no reason, at a head the list still names: gone only if a force-push took that commit", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    w.post.answer = () => ({ stdout: "", stderr: "gh: Validation Failed (HTTP 422)", exitCode: 1 });
    w.forge.prCommits = [SHA412];
    expect((await w.review({ key: PR412, head_sha: SHA412, action: "comment", body: "x" })).status).toBe(502);
    w.forge.prCommits = ["f".repeat(40)];
    const gone = await w.review({ key: PR412, head_sha: SHA412, action: "comment", body: "y" });
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { code: string }).code).toBe("pull_commit_gone");
  });

  test("GitLab: a commit the Inbox does not name is refused, and nothing posts, whatever the commit list could say", async () => {
    const w = await world({ codeReview: true, gitlab: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const res = await w.review({ key: "gitlab.com/northwind/data/ledger#61:pull", head_sha: "e".repeat(40), action: "comment", body: "x" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("pull_moved");
    expect(w.post.calls.filter((c) => c.args.includes("POST"))).toEqual([]);
  });

  test("file-level comments over the limit, or one malformed: all refused and nothing posted, never cut for the page to forget", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    const one = { path: "src/retry.ts", body: "On the file." };
    const review = (fileLevelComments: unknown[]) => w.review({ key: PR412, head_sha: SHA412, action: "comment", body: "Words.", fileLevelComments });
    const over = await review(Array.from({ length: 501 }, () => one));
    expect(over.status).toBe(422);
    expect(((await over.json()) as { error: string }).error).toContain("at most 500");
    expect((await review([one, { path: "src/retry.ts", body: "  " }])).status).toBe(422);
    expect(w.post.calls).toEqual([]);
  });

  test("GitHub lists 250 commits at most: a full list not naming the commit says nothing, and GitHub decides", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    w.forge.prCommits = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(40, "0"));
    const res = await w.review({ key: PR412, head_sha: "e".repeat(40), action: "comment", body: "x" });
    expect(res.status).toBe(200);
    expect(w.post.calls[0]!.input).toMatchObject({ commit_id: "e".repeat(40) });
  });

  test("a forge that refuses the review: an error the window shows, nothing claimed posted", async () => {
    const w = await world({ codeReview: true });
    await w.send("Ready.", "posting");
    await w.pulls();
    w.post.answer = () => ({ stdout: "", stderr: "HTTP 422: Unprocessable Entity (Review cannot request changes on your own pull request)", exitCode: 1 });
    const res = await w.review({ key: PR412, head_sha: SHA412, action: "request_changes", body: "x" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "pull_review_failed", error: expect.stringContaining("your own pull request") });
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
      const post = postForge();
      const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, refRunner: f.run, prRuntime: post.runtime, readProjectRepo: async () => null });
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
      // Nor post a review with the owner's gh account: the Inbox's one forge write is the owner's alone.
      const postGuest = await fetch(`http://127.0.0.1:${listener}/api/inbox/pulls/review`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": GUEST, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "github.com/northwind/billing-svc#412", head_sha: "412".padStart(40, "a"), action: "approve", body: "" }),
      });
      expect(postGuest.status).toBe(403);
      expect(((await postGuest.json()) as { code: string }).code).toBe("local_only");
      expect(f.calls).toEqual([]);
      expect(post.calls).toEqual([]);
      expect((await through(OWNER)).status).toBe(200);
      // The owner over the tailnet may hand a PR over: past the guards, the route answers on the request itself.
      const handOwner = await fetch(`http://127.0.0.1:${listener}/api/inbox/pulls/owner`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["github.com/northwind/billing-svc#412"], thread_id: "msg_01M4H6G73M9H3Z32T859E72NOP" }),
      });
      expect(handOwner.status).toBe(422);
      expect(((await handOwner.json()) as { field?: string; code?: string }).code).not.toBe("local_only");
      // The owner over the tailnet is never blocked: past the guards (this Inbox has no project for the PR, so 404).
      const postOwner = await fetch(`http://127.0.0.1:${listener}/api/inbox/pulls/review`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "github.com/northwind/billing-svc#412", head_sha: "412".padStart(40, "a"), action: "approve", body: "" }),
      });
      expect(postOwner.status).toBe(404);
      expect(((await postOwner.json()) as { code: string }).code).toBe("pull_unknown");
    } finally {
      if (savedTailscale === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
      else process.env.PLANNOTATOR_INBOX_TAILSCALE = savedTailscale;
    }
  });
});

// --- the authors' pictures (the owner on #2608: the row's top-left spot is the author's picture) ---

describe("GET /api/inbox/pulls/avatar", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const pictured = answerOf(
    [ghPull(412, { headRefName: "retry/schedule", author: { login: "dana", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" } })],
    [ghPull(880, { headRefName: "rtl", author: { login: "tomas", avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4" } })],
  );
  const scripted = () => {
    const fetched: string[] = [];
    const options: Partial<PullAvatarOptions> = {
      fetch: async (url) => {
        fetched.push(url);
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      },
      lookup: async () => ["185.199.108.133"],
    };
    return { fetched, options };
  };

  test("a listed author's picture comes from the Inbox's own origin, fetched once from the URL the forge gave", async () => {
    const s = scripted();
    const w = await world({ codeReview: true, answer: pictured, avatars: s.options });
    await w.send("Working in billing-svc.", "avatars");
    expect((await w.pulls()).status).toBe(200);
    const res = await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=tomas`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // The person's own picture too; the second ask of a picture is the cache's.
    expect((await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=dana`)).status).toBe(200);
    expect((await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=tomas`)).status).toBe(200);
    expect(s.fetched).toEqual(["https://avatars.githubusercontent.com/u/2?v=4", "https://avatars.githubusercontent.com/u/1?v=4"]);
  });

  test("a login the list did not show is 404 and nothing is fetched; another site's page is refused", async () => {
    const s = scripted();
    const w = await world({ codeReview: true, answer: pictured, avatars: s.options });
    await w.send("Working in billing-svc.", "avatars");
    // Before any list: no one is known.
    expect(((await (await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=tomas`)).json()) as { code: string }).code).toBe("avatar_unknown");
    await w.pulls();
    const unknown = await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=mallory`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("avatar_unknown");
    const crossSite = await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=tomas`, { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(s.fetched).toEqual([]);
  });

  test("a host the next list does not name keeps no author: its pictures are refused and nothing is fetched", async () => {
    const s = scripted();
    const w = await world({ codeReview: true, answer: pictured, avatars: s.options });
    await w.send("Working in billing-svc.", "avatars");
    await w.pulls();
    expect((await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=tomas`)).status).toBe(200);
    // The project's origin goes (removed, or no longer on github.com): once the Inbox reads the origin again (its
    // cache past its age), the next list names no host at all.
    w.setRepo(null);
    setSystemTime(new Date(Date.now() + INBOX_REPO_TTL_MS + 60_000));
    try {
      let hosts = 1;
      for (let i = 0; i < 100 && hosts > 0; i++) {
        hosts = ((await (await w.pulls()).json()) as { hosts: unknown[] }).hosts.length;
        if (hosts > 0) await new Promise((done) => setTimeout(done, 10));
      }
      expect(hosts).toBe(0);
      const fetched = s.fetched.length;
      const gone = await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=dana`);
      expect(gone.status).toBe(404);
      expect(((await gone.json()) as { code: string }).code).toBe("avatar_unknown");
      expect(s.fetched.length).toBe(fetched);
    } finally {
      setSystemTime();
    }
  });

  test("a picture the forge does not give is a miss (the window shows initials), and nothing runs while Code review is off", async () => {
    const s = scripted();
    s.options.fetch = async (url) => {
      s.fetched.push(url);
      return new Response("gone", { status: 404 });
    };
    const w = await world({ answer: pictured, avatars: s.options });
    await w.send("Working in billing-svc.", "avatars");
    expect((await w.setCodeReview(true)).status).toBe(200);
    await w.pulls();
    const miss = await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=tomas`);
    expect(miss.status).toBe(404);
    expect((await miss.json()) as unknown).toMatchObject({ code: "avatar_miss", miss: "status" });
    await w.setCodeReview(false);
    const before = s.fetched.length;
    expect((await fetch(`${w.base}/api/inbox/pulls/avatar?host=github.com&login=dana`)).status).toBe(409);
    expect(s.fetched.length).toBe(before);
  });
});
