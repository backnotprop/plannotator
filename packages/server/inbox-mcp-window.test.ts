/**
 * read_thread's window, the text-complete transcript, and the agents' search
 * (step 2 of the Inbox MCP size work), through the real doors: a running
 * Inbox, the MCP SDK client, the window's routes for the person, and the text
 * the agent connections hand the model (`inboxToolResultText`). The failures
 * these guard: a long thread read growing with the whole history again; a
 * windowed read that loses a question's state; `limit`, `expand`, `before`,
 * `after` or `message_id` not doing what the guide says; a connection that
 * appends JSON to a complete transcript (or an older one that no longer gets
 * the JSON); and a search that writes, leaks another project's messages or
 * marks anything read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_TEXT_COMPLETE_META_KEY, inboxToolResultText } from "@plannotator/shared/inbox/connection";
import { LONG_THREAD_FIRST_CHOICE, seedLongThread } from "../../tests/helpers/inbox-long-thread";
import { startInboxServer, type InboxServer } from "./inbox";
import { splitInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import type { InboxMessageWire } from "@plannotator/core/inbox-types";
import { agentMessage, INBOX_BODY_CUT_BYTES, INBOX_EARLIER_PERSON_BYTES, INBOX_THREAD_WINDOW, messageText, windowedThread, windowedThreadText, withoutAnswersSection, type ThreadReadInput } from "./inbox-mcp-read";
import { INBOX_RECENT_SEARCHES_FILE } from "./inbox-search";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any>; _meta?: Record<string, unknown> };

async function world(options: { setAsideDelayMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-window-")));
  roots.push(root);
  const project = join(root, "api");
  const other = join(root, "web");
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), ...options });
  servers.push(server);
  const client = new Client({ name: "inbox-mcp-window-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as Record<string, any>;
  };
  return { root, project, other, server, client, post };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  if (result.isError) throw new Error(result.content[0]!.text);
  return result;
}

async function refused(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  expect(result.isError).toBe(true);
  return result.content[0]!.text;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const ids = (messages: { id: string }[]) => messages.map((m) => m.id);

/** The text a connection that predates the mark hands the model: always the text, then the JSON (step 1's rendering). */
function olderConnectionText(result: Result): string {
  const text = result.content.map((part) => part.text).join("\n");
  return `${text}\n\n${JSON.stringify(result.structuredContent)}`.trim();
}

