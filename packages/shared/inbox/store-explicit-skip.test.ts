import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import type { InboxAuthor, InboxMessage, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const B: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_b", name: null };

const question = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const asking = (...prompts: string[]) => prompts.map(question).join("\n\n");

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-explicit-skip-"));
  roots.push(dir);
  let tick = Date.parse("2026-10-21T15:56:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date((tick += 1000)) });
  const project = store.ensureProject({ name: "plannotator", root: "/work/plannotator" });
  return { store, project };
}

function ownersThread() {
  const { store, project } = open();
  const root = store.sendMessage({ project_id: project.id, author: A, body: asking("Build #1057 as shown?", "Keep the old toolbar?", "Ship behind a flag?", "Add a setting?") }).message;
  const messages: InboxMessage[] = [root];
  for (const prompt of ["Merge New chat (#2046)?", "Merge Code Font (#855)?", "Merge Enter saves (#2048)?", "Merge the five outside PRs?", "Merge Live versions (#2049)?", "Merge N / Shift+N (#1550)?", "Upload the new install scripts now?"]) {
    messages.push(store.sendMessage({ project_id: project.id, author: A, reply_to: root.id, body: question(prompt) }).message);
  }
  return { store, project, root, messages };
}

const pick = (q: InboxQuestion, label = "Yes"): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] });
const allStates = (store: InboxStore, messages: readonly InboxMessage[]) => messages.flatMap((m) => store.questionsOf(m.id).map((q) => q.state));

