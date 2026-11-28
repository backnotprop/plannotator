/**
 * An orchestrator gathers sub-agents' questions into one brief thread and
 * closes out the old threads with resolve_message's `moved_to`, on a real
 * store in a temp dir: what an agent's archive does to a thread with open
 * questions (another session's too), what `moved_to` checks before anything
 * is written, that it writes no message and makes nothing new, and that the
 * old thread still comes back when its own agent writes there again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { inboxArchivedRows, inboxRowArchived } from "./list";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-moved-to-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  return { store: InboxStore.open(dir), dir };
}

const agent = (session: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host: "claude-code", session, name: null });
const SUB = agent("ses_sub");
const ORCH = agent("ses_orch");
const ASK = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

/** A sub-agent's thread with one open question, and the orchestrator's brief that asks it again, in one project. */
function world(store: InboxStore) {
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const old = store.sendMessage({ project_id: project.id, author: SUB, subject: "Retry policy", body: ASK("Retry failed charges?") }).message;
  const brief = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Morning brief", body: ASK("Retry failed charges? (from Retry policy)") }).message;
  return { project, old, brief };
}

function refusal(run: () => unknown): InboxError {
  try {
    run();
  } catch (error) {
    if (error instanceof InboxError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("an agent's archive today (no moved_to)", () => {
  test("archives a thread with its own open questions: no message, questions closed, nothing to deliver, the row leaves the list", () => {
    const { store } = open();
    const { old } = world(store);
    const before = store.thread(old.id)!.messages.length;
    store.resolveThread(old.id, true);
    expect(store.thread(old.id)!.messages.length).toBe(before);
    expect(store.questionsOf(old.id).map((q) => q.state)).toEqual(["closed"]);
    expect(inboxRowArchived(store.listRow(old.id)!)).toBe(true);
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
  });

  test("another session may archive a sub-agent's thread: the store has no caller check", () => {
    const { store } = open();
    const { old } = world(store);
    // resolveThread takes no session at all: whoever calls archives.
    store.resolveThread(old.id, true, "agent");
    expect(store.listRow(old.id)!.resolved_at).not.toBeNull();
    expect(store.questionsOf(old.id)[0]!.state).toBe("closed");
  });

  test("the archived thread stays findable in Settings' Archived list", () => {
    const { store } = open();
    const { old } = world(store);
    store.resolveThread(old.id, true);
    expect(inboxArchivedRows(store.listRows()).map((row) => row.thread_id)).toContain(old.id);
  });
});

describe("resolve_message with moved_to", () => {
  test("archives the old thread pointing at the brief: no message written, questions closed, not new, nothing sent", () => {
    const { store } = open();
    const { old, brief } = world(store);
    const messagesBefore = store.thread(old.id)!.messages.length;
    const unseenBefore = store.listRow(old.id)!.unseen;
    const cursor = store.cursor();
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    // The root's archive line, which carries where the questions went, and the sub-agent's quiet note (below).
    expect(store.cursor()).toBe(cursor + 2);
    expect(store.thread(old.id)!.messages.length).toBe(messagesBefore);
    expect(store.message(old.id)!.moved_to).toEqual({ thread_id: brief.id, subject: "Morning brief" });
    expect(store.questionsOf(old.id).map((q) => q.state)).toEqual(["closed"]);
    const row = store.listRow(old.id)!;
    expect(inboxRowArchived(row)).toBe(true);
    // The row counts no question waiting (the list and Settings' Archived block read this).
    expect(row.questions).toMatchObject({ open: 0, picked: 0 });
    expect(row.unseen).toBe(unseenBefore);
    expect(store.pendingReplies(SUB.session!)).toHaveLength(1);
    expect(store.pendingReplies(ORCH.session!)).toEqual([]);
    // The brief is untouched and still open.
    expect(store.listRow(brief.id)!.resolved_at).toBeNull();
  });

  test("a thread the person looked at stays looked at, where a withdrawal message would make it new", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    // The old way, for contrast: the sub-agent withdraws its question with a message, and the thread is new again.
    const withdrawn = store.sendMessage({ project_id: project.id, author: SUB, subject: "Copy tone", body: ASK("Formal tone?") }).message;
    store.markSeen(withdrawn.id);
    store.sendMessage({ project_id: project.id, author: SUB, body: "Moved to the brief.", reply_to: withdrawn.id, supersedes: [withdrawn.id] });
    expect(store.listRow(withdrawn.id)!.unseen).toBe(1);
    // moved_to: nothing new.
    store.markSeen(old.id);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.listRow(old.id)!.unseen).toBe(0);
  });

  test("takes a message id of the brief and an orchestrator closing out several threads", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    const other = store.sendMessage({ project_id: project.id, author: agent("ses_sub2"), subject: "Refund copy", body: ASK("Say refund or credit?") }).message;
    const followUp = store.sendMessage({ project_id: project.id, author: ORCH, body: ASK("Say refund or credit?"), reply_to: brief.id }).message;
    store.resolveThread(old.id, true, "agent", { to: followUp.id, session: ORCH.session });
    store.resolveThread(other.id, true, "agent", { to: brief.id, session: ORCH.session });
    for (const id of [old.id, other.id]) expect(store.message(id)!.moved_to?.thread_id).toBe(brief.id);
  });

  test("refuses, writing nothing: another project, an archived target, the same thread, a thread the caller never wrote in, no session, an unknown id, resolved false", () => {
    const { store } = open();
    const { old, brief } = world(store);
    const elsewhere = store.ensureProject({ name: "web", root: "/work/web" });
    const foreign = store.sendMessage({ project_id: elsewhere.id, author: ORCH, subject: "Web brief", body: "Notes." }).message;
    const archived = store.sendMessage({ project_id: old.project_id, author: ORCH, subject: "Old brief", body: "Notes." }).message;
    store.resolveThread(archived.id, true);
    const subOwn = store.sendMessage({ project_id: old.project_id, author: SUB, subject: "Sub notes", body: "Notes." }).message;
    const cursor = store.cursor();
    const cases: [{ to: string; session: string | null }, boolean, string][] = [
      [{ to: foreign.id, session: ORCH.session }, true, "validation_error"],
      [{ to: archived.id, session: ORCH.session }, true, "thread_resolved"],
      [{ to: old.id, session: ORCH.session }, true, "validation_error"],
      [{ to: subOwn.id, session: ORCH.session }, true, "validation_error"],
      [{ to: brief.id, session: null }, true, "validation_error"],
      [{ to: brief.id, session: "ses_someone_else" }, true, "validation_error"],
      [{ to: "msg_00000000000000000000000000", session: ORCH.session }, true, "validation_error"],
      [{ to: brief.id, session: ORCH.session }, false, "validation_error"],
    ];
    for (const [movedTo, resolved, code] of cases) {
      const error = refusal(() => store.resolveThread(old.id, resolved, "agent", movedTo));
      expect(error.code).toBe(code);
      expect(error.details.field).toBe("moved_to");
    }
    expect(store.cursor()).toBe(cursor);
    expect(store.message(old.id)!.resolved_at).toBeNull();
    expect(store.questionsOf(old.id)[0]!.state).toBe("open");
  });

  test("on a thread already archived, adds where its questions went without a new archive line", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "person");
    const archiveSeq = store.archiveSeq(old.id);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.message(old.id)!.moved_to?.thread_id).toBe(brief.id);
    expect(store.archiveSeq(old.id)).toBe(archiveSeq);
    // The same call again writes nothing.
    const cursor = store.cursor();
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.cursor()).toBe(cursor);
  });

  test("the old thread comes back when its own agent writes there again; its moved questions stay closed", () => {
    const { store, dir } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    const after = store.sendMessage({ project_id: old.project_id, author: SUB, body: ASK("Also retry refunds?"), reply_to: old.id }).message;
    expect(after.thread_id).toBe(old.id);
    const row = store.listRow(old.id)!;
    expect(row).toMatchObject({ agent_after_archive: true, back_from_archive: true });
    expect(inboxRowArchived(row)).toBe(false);
    expect(store.questionsOf(old.id)[0]!.state).toBe("closed");
    expect(store.questionsOf(after.id)[0]!.state).toBe("open");
    // It came back: where its questions moved no longer applies, and the archived foot reads as any thread's.
    expect(store.message(old.id)!.moved_to ?? null).toBeNull();
    expect(store.messageWire(old.id)!.moved_to ?? null).toBeNull();
    expect(store.archiveSeq(old.id)).not.toBeNull();
    // Derived from the log: a store read again from disk agrees.
    const replay = InboxStore.open(dir);
    expect(replay.listRow(old.id)).toEqual(row);
    expect(replay.message(old.id)!.moved_to ?? null).toBeNull();
  });

  test("a withdrawal into the moved thread that replaces nothing is refused: nothing written, the move and the sub-agent's note stay", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    const cursor = store.cursor();
    const error = refusal(() => store.sendMessage({ project_id: old.project_id, author: SUB, body: "Never mind.", reply_to: old.id, supersedes: [old.id] }));
    expect(error.code).toBe("invalid_supersedes");
    expect(error.message).toBe(`This thread is archived and its questions moved to thread ${brief.id} (Morning brief): nothing you named is open here, so nothing was sent.`);
    expect(store.cursor()).toBe(cursor);
    expect(store.message(old.id)!.moved_to?.thread_id).toBe(brief.id);
    expect(store.pendingReplies(SUB.session!).filter((m) => m.moved_note)).toHaveLength(1);
    const moved = `${old.id}/${store.questionsOf(old.id)[0]!.key}`;
    const again = refusal(() => store.sendMessage({ project_id: old.project_id, author: SUB, body: ASK("Retry failed charges?").replace(":::question\n", `:::question\nReplaces: ${moved}\n`), reply_to: old.id }));
    expect(again.code).toBe("invalid_supersedes");
    expect(store.cursor()).toBe(cursor);
    expect(store.message(old.id)!.moved_to?.thread_id).toBe(brief.id);
  });

  test("Unarchive drops it, and the person's own Archive never sets it", () => {
    const { store, dir } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    store.resolveThread(old.id, false, "person");
    expect(store.message(old.id)!.moved_to ?? null).toBeNull();
    store.resolveThread(old.id, true, "person");
    expect(store.message(old.id)!.moved_to ?? null).toBeNull();
    expect(InboxStore.open(dir).message(old.id)!.moved_to ?? null).toBeNull();
  });

  test("no session is refused as such, not as a thread the caller never wrote in", () => {
    const { store } = open();
    const { old, brief } = world(store);
    for (const session of [null, "  "]) {
      const error = refusal(() => store.resolveThread(old.id, true, "agent", { to: brief.id, session }));
      expect(error.message).toBe("moved_to: needs your session (agent_session). Nothing was archived.");
    }
    expect(store.message(old.id)!.resolved_at).toBeNull();
  });

  test("refuses a thread with no question from the caller: one where it asked nothing would swallow the old questions", () => {
    const { store } = open();
    const { project, old } = world(store);
    const noQuestion = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Notes only", body: "What I did overnight." }).message;
    // Only another session's question there.
    const othersOnly = store.sendMessage({ project_id: project.id, author: SUB, subject: "Sub brief", body: ASK("Sub's question?") }).message;
    store.sendMessage({ project_id: project.id, author: ORCH, body: "Noted.", reply_to: othersOnly.id });
    // The caller's question there was withdrawn: it no longer asks anything.
    const withdrawn = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Withdrawn brief", body: ASK("Ship it?") }).message;
    store.sendMessage({ project_id: project.id, author: ORCH, body: "Never mind.", reply_to: withdrawn.id, supersedes: [withdrawn.id] });
    expect(store.questionsOf(withdrawn.id)[0]!.state).toBe("superseded");
    const cursor = store.cursor();
    for (const target of [noQuestion, othersOnly, withdrawn]) {
      const error = refusal(() => store.resolveThread(old.id, true, "agent", { to: target.id, session: ORCH.session }));
      expect(error.code).toBe("validation_error");
      expect(error.message).toBe(`moved_to: thread ${target.id} has no question from your session; ask the questions there first. Nothing was archived.`);
    }
    expect(store.cursor()).toBe(cursor);
    expect(store.message(old.id)!.resolved_at).toBeNull();
  });

  test("takes a brief the person already answered and sent: they answered it before the close-out", () => {
    const { store } = open();
    const { project, old } = world(store);
    const answered = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Answered brief", body: ASK("Retry failed charges?") }).message;
    const [record] = store.questionsOf(answered.id);
    store.sendReply(answered.id, { idempotency_key: "k-answered", questions: [{ key: record!.key, revision: 0, answer: { v: 1, key: record!.key, kind: "single", prompt: record!.prompt, selected: ["Yes"] } }] });
    expect(store.questionsOf(answered.id)[0]!.state).toBe("sent");
    store.resolveThread(old.id, true, "agent", { to: answered.id, session: ORCH.session });
    expect(store.message(old.id)!.moved_to).toEqual({ thread_id: answered.id, subject: "Answered brief" });
  });

  test("the window's read names the brief as it is now while it is open (its thread name over its subject); archived, only the subject it had", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.messageWire(old.id)!.moved_to).toEqual({ thread_id: brief.id, subject: "Morning brief", open: true, name: "Morning brief" });
    // A brief with a thread name: the window shows that name, as the list does.
    const other = store.sendMessage({ project_id: project.id, author: agent("ses_sub2"), subject: "Refund copy", body: ASK("Say refund or credit?") }).message;
    const named = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Evening brief", thread: "Thursday brief", body: ASK("Say refund or credit?") }).message;
    store.resolveThread(other.id, true, "agent", { to: named.id, session: ORCH.session });
    expect(store.messageWire(other.id)!.moved_to).toEqual({ thread_id: named.id, subject: "Evening brief", open: true, name: "Thursday brief" });
    // Never stored: the log keeps the subject it had.
    expect(store.message(old.id)!.moved_to).toEqual({ thread_id: brief.id, subject: "Morning brief" });
    store.resolveThread(brief.id, true, "person");
    expect(store.messageWire(old.id)!.moved_to).toEqual({ thread_id: brief.id, subject: "Morning brief" });
    expect(store.thread(old.id)!.messages[0]!.moved_to).toEqual({ thread_id: brief.id, subject: "Morning brief" });
  });
});

