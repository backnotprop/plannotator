/**
 * Reviews in the Inbox (approval "inbox-reviews-page", PR 2 "Server index"),
 * through a running Inbox's real doors: the MCP SDK client for the agent,
 * real `fetch` for the window, a scripted gh / glab (`refRunner`) and a
 * scripted origin read (`readProjectRepo`): no real CLI, git remote or forge.
 *
 * What regresses:
 *  - anything run (gh, glab, the origin read) while Code review is off, or
 *    the route answering then;
 *  - a review sent in an ordinary thread missing from Reviews, listed twice,
 *    or listed as a copy (another id than the thread's own);
 *  - a second review in the thread starting a second row, or moving the
 *    first review message (the page folds what came before it);
 *  - the person's verdict not moving the row (On you → With your agents →
 *    On you on round 2 → Ready to land);
 *  - an approved review of the person's linked PR left On you;
 *  - a listed PR with no review thread shown as reviewed;
 *  - an approval lost once the person writes again ("Thanks!");
 *  - a verdict on an earlier review card taken as answering the newest;
 *  - a review sent after the thread was archived hidden from Reviews;
 *  - a review whose PR merged still listed;
 *  - a deleted thread still listed (the index kept after a re-read);
 *  - an older review (its guide ref without `source`) listed without the
 *    source its snapshot names.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessage, InboxPullHost, InboxReviewLanding, InboxReviewRow, InboxReviewsAnswer, InboxReviewThread } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { startInboxServer, type InboxServer } from "./inbox";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";
import { createInboxPullLinks, INBOX_PULL_LINKS_FILE } from "./inbox-pull-links";
import { createInboxPullStates, createInboxReviewIndex, type InboxReviewIndexStore } from "./inbox-reviews";
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

const PULL_URL = "https://github.com/northwind/billing-svc/pull/412";

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

/** dana's #412 (her agent's), #869 nobody reviewed, and #300 she merged; gh signed in to github.com only, glab nowhere. */
const GH_ANSWER = {
  data: {
    viewer: { login: "dana" },
    requested: { nodes: [] },
    authored: { nodes: [ghPull(412), ghPull(869)] },
    // Merged after the review the test sends (a review newer than the merge would be listed again).
    merged: { nodes: [ghPull(300, { state: "MERGED", mergedAt: new Date(Date.now() + 3_600_000).toISOString() })] },
  },
};
const MERGED_URL = "https://github.com/northwind/billing-svc/pull/300";