describe("read_thread reads a window", () => {
  test("a 60-message thread: the transcript stays small, and each message past the window adds at most a line", async () => {
    const w = await world();
    const sizes: number[] = [];
    for (const rounds of [20, 30]) {
      const project = join(w.root, `long-${rounds}`);
      mkdirSync(project, { recursive: true });
      const seeded = await seedLongThread({ client: w.client, port: w.server.port, project, rounds, session: `ses_${rounds}` });
      await seeded.answerLast();
      const read = await call(w.client, "read_thread", { thread_id: seeded.threadId, agent_session: `ses_${rounds}` });
      expect(read._meta?.[INBOX_TEXT_COMPLETE_META_KEY]).toBe(true);
      const text = inboxToolResultText(read).text;
      // The connection hands the model the transcript alone: no JSON after it.
      expect(text).toBe(read.content[0]!.text);
      expect(text).not.toContain('"thread_id"');
      expect(read.structuredContent.thread.message_count).toBe(rounds * 2);
      sizes.push(bytes(text));
    }
    const [forty, sixty] = sizes as [number, number];
    // Measured: about 18.8 KB for 60 messages (35 KB of o200k tokens before: ~100 KB as JSON).
    expect(sixty).toBeLessThan(24 * 1024);
    // Twenty more messages (ten agent lines, ten short replies) add under 500 bytes each.
    expect((sixty - forty) / 20).toBeLessThan(500);
  });

  test("the window: the newest limit messages in full, the person's earlier messages in full, every other earlier message as one line", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 10 });
    const all = seeded.messageIds; // 19 messages, oldest first: agent, person, agent, …, agent
    const read = await call(w.client, "read_thread", { thread_id: seeded.threadId, agent_session: "ses_long" });
    const { thread, window } = read.structuredContent;
    expect(ids(thread.messages).slice(-INBOX_THREAD_WINDOW)).toEqual(all.slice(-INBOX_THREAD_WINDOW));
    // Before the window: the person's replies in full (they fit in 12 KB), the agent's messages one line each.
    const before = all.slice(0, -INBOX_THREAD_WINDOW);
    const persons = before.filter((_, i) => i % 2 === 1);
    const agents = before.filter((_, i) => i % 2 === 0);
    expect(ids(thread.messages)).toEqual([...persons, ...all.slice(-INBOX_THREAD_WINDOW)].sort((a, b) => all.indexOf(a) - all.indexOf(b)));
    expect(ids(thread.earlier)).toEqual(agents);
    expect(window).toMatchObject({ limit: INBOX_THREAD_WINDOW, full: persons.length + INBOX_THREAD_WINDOW, lines: agents.length, left_out: 0 });
    // A one-line message: id, author, time, first words, size, and its questions with their states and answers.
    const line = thread.earlier[0];
    expect(line).toMatchObject({ id: all[0], author: { kind: "agent", name: "Claude Code" }, words: expect.stringMatching(/^Step 1:/), bytes: expect.any(Number) });
    expect(line.questions.map((q: any) => [q.q, q.state, q.answer.selected])).toEqual([
      [1, "sent", [LONG_THREAD_FIRST_CHOICE]],
      [2, "sent", ["Yes"]],
    ]);
    // An earlier reply leaves its answers section out (the answers are on the questions); one in the window keeps it.
    const earlierReply = thread.messages.find((m: any) => m.id === persons[0]);
    expect(earlierReply.body).toContain("Round 1: go ahead.");
    expect(earlierReply.body).not.toContain("### Q1.");
    const windowReply = thread.messages.find((m: any) => m.id === all.at(-2));
    expect(windowReply.body).toContain("## Answers to your questions");
    // The bookkeeping is gone; the fields readers use keep their names.
    const newest = thread.messages.at(-1);
    expect(Object.keys(newest).sort()).toEqual(["author", "body", "created_at", "id", "questions", "reply_to"]);
    expect(Object.keys(newest.questions[0]).sort()).toEqual(["key", "kind", "prompt", "q", "state"]);
    const withFile = thread.messages.find((m: any) => m.attachments);
    expect(withFile.attachments[0]).toEqual({ name: "notes.md", kind: "markdown", size: expect.any(Number), path: join(w.project, "notes.md") });
    // The header: the open questions, every participant.
    expect(thread.open_questions.map((q: any) => [q.message_id, q.state, q.choices])).toEqual([
      [seeded.lastAgentMessageId, "open", [LONG_THREAD_FIRST_CHOICE, "Fixed 5 s"]],
      [seeded.lastAgentMessageId, "open", ["Yes", "No"]],
    ]);
    expect(thread.participants).toEqual([
      { kind: "agent", name: "Claude Code", messages: 10 },
      { kind: "person", name: "the person", messages: 9 },
    ]);
    // The transcript: the summary line first, the open questions, every message once, oldest first.
    const text = read.content[0]!.text;
    expect(text.split("\n")[0]).toBe(`Thread ${seeded.threadId} (Round 1: which backoff should the worker use?): 19 messages, 9 from the person.`);
    expect(text).toContain(`- ${seeded.lastAgentMessageId}/${thread.open_questions[0].key} (Q1) open: Round 10: which backoff should the worker use? Choices: ${LONG_THREAD_FIRST_CHOICE} | Fixed 5 s`);
    let at = 0;
    for (const id of all) {
      const next = text.indexOf(id, at);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    // A one-line message's question names its prompt, so the answer says what it answers.
    expect(text).toContain(`Q1 ${line.questions[0].key} ("Round 1: which backoff should the worker use?") sent: "${LONG_THREAD_FIRST_CHOICE}"`);
    expect(text).toContain(`Cursor ${read.structuredContent.cursor}: read_thread after: ${read.structuredContent.cursor}`);
  });

  test("limit sets the window; expand and message_id show any message in full, as sent", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 10 });
    const all = seeded.messageIds;
    const two = (await call(w.client, "read_thread", { thread_id: seeded.threadId, limit: 2 })).structuredContent;
    expect(ids(two.thread.messages).slice(-2)).toEqual(all.slice(-2));
    expect(two.window.limit).toBe(2);
    expect(ids(two.thread.earlier)).toContain(all.at(-3));

    const first = all[0]!;
    const expanded = (await call(w.client, "read_thread", { thread_id: seeded.threadId, expand: [first, all[1]] })).structuredContent;
    expect(ids(expanded.thread.messages)[0]).toBe(first);
    expect(ids(expanded.thread.earlier)).not.toContain(first);
    // Expanded means exactly as sent: an earlier reply keeps its answers section then.
    expect(expanded.thread.messages.find((m: any) => m.id === all[1]).body).toBe(w.server.store.message(all[1]!)!.body);

    const byMessage = await call(w.client, "read_thread", { message_id: all[2] });
    expect(byMessage.structuredContent.thread.thread_id).toBe(seeded.threadId);
    expect(ids(byMessage.structuredContent.thread.messages)).toContain(all[2]);
    expect(byMessage.content[0]!.text).toContain(`[${all[2]} · Claude Code`);

    expect(await refused(w.client, "read_thread", { thread_id: seeded.threadId, expand: ["msg_01ARZ3NDEKTSV4RRFFQ69G5FAV"] })).toBe(
      "validation_error: expand: msg_01ARZ3NDEKTSV4RRFFQ69G5FAV is not a message of this thread.",
    );
    expect(await refused(w.client, "read_thread", { project_path: w.project, expand: [first] })).toStartWith("validation_error: expand, before and after read one thread");
  });

  test("before reads further back; after returns only what is new, by cursor or message id", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 10 });
    const all = seeded.messageIds;
    const pivot = all[10]!;
    const back = (await call(w.client, "read_thread", { thread_id: seeded.threadId, before: pivot })).structuredContent;
    expect(ids(back.thread.messages).slice(-INBOX_THREAD_WINDOW)).toEqual(all.slice(10 - INBOX_THREAD_WINDOW, 10));
    expect([...ids(back.thread.messages), ...ids(back.thread.earlier)].sort()).toEqual(all.slice(0, 10).sort());
    expect(back.window.left_out).toBe(all.length - 10);
    // The questions of the messages left out are still there, with their states.
    const leftOutKeys = all.slice(10).flatMap((id) => (w.server.store.questionsOf(id) ?? []).map((q) => `${id}/${q.key}`));
    const listed = new Set([
      ...back.thread.questions.map((q: any) => `${q.message_id}/${q.key}`),
      ...back.thread.open_questions.map((q: any) => `${q.message_id}/${q.key}`),
    ]);
    for (const key of leftOutKeys) expect(listed.has(key)).toBe(true);

    const read = (await call(w.client, "read_thread", { thread_id: seeded.threadId })).structuredContent;
    const nothingNew = (await call(w.client, "read_thread", { thread_id: seeded.threadId, after: read.cursor })).structuredContent;
    expect(nothingNew.thread.messages).toEqual([]);
    expect(nothingNew.thread.earlier).toEqual([]);
    expect(nothingNew.thread.open_questions).toHaveLength(2);
    const replyId = await seeded.answerLast();
    const fresh = await call(w.client, "read_thread", { thread_id: seeded.threadId, after: read.cursor });
    expect(ids(fresh.structuredContent.thread.messages)).toEqual([replyId]);
    expect(fresh.structuredContent.thread.open_questions).toEqual([]);
    // The cursor may come back as digits in a string, and a message id works as the bound too.
    expect(ids((await call(w.client, "read_thread", { thread_id: seeded.threadId, after: String(read.cursor) })).structuredContent.thread.messages)).toEqual([replyId]);
    expect(ids((await call(w.client, "read_thread", { thread_id: seeded.threadId, after: seeded.lastAgentMessageId })).structuredContent.thread.messages)).toEqual([replyId]);
    expect(fresh.content[0]!.text).toContain("Range: after");
    expect(await refused(w.client, "read_thread", { thread_id: seeded.threadId, before: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toStartWith("validation_error: before: msg_01ARZ3NDEKTSV4RRFFQ69G5FAV is not a message of this thread");
  });

  test("a body over 16 KB is cut with a marker naming expand; expand shows it whole", async () => {
    const w = await world();
    const long = `Start of the report.\n\n${"The retry worker drains the queue in order. ".repeat(1200)}\n\nEnd of the report.`;
    const sent = (await call(w.client, "send_message", { project_path: w.project, body: long, agent_session: "ses_big" })).structuredContent;
    const read = (await call(w.client, "read_thread", { thread_id: sent.thread_id })).structuredContent;
    const message = read.thread.messages[0];
    expect(bytes(message.body)).toBeLessThan(INBOX_BODY_CUT_BYTES + 200);
    expect(message.body).toStartWith("Start of the report.");
    expect(message.body).toContain(`read_thread expand: ["${sent.message_id}"] shows the rest`);
    expect(message.body_bytes).toBe(bytes(long));
    const whole = (await call(w.client, "read_thread", { thread_id: sent.thread_id, expand: [sent.message_id] })).structuredContent;
    expect(whole.thread.messages[0].body).toBe(long);
    expect(whole.thread.messages[0].body_bytes).toBeUndefined();
  });

  test("the person's earlier messages past 12 KB become one line, newest kept in full", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 2 });
    let last = seeded.lastAgentMessageId;
    const words = "This is what I think about the retry worker, at some length. ".repeat(40); // ~2.4 KB a reply
    const replies: string[] = [];
    for (let i = 0; i < 9; i++) {
      const reply = await w.post(`/api/inbox/messages/${last}/reply`, { idempotency_key: `r${i}`, words: `${i}: ${words}` });
      replies.push(reply.reply.id);
      last = (await call(w.client, "send_message", { reply_to: reply.reply.id, body: `Noted ${i}.`, agent_session: "ses_long" })).structuredContent.message_id;
    }
    const { thread } = (await call(w.client, "read_thread", { thread_id: seeded.threadId })).structuredContent;
    const inFull = replies.filter((id) => ids(thread.messages).includes(id));
    const asLines = replies.filter((id) => ids(thread.earlier).includes(id));
    expect(inFull.length + asLines.length).toBe(replies.length);
    // Contiguous: the oldest ones are the lines.
    expect(asLines).toEqual(replies.slice(0, asLines.length));
    expect(asLines.length).toBeGreaterThan(0);
    const earlierFullBytes = inFull.filter((id) => !replies.slice(-3).includes(id)).reduce((sum, id) => sum + bytes(w.server.store.message(id)!.body), 0);
    expect(earlierFullBytes).toBeLessThanOrEqual(INBOX_EARLIER_PERSON_BYTES);
  });

  test("format: \"full\" returns every full record, as before the window", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 10 });
    const full = await call(w.client, "read_thread", { thread_id: seeded.threadId, format: "full" });
    expect(full._meta?.[INBOX_TEXT_COMPLETE_META_KEY]).toBeUndefined();
    expect(ids(full.structuredContent.thread.messages)).toEqual(seeded.messageIds);
    const withFile = (full.structuredContent.thread.messages as Record<string, any>[]).find((m) => (m.attachments ?? []).length > 0)!;
    expect(withFile.attachments[0].sent_sha256).toEqual(expect.any(String));
    // Not marked complete: every connection appends its JSON.
    expect(inboxToolResultText(full).text).toContain('"sent_sha256"');
  });
});

