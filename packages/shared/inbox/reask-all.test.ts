/**
 * Re-ask all on one thread (reask-all.ts): the thread's own Re-ask to every session there with a question open that
 * can still be woken. What can regress: a note to a session with nothing open, two notes stacked for a session that
 * has not taken the first, a note to a session that cannot be woken, a retry writing again, the action archiving or
 * reading the thread, the note not going to the agent the way a reply goes, or the thread's own Re-ask note gaining
 * the tidy line. And Re-ask all's own rules: the tidy line only for the one agent everything left waits on (archiving
 * closes every question in the thread), the person's unsent picks left as they are and out of the note, a refusal on
 * one session not hiding the notes already written, an archived thread that came back, an agent that named no
 * session, a permission prompt never asked, and the per-message route taking neither rule from a body.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { INBOX_REASK_TIDY_LINE } from "@plannotator/core/inbox-questions";
import { InboxError } from "./schema";
import { InboxStore } from "./store";
import { messageReaskInput, reaskAllReachable, reaskThreadAll } from "./reask-all";

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
    // Two agents wait on the person here: an archive by one would close the other's question, so neither note tidies.
    expect(toA.body).not.toContain(INBOX_REASK_TIDY_LINE);
    expect(toB.body).not.toContain(INBOX_REASK_TIDY_LINE);
    // Byte for byte the thread's own Re-ask note (the ids aside).
    const { store: plain, root: plainRoot } = setup();
    const own = plain.sendReask(plainRoot.id, { idempotency_key: "k1" }).reply;
    expect(toA.body.replaceAll(toA.id, "<note>").replaceAll(root.id, "<asked>")).toBe(own.body.replaceAll(own.id, "<note>").replaceAll(plainRoot.id, "<asked>"));
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
    expect(reaskThreadAll(store, quiet.id, "press1", always)).toEqual({ thread_id: quiet.id, asked: [], unreached: [], failed: [], already: 0 });
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

/** A thread one session asked in (`A`, two questions), and `more` messages after it. */
function alone() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-reask-all-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const root = store.sendMessage({ project_id: project.id, author: A, wakes: true, body: `Two calls.\n\n${block("Backfill the ledger first?")}\n\n${block("Keep the old webhook?")}` }).message;
  return { store, project, root };
}
const pick = (store: InboxStore, messageId: string, index: number) => {
  const q = store.questionsOf(messageId)[index]!;
  store.savePicks(messageId, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } }]);
  return q;
};

describe("Re-ask all's tidy line: only for the one agent everything left waits on", () => {
  test("the only session with anything waiting gets the tidy line", () => {
    const { store, root } = alone();
    reaskThreadAll(store, root.id, "press1", always);
    expect(notes(store, root.id)[0]!.body).toContain(INBOX_REASK_TIDY_LINE);
  });

  test("one session reached and one not: no tidy line (the other's question would close with an archive)", () => {
    const { store, root } = setup();
    reaskThreadAll(store, root.id, "press1", (m) => m.author.kind === "agent" && m.author.session !== "ses_b");
    const [note] = notes(store, root.id);
    expect(note!.reply_to).toBe(root.id);
    expect(note!.body).not.toContain(INBOX_REASK_TIDY_LINE);
  });

  test("another session holding only picks the person has not sent: no tidy line", () => {
    const { store, project, root } = alone();
    const fromB = store.sendMessage({ project_id: project.id, author: B, wakes: true, reply_to: root.id, body: `One more.\n\n${block("Move refunds now?")}` }).message;
    pick(store, fromB.id, 0);
    const result = reaskThreadAll(store, root.id, "press1", always);
    expect(result.asked.map((s) => s.session)).toEqual(["ses_a"]);
    expect(notes(store, root.id)[0]!.body).not.toContain(INBOX_REASK_TIDY_LINE);
  });

  test("another session whose note still waits (asked again already): no tidy line, and it is counted as asked already", () => {
    const { store, root, fromB } = setup();
    store.sendReask(fromB.id, { idempotency_key: "own" });
    const result = reaskThreadAll(store, root.id, "press1", always);
    expect(result.asked.map((s) => s.session)).toEqual(["ses_a"]);
    expect(result.already).toBe(1);
    expect(notes(store, root.id).find((m) => m.reply_to === root.id)!.body).not.toContain(INBOX_REASK_TIDY_LINE);
  });

  test("a pick of its own not sent: no tidy line (an archive would close what the person picked)", () => {
    const { store, root } = alone();
    pick(store, root.id, 0);
    reaskThreadAll(store, root.id, "press1", always);
    expect(notes(store, root.id)[0]!.body).not.toContain(INBOX_REASK_TIDY_LINE);
  });
});

describe("Re-ask all leaves the person's picks as they are", () => {
  test("a pick stays picked and unsent, and the note lists only what has no pick", () => {
    const { store, root } = alone();
    const picked = pick(store, root.id, 0);
    const other = store.questionsOf(root.id)[1]!;
    reaskThreadAll(store, root.id, "press1", always);
    const [note] = notes(store, root.id);
    expect(note!.reask).toEqual([`${root.id}/${other.key}`]);
    expect(note!.body).not.toContain(picked.prompt);
    expect(note!.body).not.toContain("The person answered");
    const now = store.questionsOf(root.id).find((q) => q.key === picked.key)!;
    expect(now.state).toBe("picked");
    expect(now.answer?.selected).toEqual(["Yes"]);
    expect(store.listRow(root.id)!.unsent?.picks).toBe(1);
  });

  test("the thread's own Re-ask still sends its picks with the note", () => {
    const { store, root } = alone();
    const picked = pick(store, root.id, 0);
    store.sendReask(root.id, { idempotency_key: "own" });
    expect(store.questionsOf(root.id).find((q) => q.key === picked.key)!.state).toBe("sent");
  });

  test("a session with only picks gets nothing, and nothing of it is sent", () => {
    const { store, root } = alone();
    pick(store, root.id, 0);
    pick(store, root.id, 1);
    expect(reaskThreadAll(store, root.id, "press1", always)).toMatchObject({ asked: [], unreached: [], failed: [], already: 0 });
    expect(notes(store, root.id)).toEqual([]);
    expect(store.questionsOf(root.id).every((q) => q.state === "picked")).toBe(true);
  });
});