function forge(answer: unknown = GH_ANSWER) {
  const calls: { cli: string; args: string[] }[] = [];
  /** What `gh api repos/…/pulls/N` answers; null: it fails. */
  const prState: { answer: Record<string, unknown> | null } = { answer: null };
  /** What `gh api …/pulls/N/commits` lists; null: it fails, and the Inbox can't say a commit is gone. */
  const commits: { shas: string[] | null } = { shas: null };
  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    if (cli === "gh" && args[0] === "api" && commits.shas && args.some((arg) => arg.includes("/commits?"))) return { stdout: commits.shas.join("\n"), stderr: "", exitCode: 0 };
    if (cli === "gh" && args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    if (cli === "glab" && args[0] === "auth") return { stdout: "", stderr: "No hosts logged in", exitCode: 1 };
    if (cli === "gh" && args.includes("graphql")) return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
    if (cli === "gh" && args[0] === "api" && prState.answer) return { stdout: JSON.stringify(prState.answer), stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  return { run, calls, prState, commits };
}

async function world(options: { repoDelayMs?: number; answer?: unknown } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reviews-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The switch is config.json's: this test's own data dir.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const f = forge(options.answer);
  let originReads = 0;
  const posts: string[][] = [];
  const server = await startInboxServer({
    dataDir,
    phones: false,
    refRunner: f.run,
    // A posted review stops here: nothing reaches a forge.
    prRuntime: {
      runCommand: async (_cmd, args) => (posts.push(args), { stdout: "{}", stderr: "", exitCode: 0 }),
      runCommandWithInput: async (_cmd, args) => (posts.push(args), { stdout: "{}", stderr: "", exitCode: 0 }),
    },
    readProjectRepo: async () => {
      originReads += 1;
      if (options.repoDelayMs) await Bun.sleep(options.repoDelayMs);
      return { display: "northwind/billing-svc", host: "github.com" };
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-reviews-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  const agent = { agent_session: "ses_retries", agent_name: "Claude Code", agent_host: "claude-code" };
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: { project_path: project, ...agent, ...args } })) as { structuredContent: { message_id: string; thread_id: string } }).structuredContent;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const setCodeReview = (on: boolean) => post("/api/inbox/settings", { code_review: { on } });
  const sendReview = (thread: string, key: string, body?: string, extra: Record<string, unknown> = {}) =>
    call("submit_guide", { ...GUIDE_BRIEF_EXAMPLE, ...(body ? { body } : {}), thread, idempotency_key: key, review: true, ...extra });
  /** A review of a PR: the guide's source names it. */
  const prGuide = (url: string, number: number) => ({ guide: { ...GUIDE_BRIEF_EXAMPLE.guide, source: { kind: "pr", pr: { url, number, platform: "github" } } } });
  const say = (messageId: string, key: string, words: string) => post(`/api/inbox/messages/${messageId}/reply`, { idempotency_key: key, words });
  const verdict = (reviewId: string, key: string, review_verdict: "approved" | "changes_requested") =>
    post(`/api/inbox/messages/${reviewId}/reply`, { idempotency_key: key, words: "Verdict.", review_verdict });
  const reviews = async (): Promise<InboxReviewsAnswer> => {
    const res = await fetch(`${base}/api/inbox/reviews`);
    expect(res.status).toBe(200);
    return (await res.json()) as InboxReviewsAnswer;
  };
  return { project, dataDir, base, forge: f, posts, originReads: () => originReads, call, post, setCodeReview, sendReview, prGuide, say, verdict, reviews };
}

const rowsOf = (answer: InboxReviewsAnswer, threadId: string): InboxReviewRow[] => answer.rows.filter((row) => row.thread_id === threadId);

const key = (number: number) => `github.com/northwind/billing-svc#${number}`;

describe("a thread handed a PR, archived before its review", () => {
  test("gives the PR back: listed as not reviewed, with no owner, so a review can start; unarchived, it owns it again", async () => {
    const w = await world();
    await w.setCodeReview(true);
    await w.reviews();
    const { thread_id } = await w.call("send_message", { thread: "handed", subject: "Review #869", body: "On it." });
    expect((await w.post("/api/inbox/pulls/owner", { keys: [key(869)], thread_id, ask: "guide" })).status).toBe(200);
    const pr869 = (answer: InboxReviewsAnswer) => answer.rows.filter((row) => row.stacks.some((stack) => stack.layers.some((layer) => layer.number === 869)));
    const links = async () => ((await (await fetch(`${w.base}/api/inbox/pulls`)).json()) as { links: Record<string, { thread_id: string }> }).links;

    expect(pr869(await w.reviews())).toMatchObject([{ reviewed: true, reason: "curating", thread_id }]);
    expect((await links())[key(869)]?.thread_id).toBe(thread_id);

    expect((await w.post(`/api/inbox/messages/${thread_id}/resolve`, { resolved: true })).status).toBe(200);
    expect(pr869(await w.reviews())).toMatchObject([{ reviewed: false, move: "not_reviewed", thread_id: null, link: null }]);
    expect((await links())[key(869)]).toBeUndefined();

    expect((await w.post(`/api/inbox/messages/${thread_id}/resolve`, { resolved: false })).status).toBe(200);
    expect(pr869(await w.reviews())).toMatchObject([{ reviewed: true, reason: "curating", thread_id }]);
    expect((await links())[key(869)]?.thread_id).toBe(thread_id);
  });

  test("one with a review keeps the PR: the archive is not the agent giving up", async () => {
    const w = await world();
    await w.setCodeReview(true);
    await w.reviews();
    const { thread_id } = await w.sendReview("kept", "r1");
    expect((await w.post("/api/inbox/pulls/owner", { keys: [key(869)], thread_id, ask: "guide" })).status).toBe(200);
    expect((await w.post(`/api/inbox/messages/${thread_id}/resolve`, { resolved: true })).status).toBe(200);
    expect(rowsOf(await w.reviews(), thread_id)).toMatchObject([{ reviewed: true, move: "on_you", pull_keys: [key(869)] }]);
  });
});

describe("a teammate's PR assigned to the person, with no thread", () => {
  const pullOf = (sha: string) => ghPull(891, { author: { login: "jun" }, headRefOid: sha });
  const row891 = (answer: InboxReviewsAnswer) => answer.rows.find((row) => row.stacks.some((stack) => stack.layers.some((layer) => layer.number === 891)))!;

  test("a posted review takes it off the person until a push moves past it, and comes through a reload of the store", async () => {
    const assigned = { nodes: [pullOf("a".repeat(40))] };
    const w = await world({ answer: { data: { ...GH_ANSWER.data, assigned } } });
    await w.setCodeReview(true);
    await w.call("send_message", { thread: "elsewhere", subject: "Something else", body: "So the Inbox knows this project." });
    expect(row891(await w.reviews())).toMatchObject({ move: "on_you", reason: "assigned" });
    expect((await w.post("/api/inbox/pulls/review", { key: key(891), head_sha: "a".repeat(40), action: "approve", body: "Good." })).status).toBe(200);
    expect(row891(await w.reviews())).toMatchObject({ move: "waiting", reason: "others" });
    expect(createInboxPullLinks(w.dataDir).posted().get(key(891))?.head).toBe("a".repeat(40));
    assigned.nodes = [pullOf("b".repeat(40))];
    try {
      setSystemTime(new Date(Date.now() + 120_000));
      const read = await fetch(`${w.base}/api/inbox/reviews?refresh=1`);
      expect(row891((await read.json()) as InboxReviewsAnswer)).toMatchObject({ move: "on_you", reason: "assigned" });
    } finally {
      setSystemTime();
    }
  });

  test("a record kept before heads were is read as it was, and still counts", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-posted-")));
    roots.push(dir);
    mkdirSync(inboxDir(dir), { recursive: true });
    writeFileSync(join(inboxDir(dir), INBOX_PULL_LINKS_FILE), JSON.stringify({ v: 1, links: {}, posted: { old: "2026-11-04T11:00:00.000Z", bad: 7 } }));
    expect([...createInboxPullLinks(dir).posted()]).toEqual([["old", { at: "2026-11-04T11:00:00.000Z", head: null }]]);
  });
});

