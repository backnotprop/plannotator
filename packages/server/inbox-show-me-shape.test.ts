/**
 * Show me makes a Shape (approval "code-review-launch-build", items 1 and 3),
 * through a running Inbox's real doors: the MCP client for the agent's review,
 * the window's own requests for the Show me, the store the `plannotator shape`
 * command writes to, config.json (this test's temp data dir) for the switches.
 *
 * What regresses:
 *  - the boards not reachable with Code review on and Shape's own switch off, or
 *    reachable with both off;
 *  - a Show me about a review of another thread, a file the review lacks, or
 *    with words other than the request the agent will read;
 *  - a turn not naming the board the agent stored for it, or naming one a later
 *    Show me or an earlier board made;
 *  - Show me again's retry from the Ask window being refused, or its board id
 *    not being a board id;
 *  - the old drawings routes coming back;
 *  - Show me reaching anyone with Code review off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxShowMeRequest, type InboxShowMeTarget } from "@plannotator/core/inbox-review";
import { INBOX_ASK_POLL_FIELD, INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { createShapeStore } from "@plannotator/shared/shape/store";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";
import { startInboxServer, type InboxServer } from "./inbox";

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

const SESSION = "ses_review";
const WINDOW_HEADERS = { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const BOARD = { title: "The refresh guard", claim: "One guard.", views: { picture: { html: '<p data-mark="guard" data-code="src/auth.ts#L1">guard</p>' } } };

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-show-me-shape-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "notes.md"), "# Notes\n");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env: this test's own, so the switches are the person's file.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false, askAi: false, binaryPath: null, askTimes: { connectWaitMs: 0 } });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-show-me-shape-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  const fromWindow = (path: string, body?: Record<string, unknown>) =>
    fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { ...WINDOW_HEADERS, ...(body ? { Origin: base } : {}) },
      ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
    });
  const setCodeReview = (on: boolean) => fromWindow("/api/inbox/settings", { code_review: { on } });
  /** The agent's session says it can answer live, so a question is saved. */
  const live = async () => {
    const poll = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: SESSION, host: "claude-code", project_path: project, waitMs: 0, [INBOX_ASK_POLL_FIELD]: true }),
    });
    expect(poll.status).toBe(200);
  };
  const sendReview = async (extra: Record<string, unknown> = {}) => {
    const sent = await call("submit_guide", { project_path: project, ...GUIDE_BRIEF_EXAMPLE, review: true, agent_session: SESSION, agent_name: "Claude Code", agent_host: "claude-code", ...extra });
    expect(sent.isError).toBeFalsy();
    await live();
    return sent.structuredContent as { message_id: string; thread_id: string; guide: { title: string } };
  };
  const askPath = (threadId: string) => `/api/inbox/threads/${threadId}/ask`;
  const showMe = (threadId: string, turnId: string, target: InboxShowMeTarget, title: string, again?: string) =>
    fromWindow(askPath(threadId), {
      turn_id: turnId,
      question: inboxShowMeRequest({ target, title, threadId, ...(again ? { again } : {}) }),
      kind: "show_me",
      show_me: target,
      ...(again ? { again_shape: again } : {}),
    });
  /** What `plannotator shape update --thread T --through M` writes. */
  const store = createShapeStore({ dataDir });
  const drawBoard = (thread: string, through: string, id?: string, base_?: number) => {
    const made = store.update({ board: BOARD, project: { root: project, name: "ledger" }, thread, through, ...(id ? { id, base: base_ } : {}) } as Parameters<typeof store.update>[0]);
    if (!made.ok) throw new Error(JSON.stringify(made));
    return made.id;
  };
  const turnsOf = async (threadId: string) => (await json(await fromWindow(askPath(threadId)))).conversation?.turns ?? [];
  return { project, dataDir, server, call, fromWindow, setCodeReview, sendReview, askPath, showMe, drawBoard, turnsOf };
}

