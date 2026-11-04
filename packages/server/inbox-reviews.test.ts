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
 *  - an older review (its guide ref without `source`) listed without the
 *    source its snapshot names.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessage, InboxReviewRow, InboxReviewsAnswer } from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { startInboxServer, type InboxServer } from "./inbox";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";
import { createInboxReviewIndex, type InboxReviewIndexStore } from "./inbox-reviews";
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

/** dana's #412 (her agent's), and #869 nobody reviewed; gh signed in to github.com only, glab nowhere. */
const GH_ANSWER = { data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [ghPull(412), ghPull(869)] }, merged: { nodes: [] } } };

function forge() {
  const calls: { cli: string; args: string[] }[] = [];
  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    if (cli === "gh" && args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    if (cli === "glab" && args[0] === "auth") return { stdout: "", stderr: "No hosts logged in", exitCode: 1 };
    if (cli === "gh" && args.includes("graphql")) return { stdout: JSON.stringify(GH_ANSWER), stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  return { run, calls };
}

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reviews-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The switch is config.json's: this test's own data dir.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const f = forge();
  let originReads = 0;
  const server = await startInboxServer({
    dataDir,
    phones: false,
    refRunner: f.run,
    readProjectRepo: async () => {
      originReads += 1;
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
  const sendReview = (thread: string, key: string, body?: string) => call("submit_guide", { ...GUIDE_BRIEF_EXAMPLE, ...(body ? { body } : {}), thread, idempotency_key: key, review: true });
  const verdict = (reviewId: string, key: string, review_verdict: "approved" | "changes_requested") =>
    post(`/api/inbox/messages/${reviewId}/reply`, { idempotency_key: key, words: "Verdict.", review_verdict });
  const reviews = async (): Promise<InboxReviewsAnswer> => {
    const res = await fetch(`${base}/api/inbox/reviews`);
    expect(res.status).toBe(200);
    return (await res.json()) as InboxReviewsAnswer;
  };
  return { project, dataDir, base, forge: f, originReads: () => originReads, call, post, setCodeReview, sendReview, verdict, reviews };
}

const rowsOf = (answer: InboxReviewsAnswer, threadId: string): InboxReviewRow[] => answer.rows.filter((row) => row.thread_id === threadId);

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
    const r1 = await w.sendReview("retries", "r1");
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
