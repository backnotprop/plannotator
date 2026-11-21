/**
 * A recommendation written into a choice's label (`- [ ] Foo (Recommended)`,
 * no `Recommended:` line) through the Inbox store: the record keeps the
 * recommendation, the card's pick is taken, and a record stored before the
 * parser read the marker still takes the card's (marker-free) label.
 *
 * What regresses if this fails: the reply loses "(your recommendation)", or
 * the window's pick on such a question answers `422 "…" is not one of the
 * question's choices`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxQuestionRecord } from "@plannotator/core/inbox-types";
import { checkInboxAnswer, parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { canonicalQuestionAnswer, parseQuestionBlock, recommendedQuestionAnswer } from "@plannotator/core/question-block";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const INNER = [
  "Should a broken config block uninstall?",
  "- [ ] Only block on ours (Recommended) — a stray file stays a warning",
  "- [ ] Block on any unreadable config — strictest",
];
const BODY = ["Uninstall:", "", ":::question", ...INNER, ":::"].join("\n");
const card = () => parseQuestionBlock("question", INNER.join("\n"), { decisionLines: false })!;

function storeWith(parsed?: InboxQuestionRecord["parsed"]) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-rec-marker-"));
  roots.push(dataDir);
  let store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  const message = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
  const key = store.questionsOf(message.id)[0]!.key;
  if (parsed) {
    const record = store.questionRecord(`${message.id}/${key}`)!;
    appendFileSync(
      join(store.dir, "projects", project.key, "questions.jsonl"),
      `${JSON.stringify({ v: 1, seq: store.cursor() + 1, at: new Date().toISOString(), kind: "question", id: record.id, record: { ...record, parsed } })}\n`,
    );
    store = InboxStore.open(dataDir);
  }
  return { store, message, key };
}

describe("a question sent with the recommendation in a label", () => {
  test("the record and the card agree: marker-free label, recommended", () => {
    const [record] = parseInboxQuestionBlocks(BODY);
    expect(record!.parsed.choices.map((c) => c.label)).toEqual(card().choices.map((c) => c.label));
    expect(record!.parsed.choices.map((c) => [c.label, c.recommended])).toEqual([
      ["Only block on ours", true],
      ["Block on any unreadable config", false],
    ]);
  });

  test("Accept recommended is taken, and Send says it was the recommendation", () => {
    const { store, message, key } = storeWith();
    const answer = recommendedQuestionAnswer({ line: 1, question: card() })!;
    const [picked] = store.savePicks(message.id, [{ key, revision: 0, answer }]);
    expect(picked!.answer!.selected).toEqual(["Only block on ours"]);
    const sent = store.sendReply(message.id, { idempotency_key: "k-1", questions: [{ key, revision: 1 }] });
    expect(sent.reply!.body).toContain("Answer: Only block on ours (your recommendation)");
  });

  test("an older client's pick of the raw label is taken as the choice", () => {
    const [record] = parseInboxQuestionBlocks(BODY);
    const q = card();
    const checked = checkInboxAnswer(record!, { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Only block on ours (Recommended)"] }, "answer");
    expect(checked.ok && checked.answer.selected).toEqual(["Only block on ours"]);
  });
});

describe("a record stored before the parser read the marker", () => {
  const OLD: InboxQuestionRecord["parsed"] = {
    context: null,
    choices: [
      { label: "Only block on ours (Recommended)", description: "a stray file stays a warning", recommended: false, settled: false },
      { label: "Block on any unreadable config", description: "strictest", recommended: false, settled: false },
    ],
    aliases: [null, null],
    recommendation: null,
    suggested_text: null,
    line: 4,
  };

  test("the card's marker-free label is a pick the old record takes, and the card maps it back", () => {
    const { store, message, key } = storeWith(OLD);
    const q = card();
    const label = q.choices[0]!.label;
    expect(label).toBe("Only block on ours");
    const [picked] = store.savePicks(message.id, [{ key, revision: 0, answer: { v: 1, key, kind: q.kind, prompt: q.prompt, selected: [label] } }]);
    expect(picked!.state).toBe("picked");
    expect(picked!.answer!.selected).toEqual(["Only block on ours (Recommended)"]);
    expect(canonicalQuestionAnswer(q, picked!.answer!).selected).toEqual([label]);
  });
});