describe("a teammate's PR assigned to the person, reviewed by their agent", () => {
  const TEAMMATE = 891;
  const answer = { data: { ...GH_ANSWER.data, assigned: { nodes: [ghPull(TEAMMATE, { author: { login: "jun" } })] } } };
  const handed = async () => {
    const w = await world({ answer });
    await w.setCodeReview(true);
    await w.reviews();
    const { thread_id } = await w.call("send_message", { thread: "theirs", subject: "Review #891", body: "On it." });
    expect((await w.post("/api/inbox/pulls/owner", { keys: [key(TEAMMATE)], thread_id, ask: "guide", theirs: true })).status).toBe(200);
    const r1 = await w.sendReview("theirs", "r1");
    return { w, thread_id, r1 };
  };
  const postReview = (w: Awaited<ReturnType<typeof world>>, action: string) =>
    w.post("/api/inbox/pulls/review", { key: key(TEAMMATE), head_sha: String(TEAMMATE).padStart(40, "a"), action, body: "Looks right." });

  test("posting Approve from here takes it off the person, kept across a restart of the store; a new review puts it back", async () => {
    const { w, thread_id } = await handed();
    expect(rowsOf(await w.reviews(), thread_id)).toMatchObject([{ move: "on_you", reason: "review_ready" }]);
    const res = await postReview(w, "approve");
    expect(res.status).toBe(200);
    expect(w.posts.length).toBeGreaterThan(0);
    expect(rowsOf(await w.reviews(), thread_id)).toMatchObject([{ move: "waiting", reason: "others" }]);
    expect(createInboxPullLinks(w.dataDir).posted().has(key(TEAMMATE))).toBe(true);

    await Bun.sleep(5);
    await w.sendReview("theirs", "r2");
    expect(rowsOf(await w.reviews(), thread_id)).toMatchObject([{ move: "on_you", reason: "review_ready" }]);
  });

  test("words in the thread do too", async () => {
    const { w, thread_id, r1 } = await handed();
    expect((await w.say(r1.message_id, "words", "Thanks, I'll tell jun.")).status).toBe(200);
    expect(rowsOf(await w.reviews(), thread_id)).toMatchObject([{ move: "waiting", reason: "others" }]);
  });

  test("a post that fails answers nothing", async () => {
    const { w, thread_id } = await handed();
    // GitHub takes a review at an older commit of the PR: this one is no longer on it.
    w.forge.commits.shas = [String(TEAMMATE).padStart(40, "a")];
    const res = await w.post("/api/inbox/pulls/review", { key: key(TEAMMATE), head_sha: "b".repeat(40), action: "approve", body: "Old commit." });
    expect(res.status).toBe(409);
    expect(w.posts).toEqual([]);
    expect(rowsOf(await w.reviews(), thread_id)).toMatchObject([{ move: "on_you", reason: "review_ready" }]);
  });
});