describe("no question's state is ever lost from a windowed read", () => {
  /** A thread whose questions are in every state: sent, skipped by a reply, picked, replaced, withdrawn, open, and closed by Mark read. */
  async function richThreads(w: Awaited<ReturnType<typeof world>>) {
    const send = async (args: Record<string, unknown>) => (await call(w.client, "send_message", { project_path: w.project, agent_session: "ses_rich", agent_name: "Claude Code", ...args })).structuredContent;
    const block = (prompt: string) => `:::question\n${prompt}\n\n- [ ] Yes\n- [ ] No\n:::`;
    const answer = (q: { key: string; kind: string; prompt: string }, label: string) => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] });
    const one = await send({ body: `Round one.\n\n${block("Ship A?")}\n\n${block("Ship B?")}`, thread: "rich" });
    await w.post(`/api/inbox/messages/${one.message_id}/reply`, { idempotency_key: "one", words: "Go.", questions: one.questions.map((q: any) => ({ key: q.key, revision: 0, answer: answer(q, "Yes") })) });
    const two = await send({ body: `Round two.\n\n${block("Ship C?")}\n\n${block("Ship D?")}\n\n${block("Ship E?")}`, reply_to: one.message_id });
    // C answered, the rest skipped by the reply ("Skip them").
    await w.post(`/api/inbox/messages/${two.message_id}/reply`, { idempotency_key: "two", words: "Only C.", skip: [two.questions[1].key, two.questions[2].key], questions: [{ key: two.questions[0].key, revision: 0, answer: answer(two.questions[0], "No") }] });
    const three = await send({ body: `Round three.\n\n${block("Ship F?")}\n\n${block("Ship G?")}\n\n${block("Ship H?")}`, reply_to: two.message_id });
    // F picked, not sent.
    await w.post(`/api/inbox/messages/${three.message_id}/picks`, { questions: [{ key: three.questions[0].key, revision: 0, answer: answer(three.questions[0], "Yes") }] });
    // G replaced by a new question, H withdrawn with nothing in its place (a later message).
    const four = await send({ body: `Round four.\n\n${block("Ship G, revised?")}`, reply_to: three.message_id, supersedes: [`${three.message_id}/${three.questions[1].key}`] });
    await send({ body: "Never mind H.", reply_to: four.message_id, supersedes: [`${three.message_id}/${three.questions[2].key}`] });
    for (let i = 0; i < 8; i++) await send({ body: `Progress ${i}.`, reply_to: four.message_id });
    // A second thread, its open questions closed by the person's Mark read.
    const closed = await send({ body: `Elsewhere.\n\n${block("Ship I?")}`, thread: "closed" });
    await w.post(`/api/inbox/threads/${closed.thread_id}/read`, {});
    return [one.thread_id as string, closed.thread_id as string];
  }

  /** A small deterministic generator (mulberry32), so a failure replays. */
  function random(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("for random windows (limit, before, after, expand) every question is in the result with its state, in the JSON and in the text (after a cursor, every one that changed since)", async () => {
    const w = await world({ setAsideDelayMs: 50 });
    const threadIds = await richThreads(w);
    const store = w.server.store;
    const states = new Set<string>();
    for (const threadId of threadIds) {
      for (const m of store.thread(threadId)!.messages) for (const q of m.questions ?? []) states.add(q.state);
    }
    expect([...states].sort()).toEqual(["closed", "open", "picked", "sent", "superseded"]);
    const next = random(1729);
    for (let run = 0; run < 300; run++) {
      const threadId = threadIds[Math.floor(next() * threadIds.length)]!;
      const messages = store.thread(threadId)!.messages;
      const pick = () => messages[Math.floor(next() * messages.length)]!;
      const input: ThreadReadInput = { limit: 1 + Math.floor(next() * 8) };
      if (next() < 0.4) input.before = next() < 0.5 ? pick().id : store.messageCursor(pick().id)!;
      if (next() < 0.4) input.after = next() < 0.5 ? pick().id : store.messageCursor(pick().id)!;
      if (next() < 0.3) input.expand = [pick().id];
      const { result, order } = windowedThread(store, threadId, input, "http://localhost/#thread");
      const text = windowedThreadText(result, order);
      const found = new Map<string, string>();
      for (const q of result.thread.open_questions) found.set(`${q.message_id}/${q.key}`, q.state);
      for (const m of result.thread.messages) for (const q of m.questions ?? []) found.set(`${m.id}/${q.key}`, q.state);
      for (const line of result.thread.earlier) for (const q of line.questions ?? []) found.set(`${line.id}/${q.key}`, q.state);
      for (const q of result.thread.questions ?? []) found.set(`${q.message_id}/${q.key}`, q.state);
      const after = input.after === undefined ? null : typeof input.after === "number" ? input.after : store.messageCursor(input.after)!;
      const archived = store.archiveSeq(threadId);
      for (const m of messages) {
        for (const q of m.questions ?? []) {
          const context = `${JSON.stringify(input)} ${m.id}/${q.key}`;
          // A read of what is new may leave out a question of an older message only
          // when nothing changed it since the cursor: the reader already has its state.
          const unchangedSinceCursor =
            after !== null &&
            store.messageCursor(m.id)! <= after &&
            q.state !== "open" &&
            q.state !== "picked" &&
            (store.questionLineSeq(`${m.id}/${q.key}`) ?? 0) <= after &&
            !(q.state === "closed" && archived !== null && archived > after);
          if (unchangedSinceCursor && !found.has(`${m.id}/${q.key}`)) continue;
          expect(found.get(`${m.id}/${q.key}`), context).toBe(q.state);
          expect(text.includes(q.key), context).toBe(true);
        }
      }
    }
  });
});

