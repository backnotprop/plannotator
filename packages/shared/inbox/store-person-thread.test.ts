/**
 * Threads the person starts (compose): a root person message addressed to one
 * live session. What can regress: the thread becoming some session's default
 * thread, the agent's answer landing elsewhere, the wrong session being handed
 * it, the list placing it wrong, a replay writing twice, and re-addressing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-person-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  return { dir, store, project };
}

const claude = { host: "claude-code", session: "ses_live" };
const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: null });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("a thread the person starts", () => {
  test("is a person root addressed to the session, with a derived subject, in Sent", () => {
    const { store, project } = world();
    const body = "Idea: let the list show which session wrote each thread.\n\n:::question\nNot a question?\n\n- [ ] A\n- [ ] B\n:::";
    const { message, replayed } = store.startPersonThread({ project_id: project.id, body, to: claude, idempotency_key: "k1" });
    expect(replayed).toBe(false);
    expect(message).toMatchObject({ thread_id: message.id, reply_to: null, author: { kind: "person" }, started_by_person: true, to: claude });
    expect(message.subject).toBe("Idea: let the list show which session wrote each thread.");
    // The person's text never becomes question records.
    expect(store.questionsOf(message.id)).toEqual([]);
    const row = store.listRow(message.id)!;
    expect(row).toMatchObject({ section: "sent", unread: false, unseen: 0, waiting_on_person: false, addressee: claude });
  });

  test("is handed only to the addressed session, and its delivery moves it to Quiet", () => {
    const { store, project } = world();
    const { message } = store.startPersonThread({ project_id: project.id, body: "Add a retry budget.", to: claude, idempotency_key: "k" });
    expect(store.pendingReplies("ses_other")).toEqual([]);
    expect(store.pendingReplies("ses_live").map((m) => m.id)).toEqual([message.id]);
    expect(code(() => store.recordDelivery(message.id, { host: "pi", session: "ses_other" }))).toBe("validation_error");
    store.recordDelivery(message.id, claude);
    expect(store.pendingReplies("ses_live")).toEqual([]);
    expect(store.listRow(message.id)!.section).toBe("quiet");
  });

  test("the agent's reply_to answer lands in it; it is never a session's default thread", () => {
    const { store, project } = world();
    // The session already had a default thread of its own.
    const own = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "Working on the relay." });
    const { message } = store.startPersonThread({ project_id: project.id, body: "Add a retry budget.", to: claude, idempotency_key: "k" });
    const answer = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "I'll do it after the relay.", reply_to: message.id });
    expect(answer.message.thread_id).toBe(message.id);
    expect(store.listRow(message.id)!.section).toBe("new");
    // The session's next message without reply_to joins its own default thread, not the person's.
    const next = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "Relay done." });
    expect(next.message.thread_id).toBe(own.message.thread_id);
    // A session with no thread yet starts a new one rather than joining the person's.
    const fresh = store.sendMessage({ project_id: project.id, author: agent("ses_new"), body: "Hello." });
    expect(fresh.message.thread_id).toBe(fresh.message.id);
  });

  test("a replayed key writes nothing; another body under it is refused; a session not live writes nothing", () => {
    const { store, project } = world();
    const first = store.startPersonThread({ project_id: project.id, body: "One", to: claude, idempotency_key: "k" });
    const cursor = store.cursor();
    expect(store.startPersonThread({ project_id: project.id, body: "One", to: null, idempotency_key: "k" })).toMatchObject({ replayed: true, message: { id: first.message.id } });
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "Two", to: claude, idempotency_key: "k" }))).toBe("idempotency_key_reused");
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "Three", to: null, idempotency_key: "k2" }))).toBe("session_not_live");
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "  ", to: claude, idempotency_key: "k3" }))).toBe("validation_error");
    expect(store.cursor()).toBe(cursor);
  });

  test("Send to another session re-addresses the same message until it is delivered, and replays from disk", () => {
    const { dir, store, project } = world();
    const { message } = store.startPersonThread({ project_id: project.id, body: "Rename Quiet?", to: claude, idempotency_key: "k" });
    const pi = { host: "pi", session: "ses_pi" };
    const moved = store.readdressMessage(message.id, pi);
    expect(moved.to).toEqual(pi);
    expect(store.pendingReplies("ses_live")).toEqual([]);
    expect(store.pendingReplies("ses_pi").map((m) => m.id)).toEqual([message.id]);
    expect(store.listRow(message.id)!.addressee).toEqual(pi);
    // The same session again writes nothing.
    const cursor = store.cursor();
    store.readdressMessage(message.id, pi);
    expect(store.cursor()).toBe(cursor);
    expect(code(() => store.readdressMessage(message.id, null))).toBe("session_not_live");
    store.recordDelivery(message.id, pi);
    expect(code(() => store.readdressMessage(message.id, claude))).toBe("already_delivered");
    // An agent's message, or a person reply addressed to nobody, is not re-addressable.
    const asked = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Ship it?" });
    const reply = store.sendReply(asked.message.id, { words: "yes", idempotency_key: "r" });
    expect(code(() => store.readdressMessage(asked.message.id, pi))).toBe("not_addressed");
    expect(code(() => store.readdressMessage(reply.reply.id, pi))).toBe("not_addressed");
    const reopened = InboxStore.open(dir);
    expect(reopened.message(message.id)).toEqual(store.message(message.id));
    expect(reopened.listRows()).toEqual(store.listRows());
  });

  test("lastThreadsBySession names the thread each session last wrote in", () => {
    const { store, project } = world();
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "First thread", subject: "First" });
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Second", thread: "named" });
    const last = store.lastThreadsBySession();
    expect(last.get("ses_a")).toMatchObject({ id: b.message.thread_id, project_id: project.id });
    expect(a.message.thread_id).not.toBe(b.message.thread_id);
  });
});
