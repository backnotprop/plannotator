/**
 * A script's post does not steal the thread. The owner hit it on 0.29.0: a live, idle Claude Code session wrote in a
 * thread with its tool, a script (`plannotator inbox call` from a shell that names no session) posted after it, and
 * the person's plain reply went to the script: "Saved for An agent. It sees it when it next reads this thread.", the
 * session never woken, its read settling nothing. A sessionless send is stored with no session, no host and no wake;
 * the window's plain reply passes over it to the latest agent message that has a session, and from there everything
 * is the Inbox's usual handling of a reply to that message. The failures these guard:
 *   - the reply left for the script while the session that wrote is live (and its poll never handing it);
 *   - the session that wrote having ended, and the reply not following that session's ended flow;
 *   - a sender with a session id and no host (a stdio shim's `ses_…` agent: Cursor, Gemini CLI…) treated as a
 *     script: its reply handed to the Claude Code session, or settled by that session's read so its `unread` goes;
 *   - a thread no session wrote in changing at all.
 * Proved on the Inbox's own pieces (store, live sessions) and the window's own choice (`sendTargetsOf`) with no server
 * started; the reply route and the wake are proved through the server in inbox-ended-reply.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryText } from "@plannotator/core/inbox-delivery-line";
import { INBOX_HOST_NAMES, inboxAgentName, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { sendTargetsOf } from "../inbox/sendTargets";
import { createInboxLiveSessions, INBOX_ASKER_RESTART_GRACE_MS } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-sessionless-")));
  roots.push(root);
  const projectDir = join(root, "compute-ops");
  mkdirSync(projectDir, { recursive: true });
  const store = InboxStore.open(join(root, "data", "inbox"));
  const project = store.ensureProject({ name: "compute-ops", root: projectDir });
  let offset = 0;
  const live = createInboxLiveSessions({ store, serverSession: "srv-sessionless", resolveRoot: async (path) => path, now: () => Date.now() + offset });
  // As the server wires it (inbox.ts `setDeliveryPresence`).
  store.setDeliveryPresence({ connection: live.deliveryConnectionOf, askerLive: live.askerLive, hostOf: live.hostOf });
  /** A Claude Code session's connection polls, idle, working in the project. */
  const poll = async (session: string) => (await live.pollStarted(session, "claude-code", { project_path: projectDir, busy: false }))();
  const agent = (session: string | null, host: string | null = "claude-code"): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host, session, name: host ? (INBOX_HOST_NAMES[host] ?? null) : null });
  /** The session's own tool: a waking connection, as the Claude Code mod sends. */
  const tool = (session: string, body: string, reply_to?: string) =>
    store.sendMessage({ project_id: project.id, author: agent(session), body, wakes: true, ...(reply_to ? { reply_to } : {}) }).message;
  /** `plannotator inbox call send_message` from a shell that names no session; with `session`, a stdio shim's `ses_` agent with no host. */
  const script = (body: string, reply_to?: string, session: string | null = null) =>
    store.sendMessage({ project_id: project.id, author: agent(session, null), body, ...(reply_to ? { reply_to } : {}) }).message;
  let keys = 0;
  /** The person's plain Send, words only: to the message the window's own rule picks, with nothing aimed. */
  const reply = (threadId: string, words: string) => {
    const target = sendTargetsOf(store.thread(threadId)!).at(-1)!.message;
    return store.sendReply(target.id, { words, idempotency_key: `k${++keys}` }).reply!;
  };
  const row = (threadId: string) => store.listRows().find((r) => r.thread_id === threadId)!;
  /** The row's line, in the thread's words. */
  const line = (threadId: string) => {
    const d = row(threadId).delivery!;
    const name = inboxAgentName({ kind: "agent", host: d.host, name: d.name });
    const readBy = d.read_by ? inboxAgentName({ kind: "agent", host: d.read_by }) : null;
    const endedName = inboxAgentName({ kind: "agent", host: d.asking?.host ?? null, name: d.asking?.name ?? null });
    return deliveryText(d.reason, { name, at: d.at, readBy, time: () => "5:12 PM", undeliveredHost: name, endedName });
  };
  /** read_thread by `reader`, as inbox-mcp.ts records it. */
  const read = (threadId: string, reader: string) => {
    store.markAgentChecked(threadId, undefined, undefined, reader);
    store.settleReadPast(threadId, reader);
  };
  return { store, live, poll, tool, script, reply, row, line, read, later: (ms: number) => void (offset += ms) };
}

