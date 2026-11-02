/**
 * The window reads its open thread again only for records that can change it
 * (packages/inbox/openThreadReads.ts). This runs every kind of write on a
 * running Inbox (temp data dir, loopback), reads the open thread as the
 * window does (`GET /api/inbox/threads/:id`) before and after, and takes the
 * records the event stream sent for it. Failures to catch: a write that
 * changes the open thread's read while its records map to "not this thread"
 * (the window would keep the old thread on screen): a reply to it from
 * elsewhere, a pick, a comment, a look or Mark read from another window, a
 * 👍, a project rename or combine, a new project that changes its label; and
 * a write with no record (a snooze, a pin, a draft, a card, a deletion of
 * another thread) that changes the thread's read, which no record would
 * carry. The other way: another thread's records reading the open one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxQuestion, QuestionAnswer } from "@plannotator/core/inbox-types";
import type { InboxEvent } from "../inbox/api";
import { newRecordBatch, noteRecord, openThreadRead, type OpenThreadRead } from "../inbox/openThreadReads";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent = (session: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host: "claude-code", session, name: null });

const ASKS = ["Which layout?", "", ":::question", "Cards or a table?", "", "- [ ] Cards", "- [ ] Table", ":::"].join("\n");

const pickFor = (q: InboxQuestion, label: string): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] }) as QuestionAnswer;

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-open-reads-")));
  roots.push(root);
  for (const folder of ["web", "api", "elsewhere/web"]) mkdirSync(join(root, folder), { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, setAsideDelayMs: 60_000 });
  servers.push(server);
  const store = server.store;
  const web = store.ensureProject({ name: "web", root: join(root, "web") });
  const api = store.ensureProject({ name: "api", root: join(root, "api") });
  const open = store.sendMessage({ project_id: web.id, author: agent("ses_open"), body: ASKS, subject: "The open thread" }).message;
  const other = store.sendMessage({ project_id: web.id, author: agent("ses_other"), body: ASKS, subject: "Another thread" }).message;
  const elsewhere = store.sendMessage({ project_id: api.id, author: agent("ses_api"), body: "Built.", subject: "In another project" }).message;
  return { root, server, store, web, api, open, other, elsewhere };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;

/** The open thread as the window reads it: the thread (what the pane draws) and its own row. */
async function windowRead(server: InboxServer, threadId: string): Promise<{ thread: string; row: string }> {
  const body = (await (await fetch(url(server, `/api/inbox/threads/${threadId}`))).json()) as { thread: unknown; row: unknown };
  return { thread: JSON.stringify(body.thread), row: JSON.stringify(body.row) };
}

/** The records the event stream sends after `cursor`, as a window receives them. */
async function recordsSince(server: InboxServer, cursor: number): Promise<InboxEvent[]> {
  const target = server.store.cursor();
  if (target <= cursor) return [];
  const controller = new AbortController();
  const stream = await fetch(url(server, `/api/inbox/events?cursor=${cursor}`), { signal: controller.signal });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  const out: InboxEvent[] = [];
  let text = "";
  let last = cursor;
  const deadline = Date.now() + 3000;
  try {
    while (last < target && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
      if (chunk?.value) text += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = text.indexOf("\n\n")) >= 0) {
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        if (!/^event: record$/m.test(frame)) continue;
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        const id = Number(/^id: (\d+)$/m.exec(frame)?.[1]);
        if (data) out.push(JSON.parse(data) as InboxEvent);
        if (Number.isFinite(id)) last = Math.max(last, id);
      }
    }
  } finally {
    controller.abort();
  }
  expect(last).toBe(target);
  return out;
}

