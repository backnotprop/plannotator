/**
 * A reply to a sender nothing can wake: an agent message with no host, not sent through a waking connection (a
 * script's `plannotator inbox call` outside any agent session, the stdio shim outside one, a raw MCP call). The
 * owner hit it on 0.29.0: their reply in a thread a live, idle Claude Code session wrote in said "Saved for An
 * agent. It sees it when it next reads this thread.", the session was never woken, and its read of the thread
 * left the line as it was. The failures these guard:
 *   - the reply owed to a sender nobody is, while the live session that wrote in the thread is never handed it
 *     (`unwakeableReply`'s taker, which the reply route addresses the reply to);
 *   - a session that only read the thread, a session of another project, or a sender that is there now taking it;
 *   - with no such session, the row saying "reads" instead of "ended" (the window's line and choice follow it);
 *   - that live session's read never settling the reply, and the line naming nobody ("Read by Claude Code");
 *   - any reply that already reaches its session (a waking session, an ended one, an MCP agent with a host, a T3
 *     thread, a person-started thread) changing at all.
 * Proved on the Inbox's own pieces (store, live sessions, the sessions route) with no server started; the reply
 * route's own wiring is proved through the server in inbox-ended-reply.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryText } from "@plannotator/core/inbox-delivery-line";
import { INBOX_HOST_NAMES, inboxAgentName, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLiveSessions, INBOX_ASKER_GRACE_MS } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SERVER = "srv-unwakeable";
const T3_THREAD = "0f8fad5b-d9cb-469f-a165-70867728950e";

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-unwakeable-")));
  roots.push(root);
  const projectDir = join(root, "compute-ops");
  const otherDir = join(root, "elsewhere");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const store = InboxStore.open(join(root, "data", "inbox"));
  const project = store.ensureProject({ name: "compute-ops", root: projectDir });
  let offset = 0;
  const live = createInboxLiveSessions({ store, serverSession: SERVER, resolveRoot: async (path) => path, now: () => Date.now() + offset });
  // As the server wires it (inbox.ts `setDeliveryPresence`).
  store.setDeliveryPresence({ connection: live.deliveryConnectionOf, askerLive: live.askerLive, hostOf: live.hostOf, unwakeable: live.unwakeableReply });
  /** A Claude Code session's connection polls, idle, working in `dir` (the project by default). */
  const poll = async (session: string, dir = projectDir, host = "claude-code") => (await live.pollStarted(session, host, { project_path: dir, busy: false }))();
  const agent = (session: string | null, host: string | null = "claude-code"): InboxAuthor => ({ kind: "agent", host, session, name: host ? (INBOX_HOST_NAMES[host] ?? null) : null });
  /** The session's own tool: a waking connection, as the Claude Code mod sends. */
  const tool = (session: string, body: string, reply_to?: string) =>
    store.sendMessage({ project_id: project.id, author: agent(session), body, wakes: true, ...(reply_to ? { reply_to } : {}) }).message;
  /** A sender nothing wakes: `plannotator inbox call send_message` from a shell with no session, or a raw MCP call. */
  const script = (body: string, reply_to: string, session: string | null = null) =>
    store.sendMessage({ project_id: project.id, author: agent(session, null), body, reply_to }).message;
  let keys = 0;
  /**
   * The person's Send with nothing aimed, as the reply route does it: a reply to a sender nothing wakes goes to its
   * taker. (Optional call: before the rule existed, every reply stayed with the session it answers.)
   */
  const reply = (messageId: string, words: string) => {
    const taker = live.unwakeableReply?.(messageId)?.taker ?? undefined;
    return store.sendReply(messageId, { words, idempotency_key: `k${++keys}`, ...(taker ? { to: taker } : {}) }).reply!;
  };
  /** A reply sent while no live session took it: owed to the sender. */
  const leave = (messageId: string, words: string) => store.sendReply(messageId, { words, idempotency_key: `k${++keys}` }).reply!;
  const row = (threadId: string) => store.listRows().find((r) => r.thread_id === threadId)!;
  /** The row's line, in the thread's words. */
  const line = (threadId: string) => {
    const d = row(threadId).delivery!;
    const name = inboxAgentName({ kind: "agent", host: d.host, name: d.name });
    const readBy = d.read_by ? inboxAgentName({ kind: "agent", host: d.read_by }) : null;
    const endedName = inboxAgentName({ kind: "agent", host: d.asking?.host ?? null, name: d.asking?.name ?? null });
    return deliveryText(d.reason, { name, at: d.at, readBy, time: () => "5:12 PM", undeliveredHost: name, endedName });
  };
  /** The thread window's read of where a reply to `messageId` goes (`?answers=`). */
  const answers = async (threadId: string, messageId: string) => {
    const path = `/api/inbox/threads/${threadId}/sessions`;
    const response = await live.route(new Request(`http://127.0.0.1${path}?answers=${messageId}`), path);
    return ((await response!.json()) as { answers?: unknown }).answers;
  };
  /** read_thread by `reader`, as inbox-mcp.ts records it. */
  const read = (threadId: string, reader: string) => {
    store.markAgentChecked(threadId, undefined, undefined, reader);
    store.settleReadPast(threadId, reader);
  };
  return { store, live, poll, tool, script, reply, leave, row, line, answers, read, projectDir, otherDir, later: (ms: number) => void (offset += ms) };
}

