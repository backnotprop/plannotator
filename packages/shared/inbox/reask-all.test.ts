/**
 * Re-ask all on one thread (reask-all.ts): the thread's own Re-ask to every session there with a question open that
 * can still be woken. What can regress: a note to a session with nothing open, two notes stacked for a session that
 * has not taken the first, a note to a session that cannot be woken, a retry writing again, the action archiving or
 * reading the thread, the note not going to the agent the way a reply goes, or the thread's own Re-ask note gaining
 * the tidy line.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { INBOX_REASK_TIDY_LINE } from "@plannotator/core/inbox-questions";
import { InboxError } from "./schema";
import { InboxStore } from "./store";
import { reaskThreadAll } from "./reask-all";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent = (host: string, session: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host, session, name: null });
const A = agent("claude-code", "ses_a");
const B = agent("pi", "ses_b");
const C = agent("codex", "ses_c");
const block = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const always = () => true;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-reask-all-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  // A asks two, B asks one, C only writes.
  const root = store.sendMessage({ project_id: project.id, author: A, wakes: true, body: `Two calls.\n\n${block("Backfill the ledger first?")}\n\n${block("Keep the old webhook?")}` }).message;
  const fromB = store.sendMessage({ project_id: project.id, author: B, wakes: true, reply_to: root.id, body: `One more.\n\n${block("Move refunds now?")}` }).message;
  store.sendMessage({ project_id: project.id, author: C, reply_to: root.id, body: "Tests pass on my side." });
  return { store, project, root, fromB };
}

const notes = (store: InboxStore, threadId: string) => (store.thread(threadId)?.messages ?? []).filter((m) => m.author.kind === "person");

describe("Re-ask all on a thread", () => {
  test("one note per session with a question open, listing only that session's questions; none to a session with nothing open", () => {
    const { store, root, fromB } = setup();
    const result = reaskThreadAll(store, root.id, "press1", always);
    expect(result.asked.map((s) => s.session).sort()).toEqual(["ses_a", "ses_b"]);
    expect(result.unreached).toEqual([]);
    const written = notes(store, root.id);
    expect(written).toHaveLength(2);
    const toA = written.find((m) => m.reply_to === root.id)!;
    const toB = written.find((m) => m.reply_to === fromB.id)!;
    expect(toA.reask).toEqual(store.questionsOf(root.id).map((q) => `${root.id}/${q.key}`));
    expect(toB.reask).toEqual(store.questionsOf(fromB.id).map((q) => `${fromB.id}/${q.key}`));
    // The tidy line rides on Re-ask all's notes.
    expect(toA.body).toContain(INBOX_REASK_TIDY_LINE);
  });

  test("the note goes to the asking agent as a reply goes (its pending items), and nothing comes to the person", () => {
    const { store, root } = setup();
    const before = store.listRow(root.id)!;
    reaskThreadAll(store, root.id, "press1", always);
    const pendingA = store.pendingReplies("ses_a");
    expect(pendingA.some((m) => m.reask && m.reply_to === root.id)).toBe(true);
    expect(store.pendingReplies("ses_c")).toEqual([]);
    const after = store.listRow(root.id)!;
    // Nothing new for the person, nothing archived or read; the questions stay open until the agents replace them.
    expect(after.unseen).toBeLessThanOrEqual(before.unseen);
    expect(after.resolved_at).toBeNull();
    expect(after.read_at ?? null).toBeNull();
    expect(store.questionsOf(root.id).every((q) => q.state === "open")).toBe(true);
    expect(after.reask_pending).toBe(true);
  });

  test("a second press stacks nothing for a session that has not taken the first; a retry of the same press answers the same notes", () => {
    const { store, root } = setup();
    const first = reaskThreadAll(store, root.id, "press1", always);
    const again = reaskThreadAll(store, root.id, "press2", always);
    expect(again.asked).toEqual([]);
    const retry = reaskThreadAll(store, root.id, "press1", always);
    expect(retry.asked.map((s) => s.reply_id).sort()).toEqual(first.asked.map((s) => s.reply_id).sort());
    expect(notes(store, root.id)).toHaveLength(2);
  });

  test("once the agent wrote again, what it still has open can be asked again", () => {
    const { store, project, root } = setup();
    reaskThreadAll(store, root.id, "press1", always);
    const note = notes(store, root.id).find((m) => m.reply_to === root.id)!;
    store.sendMessage({ project_id: project.id, author: A, reply_to: note.id, body: `Still needed.\n\n${block("Ship on Friday?")}` });
    const later = reaskThreadAll(store, root.id, "press2", always);
    expect(later.asked.map((s) => s.session)).toEqual(["ses_a"]);
  });

  test("a session that cannot be woken gets nothing and is counted", () => {
    const { store, root } = setup();
    const result = reaskThreadAll(store, root.id, "press1", (m) => m.author.kind === "agent" && m.author.session !== "ses_b");
    expect(result.asked.map((s) => s.session)).toEqual(["ses_a"]);
    expect(result.unreached).toEqual([{ host: "pi", session: "ses_b" }]);
    expect(notes(store, root.id)).toHaveLength(1);
  });

  test("a thread with no question open is left as it is", () => {
    const { store, project } = setup();
    const quiet = store.sendMessage({ project_id: project.id, author: C, body: "Done with the migration." }).message;
    expect(reaskThreadAll(store, quiet.id, "press1", always)).toEqual({ thread_id: quiet.id, asked: [], unreached: [] });
    expect(notes(store, quiet.id)).toEqual([]);
  });

  test("the thread's own Re-ask note is unchanged: no tidy line", () => {
    const { store, root } = setup();
    const { reply } = store.sendReask(root.id, { idempotency_key: "k1" });
    expect(reply.body).not.toContain(INBOX_REASK_TIDY_LINE);
  });

  test("a bad key or an unknown thread is refused, with nothing written", () => {
    const { store, root } = setup();
    expect(() => reaskThreadAll(store, root.id, "", always)).toThrow(InboxError);
    expect(() => reaskThreadAll(store, root.id, "no spaces", always)).toThrow(InboxError);
    expect(() => reaskThreadAll(store, "msg_nope", "press1", always)).toThrow(InboxError);
    expect(notes(store, root.id)).toEqual([]);
  });
});
