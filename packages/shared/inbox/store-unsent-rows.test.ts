/**
 * The Drafts read builds only the rows of threads that may hold unsent work
 * (`InboxStore.unsentRows`, perf study item 4a), not the whole list. Failures
 * to catch: a thread with unsent work missing from Drafts (a reply draft,
 * comments waiting for a Send, a pick, a staged Done or Can't do it, the
 * person's note on an action item the agent saw done), or a row that differs
 * from the list's; and the read building every row again.
 * The reference is the whole list filtered as the Drafts read did before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxHasUnsent, inboxRowArchived, type InboxAuthor, type InboxListRow, type InboxQuestion, type QuestionAnswer } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent = (session: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host: "claude-code", session, name: null });

const BODY = [
  "Release 4.2 is built.",
  "",
  ":::action",
  "Approve the production deploy",
  "Stopped: the release waits on it",
  ":::",
  "",
  ":::question",
  "Announce it?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

const pickFor = (q: InboxQuestion, label: string): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] }) as QuestionAnswer;

/** The Drafts read's rows, before and now: unsent work, not archived, in thread order. */
const draftsOf = (rows: InboxListRow[]) =>
  rows.filter((row) => inboxHasUnsent(row.unsent) && !inboxRowArchived(row)).sort((a, b) => a.thread_id.localeCompare(b.thread_id));

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-unsent-rows-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date("2026-11-02T12:00:00.000Z") });
  const project = store.ensureProject({ name: "web", root: "/work/web" });
  let n = 0;
  const thread = () => store.sendMessage({ project_id: project.id, author: agent(`ses_${++n}`), body: BODY, subject: `Thread ${n}` }).message;
  const question = (messageId: string) => store.questionsOf(messageId).find((q) => q.kind !== "action")!;
  const action = (messageId: string) => store.questionsOf(messageId).find((q) => q.kind === "action")!;
  // Threads with nothing unsent: the bulk of a real Inbox.
  const quiet = Array.from({ length: 30 }, () => thread());

  const draft = thread();
  store.saveReplyDraft(draft.thread_id, { body: "Half a thought" });
  const comment = thread();
  store.saveMessageAnnotation(comment.id, { id: "c-1", type: "COMMENT", originalText: "Release 4.2", text: "Which build?" });
  const picked = thread();
  store.savePicks(picked.id, [{ key: question(picked.id).key, revision: 0, answer: pickFor(question(picked.id), "Yes") }]);
  const staged = thread();
  store.markAction(staged.id, action(staged.id).key, { outcome: "cant", note: "No access.", staged: true });
  const noted = thread();
  store.markAction(noted.id, action(noted.id).key, { outcome: "done", note: "Promoted from the CLI.", staged: true });
  store.sendMessage({ project_id: project.id, author: noted.author as InboxAuthor, body: "Deployed.", reply_to: noted.id, done: [`${noted.id}/${action(noted.id).key}`] });
  // Sent: an answer the reply carried is not unsent work.
  const sent = thread();
  const answer = { key: question(sent.id).key, revision: 0, answer: pickFor(question(sent.id), "No") };
  store.savePicks(sent.id, [answer]);
  store.sendReply(sent.id, { words: "Here.", questions: [{ ...answer, revision: 1 }], idempotency_key: "k-sent" });
  // Picked, then Mark read set it aside: an answer still stored, nothing unsent.
  const setAside = thread();
  store.savePicks(setAside.id, [{ key: question(setAside.id).key, revision: 0, answer: pickFor(question(setAside.id), "Yes") }]);
  store.markRead(setAside.thread_id, true);
  // Archived with a draft: Drafts leaves it out.
  const archived = thread();
  store.saveReplyDraft(archived.thread_id, { body: "Never sent" });
  store.resolveThread(archived.id, true, "person");
  // A draft taken back.
  const dropped = thread();
  store.saveReplyDraft(dropped.thread_id, { body: "Gone" });
  store.deleteReplyDraft(dropped.thread_id);

  return { store, quiet, draft, comment, picked, staged, noted, sent, setAside, archived };
}

describe("unsentRows: the Drafts read's rows without building every row", () => {
  test("the same rows as the whole list filtered, from every kind of unsent work", () => {
    const { store, draft, comment, picked, staged, noted } = world();
    const now = draftsOf(store.unsentRows());
    expect(now).toEqual(draftsOf(store.listRows()));
    expect(now.map((row) => row.thread_id).sort()).toEqual([draft, comment, picked, staged, noted].map((m) => m.thread_id).sort());
  });

  test("still the same after a reload from disk", () => {
    const { store } = world();
    const again = InboxStore.open(store.dir, { now: () => new Date("2026-11-02T12:00:00.000Z") });
    expect(draftsOf(again.unsentRows())).toEqual(draftsOf(again.listRows()));
  });

  test("builds no row for a thread with nothing unsent", () => {
    const { store, quiet } = world();
    const built = new Set<string>();
    const listRow = store.listRow.bind(store);
    store.listRow = (threadId: string) => {
      built.add(threadId);
      return listRow(threadId);
    };
    store.unsentRows();
    for (const message of quiet) expect(built.has(message.thread_id)).toBe(false);
  });
});