/** What the window decides for these records, with the open thread read, listed and its repo known (the case it skips in). */
function decide(records: InboxEvent[], threadId: string): OpenThreadRead {
  const batch = newRecordBatch();
  for (const record of records) noteRecord(batch, record);
  return openThreadRead(batch, { threadId, remote: false, loaded: { thread_id: threadId, project: { repo: { display: "acme/web", host: "github.com" } } }, settled: true, listed: true });
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * Run one write; the thread read must not change unless its records read the thread. `expected`: what the window
 * decides (`none`: the write sends no record at all, so only its own frame's read follows, as before).
 */
async function write(s: Setup, act: () => unknown, expected: OpenThreadRead | "none") {
  const threadId = s.open.thread_id;
  const before = await windowRead(s.server, threadId);
  const cursor = s.server.store.cursor();
  await act();
  const records = await recordsSince(s.server, cursor);
  const after = await windowRead(s.server, threadId);
  const changed = after.thread !== before.thread;
  if (records.length === 0) {
    expect(expected).toBe("none");
    // No record: nothing the pane draws may change, since no record would carry it.
    expect(changed).toBe(false);
    return { records, changed, rowChanged: after.row !== before.row };
  }
  const read = decide(records, threadId);
  if (changed) expect(read).toBe("thread");
  expect(read).toBe(expected as OpenThreadRead);
  return { records, changed, rowChanged: after.row !== before.row };
}

describe("every write that changes the open thread reads it; another thread's writes do not", () => {
  test("messages: an agent's reply to the open thread from another session, a person's reply from another window; the same in another thread", async () => {
    const s = await setup();
    expect((await write(s, () => s.store.sendMessage({ project_id: s.web.id, author: agent("ses_third"), body: "Here is more.", reply_to: s.other.id }), "files")).changed).toBe(false);
    expect((await write(s, () => s.store.sendMessage({ project_id: s.api.id, author: agent("ses_third"), body: "Answering here.", reply_to: s.open.id }), "thread")).changed).toBe(true);
    expect((await write(s, () => s.store.sendReply(s.open.id, { words: "Thanks.", idempotency_key: "k-open" }), "thread")).changed).toBe(true);
    expect((await write(s, () => s.store.sendReply(s.other.id, { words: "Thanks.", idempotency_key: "k-other" }), "files")).changed).toBe(false);
  });

  test("questions and comments: picks and a comment saved in another window, on the open thread and on another", async () => {
    const s = await setup();
    const q = (messageId: string) => s.store.questionsOf(messageId)[0]!;
    await write(s, () => s.store.savePicks(s.other.id, [{ key: q(s.other.id).key, revision: 0, answer: pickFor(q(s.other.id), "Cards") }]), "files");
    expect((await write(s, () => s.store.savePicks(s.open.id, [{ key: q(s.open.id).key, revision: 0, answer: pickFor(q(s.open.id), "Table") }]), "thread")).changed).toBe(true);
    const comment = (id: string) => ({ id, type: "COMMENT", originalText: "Which layout", text: "Cards, please." });
    await write(s, () => s.store.saveMessageAnnotation(s.other.id, comment("c-other")), "files");
    // The thread read counts a comment only once a reply carries it; its record still reads the thread (the pane's files and comments).
    await write(s, () => s.store.saveMessageAnnotation(s.open.id, comment("c-open")), "thread");
  });

  test("read state synced from another window: a look, Mark read, Mark unread and a 👍 on the open thread; Mark read on another", async () => {
    const s = await setup();
    await write(s, () => s.store.markRead(s.other.id, true), "files");
    await write(s, () => s.store.markSeen(s.open.thread_id), "thread");
    expect((await write(s, () => s.store.markRead(s.open.thread_id, true), "thread")).changed).toBe(true);
    await write(s, () => s.store.markUnread(s.open.thread_id), "thread");
    const latest = s.store.sendMessage({ project_id: s.web.id, author: agent("ses_open"), body: "Done.", reply_to: s.open.id }).message;
    expect((await write(s, () => s.store.ackMessage(latest.id, true), "thread")).changed).toBe(true);
  });

  test("projects: a new project with the same folder name, a rename of it or of another, a combine; every project record reads the thread", async () => {
    const s = await setup();
    // The open thread's label now tells two folders named web apart.
    expect((await write(s, () => s.store.ensureProject({ name: "web", root: join(s.root, "elsewhere/web") }), "thread")).changed).toBe(true);
    expect((await write(s, () => s.store.renameProject(s.web.id, "Website"), "thread")).changed).toBe(true);
    await write(s, () => s.store.renameProject(s.api.id, "Backend"), "thread");
    await write(s, () => s.store.combineProject(s.api.id, s.web.id), "thread");
    // Combined the other way: the open thread's project goes into another, and its header reads that one's name.
    await write(s, () => s.store.combineProject(s.api.id, null), "thread");
    expect((await write(s, () => s.store.combineProject(s.web.id, s.api.id), "thread")).changed).toBe(true);
  });

  test("archive: another thread's archive does not read it; its own does", async () => {
    const s = await setup();
    await write(s, () => s.store.resolveThread(s.other.id, true, "person"), "files");
    expect((await write(s, () => s.store.resolveThread(s.open.id, true, "person"), "thread")).changed).toBe(true);
  });

  test("writes with no record leave the thread's read as it was: a snooze and its end, a pin, a reply draft, another thread deleted", async () => {
    const s = await setup();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    // The row changes (its snooze); the window reads it from the list, which `event: snoozes` reads again, as before.
    expect((await write(s, () => s.store.setSnooze(s.open.thread_id, until), "none")).rowChanged).toBe(true);
    await write(s, () => s.store.clearSnooze(s.open.thread_id), "none");
    await write(s, () => s.store.setPinned(s.open.thread_id, true), "none");
    await write(s, () => s.store.saveReplyDraft(s.open.thread_id, { body: "Half a thought" }), "none");
    await write(s, () => s.store.deleteThread(s.elsewhere.id), "none");
  });

  test("a Board card naming the open thread: card records only (the window hands them to the Board), the thread's read unchanged", async () => {
    const s = await setup();
    const cursor = s.server.store.cursor();
    const before = await windowRead(s.server, s.open.thread_id);
    s.store.createCard({ project_id: s.web.id, by: agent("ses_open"), title: "Layout", threads: [s.open.id] });
    const records = await recordsSince(s.server, cursor);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.kind === "card")).toBe(true);
    expect((await windowRead(s.server, s.open.thread_id)).thread).toBe(before.thread);
  });

  test("a question record names its message's thread", async () => {
    const s = await setup();
    const q = s.store.questionsOf(s.other.id)[0]!;
    const cursor = s.server.store.cursor();
    s.store.savePicks(s.other.id, [{ key: q.key, revision: 0, answer: pickFor(q, "Cards") }]);
    const records = await recordsSince(s.server, cursor);
    expect(records.filter((r) => r.kind === "question").map((r) => (r as { thread_id?: string | null }).thread_id)).toEqual([s.other.thread_id]);
  });
});
