/**
 * Show me (code review in the Inbox, approval "shape-in-code-review", ac2)
 * through a running Inbox's real doors: the MCP client for the agent's
 * review, the window's own requests for the Show me question, the Inbox token
 * for `plannotator review draw`, config.json (this test's temp data dir) for
 * the Code review switch.
 *
 * What regresses:
 *  - Show me, its drawings or the overview's drawing reaching anyone while
 *    Code review is off;
 *  - Code review on without Ask (it brings Ask, the env var or not);
 *  - a Show me about a review of another thread, a file the review lacks, or
 *    with words other than the request the agent will read;
 *  - a drawing for a turn that is not a Show me, or one that breaks Shape's
 *    rules or names code outside the review, being stored;
 *  - a drawing read by anything but the owner's window or the token.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC, inboxShowMeRequest, type InboxShowMeTarget } from "@plannotator/core/inbox-review";
import { INBOX_ASK_POLL_FIELD, INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { inboxDir } from "@plannotator/shared/inbox/schema";
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
const GOOD_DRAWING = {
  kind: "html",
  title: "The refresh guard",
  source: '<div data-step="1" data-mark="guard" data-code="src/auth.ts#L1">guard</div>',
  width: 800,
  height: 360,
  tall: { source: '<div data-mark="guard">guard</div>' },
};

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-show-me-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "notes.md"), "# Notes\n");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env: this test's own, so the switch is the person's file.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  // Ask AI's env switch off: Code review alone must bring Ask.
  const server = await startInboxServer({ dataDir, phones: false, askAi: false, binaryPath: null, askTimes: { connectWaitMs: 0 } });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-show-me-test", version: "1.0.0" });
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
  /** As `plannotator review draw` / `drawings` reach it: this machine, no Origin, the token. */
  const cli = (path: string, body?: unknown, token = server.token) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
  const showMe = (threadId: string, turnId: string, target: InboxShowMeTarget, title: string, extra: Record<string, unknown> = {}) =>
    fromWindow(askPath(threadId), {
      turn_id: turnId,
      question: inboxShowMeRequest({ target, title, turnId, ...(typeof extra.again_of_round === "number" ? { againOfRound: extra.again_of_round } : {}) }),
      kind: "show_me",
      show_me: target,
      ...extra,
    });
  const drawingsPath = (messageId: string) => `/api/inbox/reviews/${messageId}/drawings`;
  return { root, project, dataDir, server, base, call, fromWindow, setCodeReview, cli, sendReview, askPath, showMe, drawingsPath };
}

const json = async (response: Response) => (await response.json()) as Record<string, any>;