describe("the read that follows the store (?cached=1)", () => {
  test("never calls a forge, cold or warm", async () => {
    const w = await world();
    await w.setCodeReview(true);
    await w.sendReview("retries", "r1");
    // Cold: nothing read since the Inbox started.
    const before = w.forge.calls.length;
    const cold = (await (await fetch(`${w.base}/api/inbox/reviews?cached=1`)).json()) as { cold?: boolean };
    expect(cold.cold).toBe(true);
    expect(w.forge.calls.length).toBe(before);
    // Warm: a real read has been. A new review names a PR off the list, which the next real read asks the forge about.
    await w.reviews();
    await Bun.sleep(20);
    w.forge.prState.answer = { state: "open", draft: false };
    await w.sendReview("off-list", "r2", undefined, w.prGuide("https://github.com/northwind/billing-svc/pull/999", 999));
    const warm = w.forge.calls.length;
    const res = await fetch(`${w.base}/api/inbox/reviews?cached=1`);
    expect(((await res.json()) as InboxReviewsAnswer).rows.length).toBeGreaterThan(0);
    await Bun.sleep(20);
    expect(w.forge.calls.slice(warm)).toEqual([]);
    // The read is due, so the quiet above is the route's doing.
    await w.reviews();
    await Bun.sleep(20);
    expect(w.forge.calls.slice(warm).some((call) => call.args.includes("repos/northwind/billing-svc/pulls/999"))).toBe(true);
  });

  test("two reads while the first waits on git: neither answers no rows, and the cache keeps the rows", async () => {
    const w = await world({ repoDelayMs: 200 });
    await w.setCodeReview(true);
    await w.sendReview("retries", "r1");
    const answers = await Promise.all([w.reviews(), Bun.sleep(30).then(() => w.reviews())]);
    // The PRs come from the forge: a read that lost the project answers its own local row and nothing else.
    for (const answer of answers) expect(answer.rows.some((row) => row.stacks.length > 0)).toBe(true);
    const cached = (await (await fetch(`${w.base}/api/inbox/reviews?cached=1`)).json()) as InboxReviewsAnswer;
    expect(cached.rows.some((row) => row.stacks.length > 0)).toBe(true);
  });
});