const json = async (response: Response) => (await response.json()) as Record<string, any>;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Show me while Code review is on", () => {
  test("the boards answer with Code review on and Shape's own switch off, and not with both off", async () => {
    const w = await world();
    expect((await w.fromWindow("/api/shapes")).status).toBe(404);
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const id = w.drawBoard(review.thread_id, review.message_id);
    const list = await w.fromWindow("/api/shapes");
    expect(list.status).toBe(200);
    expect((await json(list)).shapes.map((s: { id: string }) => s.id)).toContain(id);
    expect((await w.fromWindow(`/api/shapes/${id}`)).status).toBe(200);
    await w.setCodeReview(false);
    expect((await w.fromWindow("/api/shapes")).status).toBe(404);
    expect((await w.fromWindow(`/api/shapes/${id}`)).status).toBe(404);
  });

  test("the board the agent stores is named on its Show me's turn, and not on a Show me before it or after it", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const title = review.guide.title;
    const lines: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 7, words: "why here" };

    // A board stored before any Show me is nobody's turn's.
    w.drawBoard(review.thread_id, review.message_id);
    await pause();
    const first = await w.showMe(review.thread_id, "turn-0001", lines, title);
    expect(first.status).toBe(200);
    // The window's round is not believed: the Inbox counts the thread's reviews.
    expect((await json(first)).turn).toMatchObject({ id: "turn-0001", kind: "show_me", show_me: { ...lines, round: 1 } });
    expect((await w.turnsOf(review.thread_id))[0].shape).toBeUndefined();

    await pause();
    const board = w.drawBoard(review.thread_id, review.message_id);
    expect((await w.turnsOf(review.thread_id))[0].shape).toBe(board);

    await pause();
    const whole: InboxShowMeTarget = { review: review.message_id, file: null, lines: null, round: 1 };
    expect((await w.showMe(review.thread_id, "turn-0002", whole, title)).status).toBe(200);
    let turns = await w.turnsOf(review.thread_id);
    expect(turns.map((t: { shape?: string }) => t.shape)).toEqual([board, undefined]);

    await pause();
    const second = w.drawBoard(review.thread_id, review.message_id);
    turns = await w.turnsOf(review.thread_id);
    expect(turns.map((t: { shape?: string }) => t.shape)).toEqual([board, second]);
  });

  test("a Show me the agent drew nothing for never claims the next one's board", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const title = review.guide.title;
    const target: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 1 };
    await w.showMe(review.thread_id, "turn-0001", target, title);
    await pause();
    await w.showMe(review.thread_id, "turn-0002", { ...target, file: null, lines: null }, title);
    await pause();
    const board = w.drawBoard(review.thread_id, review.message_id);
    expect((await w.turnsOf(review.thread_id)).map((t: { shape?: string }) => t.shape)).toEqual([undefined, board]);
  });

  test("Show me again: a new version of the same board names the new turn; the window's retry is the same turn", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const title = review.guide.title;
    const target: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 1 };
    await w.showMe(review.thread_id, "turn-0001", target, title);
    await pause();
    const board = w.drawBoard(review.thread_id, review.message_id);
    await pause();

    const again = await w.showMe(review.thread_id, "turn-0002", target, title, board);
    expect(again.status).toBe(200);
    const turn = (await json(again)).turn;
    expect(turn).toMatchObject({ kind: "show_me", again_shape: board });
    expect(turn.question).toContain(`Bring your Shape ${board} up to date`);
    // What AskChat's retry sends: the kept turn's question, target and board.
    const retry = await w.fromWindow(w.askPath(review.thread_id), { turn_id: turn.id, question: turn.question, kind: "show_me", show_me: turn.show_me, again_shape: turn.again_shape });
    expect(retry.status).toBe(200);
    expect((await json(retry)).turn.id).toBe("turn-0002");
    expect((await w.turnsOf(review.thread_id))[1].shape).toBeUndefined();

    await pause();
    expect(w.drawBoard(review.thread_id, review.message_id, board, 1)).toBe(board);
    expect((await w.turnsOf(review.thread_id)).map((t: { shape?: string }) => t.shape)).toEqual([board, board]);
  });

  test("refused: a review of another thread, a message that is no review, a file it lacks, bad lines, other words, a board id that is none", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const other = await w.sendReview({ idempotency_key: "second-review", agent_session: "ses_other" });
    const plain = await w.call("send_message", { project_path: w.project, body: "Ship it?", agent_session: SESSION, agent_host: "claude-code", agent_name: "Claude Code", reply_to: review.message_id });
    expect(plain.isError).toBeFalsy();
    const title = review.guide.title;
    const target: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 1 };

    expect(other.thread_id).not.toBe(review.thread_id);
    const elsewhere = await w.showMe(review.thread_id, "turn-000a", { ...target, review: other.message_id }, title);
    expect(elsewhere.status).toBe(409);
    expect((await json(elsewhere)).code).toBe("not_a_review");

    const notReview = await w.showMe(review.thread_id, "turn-000b", { ...target, review: String(plain.structuredContent.message_id) }, title);
    expect(notReview.status).toBe(409);
    expect((await json(notReview)).code).toBe("not_a_review");

    const noFile = await w.showMe(review.thread_id, "turn-000d", { ...target, file: "src/nope.ts" }, title);
    expect(noFile.status).toBe(422);
    expect((await json(noFile)).error).toContain("src/nope.ts is not a file of this review");

    const badLines = await w.showMe(review.thread_id, "turn-000e", { ...target, lines: [3, 2] }, title);
    expect(badLines.status).toBe(422);
    expect((await json(badLines)).field).toBe("show_me");

    const otherWords = await w.fromWindow(w.askPath(review.thread_id), { turn_id: "turn-000f", question: "Draw me anything you like.", kind: "show_me", show_me: target });
    expect(otherWords.status).toBe(422);
    expect((await json(otherWords)).field).toBe("question");

    const notABoard = await w.fromWindow(w.askPath(review.thread_id), { turn_id: "turn-000g", question: inboxShowMeRequest({ target, title, threadId: review.thread_id, again: "drw_1" }), kind: "show_me", show_me: target, again_shape: "drw_1" });
    expect(notABoard.status).toBe(422);

    expect(await w.turnsOf(review.thread_id)).toEqual([]);
  });

  test("the drawings routes are gone; an overview's drawing still rides a review", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    expect((await w.fromWindow(`/api/inbox/reviews/${review.message_id}/drawings`)).status).toBe(404);
    const diagram = { kind: "html", source: '<div data-step="1" data-mark="guard" data-code="src/auth.ts#L1">guard</div>', width: 800, height: 360 };
    const guide = { ...GUIDE_BRIEF_EXAMPLE.guide, overview: { text: "One guard.", diagram } };
    const bad = await w.call("submit_guide", { project_path: w.project, ...GUIDE_BRIEF_EXAMPLE, guide: { ...guide, overview: { text: "x", diagram: { ...diagram, source: '<div data-code="src/zzz.ts#L1">x</div>' } } }, review: true, agent_session: SESSION, agent_name: "Claude Code", agent_host: "claude-code" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("src/zzz.ts is not a file in this review");
    const drawn = await w.sendReview({ guide, idempotency_key: "drawn-review" });
    const read = await json(await w.fromWindow(`/api/inbox/messages/${drawn.message_id}/guide`));
    expect(read.snapshot.guide.overview).toEqual({ text: "One guard.", diagram });
  });
});

describe("off, the default", () => {
  test("no Show me, no Ask, no boards: nothing read or kept", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const target: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 1 };
    expect((await w.showMe(review.thread_id, "turn-0001", target, review.guide.title)).status).toBe(200);
    expect((await w.setCodeReview(false)).status).toBe(200);
    expect((await json(await w.fromWindow("/api/inbox/settings"))).ask_ai).toBeUndefined();
    // Ask is off with Code review (the env var unset): its routes are the unknown route.
    expect((await w.showMe(review.thread_id, "turn-0002", target, review.guide.title)).status).toBe(404);
    expect((await w.fromWindow("/api/shapes")).status).toBe(404);
  });
});
