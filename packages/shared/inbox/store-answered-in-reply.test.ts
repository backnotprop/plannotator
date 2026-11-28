import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const OTHER: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "codex", session: "ses_b", name: null };

const ASK = [
  "The new runner is up for harbor.",
  "",
  ":::question",
  "Which region should the new runner live in?",
  "",
  "Holds up: the runner image",
  "",
  "- [ ] us-east-1",
  "- [ ] eu-west-1",
  ":::",
  "",
  ":::question",
  "Keep the old Jenkins job as a fallback for a week?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-answered-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: ASK }).message;
  const [region, jenkins] = store.questionsOf(asked.id) as [InboxQuestion, InboxQuestion];
  return { store, project, asked, region, jenkins, ref: `${asked.id}/${jenkins.key}` };
}

function refused(run: () => unknown): InboxError {
  try {
    run();
  } catch (error) {
    if (error instanceof InboxError) return error;
    throw error;
  }
  throw new Error("not refused");
}

const words = "Yep, keep Jenkins for a week, that's fine. Region I still need to think about.";

describe("answered_in_reply", () => {
  test("the asking agent marks its question answered with the person's own words; counts drop", () => {
    const { store, asked, jenkins, ref } = setup();
    const reply = store.sendReply(asked.id, { idempotency_key: "r1", words, questions: [] }).reply;
    const result = store.sendMessage({ project_id: asked.project_id, author: AGENT, reply_to: reply.id, body: "Got it.", answered_in_reply: [{ question: ref, quote: "keep Jenkins for a week" }] });
    expect(result.answered_in_reply).toEqual([ref]);
    const q = store.questionsOf(asked.id).find((x) => x.key === jenkins.key)!;
    expect(q.state).toBe("answered_in_reply");
    expect(q.answered_in_reply).toMatchObject({ reply_id: reply.id, quote: "keep Jenkins for a week", message_id: result.message.id });
    expect(store.listRow(asked.thread_id)!.questions.open).toBe(1);
  });

  test("without a quote it takes the person's whole reply, never the Inbox's still-open line", () => {
    const { store, asked, jenkins, ref } = setup();
    store.sendReply(asked.id, { idempotency_key: "r1", words: "Yes, keep it.", questions: [] });
    store.sendMessage({ project_id: asked.project_id, author: AGENT, reply_to: asked.id, body: "Ok.", answered_in_reply: [{ question: ref }] });
    expect(store.questionsOf(asked.id).find((x) => x.key === jenkins.key)!.answered_in_reply!.quote).toBe("Yes, keep it.");
  });

  test("refuses, writing nothing: another session's question, words the reply does not hold, no reply after it, a question not open", () => {
    const { store, asked, region, ref } = setup();
    const send = (author: typeof AGENT, entry: { question: string; reply?: string; quote?: string }) => () =>
      store.sendMessage({ project_id: asked.project_id, author, reply_to: asked.id, body: "Noted.", answered_in_reply: [entry] });
    expect(refused(send(AGENT, { question: ref })).message).toContain("the person has not replied after it");
    const reply = store.sendReply(asked.id, { idempotency_key: "r1", words, questions: [] }).reply;
    expect(refused(send(OTHER, { question: ref })).message).toContain("only the agent that asked a question may mark it answered");
    expect(refused(send(AGENT, { question: ref, quote: "keep Jenkins forever" })).message).toContain("exact part of the person's reply");
    expect(refused(send(AGENT, { question: ref, reply: asked.id })).message).toContain("is not the person's own reply");
    store.savePicks(asked.id, [{ key: region.key, revision: 0, answer: { v: 1, key: region.key, kind: "single", prompt: region.prompt, selected: ["us-east-1"] } }]);
    store.sendReply(asked.id, { idempotency_key: "r2", questions: [{ key: region.key, revision: 1 }] });
    const sent = refused(send(AGENT, { question: `${asked.id}/${region.key}`, reply: reply.id }));
    expect(sent.code).toBe("invalid_answered_in_reply");
    expect(sent.message).toContain("is not open (it is sent)");
    expect(store.thread(asked.thread_id)!.messages.filter((m) => m.author.kind === "agent").length).toBe(1);
  });

  test("Reopen puts the question back as it was and tells the asking agent", () => {
    const { store, asked, jenkins, ref } = setup();
    store.savePicks(asked.id, [{ key: jenkins.key, revision: 0, answer: { v: 1, key: jenkins.key, kind: "single", prompt: jenkins.prompt, selected: ["Yes"] } }]);
    const before = store.questionsOf(asked.id).find((x) => x.key === jenkins.key)!;
    store.sendReply(asked.id, { idempotency_key: "r1", words, questions: [] });
    store.sendMessage({ project_id: asked.project_id, author: AGENT, reply_to: asked.id, body: "Ok.", answered_in_reply: [{ question: ref }] });
    expect(store.listRow(asked.thread_id)!.questions.picked).toBe(0);
    const after = store.reopenAnswered(asked.id, jenkins.key).find((x) => x.key === jenkins.key)!;
    expect({ ...after, answered_in_reply: undefined }).toEqual({ ...before, answered_in_reply: undefined });
    expect(after.state).toBe("picked");
    expect(store.listRow(asked.thread_id)!.questions.picked).toBe(1);
    const note = store.thread(asked.thread_id)!.messages.at(-1)!;
    expect(note.author.kind).toBe("person");
    expect(note.reply_to).toBe(asked.id);
    expect(note.body).toContain(ref);
    expect(note.body).toContain("don't use those words as the answer");
  });

  test("a pick on an answered question is refused until it is reopened", () => {
    const { store, asked, jenkins, ref } = setup();
    store.sendReply(asked.id, { idempotency_key: "r1", words, questions: [] });
    store.sendMessage({ project_id: asked.project_id, author: AGENT, reply_to: asked.id, body: "Ok.", answered_in_reply: [{ question: ref }] });
    const pick = () => store.savePicks(asked.id, [{ key: jenkins.key, revision: 0, answer: { v: 1, key: jenkins.key, kind: "single", prompt: jenkins.prompt, selected: ["No"] } }]);
    expect(refused(pick).code).toBe("question_answered_in_reply");
    store.reopenAnswered(asked.id, jenkins.key);
    expect(pick()[1]!.state).toBe("picked");
  });

  test("the reply the agent answers is the one quoted, not a newer one; a reopened question takes only a newer reply; Take back undoes it", () => {
    const { store, asked, jenkins, ref } = setup();
    const mark = (replyTo: string, reply?: string) => () => store.sendMessage({ project_id: asked.project_id, author: AGENT, reply_to: replyTo, body: "Ok.", answered_in_reply: [{ question: ref, ...(reply ? { reply } : {}) }] });
    const quoteNow = () => store.questionsOf(asked.id).find((x) => x.key === jenkins.key)!.answered_in_reply?.quote ?? null;
    const first = store.sendReply(asked.id, { idempotency_key: "r1", words: "Keep Jenkins for a week.", questions: [] }).reply;
    store.sendReply(asked.id, { idempotency_key: "r2", words: "Also: the region can wait for Charlie Dunn.", questions: [] });
    mark(first.id)();
    expect(quoteNow()).toBe("Keep Jenkins for a week.");
    store.reopenAnswered(asked.id, jenkins.key);
    expect(refused(mark(first.id, first.id)).message).toContain(`the person reopened it after reply ${first.id}`);
    expect(refused(mark(first.id)).message).toContain("the person reopened it and has not replied since");
    const third = store.sendReply(asked.id, { idempotency_key: "r3", words: "No, switch it off.", questions: [] }).reply;
    mark(third.id)();
    expect(quoteNow()).toBe("No, switch it off.");
    store.takeBack(third.id);
    expect(quoteNow()).toBeNull();
    expect(store.questionsOf(asked.id).find((x) => x.key === jenkins.key)!.state).toBe("open");
  });
});