describe("off", () => {
  test("Code review off: the route refuses and nothing runs (no gh, no glab, no origin read)", async () => {
    const w = await world();
    await w.setCodeReview(true);
    await w.sendReview("retries", "r1");
    await w.setCodeReview(false);
    const calls = w.forge.calls.length;
    const reads = w.originReads();
    const res = await fetch(`${w.base}/api/inbox/reviews?refresh=1`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("code_review_off");
    expect(w.forge.calls.length).toBe(calls);
    expect(w.originReads()).toBe(reads);
  });
});

describe("on", () => {
  test("a review sent in an ordinary thread is one row, the thread itself; its verdicts move it between groups", async () => {
    const w = await world();
    await w.setCodeReview(true);
    // An ordinary thread: the agent talked first, then sent a review in it.
    const first = await w.call("send_message", { body: "Cleaning up the retry worker.", thread: "retries" });
    const r1 = await w.sendReview("retries", "r1");
    expect(r1.thread_id).toBe(first.thread_id);

    let rows = rowsOf(await w.reviews(), first.thread_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.thread_id, reviewed: true, move: "on_you", reason: "review_ready" });
    expect(rows[0]!.review).toMatchObject({ first_review_id: r1.message_id, latest_review_id: r1.message_id, round: 1, title: "Token refresh", verdict: null });
    // The guide's source: the snapshot's kind and the base the agent named.
    expect(rows[0]!.review!.source).toMatchObject({ kind: "local", base: "origin/main", git_ref: "origin/main...HEAD" });

    expect((await w.verdict(r1.message_id, "v1", "changes_requested")).status).toBe(200);
    rows = rowsOf(await w.reviews(), first.thread_id);
    expect(rows[0]).toMatchObject({ move: "agents", reason: "feedback_sent" });
    expect(rows[0]!.review!.verdict).toMatchObject({ verdict: "changes_requested" });

    // Round 2 in the same thread: still one row, the first review stays the fold point.
    const r2 = await w.sendReview("retries", "r2", "Round two.");
    rows = rowsOf(await w.reviews(), first.thread_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ move: "on_you", reason: "review_ready" });
    expect(rows[0]!.review).toMatchObject({ first_review_id: r1.message_id, latest_review_id: r2.message_id, round: 2, verdict: null });

    expect((await w.verdict(r2.message_id, "v2", "approved")).status).toBe(200);
    rows = rowsOf(await w.reviews(), first.thread_id);
    expect(rows[0]).toMatchObject({ move: "ready", reason: "approved" });
  });

  test("an approved review of the person's linked PR leaves On you; a listed PR nobody reviewed is not reviewed", async () => {
    const w = await world();
    await w.setCodeReview(true);
    // The agent opened #412 in its thread (its own URL link), then sent its review there.
    const opened = await w.call("send_message", { body: `Opened ${PULL_URL}`, thread: "retries" });
    const r1 = await w.sendReview("retries", "r1", undefined, w.prGuide(PULL_URL, 412));
    const key = "github.com/northwind/billing-svc#412";

    // The pulls page alone: linked, checks done, so On you, before and after any verdict.
    const pulls = (await (await fetch(`${w.base}/api/inbox/pulls`)).json()) as { links: Record<string, { thread_id: string }> };
    expect(pulls.links[key]?.thread_id).toBe(opened.thread_id);

    let answer = await w.reviews();
    let rows = rowsOf(answer, opened.thread_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reviewed: true, move: "on_you", pull_keys: [key] });
    // #412 is under its review thread, never a row of its own too.
    expect(answer.rows.filter((row) => row.stacks.some((s) => s.layers.some((l) => l.key === key)))).toHaveLength(1);
    expect(answer.rows.find((row) => row.id === "github.com/northwind/billing-svc#869")).toMatchObject({ reviewed: false, move: "not_reviewed", thread_id: null });

    expect((await w.verdict(r1.message_id, "v1", "approved")).status).toBe(200);
    answer = await w.reviews();
    rows = rowsOf(answer, opened.thread_id);
    expect(rows[0]).toMatchObject({ move: "ready", reason: "approved" });
  });

  test("an approval holds through the chat after it", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const r1 = await w.sendReview("retries", "r1");
    expect((await w.verdict(r1.message_id, "v1", "approved")).status).toBe(200);
    // The agent asks something, the person says yes, then thanks it.
    const asked = await w.call("send_message", { body: "Merge it now?", reply_to: r1.message_id });
    expect((await w.say(asked.message_id, "s1", "Yes.")).status).toBe(200);
    expect((await w.say(asked.message_id, "s2", "Thanks!")).status).toBe(200);
    expect(rowsOf(await w.reviews(), r1.thread_id)[0]).toMatchObject({ move: "ready", reason: "approved" });
  });

  test("a verdict on an earlier review card does not answer the newest", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const r1 = await w.sendReview("retries", "r1");
    const r2 = await w.sendReview("retries", "r2", "Round two.");
    expect((await w.verdict(r1.message_id, "v1", "approved")).status).toBe(200);
    const [row] = rowsOf(await w.reviews(), r1.thread_id);
    expect(row).toMatchObject({ move: "on_you", reason: "review_ready" });
    expect(row!.review).toMatchObject({ latest_review_id: r2.message_id, verdict: null, answered: null });
  });

  test("an archived review thread leaves Reviews; a review sent after the archive brings it back", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const r1 = await w.sendReview("retries", "r1");
    expect((await w.post(`/api/inbox/messages/${r1.thread_id}/resolve`, { resolved: true })).status).toBe(200);
    expect(rowsOf(await w.reviews(), r1.thread_id)).toHaveLength(0);
    const r2 = await w.call("submit_guide", { ...GUIDE_BRIEF_EXAMPLE, body: "Round two.", reply_to: r1.message_id, idempotency_key: "r2", review: true });
    expect(r2.thread_id).toBe(r1.thread_id);
    const rows = rowsOf(await w.reviews(), r1.thread_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ move: "on_you" });
    expect(rows[0]!.review).toMatchObject({ round: 2, latest_review_id: r2.message_id });
  });

  test("a review whose PR merged leaves Reviews", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const opened = await w.call("send_message", { body: `Opened ${MERGED_URL}`, thread: "landed" });
    await w.sendReview("landed", "r1", undefined, w.prGuide(MERGED_URL, 300));
    expect(rowsOf(await w.reviews(), opened.thread_id)).toHaveLength(0);
  });

  test("a deleted review thread leaves Reviews", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const r1 = await w.sendReview("retries", "r1");
    expect(rowsOf(await w.reviews(), r1.thread_id)).toHaveLength(1);
    expect((await w.post(`/api/inbox/threads/${r1.thread_id}/delete`, {})).status).toBe(200);
    expect(rowsOf(await w.reviews(), r1.thread_id)).toHaveLength(0);
  });
});