describe("Show me while Code review is on", () => {
  test("Code review brings Ask; a Show me is kept with its review, file, lines and the Inbox's round", async () => {
    const w = await world();
    const settings = async () => json(await w.fromWindow("/api/inbox/settings"));
    expect((await settings()).ask_ai).toBeUndefined();
    expect((await w.setCodeReview(true)).status).toBe(200);
    expect((await settings()).ask_ai).toBe(true);

    const review = await w.sendReview();
    const target: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 7, words: "why here" };
    const asked = await w.showMe(review.thread_id, "turn-0001", target, review.guide.title);
    expect(asked.status).toBe(200);
    // The window's round is not believed: the Inbox counts the thread's reviews.
    expect((await json(asked)).turn).toMatchObject({ id: "turn-0001", kind: "show_me", show_me: { ...target, round: 1 } });
    const kept = (await json(await w.fromWindow(w.askPath(review.thread_id)))).conversation.turns;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kind: "show_me", show_me: { ...target, round: 1 } });
  });

  test("refused: a review of another thread, a message that is no review, a file it lacks, bad lines, other words", async () => {
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

    const missing = await w.showMe(review.thread_id, "turn-000c", { ...target, review: "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F" }, title);
    expect(missing.status).toBe(404);
    expect((await json(missing)).code).toBe("not_found");

    const noFile = await w.showMe(review.thread_id, "turn-000d", { ...target, file: "src/nope.ts" }, title);
    expect(noFile.status).toBe(422);
    expect((await json(noFile)).error).toContain("src/nope.ts is not a file of this review");

    const badLines = await w.showMe(review.thread_id, "turn-000e", { ...target, lines: [3, 2] }, title);
    expect(badLines.status).toBe(422);
    expect((await json(badLines)).field).toBe("show_me");

    const otherWords = await w.fromWindow(w.askPath(review.thread_id), { turn_id: "turn-000f", question: "Draw me anything you like.", kind: "show_me", show_me: target });
    expect(otherWords.status).toBe(422);
    expect((await json(otherWords)).field).toBe("question");

    // Nothing of these was kept.
    const conversation = (await json(await w.fromWindow(w.askPath(review.thread_id)))).conversation;
    expect(conversation?.turns ?? []).toEqual([]);
  });

  test("a drawing: checked by Shape's rules and the review's files, stored 0600 beside the review, its id on the turn", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const target: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 1, words: "why here" };
    expect((await w.showMe(review.thread_id, "turn-0001", target, review.guide.title)).status).toBe(200);
    const path = w.drawingsPath(review.message_id);

    const unknownTurn = await w.cli(path, { turn: "turn-9999", drawing: GOOD_DRAWING });
    expect(unknownTurn.status).toBe(409);
    expect((await json(unknownTurn)).code).toBe("turn_unknown");

    const invalid = await w.cli(path, { turn: "turn-0001", drawing: { ...GOOD_DRAWING, source: '<div data-code="src/elsewhere.ts#L2" onclick="x()">x</div>', width: 100 } });
    expect(invalid.status).toBe(422);
    const refusal = await json(invalid);
    expect(refusal.code).toBe("invalid");
    expect(refusal.problems).toContain('data-code="src/elsewhere.ts#L2": src/elsewhere.ts is not a file in this review');
    expect(refusal.problems.some((p: string) => p.startsWith("source"))).toBe(true);
    expect(refusal.problems.some((p: string) => p.startsWith("width"))).toBe(true);

    const notAReview = await w.cli(w.drawingsPath("msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F"), { turn: "turn-0001", drawing: GOOD_DRAWING });
    expect(notAReview.status).toBe(404);
    expect((await json(notAReview)).code).toBe("not_found");

    // Without the token, nothing.
    expect((await w.cli(path, { turn: "turn-0001", drawing: GOOD_DRAWING }, "wrong")).status).toBe(401);

    const sent = await w.cli(path, { turn: "turn-0001", drawing: GOOD_DRAWING });
    expect(sent.status).toBe(200);
    const { drawing } = await json(sent);
    expect(drawing).toMatchObject({ turn: "turn-0001", file: "src/auth.ts", lines: [1, 1], round: 1, words: "why here", title: "The refresh guard" });
    expect(drawing.id).toMatch(/^drw_/);
    expect(drawing.view.html).toBe(GOOD_DRAWING.source);

    const file = join(inboxDir(w.dataDir), "review-drawings", `${review.message_id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ v: 1, review: review.message_id, drawings: [{ id: drawing.id }] });

    const turns = (await json(await w.fromWindow(w.askPath(review.thread_id)))).conversation.turns;
    expect(turns[0]).toMatchObject({ id: "turn-0001", drawing: drawing.id });

    // The owner's window and the token read them; anything else does not.
    const read = await w.fromWindow(path);
    expect(read.status).toBe(200);
    const body = await json(read);
    expect(body).toMatchObject({ serverSession: w.server.serverSession, round: 1, overview: null });
    expect(body.drawings.map((d: { id: string }) => d.id)).toEqual([drawing.id]);
    expect((await w.cli(path)).status).toBe(200);
    expect((await fetch(`${w.base}${path}`)).status).toBe(403);
    expect((await fetch(`${w.base}${path}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  });

  test("the overview's drawing rides a review, version 3, and get_guide_brief describes it", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const brief = await w.call("get_guide_brief", {});
    expect(brief.structuredContent.rules).toContain(INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC);
    expect(brief.structuredContent.output_schema.properties.overview).toBeDefined();

    const { tall: _t, title: _title, ...diagram } = GOOD_DRAWING;
    const guide = { ...GUIDE_BRIEF_EXAMPLE.guide, overview: { text: "One guard.", diagram } };
    const bad = await w.call("submit_guide", { project_path: w.project, ...GUIDE_BRIEF_EXAMPLE, guide: { ...guide, overview: { text: "x", diagram: { ...diagram, source: '<div data-code="src/zzz.ts#L1">x</div>' } } }, review: true, agent_session: SESSION, agent_name: "Claude Code", agent_host: "claude-code" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("src/zzz.ts is not a file in this review");

    const review = await w.sendReview({ guide });
    const read = await json(await w.fromWindow(`/api/inbox/messages/${review.message_id}/guide`));
    expect(read.snapshot.version).toBe(3);
    expect(read.snapshot.guide.overview).toEqual({ text: "One guard.", diagram });
    const drawings = await json(await w.fromWindow(w.drawingsPath(review.message_id)));
    expect(drawings.overview).toEqual({ round: 1, codes: ["src/auth.ts#L1"] });
  });
});