describe("Re-ask all when a note cannot be written", () => {
  test("a refusal on the second session: the first note stands and is answered, the second is counted failed", () => {
    const { store, root } = setup();
    const real = store.sendReask.bind(store);
    let calls = 0;
    store.sendReask = (id, input) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      return real(id, input);
    };
    try {
      const result = reaskThreadAll(store, root.id, "press1", always);
      expect(result.asked).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(notes(store, root.id)).toHaveLength(1);
    } finally {
      store.sendReask = real;
    }
  });

  test("nothing written at all: the refusal is the answer", () => {
    const { store, root } = setup();
    const real = store.sendReask.bind(store);
    store.sendReask = () => {
      throw new Error("disk full");
    };
    try {
      expect(() => reaskThreadAll(store, root.id, "press1", always)).toThrow("disk full");
    } finally {
      store.sendReask = real;
    }
  });
});

describe("Re-ask all's other threads", () => {
  test("an archived thread that came back: only what the agent asked after the archive is asked again", () => {
    const { store, project, root } = alone();
    store.resolveThread(root.id, true, "person");
    expect(reaskThreadAll(store, root.id, "press0", always).asked).toEqual([]);
    const later = store.sendMessage({ project_id: project.id, author: A, wakes: true, reply_to: root.id, body: `New one.\n\n${block("Ship on Friday?")}` }).message;
    const result = reaskThreadAll(store, root.id, "press1", always);
    expect(result.asked.map((s) => s.message_id)).toEqual([later.id]);
    const [note] = notes(store, root.id);
    expect(note!.reask).toEqual(store.questionsOf(later.id).map((q) => `${later.id}/${q.key}`));
  });

  test("an agent that named no session is asked (it reads the thread when it looks)", () => {
    const { store, project } = alone();
    const anon = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: null, name: null }, body: `Hi.\n\n${block("Rename the table?")}` }).message;
    const result = reaskThreadAll(store, anon.id, "press1", (m) => reaskAllReachable(m, anon.id, { gone: () => true, askerLive: () => false, resumes: () => false }));
    expect(result.asked.map((s) => s.message_id)).toEqual([anon.id]);
  });

  test("a thread whose only open item is a launched session's permission prompt: nothing written, nothing counted", () => {
    const { store, project } = alone();
    const prompt = store.sendMessage({ project_id: project.id, author: agent("claude-code", "perm:ses_a"), permission: true, body: block("Claude Code wants to run `ls`") }).message;
    expect(reaskThreadAll(store, prompt.id, "press1", always)).toEqual({ thread_id: prompt.id, asked: [], unreached: [], failed: [], already: 0 });
    expect(notes(store, prompt.id)).toEqual([]);
  });

  test("a second press counts the sessions asked again already", () => {
    const { store, root } = setup();
    reaskThreadAll(store, root.id, "press1", always);
    expect(reaskThreadAll(store, root.id, "press2", always)).toMatchObject({ asked: [], unreached: [], already: 2 });
  });
});

describe("who can be woken (reaskAllReachable)", () => {
  const msg = (session: string | null, wakes?: boolean) => ({ id: "msg_1", author: { kind: "agent", host: "claude-code", session, name: null }, ...(wakes === undefined ? {} : { wakes }) }) as never;
  const wakes = (over: Partial<Parameters<typeof reaskAllReachable>[2]> = {}) => ({ gone: () => false, askerLive: () => false, resumes: () => false, ...over });
  test("no session named, or a session that reads through MCP (not a waking connection): asked", () => {
    expect(reaskAllReachable(msg(null), "msg_t", wakes({ gone: () => true }))).toBe(true);
    expect(reaskAllReachable(msg("ses_mcp"), "msg_t", wakes())).toBe(true);
  });
  test("a waking connection: only while it is live or a launch resumes it; never a session known gone", () => {
    expect(reaskAllReachable(msg("ses_a", true), "msg_t", wakes())).toBe(false);
    expect(reaskAllReachable(msg("ses_a", true), "msg_t", wakes({ askerLive: () => true }))).toBe(true);
    expect(reaskAllReachable(msg("ses_a", true), "msg_t", wakes({ resumes: () => true }))).toBe(true);
    expect(reaskAllReachable(msg("ses_mcp"), "msg_t", wakes({ gone: () => true }))).toBe(false);
  });
});

describe("the per-message Re-ask route's input", () => {
  test("a body's tidy or leave_picks is never taken: the note has no tidy line and its picks go with it", () => {
    const input = messageReaskInput({ idempotency_key: "k1", tidy: true, leave_picks: true }, undefined);
    expect(input).toEqual({ idempotency_key: "k1" });
    const { store, root } = alone();
    const picked = pick(store, root.id, 0);
    const { reply } = store.sendReask(root.id, input);
    expect(reply.body).not.toContain(INBOX_REASK_TIDY_LINE);
    expect(store.questionsOf(root.id).find((q) => q.key === picked.key)!.state).toBe("sent");
  });
});