describe("a PR that left the list", () => {
  const CLOSED_URL = "https://github.com/northwind/billing-svc/pull/500";
  const answers = (state: string, merged: string | null) => ({
    state,
    merged_at: merged,
    // Later than the review the test sends: the review is the one the PR left with.
    closed_at: new Date(Date.now() + 3_600_000).toISOString(),
    title: "A dropped idea",
    html_url: CLOSED_URL,
  });
  /** A reviews read, then the background read's turn, then the read that shows it. */
  const settled = async (w: Awaited<ReturnType<typeof world>>) => {
    await w.reviews();
    await new Promise((done) => setTimeout(done, 30));
    return w.reviews();
  };

  test.each([
    ["closed, which the list never carries", null],
    ["merged long ago, past the list's window", new Date(Date.now() + 3_600_000).toISOString()],
  ])("a PR %s: one read records it, and its review leaves instead of reading as local", async (_name, mergedAt) => {
    const w = await world();
    await w.setCodeReview(true);
    w.forge.prState.answer = answers("closed", mergedAt);
    const r1 = await w.sendReview("closed", "r1", undefined, w.prGuide(CLOSED_URL, 500));
    expect(rowsOf(await settled(w), r1.thread_id)).toHaveLength(0);
    expect(w.forge.calls.filter((c) => c.args.includes("repos/northwind/billing-svc/pulls/500"))).toHaveLength(1);
    // The record stays: no second read, and a later review comes back with its link.
    const r2 = await w.sendReview("closed", "r2", undefined, w.prGuide(CLOSED_URL, 500));
    const rows = rowsOf(await settled(w), r2.thread_id);
    expect(rows[0]).toMatchObject({ move: "on_you", landed: [{ state: mergedAt ? "merged" : "closed", url: CLOSED_URL, number: 500 }] });
    expect(w.forge.calls.filter((c) => c.args.includes("repos/northwind/billing-svc/pulls/500"))).toHaveLength(1);
  });

  test("a PR still open, only gone from the person's list, stays a row and is not read again at once", async () => {
    const w = await world();
    await w.setCodeReview(true);
    w.forge.prState.answer = answers("open", null);
    const r1 = await w.sendReview("open", "r1", undefined, w.prGuide(CLOSED_URL, 500));
    expect(rowsOf(await settled(w), r1.thread_id)).toHaveLength(1);
    expect(rowsOf(await settled(w), r1.thread_id)).toHaveLength(1);
    expect(w.forge.calls.filter((c) => c.args.includes("repos/northwind/billing-svc/pulls/500"))).toHaveLength(1);
  });

  test("a read that fails leaves the row as it was", async () => {
    const w = await world();
    await w.setCodeReview(true);
    w.forge.prState.answer = null;
    const r1 = await w.sendReview("failed", "r1", undefined, w.prGuide(CLOSED_URL, 500));
    expect(rowsOf(await settled(w), r1.thread_id)).toHaveLength(1);
  });
});