describe("the owner's case", () => {
  test("answer 1 of 11 and Send: one reply, the other 10 stay open, and the reply says 10", () => {
    const { store, messages } = ownersThread();
    const last = messages.at(-1)!;
    const q = store.questionsOf(last.id)[0]!;
    const result = store.sendReply(last.id, { idempotency_key: "k-1", questions: [{ key: q.key, revision: 0, answer: pick(q, "Yes") }] });
    const replies = store.thread(messages[0]!.id)!.messages.filter((m) => m.author.kind === "person");
    expect(replies).toHaveLength(1);
    expect(allStates(store, messages).filter((s) => s === "open")).toHaveLength(10);
    expect(allStates(store, messages).filter((s) => s === "sent")).toHaveLength(1);
    const parts = result.reply.body.split("\n\n");
    expect(parts[0]).toBe("Answered 1 question.");
    expect(parts[1]).toBe("You have 10 other questions open in this thread. They stay open; the person will answer them in the Inbox. Don't re-ask them.");
    expect(result.reply.body).not.toContain("Skipped");
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([result.reply.id]);
  });

  test("answers on 3 of the session's messages: exactly one reply (one wake), each answer under its message's id", () => {
    const { store, messages } = ownersThread();
    const [first, second, last] = [messages[0]!, messages[1]!, messages.at(-1)!];
    const q1 = store.questionsOf(first.id)[2]!;
    const q2 = store.questionsOf(second.id)[0]!;
    const q3 = store.questionsOf(last.id)[0]!;
    store.savePicks(first.id, [{ key: q1.key, revision: 0, answer: pick(q1, "No") }]);
    store.savePicks(second.id, [{ key: q2.key, revision: 0, answer: pick(q2) }]);
    store.savePicks(last.id, [{ key: q3.key, revision: 0, answer: pick(q3) }]);
    const result = store.sendReply(last.id, {
      idempotency_key: "k-1",
      words: "Go.",
      questions: [
        { message_id: first.id, key: q1.key, revision: 1 },
        { message_id: second.id, key: q2.key, revision: 1 },
        { key: q3.key, revision: 1 },
      ],
    });
    expect(store.pendingReplies("ses_a")).toHaveLength(1);
    expect(result.reply.reply_to).toBe(last.id);
    const body = result.reply.body;
    const parts = body.split("\n\n");
    expect(parts[0]).toBe("Answered 3 questions.");
    expect(parts[1]).toBe("Go.");
    expect(parts[2]).toBe("You have 8 other questions open in this thread. They stay open; the person will answer them in the Inbox. Don't re-ask them.");
    expect(body).toContain("## Answers to your questions");
    const at = [first, second, last].map((m) => body.indexOf(`### Your message ${m.id}`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(body).toContain(`### Your message ${first.id}\n\n1 of 4 questions answered.\n\n#### Q3. Ship behind a flag? (line 16)\nAnswer: No`);
    for (const [m, q] of [[first, q1], [second, q2], [last, q3]] as const) {
      expect(store.questionsOf(m.id).find((x) => x.key === q.key)).toMatchObject({ state: "sent", sent_reply_id: result.reply.id });
    }
    const again = store.sendReply(last.id, { idempotency_key: "k-1", questions: [] });
    expect(again).toMatchObject({ replayed: true, reply: { id: result.reply.id } });
    expect(store.thread(first.id)!.messages.filter((m) => m.author.kind === "person")).toHaveLength(1);
  });

  test("Skip them across messages: only the listed questions are skipped, in the same one reply", () => {
    const { store, messages } = ownersThread();
    const [first, second, last] = [messages[0]!, messages[1]!, messages.at(-1)!];
    const firstQs = store.questionsOf(first.id);
    const q3 = store.questionsOf(last.id)[0]!;
    const result = store.sendReply(last.id, {
      idempotency_key: "k-1",
      questions: [{ key: q3.key, revision: 0, answer: pick(q3) }],
      skip: [...firstQs.map((q) => ({ message_id: first.id, key: q.key })), { message_id: second.id, key: store.questionsOf(second.id)[0]!.key }],
    });
    expect(result.reply.body.split("\n\n")[0]).toBe("Answered 1 question, skipped 5.");
    expect(result.reply.body).toContain("You have 5 other questions open in this thread.");
    expect(store.questionsOf(first.id).every((q) => q.state === "sent" && q.answer?.skipped && q.answer.by_reply)).toBe(true);
    expect(allStates(store, messages).filter((s) => s === "open")).toHaveLength(5);
    expect(store.pendingReplies("ses_a")).toHaveLength(1);
  });

  test("a question that lands after the person pressed Skip them is never skipped: it is not in the list", () => {
    const { store, project, messages } = ownersThread();
    const first = messages[0]!;
    const listed = store.questionsOf(first.id).map((q) => q.key);
    const late = store.sendMessage({ project_id: project.id, author: A, reply_to: first.id, body: question("One more thing?") }).message;
    store.sendReply(first.id, { idempotency_key: "k-1", skip: listed });
    expect(store.questionsOf(late.id)[0]!.state).toBe("open");
  });
});

describe("what one reply may carry", () => {
  test("an answer on another session's message is refused, and nothing is written", () => {
    const { store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: A, body: question("A's question?") }).message;
    const b = store.sendMessage({ project_id: project.id, author: B, reply_to: a.id, body: question("B's question?") }).message;
    const qa = store.questionsOf(a.id)[0]!;
    const qb = store.questionsOf(b.id)[0]!;
    expect(() =>
      store.sendReply(a.id, {
        idempotency_key: "k-1",
        questions: [{ key: qa.key, revision: 0, answer: pick(qa) }, { message_id: b.id, key: qb.key, revision: 0, answer: pick(qb) }],
      }),
    ).toThrow(expect.objectContaining({ code: "validation_error" }));
    expect(() => store.sendReply(a.id, { idempotency_key: "k-2", skip: [{ message_id: b.id, key: qb.key }] })).toThrow(expect.objectContaining({ code: "validation_error" }));
    expect([...store.questionsOf(a.id), ...store.questionsOf(b.id)].map((q) => q.state)).toEqual(["open", "open"]);
    expect(store.thread(a.id)!.messages).toHaveLength(2);
  });

  test("two sessions in one thread: one reply each", () => {
    const { store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: A, body: question("A's question?") }).message;
    const b = store.sendMessage({ project_id: project.id, author: B, reply_to: a.id, body: question("B's question?") }).message;
    const qa = store.questionsOf(a.id)[0]!;
    const qb = store.questionsOf(b.id)[0]!;
    store.sendReply(a.id, { idempotency_key: "k-a", questions: [{ key: qa.key, revision: 0, answer: pick(qa) }] });
    store.sendReply(b.id, { idempotency_key: "k-b", questions: [{ key: qb.key, revision: 0, answer: pick(qb) }] });
    expect(store.pendingReplies("ses_a")).toHaveLength(1);
    expect(store.pendingReplies("ses_b")).toHaveLength(1);
  });

  test("a message of another thread is refused", () => {
    const { store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: A, body: question("Here?") }).message;
    const other = store.sendMessage({ project_id: project.id, author: A, thread: "elsewhere", body: question("There?") }).message;
    expect(other.thread_id).not.toBe(a.thread_id);
    const q = store.questionsOf(other.id)[0]!;
    expect(() => store.sendReply(a.id, { idempotency_key: "k-1", questions: [{ message_id: other.id, key: q.key, revision: 0, answer: pick(q) }] })).toThrow(
      expect.objectContaining({ code: "validation_error" }),
    );
  });

  test("a stale revision on one of the messages refuses the whole reply, and nothing is written", () => {
    const { store, messages } = ownersThread();
    const [first, last] = [messages[0]!, messages.at(-1)!];
    const q1 = store.questionsOf(first.id)[0]!;
    const q3 = store.questionsOf(last.id)[0]!;
    store.savePicks(first.id, [{ key: q1.key, revision: 0, answer: pick(q1) }]);
    expect(() =>
      store.sendReply(last.id, {
        idempotency_key: "k-1",
        questions: [{ key: q3.key, revision: 0, answer: pick(q3) }, { message_id: first.id, key: q1.key, revision: 0 }],
      }),
    ).toThrow(expect.objectContaining({ code: "question_revision_conflict" }));
    expect(allStates(store, messages).filter((s) => s !== "open")).toEqual(["picked"]);
    expect(store.thread(first.id)!.messages.filter((m) => m.author.kind === "person")).toHaveLength(0);
  });

  test("survives a reopen from disk: the same reply, the same questions sent", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-explicit-skip-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "p", root: "/work/p" });
    const a1 = store.sendMessage({ project_id: project.id, author: A, body: question("One?") }).message;
    const a2 = store.sendMessage({ project_id: project.id, author: A, reply_to: a1.id, body: question("Two?") }).message;
    const [q1, q2] = [store.questionsOf(a1.id)[0]!, store.questionsOf(a2.id)[0]!];
    const sent = store.sendReply(a2.id, { idempotency_key: "k-1", questions: [{ message_id: a1.id, key: q1.key, revision: 0, answer: pick(q1) }, { key: q2.key, revision: 0, answer: pick(q2) }] });
    const again = InboxStore.open(dir);
    expect(again.questionsOf(a1.id)[0]).toMatchObject({ state: "sent", sent_reply_id: sent.reply.id });
    expect(again.questionsOf(a2.id)[0]).toMatchObject({ state: "sent", sent_reply_id: sent.reply.id });
    expect(again.pendingReplies("ses_a").map((m) => m.body)).toEqual([sent.reply.body]);
  });
});
