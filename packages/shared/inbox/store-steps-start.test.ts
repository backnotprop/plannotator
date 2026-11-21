/**
 * When a reply's wake says to start a checklist (`answersQuestionsOf`; the owner, 2026-11-09: a nudge "when the person
 * answers questions" in a thread with no checklist). What regresses: the line on every plain reply or 👍 (noise the
 * owner ruled out), on a reply that only skips, or on answers to another session's questions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const B: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "codex", session: "ses_b", name: "Codex" };
const ASK = ":::question\nHow far back should the backfill go?\n\n- [ ] Last 7 days\n- [ ] Since the October release\n:::";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-steps-start-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  const asked = store.sendMessage({ project_id: project.id, author: A, body: `The cursor fix is in.\n\n${ASK}`, subject: "Backfill" }).message;
  let n = 0;
  const key = () => `k${++n}`;
  const question = (id = asked.id) => store.questionsOf(id)[0]!;
  const pick = (selected: string[], extra: Record<string, unknown> = {}) => {
    const q = question();
    return { key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected, ...extra } };
  };
  return { store, project, asked, key, question, pick };
}

describe("a reply answers the session's questions", () => {
  test("a picked answer sent with the reply: yes, for the asking session only", () => {
    const w = world();
    const reply = w.store.sendReply(w.asked.id, { questions: [w.pick(["Last 7 days"])], idempotency_key: w.key() }).reply;
    expect(w.store.answersQuestionsOf(reply, "ses_a")).toBe(true);
    expect(w.store.answersQuestionsOf(reply, "ses_b")).toBe(false);
  });

  // (A 👍 Looks good never gets here: its wake is the ack line alone, `replyCommand` returns before any steps line.)
  test("words alone, the question left open: no", () => {
    const w = world();
    const plain = w.store.sendReply(w.asked.id, { words: "Thanks, looks good.", idempotency_key: w.key() }).reply;
    expect(w.store.answersQuestionsOf(plain, "ses_a")).toBe(false);
  });

  test("a skip is not an answer", () => {
    const w = world();
    const reply = w.store.sendReply(w.asked.id, { questions: [w.pick([], { skipped: true })], idempotency_key: w.key() }).reply;
    expect(w.store.answersQuestionsOf(reply, "ses_a")).toBe(false);
  });

  test("an answer to an earlier question of the session, sent later with words: yes; another session's question: not this session's", () => {
    const w = world();
    const other = w.store.sendMessage({ project_id: w.project.id, author: B, body: `Codex here.\n\n${ASK}`, reply_to: w.asked.id, idempotency_key: w.key() }).message;
    const q = w.question(other.id);
    const reply = w.store.sendReply(other.id, { words: "Last week only.", questions: [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Last 7 days"] } }], idempotency_key: w.key() }).reply;
    expect(w.store.answersQuestionsOf(reply, "ses_b")).toBe(true);
    expect(w.store.answersQuestionsOf(reply, "ses_a")).toBe(false);
  });
});
