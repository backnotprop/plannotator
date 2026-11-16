/**
 * A reply to a session the Inbox's own wake can still reach later stays owed to
 * it when another agent reads the thread first (issue #3339). A T3 thread's
 * message stored without `wakes` (sent before `plannotator t3 login`, under a
 * lapsed grant, while T3 was closed, under a mode the grant does not cover) is
 * still sent by the T3 wake once a grant reaches the thread; a cloud agent's
 * (paired without a wake address, which is set later) by the cloud wake. Both
 * ids are the same on every read, so a reader new to the thread is another
 * agent, never the recipient under a new id. Until the wake finds the session
 * gone: then the reply settles for a reader new to the thread, as before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { T3_THREAD_ID_FORMS } from "../../../tests/helpers/fake-t3";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-owed-late-wake-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  return { store, project: store.ensureProject({ name: "ledger", root: "/work/ledger" }) };
}

const agent = (host: string, session: string | null): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host, session, name: null });

/** An agent's message (no `wakes`), the person's plain reply to it, then a read of the thread as read_thread does it. */
function askedAndAnswered(store: InboxStore, projectId: string, author: Extract<InboxAuthor, { kind: "agent" }>) {
  const asked = store.sendMessage({ project_id: projectId, author, body: "Anyone there?" }).message;
  const reply = store.sendReply(asked.id, { words: "Here.", idempotency_key: `r-${asked.id}` }).reply;
  return { asked, reply };
}

function reads(store: InboxStore, threadId: string, reader: string | null) {
  store.markAgentChecked(threadId, Number.POSITIVE_INFINITY, undefined, reader);
  store.settleReadPast(threadId, reader);
}

const T3 = T3_THREAD_ID_FORMS.app;
const CLOUD = "cloud.0123456789ab";

describe("a reply the Inbox's own wake can still send", () => {
  test("a T3 thread's message without wakes: another agent's read leaves the reply waiting for the thread", () => {
    const { store, project } = open();
    const { asked, reply } = askedAndAnswered(store, project.id, agent("t3", T3));
    expect(store.readSettles(reply, "ses_another_reader")).toBe(false);
    reads(store, asked.thread_id, "ses_another_reader");
    expect(store.message(reply.id)?.delivery).toBeUndefined();
    expect(store.pendingReplies(T3).map((m) => m.id)).toEqual([reply.id]);
    // A read that names no session does not take it either.
    reads(store, asked.thread_id, null);
    expect(store.pendingReplies(T3).map((m) => m.id)).toEqual([reply.id]);
    // The thread's own read settles it.
    reads(store, asked.thread_id, T3);
    expect(store.pendingReplies(T3)).toEqual([]);
  });

  test("every form of id T3 gives a thread", () => {
    const { store, project } = open();
    for (const [form, id] of Object.entries(T3_THREAD_ID_FORMS)) {
      const { asked, reply } = askedAndAnswered(store, project.id, agent("t3", id));
      reads(store, asked.thread_id, "ses_another_reader");
      expect([form, store.pendingReplies(id).map((m) => m.id)]).toEqual([form, [reply.id]]);
    }
  });

  test("a paired cloud agent's message without wakes: another agent's read leaves the reply waiting for it", () => {
    const { store, project } = open();
    const { asked, reply } = askedAndAnswered(store, project.id, agent("cloud-claude", CLOUD));
    reads(store, asked.thread_id, "ses_another_reader");
    expect(store.message(reply.id)?.delivery).toBeUndefined();
    expect(store.pendingRepliesFor(new Set([CLOUD])).get(CLOUD)?.map((m) => m.id)).toEqual([reply.id]);
    reads(store, asked.thread_id, CLOUD);
    expect(store.pendingReplies(CLOUD)).toEqual([]);
  });

  test("once its wake found the session gone, a reader new to the thread settles the reply, as before", () => {
    const { store, project } = open();
    const t3 = askedAndAnswered(store, project.id, agent("t3", T3));
    const cloud = askedAndAnswered(store, project.id, agent("cloud-claude", CLOUD));
    const gone = new Set<string>();
    store.setDeliveryPresence({ connection: () => null, askerLive: () => false, wakeGone: (session) => gone.has(session) });
    reads(store, t3.asked.thread_id, "ses_another_reader");
    reads(store, cloud.asked.thread_id, "ses_another_reader");
    expect(store.pendingReplies(T3).map((m) => m.id)).toEqual([t3.reply.id]);
    expect(store.pendingReplies(CLOUD).map((m) => m.id)).toEqual([cloud.reply.id]);
    gone.add(T3).add(CLOUD);
    expect(store.readSettles(store.message(t3.reply.id)!, "ses_another_reader")).toBe(true);
    reads(store, t3.asked.thread_id, "ses_another_reader");
    reads(store, cloud.asked.thread_id, "ses_another_reader");
    expect(store.pendingReplies(T3)).toEqual([]);
    expect(store.pendingReplies(CLOUD)).toEqual([]);
  });
});

describe("what no wake of the Inbox can send stays as it was", () => {
  test("a raw MCP client restarted under a new shim id, or a read that names none: its read settles the reply", () => {
    const { store, project } = open();
    const restarted = askedAndAnswered(store, project.id, agent("cursor", "ses_shim_one"));
    reads(store, restarted.asked.thread_id, "ses_shim_two");
    expect(store.pendingReplies("ses_shim_one")).toEqual([]);
    const unnamed = askedAndAnswered(store, project.id, agent("cursor", "ses-script"));
    reads(store, unnamed.asked.thread_id, null);
    expect(store.pendingReplies("ses-script")).toEqual([]);
  });

  test("a T3 or cloud id under another host, and a cloud host under another id: a reader new to the thread settles it", () => {
    const { store, project } = open();
    for (const author of [agent("cursor", T3), agent("cursor", CLOUD), agent("cloud-claude", "ses_shim_one")]) {
      const { asked } = askedAndAnswered(store, project.id, author);
      reads(store, asked.thread_id, "ses_another_reader");
      expect([author, store.pendingReplies(author.session!)]).toEqual([author, []]);
    }
  });

  test("a message that promised a wake stays owed to its session, gone or not", () => {
    const { store, project } = open();
    store.setDeliveryPresence({ connection: () => null, askerLive: () => false, wakeGone: () => true });
    for (const author of [agent("t3", T3), agent("cursor", "ses_shim_one")]) {
      const asked = store.sendMessage({ project_id: project.id, author, body: "Ship it?", wakes: true }).message;
      const reply = store.sendReply(asked.id, { words: "Yes.", idempotency_key: `w-${author.session}` }).reply;
      reads(store, asked.thread_id, "ses_another_reader");
      expect(store.pendingReplies(author.session!).map((m) => m.id)).toEqual([reply.id]);
    }
  });
});