describe("the state reads", () => {
  const thread = (id: string, pr?: string): InboxReviewThread =>
    ({ thread_id: id, latest_review_id: `${id}_r1`, reviewed_at: "2026-11-01T10:00:00.000Z", source: pr ? { kind: "pr", pr: { url: pr } } : null }) as unknown as InboxReviewThread;
  const key = (n: number) => `github.com/northwind/billing-svc#${n}`;
  const url = (n: number) => `https://github.com/northwind/billing-svc/pull/${n}`;
  const GITHUB: InboxPullHost = { cli: "gh", host: "github.com", login: "dana" };
  function reader(answer: (endpoint: string) => string | null) {
    const reads: string[] = [];
    const landed: InboxReviewLanding[] = [];
    let at = 1_000_000;
    const states = createInboxPullStates({
      now: () => at,
      run: async (cli, args) => {
        const endpoint = args[3]!;
        reads.push(`${cli} ${endpoint}`);
        const out = answer(endpoint);
        return out === null ? { stdout: "", stderr: "no", exitCode: 1 } : { stdout: out, stderr: "", exitCode: 0 };
      },
      onLand: (record, forget = []) => {
        for (let i = landed.length - 1; i >= 0; i--) if (forget.includes(landed[i]!.key)) landed.splice(i, 1);
        landed.push(...record);
      },
    });
    const look = (threads: InboxReviewThread[], options: { owners?: [string, string][]; hosts?: InboxPullHost[] } = {}) =>
      states.look({ threads, pulls: [], hosts: options.hosts ?? [GITHUB], owners: new Map((options.owners ?? []).map(([k, t]) => [k, { thread_id: t }])), landed: [...landed] });
    return { reads, landed, look, pass: (ms: number) => (at += ms) };
  }
  const closed = JSON.stringify({ state: "closed", merged_at: null, closed_at: "2026-11-02T10:00:00Z", title: "T", html_url: url(1), head: { ref: "b" } });
  const merged = JSON.stringify({ state: "closed", merged_at: "2026-11-02T10:00:00Z", title: "T", html_url: url(1) });

  test("a host that failed this list is not read", async () => {
    const r = reader(() => closed);
    await r.look([thread("t", url(1))], { hosts: [{ ...GITHUB, error: "unavailable" }] });
    expect(r.reads).toEqual([]);
  });

  test("the CLI is the one the host uses, whatever the host is called", async () => {
    const r = reader(() => closed);
    await r.look([thread("t")], { owners: [["git.example.com/group/app#7", "t"]], hosts: [{ cli: "glab", host: "git.example.com", login: "d" }] });
    expect(r.reads).toEqual([`glab projects/${encodeURIComponent("group/app")}/merge_requests/7`]);
  });

  test("one read of the list starts at most 5, and the rest wait", async () => {
    const r = reader(() => null);
    const threads = [1, 2, 3, 4, 5, 6, 7].map((n) => thread(`t${n}`, url(n)));
    await r.look(threads);
    expect(r.reads).toHaveLength(5);
    await r.look(threads);
    expect(r.reads).toHaveLength(7);
  });

  test("only a thread with a review is read for: a thread with none has no row to get wrong", async () => {
    const r = reader(() => closed);
    await r.look([], { owners: [[key(1), "no_review"]] });
    expect(r.reads).toEqual([]);
  });

  test("a merged record is never read again; a closed one is checked after a day, and a reopen forgets it", async () => {
    let answer = merged;
    const r = reader(() => answer);
    await r.look([thread("m", url(1))]);
    expect(r.landed.map((l) => l.state)).toEqual(["merged"]);
    r.pass(30 * 24 * 60 * 60_000);
    await r.look([thread("m", url(1))]);
    expect(r.reads).toHaveLength(1);

    const c = reader(() => answer);
    answer = closed;
    await c.look([thread("c", url(1))]);
    expect(c.landed.map((l) => l.state)).toEqual(["closed"]);
    c.pass(60 * 60_000);
    await c.look([thread("c", url(1))]);
    expect(c.reads).toHaveLength(1);
    c.pass(24 * 60 * 60_000);
    answer = JSON.stringify({ state: "open", title: "T", html_url: url(1) });
    await c.look([thread("c", url(1))]);
    expect(c.reads).toHaveLength(2);
    expect(c.landed).toEqual([]);
  });

  test("a second thread on a PR already recorded gets its own record", async () => {
    const r = reader(() => closed);
    await r.look([thread("a", url(1))]);
    r.pass(31 * 60_000);
    await r.look([thread("a", url(1)), thread("b", url(1))]);
    expect(r.landed.map((l) => l.thread_id).sort()).toEqual(["a", "b"]);
  });
});