describe("a reply to a sender nothing wakes goes to the live session that wrote in the thread", () => {
  test("the owner's sequence: the session wrote with its tool, a script wrote after it, the person replies: the idle session is handed it, and the line names it", async () => {
    const w = world();
    await w.poll("ses-ops");
    const first = w.tool("ses-ops", "The nightly sync is green.");
    const asked = w.script("Disk at 91% on node 3.", first.id);
    const sent = w.reply(asked.id, "Clear the old snapshots.");
    // Its poll hands it (the wake), as a reply to its own message would be; it is never left for the script.
    expect(w.live.pendingOf("ses-ops").map((item) => item.message.id)).toEqual([sent.id]);
    expect(sent.to).toEqual({ host: "claude-code", session: "ses-ops" });
    expect(w.line(first.thread_id)).toBe("Sending to Claude Code…");
    // The window reads the same answer before the Send (`?answers=`), so it names that session too.
    expect(await w.answers(first.thread_id, asked.id)).toEqual({ message_id: asked.id, live: false, taker: { host: "claude-code", session: "ses-ops" } });

    w.store.recordDelivery(sent.id, { host: "claude-code", session: "ses-ops" });
    expect(w.live.pendingOf("ses-ops")).toEqual([]);
    expect(w.line(first.thread_id)).toBe("Delivered to Claude Code, 5:12 PM");
  });

  test("a stdio shim outside a session (its own ses_ id) is the same; while that sender is there, its reply stays its own", async () => {
    const w = world();
    await w.poll("ses-ops");
    const first = w.tool("ses-ops", "Started.");
    const asked = w.script("Check the queue.", first.id, "ses_shim1");
    expect(w.reply(asked.id, "Seen?").to).toEqual({ host: "claude-code", session: "ses-ops" });
    // The shim calls a tool now: it is there, and reads the thread itself.
    w.live.seenOverMcp("ses_shim1");
    expect(w.reply(asked.id, "Done.").to).toBeUndefined();
    expect(w.live.unwakeableReply(asked.id)).toEqual({ live: true, taker: null });
    // Gone past the grace: the live writer takes the next one.
    w.later(INBOX_ASKER_GRACE_MS + 1_000);
    await w.poll("ses-ops");
    expect(w.reply(asked.id, "And again.").to).toEqual({ host: "claude-code", session: "ses-ops" });
  });

  test("only a live session that wrote in the thread, in its project, the latest writer first; never one that only read it", async () => {
    const w = world();
    const first = w.tool("ses-a", "A here.");
    const second = w.tool("ses-b", "B here.", first.id);
    const asked = w.script("Script here.", second.id);
    // Live in the project, but never wrote in the thread: it only read it.
    await w.poll("ses-reader");
    w.read(first.thread_id, "ses-reader");
    // A writer of the thread working in another project: never.
    await w.poll("ses-b", w.otherDir);
    expect(w.reply(asked.id, "One.").to).toBeUndefined();
    await w.poll("ses-a");
    expect(w.reply(asked.id, "Two.").to).toEqual({ host: "claude-code", session: "ses-a" });
    await w.poll("ses-b");
    expect(w.reply(asked.id, "Three.").to).toEqual({ host: "claude-code", session: "ses-b" });
  });

  test("no live session wrote in the thread: the reply waits as one to an ended session does, never 'Saved for An agent. It sees it…'", async () => {
    const w = world();
    const first = w.tool("ses-ops", "Started.");
    const asked = w.script("Disk at 91%.", first.id);
    await w.poll("ses-other");
    const sent = w.reply(asked.id, "Clear it.");
    expect(sent.to).toBeUndefined();
    expect(w.line(first.thread_id)).toBe("Saved for An agent. That session has ended; it gets this only if it's resumed.");
    expect(w.row(first.thread_id).delivery).toMatchObject({ state: "saved", reason: "ended", asking: { host: null, name: null } });
    expect(w.live.pendingOf("ses-other")).toEqual([]);
    expect(await w.answers(first.thread_id, asked.id)).toEqual({ message_id: asked.id, live: false, taker: null });
  });
});