describe("connections render a complete transcript as text alone; an older one still gets the JSON", () => {
  test("marked results (read_thread, its list) hand the model text only; an older connection appends the trimmed JSON, and send_message is unmarked", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 10 });
    const read = await call(w.client, "read_thread", { thread_id: seeded.threadId, agent_session: "ses_long" });
    const list = await call(w.client, "read_thread", { project_path: w.project, agent_session: "ses_long" });
    const replyId = await seeded.answerLast();
    for (const result of [read, list]) {
      expect(result._meta?.[INBOX_TEXT_COMPLETE_META_KEY]).toBe(true);
      expect(inboxToolResultText(result).text).toBe(result.content[0]!.text);
      // An older connection: the same text, then the JSON (trimmed: no sha256s, no idempotency keys).
      const older = olderConnectionText(result);
      expect(older.startsWith(result.content[0]!.text)).toBe(true);
      const json = JSON.parse(older.slice(result.content[0]!.text.length).trim());
      expect(json).toEqual(result.structuredContent);
      expect(older).not.toContain("sent_sha256");
      expect(older).not.toContain("idempotency_key");
    }
    // The list's text names every row's facts.
    const row = list.structuredContent.threads[0];
    expect(list.content[0]!.text).toContain(`- ${row.thread_id} · ${JSON.stringify(row.subject)} · ${row.section} · ${row.message_count} messages`);
    // send_message's questions[].key stays.
    const sent = await call(w.client, "send_message", { reply_to: replyId, body: "Thanks.\n\n:::question\nAnything else?\n\n- [ ] No\n:::", agent_session: "ses_long" });
    expect(sent._meta?.[INBOX_TEXT_COMPLETE_META_KEY]).toBeUndefined();
    expect(sent.structuredContent.questions[0].key).toEqual(expect.any(String));
    expect(inboxToolResultText(sent).text).toContain(`"message_id":"${sent.structuredContent.message_id}"`);
  });
});