describe("the record", () => {
  test("survives a restart, and a read-only folder never fails the list's read", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-landed-")));
    roots.push(dir);
    const landing: InboxReviewLanding = { key: "github.com/o/r#1", thread_id: "t", state: "closed", at: null, url: "https://github.com/o/r/pull/1", number: 1, title: "T", platform: "github", head: null, through_review: "t_r1" };
    createInboxPullLinks(dir).land([landing]);
    expect(createInboxPullLinks(dir).landings()).toEqual([landing]);
    const file = join(inboxDir(dir), INBOX_PULL_LINKS_FILE);
    const whole = JSON.parse(readFileSync(file, "utf8"));
    whole.landed.bad = { thread_id: "t", key: "github.com/o/r#2", url: "https://x", number: 2, state: "gone" };
    whole.landed.keyless = { thread_id: "t", url: "https://x", number: 3, state: "closed" };
    writeFileSync(file, JSON.stringify(whole));
    expect(createInboxPullLinks(dir).landings()).toEqual([landing]);
    chmodSync(inboxDir(dir), 0o500);
    try {
      const store = createInboxPullLinks(dir);
      expect(() => store.land([{ ...landing, thread_id: "u" }])).not.toThrow();
      expect(store.landings()).toHaveLength(2);
    } finally {
      chmodSync(inboxDir(dir), 0o700);
    }
  });
});

describe("the index", () => {
  test("an older review whose guide ref has no source gets it from its snapshot", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reviews-index-")));
    roots.push(dir);
    const sha = "c".repeat(64);
    mkdirSync(dirname(inboxBlobPath(dir, sha)), { recursive: true });
    writeFileSync(inboxBlobPath(dir, sha), JSON.stringify(snapshotOf({ kind: "local", repo: "northwind/billing-svc", branch: "retry-jitter" }, { gitRef: "main...HEAD", base: "main" })));
    const root: InboxMessage = message({ id: "msg_root", author: { kind: "agent", host: "claude-code", session: "ses_1", name: "Claude Code" } as InboxMessage["author"] });
    const old: InboxMessage = message({
      id: "msg_review",
      author: root.author,
      guide: { sha256: sha, input_sha256: sha, bytes: 1, title: "Retry jitter", sections: 1, files: 1, additions: 1, deletions: 0, review: true, chapters: ["One"] },
    });
    const messages = new Map([root, old].map((m) => [m.id, m]));
    const store: InboxReviewIndexStore = {
      dir,
      cursor: () => 1,
      reloadCount: () => 0,
      threadIds: () => ["msg_root"],
      threadMessageIds: () => ["msg_root", "msg_review"],
      message: (id) => messages.get(id) ?? null,
      threadSubject: () => "Retry worker cleanup",
      canonicalProjectId: (id) => id,
    };
    const [thread] = createInboxReviewIndex(store).threads();
    expect(thread).toMatchObject({ thread_id: "msg_root", first_review_id: "msg_review", round: 1 });
    expect(thread!.source).toEqual({ kind: "local", repo: "northwind/billing-svc", branch: "retry-jitter", base: "main", git_ref: "main...HEAD" });
  });
});

function message(fields: Partial<InboxMessage> & { id: string }): InboxMessage {
  return {
    project_id: "prj_1",
    thread_id: "msg_root",
    reply_to: null,
    author: { kind: "person" } as InboxMessage["author"],
    subject: null,
    body: "x",
    created_at: `2026-11-04T10:00:0${fields.id === "msg_root" ? 0 : 1}.000Z`,
    resolved_at: null,
    idempotency_key: null,
    ...fields,
  } as InboxMessage;
}

function snapshotOf(source: Record<string, unknown>, review: Record<string, unknown>) {
  return {
    kind: "plannotator-guided-review",
    version: 1,
    exportedAt: "2026-11-04T10:00:00.000Z",
    guide: { title: "Retry jitter", intent: "Jitter.", sections: [{ title: "One", overview: "o", diffs: [{ file: "a.ts", summary: "s" }] }], reviewed: [false] },
    review: { rawPatch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n", ...review },
    source,
  };
}
