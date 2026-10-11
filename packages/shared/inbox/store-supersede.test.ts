/**
 * Replaced questions in the Inbox store: an agent supersedes an earlier
 * question of its thread (send_message's `supersedes`, or a `Replaces:` line
 * in a newer block). The store keeps it append-only: the superseded
 * question's record gains `superseded_by`; its state is derived.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxError, parseInboxLine } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(): { store: InboxStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-supersede-"));
  roots.push(dir);
  return { store: InboxStore.open(dir), dir };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

const WORKER = [
  "I checked the 409 row. Two things before I go on.",
  "",
  ":::question",
  "Which way should the worker go on a Stripe 409?",
  "",
  "Stopped: the retry worker cannot ship without this.",
  "",
  "Decision: when answered",
  "",
  "- [ ] Retry with the same idempotency key",
  "- [ ] Fail the job and send it to the dead-letter queue",
  ":::",
  "",
  ":::question",
  "Ship the retry behind a flag?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

function queueBlock(replaces?: string): string {
  return [
    "You moved the 409 handling into the jobs queue, so this is the one the queue needs.",
    "",
    ":::question",
    ...(replaces ? [`Replaces: ${replaces}`] : []),
    "How many times should the jobs queue retry a Stripe 409?",
    "",
    "Stopped: the queue change cannot merge without this.",
    "",
    "- [ ] 3 times over 10 minutes",
    "- [ ] Once, then dead-letter",
    ":::",
  ].join("\n");
}

function answerFor(q: InboxQuestion, label: string): QuestionAnswer {
  return { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] };
}

function setup() {
  const { store, dir } = open();
  const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  const first = store.sendMessage({ project_id: project.id, author: AGENT, body: WORKER }).message;
  const [q1, q2] = store.questionsOf(first.id) as [InboxQuestion, InboxQuestion];
  return { store, dir, project, first, q1, q2 };
}

function sectionOf(store: InboxStore, threadId: string): string | undefined {
  return store.listSections().find((s) => s.threads.some((t) => t.thread_id === threadId))?.id;
}

describe("superseding a question", () => {
  test("by key: the old question reads superseded by the new message's only question; the other stays open", () => {
    const { store, first, q1, q2 } = setup();
    const sent = store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] });
    const newKey = sent.message.questions![0]!.key;
    const [old1, old2] = store.questionsOf(first.id);
    expect(old1!.state).toBe("superseded");
    expect(old1!.superseded_by).toEqual({ message_id: sent.message.id, key: newKey });
    expect(old2!.state).toBe("open");
    expect(old2!.superseded_by).toBeNull();
    expect(sent.message.supersedes).toEqual([`${first.id}/${q1.key}`]);
    expect(store.supersededBy(sent.message.id)).toEqual([`${first.id}/${q1.key}`]);
    expect(q2.key).not.toBe(q1.key);
  });

  test("by message: every open question of it is superseded; with no question in the new message the key is null", () => {
    const { store, first } = setup();
    const sent = store.sendMessage({
      project_id: first.project_id,
      author: AGENT,
      body: "You settled this in our session: neither question applies any more.",
      reply_to: first.id,
      supersedes: [first.id],
    });
    for (const q of store.questionsOf(first.id)) {
      expect(q.state).toBe("superseded");
      expect(q.superseded_by).toEqual({ message_id: sent.message.id, key: null });
    }
  });

  test("a Replaces: line in the new block supersedes as the argument does, and is never the prompt or the card's context", () => {
    const { store, first, q1 } = setup();
    const sent = store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(`${first.id}/${q1.key}`), reply_to: first.id });
    const fresh = sent.message.questions![0]!;
    expect(fresh.prompt).toBe("How many times should the jobs queue retry a Stripe 409?");
    expect(fresh.context ?? "").not.toContain("Replaces");
    expect(fresh.stopped).toBe("the queue change cannot merge without this.");
    expect(store.questionsOf(first.id)[0]!.superseded_by).toEqual({ message_id: sent.message.id, key: fresh.key });
    // Without the argument the message records no `supersedes` of its own.
    expect(store.message(sent.message.id)!.supersedes).toBeUndefined();
  });

  test("with several new questions, the argument's ids read 'No longer applies' unless a block names them with Replaces:", () => {
    const { store, first, q1, q2 } = setup();
    const body = [queueBlock(`${first.id}/${q1.key}`), "", ":::question", "Keep the flag name?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
    const sent = store.sendMessage({ project_id: first.project_id, author: AGENT, body, reply_to: first.id, supersedes: [first.id] });
    const [old1, old2] = store.questionsOf(first.id);
    expect(old1!.superseded_by).toEqual({ message_id: sent.message.id, key: sent.message.questions![0]!.key });
    expect(old2!.superseded_by).toEqual({ message_id: sent.message.id, key: null });
    expect(q2.key).toBeDefined();
  });

  test("replay: the store read again from disk gives the same states, and old stores without the fields read as before", () => {
    const { store, dir, first, q1 } = setup();
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] });
    const reopened = InboxStore.open(dir);
    expect(reopened.thread(first.thread_id)).toEqual(store.thread(first.thread_id));
    expect(reopened.listSections()).toEqual(store.listSections());
    // Append-only: the supersede is one more question line, the first one untouched.
    const projects = join(dir, "inbox", "projects");
    const lines = readdirSync(projects).flatMap((key) =>
      readFileSync(join(projects, key, "questions.jsonl"), "utf8")
        .split("\n")
        .map((raw) => parseInboxLine(raw))
        .filter((line) => line !== null && line.id === `${first.id}/${q1.key}`),
    );
    expect(lines.length).toBe(2);
    expect((lines[0]!.record as { superseded_by?: unknown }).superseded_by).toBeUndefined();
    expect((lines[1]!.record as { superseded_by?: unknown }).superseded_by).toBeTruthy();
  });

  test("an idempotent retry answers the first message and writes nothing; another list under the same key is refused", () => {
    const { store, first, q1 } = setup();
    const input = { project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`], idempotency_key: "k1" };
    const one = store.sendMessage(input);
    const cursor = store.cursor();
    const two = store.sendMessage(input);
    expect(two.replayed).toBe(true);
    expect(two.message.id).toBe(one.message.id);
    expect(store.cursor()).toBe(cursor);
    expect(() => store.sendMessage({ ...input, supersedes: [first.id] })).toThrow(expect.objectContaining({ code: "idempotency_key_reused" }));
  });
});

describe("refusals: one bad id refuses the whole send and lists the thread's open questions", () => {
  function refusal(run: () => unknown): InboxError {
    try {
      run();
    } catch (error) {
      if (error instanceof InboxError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  test("an unknown key, a malformed id and a question of another thread", () => {
    const { store, first, q1, q2, project } = setup();
    const other = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: WORKER }).message;
    const cursor = store.cursor();
    for (const ids of [[`${first.id}/q-00000000`], ["the earlier one"], [`${other.id}/${q1.key}`], [`${first.id}/${q1.key}`, "msg_NOPE"]]) {
      const error = refusal(() => store.sendMessage({ project_id: project.id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: ids }));
      expect(error.code).toBe("invalid_supersedes");
      expect(error.message).toContain(`${first.id}/${q1.key}`);
      expect(error.message).toContain(`${first.id}/${q2.key}`);
      expect((error.details.open_questions as { id: string }[]).map((q) => q.id)).toEqual([`${first.id}/${q1.key}`, `${first.id}/${q2.key}`]);
    }
    // Nothing landed: no message, no question line.
    expect(store.cursor()).toBe(cursor);
    expect(store.thread(first.thread_id)!.messages.length).toBe(1);
  });

  test("a closed question: one already sent, one already superseded, and a Replaces: line naming one", () => {
    const { store, first, q1, q2 } = setup();
    store.savePicks(first.id, [{ key: q2.key, revision: 0, answer: answerFor(q2, "Yes") }]);
    store.sendReply(first.id, { idempotency_key: "s1", questions: [{ key: q2.key, revision: 1 }] });
    expect(refusal(() => store.sendMessage({ project_id: first.project_id, author: AGENT, body: "x", reply_to: first.id, supersedes: [`${first.id}/${q2.key}`] })).code).toBe(
      "invalid_supersedes",
    );
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] });
    const again = refusal(() => store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(`${first.id}/${q1.key}`), reply_to: first.id }));
    expect(again.code).toBe("invalid_supersedes");
    expect(again.message).toContain("is not open (it is superseded)");
    // The whole message has no open question left.
    expect(refusal(() => store.sendMessage({ project_id: first.project_id, author: AGENT, body: "x", reply_to: first.id, supersedes: [first.id] })).message).toContain(
      "no open question",
    );
  });

  test("a message that would start a new thread can supersede nothing", () => {
    const { store, first, q1, project } = setup();
    const error = refusal(() =>
      store.sendMessage({ project_id: project.id, author: AGENT, body: queueBlock(), thread: "another thread", supersedes: [`${first.id}/${q1.key}`] }),
    );
    expect(error.code).toBe("invalid_supersedes");
    expect(error.message).toContain(`reply_to ${first.id}`);
  });
});

describe("picks, Send and decisions on a superseded question", () => {
  test("a pick saved before stays visible and is never sent; picking or sending it is refused with question_superseded", () => {
    const { store, first, q1, q2 } = setup();
    store.savePicks(first.id, [{ key: q1.key, revision: 0, answer: answerFor(q1, "Fail the job and send it to the dead-letter queue") }]);
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] });
    const old = store.questionsOf(first.id)[0]!;
    expect(old.state).toBe("superseded");
    expect(old.answer?.selected).toEqual(["Fail the job and send it to the dead-letter queue"]);
    const pick = () => store.savePicks(first.id, [{ key: q1.key, revision: old.revision, answer: answerFor(q1, "Retry with the same idempotency key") }]);
    expect(pick).toThrow(expect.objectContaining({ code: "question_superseded" }));
    const send = () => store.sendReply(first.id, { idempotency_key: "s1", questions: [{ key: q1.key, revision: old.revision }] });
    expect(send).toThrow(expect.objectContaining({ code: "question_superseded" }));
    // The other question still goes, and the reply never lists the superseded one, answered or unanswered.
    store.savePicks(first.id, [{ key: q2.key, revision: 0, answer: answerFor(q2, "Yes") }]);
    const reply = store.sendReply(first.id, { idempotency_key: "s2", questions: [{ key: q2.key, revision: 1 }] });
    expect(reply.reply.body).toContain("Ship the retry behind a flag?");
    expect(reply.reply.body).not.toContain("Which way should the worker go");
    expect(reply.reply.body).not.toContain("dead-letter");
    expect(store.questionsOf(first.id)[0]!.state).toBe("superseded");
  });

  test("a decision drafted on it is dropped when it is superseded", () => {
    const { store, first, q1 } = setup();
    store.writeQuestionDecision(`${first.id}/${q1.key}`, { decision_recording: true, decision_draft: { text: "Dead-letter it.", reason: null } });
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] });
    expect(store.questionRecord(`${first.id}/${q1.key}`)!.decision_draft).toBeNull();
  });
});

describe("the list and the subject", () => {
  test("replaced by a stopped question: the row stays in Stopped on you, counting the open questions only", () => {
    const { store, first, q1 } = setup();
    expect(sectionOf(store, first.thread_id)).toBe("stopped");
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] });
    const row = store.listRow(first.thread_id)!;
    expect(row.section).toBe("stopped");
    expect(row.questions.open).toBe(2);
  });

  test("withdrawn with nothing open: the row leaves Stopped on you for New since you looked, then Quiet once seen", () => {
    const { store, first } = setup();
    store.markSeen(first.thread_id);
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: "Neither applies any more.", reply_to: first.id, supersedes: [first.id] });
    expect(store.listRow(first.thread_id)!.questions.open).toBe(0);
    expect(sectionOf(store, first.thread_id)).toBe("new");
    store.markSeen(first.thread_id);
    expect(sectionOf(store, first.thread_id)).toBe("quiet");
  });

  test("a pick on a superseded question is never 'Answered, not sent'", () => {
    const { store, first, q1, q2 } = setup();
    store.savePicks(first.id, [
      { key: q1.key, revision: 0, answer: answerFor(q1, "Retry with the same idempotency key") },
      { key: q2.key, revision: 0, answer: answerFor(q2, "No") },
    ]);
    store.markSeen(first.thread_id);
    expect(store.listRow(first.thread_id)!.answered_not_sent).toBe(true);
    // The agent withdraws the whole message: both picks are dropped, so nothing waits for Send.
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: "Not that one.", reply_to: first.id, supersedes: [first.id] });
    const row = store.listRow(first.thread_id)!;
    expect(row.answered_not_sent).toBe(false);
    expect(row.questions.picked).toBe(0);
  });

  test("a subject derived from a question follows its replacement; a withdrawal and an agent's subject keep theirs", () => {
    const { store, first, q1 } = setup();
    expect(store.thread(first.thread_id)!.subject).toBe("Which way should the worker go on a Stripe 409?");
    store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] });
    expect(store.thread(first.thread_id)!.subject).toBe("How many times should the jobs queue retry a Stripe 409?");
    expect(store.listRow(first.thread_id)!.subject).toBe("How many times should the jobs queue retry a Stripe 409?");

    const withdrawn = setup();
    withdrawn.store.sendMessage({ project_id: withdrawn.first.project_id, author: AGENT, body: "No longer.", reply_to: withdrawn.first.id, supersedes: [withdrawn.first.id] });
    expect(withdrawn.store.thread(withdrawn.first.thread_id)!.subject).toBe("Which way should the worker go on a Stripe 409?");

    const given = open();
    const project = given.store.ensureProject({ name: "x", root: "/work/x" });
    const root = given.store.sendMessage({ project_id: project.id, author: AGENT, body: WORKER, subject: "Stripe 409s" }).message;
    const key = given.store.questionsOf(root.id)[0]!.key;
    given.store.sendMessage({ project_id: project.id, author: AGENT, body: queueBlock(), reply_to: root.id, supersedes: [`${root.id}/${key}`] });
    expect(given.store.thread(root.thread_id)!.subject).toBe("Stripe 409s");
  });

  test("the subject follows a chain of replacements", () => {
    const { store, first, q1 } = setup();
    const second = store.sendMessage({ project_id: first.project_id, author: AGENT, body: queueBlock(), reply_to: first.id, supersedes: [`${first.id}/${q1.key}`] }).message;
    const secondKey = second.questions![0]!.key;
    store.sendMessage({
      project_id: first.project_id,
      author: AGENT,
      body: [":::question", `Replaces: ${second.id}/${secondKey}`, "Retry a 409 at all?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n"),
      reply_to: second.id,
    });
    expect(store.thread(first.thread_id)!.subject).toBe("Retry a 409 at all?");
  });
});
