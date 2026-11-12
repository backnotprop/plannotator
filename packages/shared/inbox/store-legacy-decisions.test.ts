import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

const BODY = [
  ":::question",
  "Which database should we use?",
  "",
  "Decision: when answered",
  "",
  "- [ ] Postgres",
  "- [ ] SQLite",
  ":::",
].join("\n");

test("a store with an older Inbox's decisions loads, keeps the file untouched, and never reuses its seqs", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-legacy-decisions-"));
  roots.push(dataDir);
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "api", root: "/work/api" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
  const question = store.questionRecord(`${asked.id}/${store.questionsOf(asked.id)[0]!.key}`)!;

  const folder = join(store.dir, "projects", project.key);
  const at = new Date().toISOString();
  const top = store.cursor();
  appendFileSync(
    join(folder, "questions.jsonl"),
    `${JSON.stringify({ v: 1, seq: top + 1, at, kind: "question", id: question.id, record: { ...question, decision_on_answer: true, decision_id: "dec_01", decision_recording: true, decision_draft: { text: "Postgres.", reason: null } } })}\n`,
  );
  const decision = { id: "dec_01", project_id: project.id, text: "Postgres.", reason: null, source: { kind: "answer", question_id: question.id, message_id: asked.id, thread_id: asked.id, agent: null }, state: "current", version: 1, replaces_id: null, replacement_id: null, created_at: at, changed_at: null, idempotency_key: null };
  const decisionsFile = join(folder, "decisions.jsonl");
  const legacy = `${JSON.stringify({ v: 1, seq: top + 50, at, kind: "decision", id: "dec_01", record: decision })}\n`;
  writeFileSync(decisionsFile, legacy);

  const reopened = InboxStore.open(dataDir);
  const wire = reopened.questionsOf(asked.id)[0]!;
  expect(wire).toMatchObject({ prompt: "Which database should we use?", state: "open" });
  for (const field of ["decision_on_answer", "decision_id", "decision_recording", "decision_draft"]) expect(wire).not.toHaveProperty(field);
  expect(wire.context).toContain("Decision: when answered");
  expect(reopened.cursor()).toBeGreaterThanOrEqual(top + 50);
  const reply = reopened.sendMessage({ project_id: project.id, author: AGENT, body: "Going with Postgres.", reply_to: asked.id }).message;
  expect(reopened.messageCursor(reply.id)).toBeGreaterThan(top + 50);
  const other = reopened.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: "Unrelated." }).message;
  reopened.deleteThread(other.thread_id);
  expect(readFileSync(decisionsFile, "utf8")).toBe(legacy);
  expect(InboxStore.open(dataDir).questionsOf(asked.id)[0]!.state).toBe("open");
});

test("an agent's `Decision:` line is context in a new message too, and changes neither the key nor the state", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-legacy-decisions-"));
  roots.push(dataDir);
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "api", root: "/work/api" });
  const withLine = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
  const without = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: BODY.replace("Decision: when answered\n\n", "") }).message;
  const [a] = store.questionsOf(withLine.id);
  const [b] = store.questionsOf(without.id);
  expect(a!.key).toBe(b!.key);
  expect(a!.state).toBe("open");
  expect(a!.context).toBe("Decision: when answered");
  expect(b!.context).toBeNull();
});