describe("a script's post does not steal the thread", () => {
  test("the owner's sequence: the session wrote with its tool, a script posted after it, the person replies: the idle session's poll hands it, as a reply to its own message, and the line names it", async () => {
    const w = world();
    await w.poll("ses-ops");
    const first = w.tool("ses-ops", "The nightly sync is green.");
    w.script("Disk at 91% on node 3.", first.id);
    const sent = w.reply(first.thread_id, "Clear the old snapshots.");
    expect(sent.reply_to).toBe(first.id);
    expect(sent.to).toBeUndefined();
    expect(w.live.pendingOf("ses-ops").map((item) => item.message.id)).toEqual([sent.id]);
    expect(w.line(first.thread_id)).toBe("Sending to Claude Code…");

    w.store.recordDelivery(sent.id, { host: "claude-code", session: "ses-ops" });
    expect(w.live.pendingOf("ses-ops")).toEqual([]);
    expect(w.line(first.thread_id)).toBe("Delivered to Claude Code, 5:12 PM");
  });

  test("the session that wrote has ended: the reply is that session's, and the row and line are its ended ones", async () => {
    const w = world();
    const first = w.tool("ses-ops", "The nightly sync is green.");
    w.script("Disk at 91% on node 3.", first.id);
    // Past the Inbox's own restart grace, with no poll from that session.
    w.later(INBOX_ASKER_RESTART_GRACE_MS + 1_000);
    await w.poll("ses-other");
    expect(w.row(first.thread_id).session_ended).toBe(true);
    const sent = w.reply(first.thread_id, "Clear the old snapshots.");
    expect(sent.reply_to).toBe(first.id);
    expect(w.line(first.thread_id)).toBe("Saved for Claude Code. That session has ended; it gets this only if it's resumed.");
    expect(w.live.pendingOf("ses-other")).toEqual([]);
  });

  test("a stdio shim's agent (a ses_ id, no host) asks and goes quiet while a Claude Code session that wrote is live: the reply stays the agent's, unread for it, and Claude Code gets nothing", async () => {
    const w = world();
    await w.poll("ses-ops");
    const first = w.tool("ses-ops", "Started.");
    const asked = w.script("Which queue should I drain first?", first.id, "ses_shim1");
    w.later(2 * 60_000);
    await w.poll("ses-ops");
    const sent = w.reply(first.thread_id, "The billing queue.");
    expect(sent.reply_to).toBe(asked.id);
    expect(sent.to).toBeUndefined();
    expect(w.live.pendingOf("ses-ops")).toEqual([]);
    // Claude Code reads the thread: the reply is not its to settle.
    expect(w.store.readSettles(sent, "ses-ops")).toBe(false);
    w.read(first.thread_id, "ses-ops");
    const kept = w.store.thread(first.thread_id)!.messages.find((m) => m.id === sent.id)!;
    expect(kept.delivery ?? null).toBeNull();
    expect(kept.to ?? null).toBeNull();
    // The agent's own read_thread still counts it as unread for it (inbox-mcp.ts personFacts).
    expect(w.store.readSettles(sent, "ses_shim1")).toBe(true);
  });

  test("an agent's shell the CLI names (Gemini CLI: a name, no session, no host) asks while the session that wrote is live: the reply is owed to it, as on main", async () => {
    const w = world();
    await w.poll("ses-ops");
    const first = w.tool("ses-ops", "Started.");
    const asked = w.store.sendMessage({ project_id: first.project_id, author: { kind: "agent", host: null, session: null, name: "Gemini CLI" }, body: "Which queue should I drain first?", reply_to: first.id }).message;
    const sent = w.reply(first.thread_id, "The billing queue.");
    expect(sent.reply_to).toBe(asked.id);
    expect(sent.to).toBeUndefined();
    expect(w.live.pendingOf("ses-ops")).toEqual([]);
  });

  test("the script's action item marked Done in the draft while the session that wrote has ended: the row's mark agrees with the Send (the script's, so no Session ended)", async () => {
    const w = world();
    const first = w.tool("ses-ops", "The nightly sync is green.");
    const posted = w.script(":::action\nRotate the disk on node 3\nStopped: the cleanup\n:::", first.id);
    const action = w.store.questionsOf(posted.id).find((q) => q.kind === "action")!;
    w.later(INBOX_ASKER_RESTART_GRACE_MS + 1_000);
    await w.poll("ses-other");
    // Unmarked: the words would go to the ended session, and the row says so.
    expect(w.row(first.thread_id).session_ended).toBe(true);
    w.store.markAction(posted.id, action.key, { outcome: "done", staged: true });
    // Marked: the Send's reply is the script's (sendTargets.test.ts proves the window's side), and the row agrees.
    expect(w.row(first.thread_id).session_ended).toBeUndefined();
  });

  test("the person answers the script's own question after the session that wrote ended: the reply is the script's, and its line says so, never that session's ended line", async () => {
    const w = world();
    const first = w.tool("ses-ops", "The nightly sync is green.");
    const posted = w.script(":::question\nRotate the disk on node 3 now?\n\n- [ ] Yes\n- [ ] No\n:::", first.id);
    w.later(INBOX_ASKER_RESTART_GRACE_MS + 1_000);
    await w.poll("ses-other");
    const q = w.store.questionsOf(posted.id)[0]!;
    w.store.savePicks(posted.id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["Yes"] } }]);
    const sent = w.store.sendReply(posted.id, { idempotency_key: "k-pick", words: "Go ahead.", questions: [{ key: q.key, revision: q.revision + 1 }] }).reply!;
    expect(sent.reply_to).toBe(posted.id);
    expect(w.row(first.thread_id).delivery).toMatchObject({ state: "saved", reason: "reads" });
    expect(w.line(first.thread_id)).toBe("Saved for An agent. It sees it when it next reads this thread.");
  });

  test("no script: a routine's change line last, its session ended: the row's mark is that session's, as the Send's words are", async () => {
    const w = world();
    const first = w.tool("ses-ops", "Set up the nightly sync.");
    w.store.sendMessage({ project_id: first.project_id, author: { kind: "agent", host: "claude-code", session: "ses-ops", name: "Claude Code" }, body: "Made routine nightly.", reply_to: first.id, scheduled_change: { scheduled_id: "sch_1", name: "nightly", op: "create" } } as Parameters<InboxStore["sendMessage"]>[0]);
    expect(sendTargetsOf(w.store.thread(first.thread_id)!).at(-1)!.message.id).toBe(first.id);
    w.later(INBOX_ASKER_RESTART_GRACE_MS + 1_000);
    await w.poll("ses-other");
    expect(w.row(first.thread_id).session_ended).toBe(true);
  });

  test("a thread only a script wrote in: the reply is the script's and its line is as before, while a session is live in the project", async () => {
    const w = world();
    await w.poll("ses-ops");
    const root = w.script("Disk at 91% on node 3.");
    const sent = w.reply(root.thread_id, "Clear it.");
    expect(sent.reply_to).toBe(root.id);
    expect(sent.to).toBeUndefined();
    expect(w.live.pendingOf("ses-ops")).toEqual([]);
    expect(w.line(root.thread_id)).toBe("Saved for An agent. It sees it when it next reads this thread.");
  });
});