describe("the Inbox tells the agents whose questions moved, quietly", () => {
  const ANSWER = (record: { key: string; prompt: string }) => ({ v: 1 as const, key: record.key, kind: "single" as const, prompt: record.prompt, selected: ["Yes"] });

  test("a sub-agent waiting there gets one note naming both threads; the caller gets none", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    const [note, ...more] = store.pendingReplies(SUB.session!);
    expect(more).toEqual([]);
    expect(note!.body).toBe(
      `Your questions in "Retry policy" (${old.id}) were moved to another thread by Claude Code: "Morning brief" (${brief.id}). Don't wait on them here. The person answers there, and Claude Code gets the answer.`,
    );
    expect(note).toMatchObject({ author: { kind: "person" }, thread_id: old.id, reply_to: old.id, moved_note: { thread_id: brief.id, questions: [`${old.id}/${store.questionsOf(old.id)[0]!.key}`] } });
    expect(store.pendingReplies(ORCH.session!)).toEqual([]);
  });

  test("nothing for the person: the thread lists no new message, nothing is new or waiting, the row's last word is unchanged", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.markSeen(old.id);
    const listed = store.thread(old.id)!.messages.map((m) => m.id);
    const before = store.listRow(old.id)!;
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.thread(old.id)!.messages.map((m) => m.id)).toEqual(listed);
    expect(store.agentThread(old.id)!.messages.map((m) => m.id)).toEqual(listed);
    const row = store.listRow(old.id)!;
    expect(row.unseen).toBe(0);
    expect(row.message_count).toBe(before.message_count);
    expect(row).toMatchObject({ agent_after_archive: false, back_from_archive: false });
    expect(inboxRowArchived(row)).toBe(true);
  });

  test("a session whose question was answered and sent, or withdrawn, gets none", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    // Another sub-agent whose question the person answered and sent.
    const answeredBy = agent("ses_answered");
    const answered = store.sendMessage({ project_id: project.id, author: answeredBy, body: ASK("Also refunds?"), reply_to: old.id }).message;
    const [record] = store.questionsOf(answered.id);
    store.sendReply(answered.id, { idempotency_key: "k-a", questions: [{ key: record!.key, revision: 0, answer: ANSWER(record!) }] });
    // And one that withdrew its own question.
    const withdrewBy = agent("ses_withdrew");
    const asked = store.sendMessage({ project_id: project.id, author: withdrewBy, body: ASK("Weekly digest?"), reply_to: old.id }).message;
    store.sendMessage({ project_id: project.id, author: withdrewBy, body: "Never mind.", reply_to: asked.id, supersedes: [asked.id] });
    const waitingBefore = (session: string) => store.pendingReplies(session).length;
    const answeredBefore = waitingBefore(answeredBy.session!);
    const withdrewBefore = waitingBefore(withdrewBy.session!);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(waitingBefore(answeredBy.session!)).toBe(answeredBefore);
    expect(waitingBefore(withdrewBy.session!)).toBe(withdrewBefore);
    expect(store.pendingReplies(SUB.session!)).toHaveLength(1);
  });

  test("once per session and thread: a second resolve sends nothing more; a delivered note is never sent again", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    const [note, ...more] = store.pendingReplies(SUB.session!);
    expect(more).toEqual([]);
    store.recordDelivery(note!.id, { host: "claude-code", session: SUB.session! });
    store.resolveThread(old.id, false, "person");
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.threadMessages(old.id).filter((m) => m.moved_note)).toHaveLength(1);
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
  });

  test("a note not delivered yet never comes back with old words: a plain re-archive wakes nobody, a new move tells it afresh", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    // The sub-agent was busy. The person unarchives, then archives the thread again themselves: nobody is woken.
    store.resolveThread(old.id, false, "person");
    store.resolveThread(old.id, true, "person");
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
    // Unarchived again, and the orchestrator moves the question to a second brief: one note, with that brief's words.
    store.resolveThread(old.id, false, "person");
    const brief2 = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Evening brief", body: ASK("Retry failed charges?") }).message;
    store.resolveThread(old.id, true, "agent", { to: brief2.id, session: ORCH.session });
    const [note, ...more] = store.pendingReplies(SUB.session!);
    expect(more).toEqual([]);
    expect(note!.moved_note!.thread_id).toBe(brief2.id);
    expect(note!.body).toContain(`"Evening brief" (${brief2.id})`);
    expect(note!.body).not.toContain(brief.id);
  });

  test("moved again to another brief while still archived: the undelivered note is replaced by one naming the new brief", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    const brief2 = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Evening brief", body: ASK("Retry failed charges?") }).message;
    store.resolveThread(old.id, true, "agent", { to: brief2.id, session: ORCH.session });
    const [note, ...more] = store.pendingReplies(SUB.session!);
    expect(more).toEqual([]);
    expect(note!.moved_note!.thread_id).toBe(brief2.id);
    expect(note!.body).toContain(`"Evening brief" (${brief2.id})`);
  });

  test("the person answered in the old thread after Unarchive: a later move tells the sub-agent nothing", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    store.resolveThread(old.id, false, "person");
    const [record] = store.questionsOf(old.id);
    store.sendReply(old.id, { idempotency_key: "k-here", questions: [{ key: record!.key, revision: record!.revision, answer: ANSWER(record!) }] });
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.pendingReplies(SUB.session!).filter((m) => m.moved_note)).toEqual([]);
  });

  test("nothing later is sent for it: Unarchive or the agent writing again write no note", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    store.resolveThread(old.id, false, "person");
    store.resolveThread(old.id, true, "person");
    store.sendMessage({ project_id: old.project_id, author: SUB, body: "Still here.", reply_to: old.id });
    expect(store.threadMessages(old.id).filter((m) => m.moved_note)).toHaveLength(1);
  });

  test("a refused moved_to sends nothing", () => {
    const { store } = open();
    const { old } = world(store);
    const cursor = store.cursor();
    refusal(() => store.resolveThread(old.id, true, "agent", { to: old.id, session: ORCH.session }));
    refusal(() => store.resolveThread(old.id, true, "agent", { to: "msg_00000000000000000000000000", session: ORCH.session }));
    expect(store.cursor()).toBe(cursor);
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
  });

  /** What read_thread does for `reader`: the window's read (`shown`, the messages it listed) or format "full" (none). */
  const readAs = (store: InboxStore, threadId: string, reader: string, format: "window" | "full") => {
    const shown = format === "window" ? new Set(store.thread(threadId)!.messages.map((m) => m.id)) : undefined;
    store.markAgentChecked(threadId, Number.POSITIVE_INFINITY, undefined, reader);
    store.settleReadPast(threadId, reader, shown);
    store.markAcksSeen(threadId, shown);
    store.recordOwnRead(threadId, reader, shown);
  };

  for (const format of ["window", "full"] as const) {
    test(`another session's read of the old thread (${format}) does not swallow the note: only its wake to the sub-agent settles it`, () => {
      const { store } = open();
      const { project, old, brief } = world(store);
      store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
      // The orchestrator reads the thread it archived, and so does a third session that never wrote there.
      readAs(store, old.id, ORCH.session!, format);
      readAs(store, old.id, "ses_third", format);
      expect(store.pendingReplies(SUB.session!)).toHaveLength(1);
      // Also when the orchestrator wrote in the old thread before (not new to it).
      const { old: old2, brief: brief2 } = world(store);
      store.sendMessage({ project_id: project.id, author: ORCH, body: "Taking these to the brief.", reply_to: old2.id });
      store.resolveThread(old2.id, true, "agent", { to: brief2.id, session: ORCH.session });
      readAs(store, old2.id, ORCH.session!, format);
      const [first, second, ...more] = store.pendingReplies(SUB.session!);
      expect(more).toEqual([]);
      expect([first!.thread_id, second!.thread_id]).toEqual([old.id, old2.id]);
      // The sub-agent's own read does not settle it either: no read shows it.
      readAs(store, old.id, SUB.session!, format);
      expect(store.pendingReplies(SUB.session!)).toHaveLength(2);
      // Delivered to the sub-agent: settled, and never pending again, whoever reads after.
      store.recordDelivery(first!.id, { host: "claude-code", session: SUB.session! });
      store.recordDelivery(second!.id, { host: "claude-code", session: SUB.session! });
      readAs(store, old.id, ORCH.session!, format);
      expect(store.pendingReplies(SUB.session!)).toEqual([]);
      // The caller and the third session never get it.
      expect(store.pendingReplies(ORCH.session!)).toEqual([]);
      expect(store.pendingReplies("ses_third")).toEqual([]);
    });
  }

  test("a note not delivered yet goes stale and is not handed once the person unarchives the thread", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.pendingReplies(SUB.session!)).toHaveLength(1);
    // The sub-agent was busy; the person unarchives the old thread and answers there.
    store.resolveThread(old.id, false, "person");
    const [record] = store.questionsOf(old.id);
    store.sendReply(old.id, { idempotency_key: "k-here", questions: [{ key: record!.key, revision: record!.revision, answer: ANSWER(record!) }] });
    const waiting = store.pendingReplies(SUB.session!);
    expect(waiting.some((m) => m.moved_note)).toBe(false);
    expect(waiting).toHaveLength(1);
  });

  test("a note not delivered yet goes stale once an agent writes in the old thread again (moved_to is dropped)", () => {
    const { store } = open();
    const { old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    store.sendMessage({ project_id: old.project_id, author: agent("ses_helper"), body: "Picking this back up here.", reply_to: old.id });
    expect(store.message(old.id)!.moved_to ?? null).toBeNull();
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
  });

  test("the note is never pushed into a busy turn: auto Send now passes it by, as it does the set-aside note", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    // A plain reply to the same session in another thread is pushed in, so the clock below is due.
    const other = store.sendMessage({ project_id: project.id, author: SUB, subject: "Logs", body: "Logs are in." }).message;
    const reply = store.sendReply(other.id, { idempotency_key: "k-logs", words: "Thanks." }).reply;
    const marked = store.autoSendDue(SUB.session!, { afterMs: 0, clockOf: () => ({ autoSince: 0, since: 0 }) });
    expect(marked.map((m) => m.id)).toEqual([reply.id]);
  });

  test("a plain archive by another session (no moved_to) tells nobody, as before", () => {
    const { store } = open();
    const { old } = world(store);
    store.resolveThread(old.id, true, "agent");
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
  });
});

