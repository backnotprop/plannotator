/**
 * Re-ask in the Inbox store (approval "inbox-reask"): the person asks the
 * session that asked for its open questions again, in one message. The note
 * is the person's reply (append-only, one line), picks not sent go with it
 * as answers, the row sits in Sent until the agent asks again, and the
 * agent's new message replaces the old cards.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";
import { inboxSearchReplyText } from "./search";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const B: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_b", name: null };

const block = (prompt: string, extra: string[] = []) => [":::question", prompt, "", ...extra, "- [ ] Yes", "- [ ] No", ":::"].join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-reask-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const first = store.sendMessage({ project_id: project.id, author: A, body: `Two calls.\n\n${block("Backfill ledger first?")}\n\n${block("Keep the old webhook?")}` }).message;
  const second = store.sendMessage({ project_id: project.id, author: A, reply_to: first.id, body: `One more.\n\n${block("Move refunds now?")}` }).message;
  return { store, dir, project, first, second };
}

const sectionOf = (store: InboxStore, threadId: string) => store.listRow(threadId)?.section;
const qs = (store: InboxStore, id: string) => store.questionsOf(id) as InboxQuestion[];

describe("Re-ask", () => {
  test("asks for every open question of the session, across its messages, in one note that is the person's reply", () => {
    const { store, first, second } = setup();
    expect(sectionOf(store, first.id)).toBe("waiting");
    const { reply, replayed } = store.sendReask(second.id, { idempotency_key: "k1" });
    expect(replayed).toBe(false);
    const ids = [...qs(store, first.id), ...qs(store, second.id)].map((q) => `${q.message_id}/${q.key}`);
    expect(reply.reask).toEqual(ids);
    expect(reply.author.kind).toBe("person");
    expect(reply.reply_to).toBe(second.id);
    // The body tells the agent what to do with each id, and where to answer.
    for (const id of ids) expect(reply.body).toContain(`- ${id}: `);
    expect(reply.body).toContain("`Replaces: <id>`");
    expect(reply.body).toContain("`supersedes`");
    expect(reply.body).toContain(`reply_to ${reply.id}`);
    // The old questions stay open until the agent replaces them.
    expect([...qs(store, first.id), ...qs(store, second.id)].every((q) => q.state === "open")).toBe(true);
    // Rule 1: the row is in Sent while the note is the last message, read or not.
    expect(store.listRow(first.id)?.reask_pending).toBe(true);
    expect(sectionOf(store, first.id)).toBe("sent");
    store.recordDelivery(reply.id, { host: "claude-code", session: "ses_a" });
    expect(sectionOf(store, first.id)).toBe("sent");
  });

  test("one open question: a note of its own, worded in the singular", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-reask-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const only = store.sendMessage({ project_id: project.id, author: A, body: `One call.\n\n${block("Backfill ledger first?")}` }).message;
    const { reply } = store.sendReask(only.id, { idempotency_key: "k1" });
    const [q] = qs(store, only.id);
    expect(reply.reask).toEqual([`${only.id}/${q!.key}`]);
    expect(reply.body.split("\n")[0]).toBe("Please ask your open question in this thread again, in one new message, so the person can answer it in one place.");
    expect(reply.body).toContain("Check it against where the work is now:");
    expect(reply.body).toContain("the old question stays open for the person.");
    expect(reply.body).not.toMatch(/\b1 open question|questions stay|together/);
    expect(sectionOf(store, only.id)).toBe("sent");
  });

  test("picks not sent go with the note as answers; only the rest are asked again", () => {
    const { store, first, second } = setup();
    const [q1] = qs(store, first.id) as [InboxQuestion];
    store.savePicks(first.id, [{ key: q1.key, revision: q1.revision, answer: { v: 1, key: q1.key, kind: q1.kind, prompt: q1.prompt, selected: ["Yes"] } }]);
    const { reply } = store.sendReask(second.id, { idempotency_key: "k1" });
    expect(reply.reask).not.toContain(`${first.id}/${q1.key}`);
    expect(reply.reask).toHaveLength(2);
    const sent = qs(store, first.id).find((q) => q.key === q1.key)!;
    expect(sent.state).toBe("sent");
    expect(sent.sent_reply_id).toBe(reply.id);
    expect(reply.body).toContain("The person answered one more question with this note");
    expect(reply.body).toContain("## Answers to your questions");
    expect(reply.body).toContain(`### Backfill ledger first? (${first.id}/${q1.key})`);
    expect(reply.body).toContain("Answer: Yes");
  });

  test("the agent's new message replaces the old cards, and the row leaves Sent", () => {
    const { store, project, first, second } = setup();
    const { reply } = store.sendReask(second.id, { idempotency_key: "k1" });
    const [a1, a2] = reply.reask!;
    const dropped = reply.reask![2]!;
    const answer = store.sendMessage({
      project_id: project.id,
      author: A,
      reply_to: reply.id,
      supersedes: [dropped],
      body: `Here they are.\n\n${block("Backfill ledger first?", [`Replaces: ${a1}`, ""])}\n\n${block("Keep the old webhook?", [`Replaces: ${a2}`, ""])}`,
    }).message;
    const old = [...qs(store, first.id), ...qs(store, second.id)];
    expect(old.every((q) => q.state === "superseded")).toBe(true);
    expect(old.find((q) => `${q.message_id}/${q.key}` === dropped)!.superseded_by).toEqual({ message_id: answer.id, key: null });
    expect(old.find((q) => `${q.message_id}/${q.key}` === a1)!.superseded_by?.key).toBe(qs(store, answer.id)[0]!.key);
    expect(store.listRow(first.id)?.reask_pending).toBe(false);
    expect(sectionOf(store, first.id)).toBe("waiting");
  });

  test("one note per session: another session's questions are not in it", () => {
    const { store, project, first, second } = setup();
    const pi = store.sendMessage({ project_id: project.id, author: B, reply_to: first.id, body: block("Pin the Node version?") }).message;
    const forA = store.sendReask(second.id, { idempotency_key: "a" }).reply;
    expect(forA.reask).toHaveLength(3);
    expect(forA.reask!.some((id) => id.startsWith(pi.id))).toBe(false);
    const forB = store.sendReask(pi.id, { idempotency_key: "b" }).reply;
    expect(forB.reask).toEqual([`${pi.id}/${qs(store, pi.id)[0]!.key}`]);
  });

  test("refusals: nothing left open, a person's message, an archived thread, a reused key; a replay writes nothing", () => {
    const { store, first, second } = setup();
    const once = store.sendReask(second.id, { idempotency_key: "k1" });
    const again = store.sendReask(second.id, { idempotency_key: "k1" });
    expect(again.replayed).toBe(true);
    expect(again.reply.id).toBe(once.reply.id);
    expect(store.thread(first.id)!.messages).toHaveLength(3);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as InboxError).code;
      }
      return null;
    };
    expect(code(() => store.sendReask(once.reply.id, { idempotency_key: "k2" }))).toBe("validation_error");
    // A reply's key cannot be replayed as a Re-ask.
    store.sendReply(second.id, { idempotency_key: "r1", words: "Thinking about it." });
    expect(code(() => store.sendReask(second.id, { idempotency_key: "r1" }))).toBe("idempotency_key_reused");
    expect(code(() => store.sendReask(second.id, { idempotency_key: "k3", to: null }))).toBe("session_not_live");
    // Every question answered: nothing to ask again.
    for (const m of [first, second]) {
      for (const q of qs(store, m.id)) store.savePicks(m.id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["No"] } }]);
    }
    store.sendReply(second.id, { idempotency_key: "r2", words: "", questions: qs(store, second.id).map((q) => ({ key: q.key, revision: q.revision })) });
    store.sendReply(first.id, { idempotency_key: "r3", words: "", questions: qs(store, first.id).map((q) => ({ key: q.key, revision: q.revision })) });
    expect(code(() => store.sendReask(second.id, { idempotency_key: "k4" }))).toBe("nothing_to_reask");
    store.resolveThread(first.id, true);
    expect(code(() => store.sendReask(second.id, { idempotency_key: "k5" }))).toBe("thread_resolved");
  });

  test("a replay of the store reads the note and its picks as written", () => {
    const { store, dir, first, second } = setup();
    const [q1] = qs(store, first.id) as [InboxQuestion];
    store.savePicks(first.id, [{ key: q1.key, revision: q1.revision, answer: { v: 1, key: q1.key, kind: q1.kind, prompt: q1.prompt, selected: ["Yes"] } }]);
    const { reply } = store.sendReask(second.id, { idempotency_key: "k1" });
    const again = InboxStore.open(dir);
    expect(again.message(reply.id)?.reask).toEqual(reply.reask);
    expect(again.questionsOf(first.id).find((q) => q.key === q1.key)?.state).toBe("sent");
    expect(again.listRow(first.id)?.section).toBe("sent");
  });

  test("several sessions: Sent while every open question is in a note that waits; one session's answer leaves its own open questions on the person", () => {
    const { store, project, first, second } = setup();
    const pi = store.sendMessage({ project_id: project.id, author: B, reply_to: first.id, body: `${block("Pin the Node version?")}\n\n${block("Drop Node 18?")}` }).message;
    const forA = store.sendReask(second.id, { idempotency_key: "a" }).reply;
    // Only A's questions are in a note: B's are still the person's to answer.
    expect(sectionOf(store, first.id)).toBe("waiting");
    store.sendReask(pi.id, { idempotency_key: "b" });
    expect(sectionOf(store, first.id)).toBe("sent");
    // A answers with one question and replaces nothing: its old questions are no longer in a waiting note.
    store.sendMessage({ project_id: project.id, author: A, reply_to: forA.id, body: block("Backfill ledger first, today?") });
    expect(store.listRow(first.id)?.reask_pending).toBe(false);
    expect(sectionOf(store, first.id)).toBe("waiting");
  });

  test("the reviewer's case: never stuck in Sent when the noted session does not write", () => {
    const { store, project, first, second } = setup();
    store.sendReask(second.id, { idempotency_key: "k1" });
    expect(sectionOf(store, first.id)).toBe("sent");
    // B asks a Stopped question: it waits on the person.
    const stop = store.sendMessage({ project_id: project.id, author: B, reply_to: second.id, body: [":::question", "Which region first?", "", "Stopped: the deploy waits.", "", "- [ ] East", "- [ ] West", ":::"].join("\n") }).message;
    const row = store.listRow(first.id)!;
    expect(row.section).toBe("stopped");
    expect(row.unread).toBe(true);
    // The person replies in words to B: B's question is still open and in no note.
    store.sendReply(stop.id, { idempotency_key: "w1", words: "Looking into it." });
    expect(sectionOf(store, first.id)).toBe("stopped");
    // B supersedes every question A asked (and its own): nothing the note lists is open, so it no longer waits.
    store.sendMessage({ project_id: project.id, author: B, reply_to: stop.id, supersedes: [first.id, second.id, stop.id], body: "Settled in the session; none of these apply." });
    const after = store.listRow(first.id)!;
    expect(after.reask_pending).toBe(false);
    expect(after.section).not.toBe("sent");
  });

  test("sent to another session because the asker ended: the note names whose questions they are, and only that session's answer ends Sent", () => {
    const { store, project, second } = setup();
    const C: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_c", name: null };
    const { reply } = store.sendReask(second.id, { idempotency_key: "k1", to: { host: "claude-code", session: "ses_c" } });
    expect(reply.to).toEqual({ host: "claude-code", session: "ses_c" });
    expect(reply.body.startsWith("Please ask the 3 open questions Claude Code asked in this thread again")).toBe(true);
    expect(reply.body).not.toContain("your 3 open questions");
    // The ended session writing does not end it; the session it went to does.
    store.sendMessage({ project_id: project.id, author: A, reply_to: second.id, body: "late" });
    expect(store.listRow(second.thread_id)?.reask_pending).toBe(true);
    store.sendMessage({ project_id: project.id, author: C, reply_to: reply.id, body: block("Backfill ledger first?") });
    expect(store.listRow(second.thread_id)?.reask_pending).toBe(false);
  });

  test("search indexes the person's own words only: a note's instructions and the prompts it lists are not", () => {
    const { store, second } = setup();
    const { reply } = store.sendReask(second.id, { idempotency_key: "k1" });
    expect(inboxSearchReplyText(reply.body, reply)).toBe("");
    expect(inboxSearchReplyText("Ship it tomorrow.", { reask: [] })).toContain("Ship it tomorrow");
  });
});