describe("a live session's read settles a reply owed to a sender nothing wakes", () => {
  test("the session that wrote in the thread reads it: settled, and the line says Read by Claude Code", async () => {
    const w = world();
    const first = w.tool("ses-ops", "Started.");
    const asked = w.script("Disk at 91%.", first.id);
    // Sent while nothing was live: owed to the script.
    const sent = w.leave(asked.id, "Clear it.");
    await w.poll("ses-ops");
    expect(w.store.readSettles(sent, "ses-ops")).toBe(true);
    w.read(first.thread_id, "ses-ops");
    expect(w.row(first.thread_id).sent).toMatchObject({ read_by: "claude-code" });
    expect(w.row(first.thread_id).delivery).toMatchObject({ state: "delivered", read_by: "claude-code" });
    expect(w.line(first.thread_id)).toBe("Read by Claude Code, 5:12 PM");
  });

  test("a reader new to the thread is named too; the sender itself back, or a reader the Inbox cannot name, settles nothing new", async () => {
    const w = world();
    const first = w.tool("ses-ops", "Started.");
    const asked = w.script("Check it.", first.id, "ses_shim1");
    w.leave(asked.id, "Checked.");
    // Before: a newcomer settled it, named as nobody ("Delivered to An agent").
    await w.poll("ses-new");
    w.read(first.thread_id, "ses-new");
    expect(w.line(first.thread_id)).toBe("Read by Claude Code, 5:12 PM");

    const again = w.script("And this?", first.id, "ses_shim2");
    const second = w.leave(again.id, "That too.");
    // A reader with no host the Inbox knows, that wrote in the thread (another script): as before, not its to settle.
    expect(w.store.readSettles(second, "ses_shim1")).toBe(false);
    // The sender is there now (its tool call): another session's read leaves it to it.
    w.live.seenOverMcp("ses_shim2");
    await w.poll("ses-ops");
    expect(w.store.readSettles(second, "ses-ops")).toBe(false);
    w.read(first.thread_id, "ses-ops");
    expect(w.row(first.thread_id).delivery?.state).not.toBe("delivered");
  });
});

describe("what already reaches its session does not change", () => {
  test("a reply to a session's own waking message, live or ended, and to a hostless message its own live session sent", async () => {
    const w = world();
    await w.poll("ses-ops");
    await w.poll("ses-other");
    const own = w.tool("ses-ops", "Ready?");
    w.tool("ses-other", "Also here.", own.id);
    const sent = w.reply(own.id, "Yes.");
    expect(sent.to).toBeUndefined();
    expect(w.live.pendingOf("ses-ops").map((item) => item.message.id)).toEqual([sent.id]);
    expect(w.live.pendingOf("ses-other")).toEqual([]);

    // Ended (no poll past the live window): still its own reply, the window's ended choice decides.
    const gone = w.tool("ses-gone", "Still there?", own.id);
    w.later(INBOX_ASKER_GRACE_MS * 2);
    await w.poll("ses-other");
    expect(w.reply(gone.id, "Hello?").to).toBeUndefined();
    expect(w.live.pendingOf("ses-other")).toEqual([]);

    // `inbox call --session ses-other` with no host: that session's own message, and it is live.
    const bare = w.script("From my script.", own.id, "ses-other");
    const toBare = w.reply(bare.id, "Seen.");
    expect(toBare.to).toBeUndefined();
    expect(w.live.pendingOf("ses-other").map((item) => item.message.id)).toEqual([toBare.id]);
  });

  test("an MCP-only agent with a host (its own read settles it, unnamed), and a T3 thread", async () => {
    const w = world();
    await w.poll("ses-ops");
    const first = w.tool("ses-ops", "Started.");
    const cursor = w.store.sendMessage({ project_id: first.project_id, author: { kind: "agent", host: "cursor", session: "ses_cur", name: "Cursor" }, body: "MCP here.", reply_to: first.id }).message;
    const toCursor = w.reply(cursor.id, "Thanks.");
    expect(toCursor.to).toBeUndefined();
    // Its own read settles it, as before; it is never handed to the Claude Code session.
    expect(w.live.pendingOf("ses-ops")).toEqual([]);
    w.read(first.thread_id, "ses_cur");
    expect(w.row(first.thread_id).delivery).toMatchObject({ state: "delivered" });
    expect(w.row(first.thread_id).delivery?.read_by).toBeUndefined();

    const t3 = w.store.sendMessage({ project_id: first.project_id, author: { kind: "agent", host: "t3", session: T3_THREAD, name: "T3 Code" }, body: "T3 here.", reply_to: first.id }).message;
    expect(w.reply(t3.id, "Go on.").to).toBeUndefined();
    expect(w.live.pendingOf("ses-ops")).toEqual([]);
  });
});