describe("search: the agents' read-only search over the Inbox's messages", () => {
  test("finds messages in the caller's project only, unless all_projects; compact rows; refusals", async () => {
    const w = await world();
    const send = async (project: string, body: string, thread: string) =>
      (await call(w.client, "send_message", { project_path: project, body, thread, agent_session: "ses_s", agent_name: "Claude Code" })).structuredContent;
    const a = await send(w.project, "The webhook retries use exponential backoff.", "retries");
    await send(w.project, "Unrelated: the dashboard colours.", "colours");
    const b = await send(w.other, "Web: exponential backoff for the uploader too.", "uploader");
    const reply = await w.post(`/api/inbox/messages/${a.message_id}/reply`, { idempotency_key: "s1", words: "Backoff is fine, ship it." });

    const here = await call(w.client, "search", { query: "backoff", project_path: w.project });
    expect(here._meta?.[INBOX_TEXT_COMPLETE_META_KEY]).toBe(true);
    const rows = here.structuredContent.results as Record<string, any>[];
    expect(rows.map((r) => r.message_id).sort()).toEqual([a.message_id, reply.reply.id].sort());
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["at", "author", "message_id", "snippet", "subject", "thread_id"]);
    expect(rows.find((r) => r.message_id === reply.reply.id)).toMatchObject({ author: "person", thread_id: a.thread_id });
    expect(rows.find((r) => r.message_id === a.message_id)).toMatchObject({ author: "Claude Code", snippet: expect.stringContaining("backoff") });
    expect(here.structuredContent).toMatchObject({ query: "backoff", scope: "api", total: 2 });
    const text = inboxToolResultText(here).text;
    expect(text.split("\n")[0]).toBe('2 messages match "backoff" in api:');
    expect(text).toContain(`- ${a.message_id} in thread ${a.thread_id}`);
    expect(text).not.toContain(b.message_id);

    const everywhere = (await call(w.client, "search", { query: "exponential backoff", all_projects: true })).structuredContent;
    expect(everywhere.results.map((r: any) => r.message_id).sort()).toEqual([a.message_id, b.message_id].sort());
    expect(everywhere.results.find((r: any) => r.message_id === b.message_id).project).toBe("web");
    expect(everywhere.scope).toBe("every project");

    const one = (await call(w.client, "search", { query: "backoff", project_path: w.project, limit: 1 })).structuredContent;
    expect(one.results).toHaveLength(1);
    expect(one.total).toBe(2);
    expect((await call(w.client, "search", { query: "zebra", project_path: w.project })).content[0]!.text).toBe('No message matches "zebra" in api.');
    expect(await refused(w.client, "search", { query: "!!!", project_path: w.project })).toStartWith("validation_error: query:");
    expect(await refused(w.client, "search", { query: "backoff" })).toStartWith("validation_error: project_path:");
  });

  test("a search writes nothing: no store line, no recent search, the reply stays unread", async () => {
    const w = await world();
    const sent = (await call(w.client, "send_message", { project_path: w.project, body: "Which retry budget?", agent_session: "ses_s" })).structuredContent;
    await w.post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "q", words: "A budget of five retries." });
    const cursor = w.server.store.cursor();
    const checked = w.server.store.message(sent.thread_id)!.agent_checked_seq ?? null;
    const found = (await call(w.client, "search", { query: "budget", project_path: w.project })).structuredContent;
    expect(found.total).toBe(2);
    expect(w.server.store.cursor()).toBe(cursor);
    expect(w.server.store.message(sent.thread_id)!.agent_checked_seq ?? null).toBe(checked);
    expect(existsSync(join(w.server.store.dir, INBOX_RECENT_SEARCHES_FILE))).toBe(false);
    const list = (await call(w.client, "read_thread", { project_path: w.project, agent_session: "ses_s" })).structuredContent;
    expect(list.threads[0].unread).toBe(true);
  });
});

