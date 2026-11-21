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
    // One line only: the root's archive line, which carries where the questions went.
    expect(store.cursor()).toBe(cursor + 1);
    expect(store.thread(old.id)!.messages.length).toBe(messagesBefore);
    expect(store.message(old.id)!.moved_to).toEqual({ thread_id: brief.id, subject: "Morning brief" });
    expect(store.questionsOf(old.id).map((q) => q.state)).toEqual(["closed"]);
    const row = store.listRow(old.id)!;
    expect(inboxRowArchived(row)).toBe(true);
    // The row counts no question waiting (the list and Settings' Archived block read this).
    expect(row.questions).toMatchObject({ open: 0, picked: 0 });
    expect(row.unseen).toBe(unseenBefore);
    expect(store.pendingReplies(SUB.session!)).toEqual([]);
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
    expect(store.message(old.id)!.moved_to?.thread_id).toBe(brief.id);
    // Derived from the log: a store read again from disk agrees.
    const replay = InboxStore.open(dir);
    expect(replay.listRow(old.id)).toEqual(row);
    expect(replay.message(old.id)!.moved_to).toEqual(store.message(old.id)!.moved_to);
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
});