describe("off, the default", () => {
  test("no Show me, no drawings, no Ask, and no drawn overview: refused before anything is read or kept", async () => {
    const w = await world();
    await w.setCodeReview(true);
    const review = await w.sendReview();
    const target: InboxShowMeTarget = { review: review.message_id, file: "src/auth.ts", lines: [1, 1], round: 1 };
    expect((await w.showMe(review.thread_id, "turn-0001", target, review.guide.title)).status).toBe(200);
    expect((await w.setCodeReview(false)).status).toBe(200);

    const settings = await json(await w.fromWindow("/api/inbox/settings"));
    expect(settings.ask_ai).toBeUndefined();
    // Ask is off with Code review (the env var unset): its routes are the unknown route.
    expect((await w.showMe(review.thread_id, "turn-0002", target, review.guide.title)).status).toBe(404);

    const path = w.drawingsPath(review.message_id);
    for (const response of [await w.cli(path, { turn: "turn-0001", drawing: GOOD_DRAWING }), await w.cli(path), await w.fromWindow(path)]) {
      expect(response.status).toBe(409);
      expect((await json(response)).code).toBe("code_review_off");
    }

    // The brief says nothing of the overview; an authored overview is left out as always; a v3 snapshot is refused.
    const brief = await w.call("get_guide_brief", {});
    expect(brief.structuredContent.rules).not.toContain(INBOX_REVIEW_OVERVIEW_DIAGRAM_DOC);
    expect(brief.structuredContent.output_schema.properties.overview).toBeUndefined();
    const { tall: _t, title: _title, ...diagram } = GOOD_DRAWING;
    const sent = await w.call("submit_guide", { project_path: w.project, ...GUIDE_BRIEF_EXAMPLE, guide: { ...GUIDE_BRIEF_EXAMPLE.guide, overview: { text: "One guard.", diagram } }, idempotency_key: "off-guide" });
    expect(sent.isError).toBeFalsy();
    const read = await json(await w.fromWindow(`/api/inbox/messages/${sent.structuredContent.message_id}/guide`));
    expect(read.snapshot.version).toBe(1);
    const v3 = { ...read.snapshot, version: 3, guide: { ...read.snapshot.guide, overview: { text: "x", diagram } } };
    const refused = await w.call("submit_guide", { project_path: w.project, snapshot: v3, idempotency_key: "off-v3" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("code_review_off");
  });
});