describe("a windowed read marks read only what it showed", () => {
  /** An agent asks, the person replies, `count` times; the agent reads; then it asks once more and the person answers. */
  async function rounds(w: Awaited<ReturnType<typeof world>>, count: number) {
    const all: string[] = [];
    let last = "";
    let threadId = "";
    for (let i = 1; i <= count; i++) {
      const sent = (await call(w.client, "send_message", { project_path: w.project, body: `Step ${i}.`, agent_session: "ses_m", ...(last ? { reply_to: last } : {}) })).structuredContent;
      threadId = sent.thread_id;
      all.push(sent.message_id);
      last = (await w.post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: `m${i}`, words: `Reply ${i}.` })).reply.id;
      all.push(last);
    }
    await call(w.client, "read_thread", { thread_id: threadId, agent_session: "ses_m" });
    const ask = (await call(w.client, "send_message", { project_path: w.project, body: "Ship it?", agent_session: "ses_m", reply_to: last })).structuredContent;
    const reply = (await w.post(`/api/inbox/messages/${ask.message_id}/reply`, { idempotency_key: "late", words: "No: the migration is unsafe." })).reply.id as string;
    return { threadId, all, reply };
  }
  const pending = (w: Awaited<ReturnType<typeof world>>) => w.server.store.pendingReplies("ses_m").map((m) => m.id);

  test("before: a newer reply the read left out still wakes its session and stays unread", async () => {
    const w = await world();
    const { threadId, all, reply } = await rounds(w, 4);
    expect(pending(w)).toEqual([reply]);
    const back = await call(w.client, "read_thread", { thread_id: threadId, before: all[2], agent_session: "ses_m" });
    expect(back.content[0]!.text).not.toContain("migration is unsafe");
    expect(pending(w)).toEqual([reply]);
    const list = (await call(w.client, "read_thread", { project_path: w.project, agent_session: "ses_m" })).structuredContent;
    expect(list.threads[0].unread).toBe(true);
    // A read that shows it marks it read.
    await call(w.client, "read_thread", { thread_id: threadId, agent_session: "ses_m" });
    expect(pending(w)).toEqual([]);
  });

  test("a refused read (an expand id not in the thread) marks nothing read", async () => {
    const w = await world();
    const { threadId, reply } = await rounds(w, 1);
    expect(await refused(w.client, "read_thread", { thread_id: threadId, expand: ["msg_01AAAAAAAAAAAAAAAAAAAAAAAA"], agent_session: "ses_m" })).toContain("validation_error");
    expect(pending(w)).toEqual([reply]);
  });

  test("after: a 👍 on a message the read left out is not marked seen", async () => {
    const w = await world({ setAsideDelayMs: 50 });
    const sent = (await call(w.client, "send_message", { project_path: w.project, body: "Done with step 1.", agent_session: "ses_m" })).structuredContent;
    const first = await call(w.client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_m" });
    await w.post(`/api/inbox/messages/${sent.message_id}/ack`, {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(w.server.store.message(sent.message_id)!.ack?.settled_seq).toEqual(expect.any(Number));
    const after = await call(w.client, "read_thread", { thread_id: sent.thread_id, after: first.structuredContent.cursor, agent_session: "ses_m" });
    expect(after.content[0]!.text).not.toContain("👍");
    expect(w.server.store.message(sent.message_id)!.ack?.seen_at ?? null).toBeNull();
    // A read that shows it marks it seen.
    expect((await call(w.client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_m" })).content[0]!.text).toContain("👍");
    expect(w.server.store.message(sent.message_id)!.ack?.seen_at).toEqual(expect.any(String));
  });
});

describe("the review's fixes: answers whole, the answers section cut exactly, the person's newest message whole, after stays small", () => {
  const SKILLS = [
    "**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):",
    "- `release-notes` (cannot be invoked by a model; its instructions are included below at the person's request)",
    "",
    "--- BEGIN SKILL INSTRUCTIONS: release-notes ---",
    "# Release notes",
    "",
    "## Steps",
    "",
    "### 1. Gather the changes",
    "Answer: this line looks like an answer but belongs to the skill.",
    "--- END SKILL INSTRUCTIONS: release-notes ---",
  ].join("\n");
  const FEEDBACK = ["# Feedback on the attached files", "", "## notes.md", "", "### 1. Feedback on:", "> The worker drains the queue", "Say how it drains."].join("\n");

  /** A question answered by a reply that carries `feedback` after its answers section, through the real reply route. */
  async function answered(w: Awaited<ReturnType<typeof world>>, feedback: string, text = "In order") {
    const sent = (await call(w.client, "send_message", { project_path: w.project, body: ":::question-text\nHow does the worker drain?\n:::", agent_session: "ses_r" })).structuredContent;
    const q = sent.questions[0];
    const reply = await w.post(`/api/inbox/messages/${sent.message_id}/reply`, {
      idempotency_key: `r-${feedback.length}-${text.length}-${Math.random()}`,
      words: "Here you go.",
      questions: [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [], text } }],
      ...(feedback ? { feedback } : {}),
    });
    return { sent, replyId: reply.reply.id as string, body: w.server.store.message(reply.reply.id)!.body };
  }

  test("withoutAnswersSection cuts only the answers section: a skills block after it (with # headings in its SKILL.md), or feedback, stays exactly", async () => {
    const w = await world();
    const marker = "[Answers to your questions: left out here; each answer is on its question above, and expand shows this reply as sent]";
    for (const feedback of [SKILLS, FEEDBACK, `${FEEDBACK}\n\n${SKILLS}`, ""]) {
      const { replyId, body } = await answered(w, feedback);
      expect(body).toContain("## Answers to your questions");
      const cut = withoutAnswersSection(w.server.store.messageWire(replyId)!);
      expect(cut).toBe(`Answered 1 question.\n\nHere you go.\n\n${marker}${feedback ? `\n\n${feedback}` : ""}`);
      if (feedback.includes("**Skills referenced**")) expect(splitInboxSkillsBlock(cut)?.skills.map((skill) => skill.name)).toEqual(["release-notes"]);
    }
    // Text that does not follow the section's grammar exactly is never cut.
    const odd = { ...w.server.store.messageWire((await answered(w, "")).replyId)!, body: "My words.\n\n## Answers to your questions\n\nI wrote this heading myself." } as InboxMessageWire;
    expect(withoutAnswersSection(odd)).toBe(odd.body);
  });

  test("withoutAnswersSection cuts a reply's answers on several messages too (one reply for one session), and only that", async () => {
    const w = await world();
    const block = (prompt: string) => `:::question\n${prompt}\n\n- [ ] Yes\n- [ ] No\n:::`;
    const send = async (args: Record<string, unknown>) => (await call(w.client, "send_message", { project_path: w.project, agent_session: "ses_two", agent_name: "Claude Code", ...args })).structuredContent;
    const first = await send({ body: block("Ship A?"), thread: "two-messages" });
    const second = await send({ body: block("Ship B?"), reply_to: first.message_id });
    const answer = (q: { key: string; kind: string; prompt: string }) => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] });
    const reply = await w.post(`/api/inbox/messages/${second.message_id}/reply`, {
      idempotency_key: "both",
      words: "Both.",
      feedback: FEEDBACK,
      questions: [
        { message_id: first.message_id, key: first.questions[0].key, revision: 0, answer: answer(first.questions[0]) },
        { key: second.questions[0].key, revision: 0, answer: answer(second.questions[0]) },
      ],
    });
    const wire = w.server.store.messageWire(reply.reply.id)!;
    expect(wire.body).toContain(`### Your message ${first.message_id}`);
    const marker = "[Answers to your questions: left out here; each answer is on its question above, and expand shows this reply as sent]";
    expect(withoutAnswersSection(wire)).toBe(`Answered 2 questions.\n\nBoth.\n\n${marker}\n\n${FEEDBACK}`);
  });

  test("an answer is shown whole, line breaks kept, however long (4,000 characters), on a one-line message too", async () => {
    const w = await world();
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i}: the worker drains the queue in order, then retries.`).join("\n");
    expect(long.length).toBeGreaterThan(3000);
    expect(long.length).toBeLessThanOrEqual(4000);
    const { sent } = await answered(w, "", long);
    for (let i = 0; i < 8; i++) await call(w.client, "send_message", { reply_to: sent.message_id, body: `Progress ${i}.`, agent_session: "ses_r" });
    const read = await call(w.client, "read_thread", { thread_id: sent.thread_id });
    expect(read.structuredContent.thread.earlier.map((l: any) => l.id)).toContain(sent.message_id);
    expect(read.content[0]!.text).toContain(JSON.stringify(long));
    expect(read.structuredContent.thread.earlier[0].questions[0].answer.text).toBe(long);
  });

  test("the person's newest message is whole even past 16 KB, and one long earlier reply does not fold the older ones into lines", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 3 });
    let last = seeded.lastAgentMessageId;
    const big = `Start.\n${"A long paragraph from the person. ".repeat(700)}\nEnd of what I think.`;
    expect(Buffer.byteLength(big)).toBeGreaterThan(INBOX_BODY_CUT_BYTES);
    const replies: string[] = [];
    for (const words of ["Older reply one.", "Older reply two.", "x".repeat(13 * 1024), "Newer short reply.", big]) {
      const reply = await w.post(`/api/inbox/messages/${last}/reply`, { idempotency_key: `p-${replies.length}`, words });
      replies.push(reply.reply.id);
      for (let i = 0; i < 4; i++) last = (await call(w.client, "send_message", { reply_to: reply.reply.id, body: `Noted ${replies.length}.${i}`, agent_session: "ses_long" })).structuredContent.message_id;
    }
    const { thread, window } = (await call(w.client, "read_thread", { thread_id: seeded.threadId, limit: 2 })).structuredContent;
    const newest = thread.messages.find((m: any) => m.id === replies[4]);
    expect(newest.body).toBe(w.server.store.message(replies[4]!)!.body);
    expect(newest.body_bytes).toBeUndefined();
    const inFull = thread.messages.map((m: any) => m.id);
    // The 13 KB reply does not fit the 12 KB budget; the short ones before and after it still do.
    expect(inFull).toEqual(expect.arrayContaining([replies[0], replies[1], replies[3]]));
    expect(thread.earlier.map((l: any) => l.id)).toContain(replies[2]);
    expect(window).toMatchObject({ newest: 2, expanded: 0 });
  });

  test("after with nothing new stays the same size whether the thread has 60 or 120 messages", async () => {
    const w = await world();
    const sizes: number[] = [];
    for (const rounds of [30, 60]) {
      const project = join(w.root, `after-${rounds}`);
      mkdirSync(project, { recursive: true });
      const seeded = await seedLongThread({ client: w.client, port: w.server.port, project, rounds, session: `ses_a${rounds}` });
      await seeded.answerLast();
      const read = await call(w.client, "read_thread", { thread_id: seeded.threadId });
      const again = await call(w.client, "read_thread", { thread_id: seeded.threadId, after: read.structuredContent.cursor });
      expect(again.structuredContent.thread.messages).toEqual([]);
      expect(again.structuredContent.thread.questions).toBeUndefined();
      sizes.push(bytes(inboxToolResultText(again).text));
    }
    expect(sizes[0]!).toBeLessThan(1500);
    expect(Math.abs(sizes[1]! - sizes[0]!)).toBeLessThan(40);
  });

  test("after a cursor, a question of an older message that changed since (the archive closed it) is listed; unchanged ones are not", async () => {
    const w = await world();
    const sent = (await call(w.client, "send_message", { project_path: w.project, body: ":::question\nShip A?\n\n- [ ] Yes\n- [ ] No\n:::\n\n:::question\nShip B?\n\n- [ ] Yes\n- [ ] No\n:::", agent_session: "ses_c" })).structuredContent;
    const [a] = sent.questions;
    await w.post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "c1", words: "A yes.", questions: [{ key: a.key, revision: 0, answer: { v: 1, key: a.key, kind: a.kind, prompt: a.prompt, selected: ["Yes"] } }] });
    const cursor = (await call(w.client, "read_thread", { thread_id: sent.thread_id })).structuredContent.cursor;
    const quiet = (await call(w.client, "read_thread", { thread_id: sent.thread_id, after: cursor })).structuredContent;
    expect(quiet.thread.questions).toBeUndefined();
    // The thread is archived: both questions close, with no question line, after the cursor.
    await call(w.client, "resolve_message", { message_id: sent.thread_id });
    const after = (await call(w.client, "read_thread", { thread_id: sent.thread_id, after: cursor })).structuredContent;
    expect(after.thread.questions.map((q: any) => [q.key, q.state])).toEqual(sent.questions.map((q: any) => [q.key, "closed"]));
  });

  test("a message addressed to one session says so: to you, or to another session", () => {
    const base = {
      id: "msg_01M5C00000000000000000000A",
      project_id: "prj_x",
      thread_id: "msg_01M5C00000000000000000000B",
      reply_to: null,
      author: { kind: "person" as const },
      subject: null,
      body: "Over to you.",
      created_at: "2026-10-19T12:00:00.000Z",
      resolved_at: null,
      idempotency_key: null,
      to: { host: "claude-code", session: "ses_b" },
    } as InboxMessageWire;
    const context = () => ({ previousId: null, previousDate: null, rootId: base.thread_id });
    expect(agentMessage(base, "window", "ses_b").to).toEqual({ host: "claude-code", session: "ses_b", you: true });
    expect(messageText(agentMessage(base, "window", "ses_b"), context()).split("\n")[0]).toContain(" · to you");
    expect(messageText(agentMessage(base, "window", "ses_a"), context()).split("\n")[0]).toContain(" · to another session (Claude Code ses_b)");
  });

  test("a question-only message's line shows its first prompt; message_id from another thread with thread_id is refused; Shown counts what a range read shows", async () => {
    const w = await world();
    const sent = (await call(w.client, "send_message", { project_path: w.project, body: ":::question\nWhich backoff?\n\n- [ ] Exponential\n- [ ] Fixed\n:::", agent_session: "ses_q" })).structuredContent;
    for (let i = 0; i < 7; i++) await call(w.client, "send_message", { reply_to: sent.message_id, body: `Progress ${i}.`, agent_session: "ses_q" });
    const read = await call(w.client, "read_thread", { thread_id: sent.thread_id });
    expect(read.structuredContent.thread.earlier[0].words).toBe("Which backoff?");
    expect(read.content[0]!.text).not.toContain('":::question"');
    const other = (await call(w.client, "send_message", { project_path: w.project, body: "Elsewhere.", thread: "other", agent_session: "ses_q" })).structuredContent;
    expect(await refused(w.client, "read_thread", { thread_id: sent.thread_id, message_id: other.message_id })).toBe(
      `validation_error: message_id: ${other.message_id} is in thread ${other.thread_id}, not ${sent.thread_id}; pass one of them.`,
    );
    const back = await call(w.client, "read_thread", { thread_id: sent.thread_id, before: sent.message_id, limit: 3 });
    expect(back.structuredContent.window).toMatchObject({ full: 0, newest: 0, lines: 0, left_out: 8 });
    expect(back.content[0]!.text).toContain("Shown: 0 in full (the newest 0) and 0 earlier as one line each.");
  });

  test("search writes nothing for a folder the Inbox has never seen: no project is made, and the answer says why there are no results", async () => {
    const w = await world();
    await call(w.client, "send_message", { project_path: w.project, body: "The backoff is exponential.", agent_session: "ses_s" });
    const fresh = join(w.root, "never-seen");
    mkdirSync(fresh, { recursive: true });
    const projects = w.server.store.listProjects().length;
    const cursor = w.server.store.cursor();
    const found = await call(w.client, "search", { query: "backoff", project_path: fresh });
    expect(found.structuredContent).toMatchObject({ total: 0, results: [] });
    expect(found.content[0]!.text).toStartWith('No message matches "backoff" in ');
    expect(found.content[0]!.text).toContain("No Inbox thread has been written from this folder's project yet; pass all_projects");
    expect(w.server.store.listProjects().length).toBe(projects);
    expect(w.server.store.cursor()).toBe(cursor);
    expect((await call(w.client, "search", { query: "backoff", project_path: fresh, all_projects: true })).structuredContent.total).toBe(1);
  });
});