describe("moved_to's checks, from the final review", () => {
  test("a brief in a project the person combined with this one is taken: the two read as one project", () => {
    const { store } = open();
    const { old } = world(store);
    const clone = store.ensureProject({ name: "billing-checkout", root: "/work/billing-checkout" });
    store.combineProject(clone.id, old.project_id);
    const brief = store.sendMessage({ project_id: clone.id, author: ORCH, subject: "Morning brief", body: ASK("Retry failed charges? (from Retry policy)") }).message;
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.message(old.id)!.moved_to).toEqual({ thread_id: brief.id, subject: "Morning brief" });
  });

  test("an open permission prompt in the old thread gets no note: no wake reaches a perm: session, so it would wait for ever", () => {
    const { store } = open();
    const { project, old, brief } = world(store);
    const perm = agent("perm:ses_sub");
    store.sendMessage({ project_id: project.id, author: perm, reply_to: old.id, permission: true, body: ASK("Claude Code wants to run `ls`") });
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.pendingReplies(perm.session!)).toEqual([]);
    expect(store.pendingReplies(SUB.session!).map((m) => !!m.moved_note)).toEqual([true]);
  });

  test("the brief must hold a question the caller asked after the old thread's open ones: an older thread is refused, asking again there is taken", () => {
    const { store } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const earlier = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Last week's plan", body: ASK("Ship on Friday?") }).message;
    const old = store.sendMessage({ project_id: project.id, author: SUB, subject: "Retry policy", body: ASK("Retry failed charges?") }).message;
    const refused = refusal(() => store.resolveThread(old.id, true, "agent", { to: earlier.id, session: ORCH.session }));
    expect(refused).toMatchObject({ code: "validation_error", details: { field: "moved_to" } });
    expect(refused.message).toStartWith(`moved_to: thread ${earlier.id} has no question from your session asked after this thread's open questions`);
    expect(store.message(old.id)!.resolved_at).toBeNull();
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
    store.sendMessage({ project_id: project.id, author: ORCH, reply_to: earlier.id, body: ASK("Retry failed charges? (from Retry policy)") });
    store.resolveThread(old.id, true, "agent", { to: earlier.id, session: ORCH.session });
    expect(store.message(old.id)!.moved_to?.thread_id).toBe(earlier.id);
  });

  test("the note names the old thread as it names the brief: its thread name over its subject", () => {
    const { store } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const old = store.sendMessage({ project_id: project.id, author: SUB, subject: "Retry policy", thread: "Charge retries", body: ASK("Retry failed charges?") }).message;
    const brief = store.sendMessage({ project_id: project.id, author: ORCH, subject: "Morning brief", thread: "Thursday brief", body: ASK("Retry failed charges?") }).message;
    store.resolveThread(old.id, true, "agent", { to: brief.id, session: ORCH.session });
    expect(store.pendingReplies(SUB.session!)[0]!.body).toStartWith(`Your questions in "Charge retries" (${old.id}) were moved to another thread by Claude Code: "Thursday brief" (${brief.id}).`);
  });
});
