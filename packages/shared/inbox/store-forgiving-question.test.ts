/**
 * The owner's 2026-10-24 block in the Inbox: the server's question record and
 * the card read the same labels and the same recommendation, so the card's
 * Accept recommended (its recommended choice's label) is a pick the server
 * takes, not `422 "…" is not one of the question's choices`. The card reads
 * the body with `parseQuestionBlock`; the record comes from
 * `parseInboxQuestionBlocks`. On a real store in a temp dir.
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
  "What happens to a pin when you archive the thread?",
  "Recommended: Unpin it",
  '- Unpin it: the toast says "Archived · Unpinned", and Undo restores both',
  "- Keep it pinned",
  "Context: an archived thread gets nothing new, because the agent's next message starts a new thread.",
];
const BODY = ["Pins and archive:", "", ":::question", ...INNER, ":::"].join("\n");

describe("the owner's block in the Inbox", () => {
  test("the stored record and the card agree on labels, the recommendation and the context", () => {
    const [record] = parseInboxQuestionBlocks(BODY);
    const card = parseQuestionBlock("question", INNER.join("\n"), { decisionLines: false })!;
    expect(record!.key).toBe(card.key);
    expect(record!.parsed.choices.map((c) => c.label)).toEqual(card.choices.map((c) => c.label));
    expect(record!.parsed.choices.map((c) => c.recommended)).toEqual([true, false]);
    expect(record!.parsed.suggested_text).toBeNull();
    expect(record!.parsed.context).toBe(card.context);
    expect(record!.parsed.choices[1]!.label).toBe("Keep it pinned");
  });

  test("the card's Accept recommended is a pick the server takes, and Send carries it", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-forgiving-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "inbox-ui", root: "/work/inbox-ui" });
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
    const q = store.questionsOf(message.id)[0]!;
    const card = parseQuestionBlock("question", INNER.join("\n"), { decisionLines: false })!;
    const answer = recommendedQuestionAnswer({ line: 1, question: card })!;
    const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer }]);
    expect(picked!.state).toBe("picked");
    expect(picked!.answer!.selected).toEqual(['Unpin it: the toast says "Archived · Unpinned", and Undo restores both']);
    const sent = store.sendReply(message.id, { idempotency_key: "k-1", questions: [{ key: q.key, revision: 1 }] });
    expect(sent.reply!.body).toContain("Unpin it: the toast says");
    expect(sent.reply!.body).toContain("(your recommendation)");
  });

  test("the choice the Context: line used to swallow is picked by its own label", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-forgiving-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "inbox-ui", root: "/work/inbox-ui" });
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
    const q = store.questionsOf(message.id)[0]!;
    const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Keep it pinned"] } }]);
    expect(picked!.answer!.selected).toEqual(["Keep it pinned"]);
  });
});

// Records an Inbox through 0.28.26 stored, frozen from that build's parser
// (`parseInboxQuestionBlocks` of the bodies below): a `Context:` line read as
// the wrapped text of the plain bullet above it, and a recommendation naming
// the start of a choice kept as a suggestion with no recommended choice.
const PROMPT = "What happens to a pin when you archive the thread?";
const OLD_RECORDS: Record<string, { body: string[]; parsed: InboxQuestionRecord["parsed"] }> = {
  wrapped: {
    body: [PROMPT, "- Unpin it", "- Keep it", "  pinned forever", "Context: an archived thread gets nothing new."],
    parsed: {
      context: null,
      choices: [
        { label: "Unpin it", description: null, recommended: false, settled: false },
        { label: "Keep it pinned forever Context: an archived thread gets nothing new.", description: null, recommended: false, settled: false },
      ],
      aliases: [null, ["Keep it"]],
      recommendation: null,
      suggested_text: null,
      line: 4,
    },
  },
  singleLine: {
    body: [PROMPT, "- Unpin it", "- Keep it pinned", "**Context:** an archived thread gets nothing new."],
    parsed: {
      context: null,
      choices: [
        { label: "Unpin it", description: null, recommended: false, settled: false },
        { label: "Keep it pinned **Context:** an archived thread gets nothing new.", description: null, recommended: false, settled: false },
      ],
      aliases: [null, null],
      recommendation: null,
      suggested_text: null,
      line: 4,
    },
  },
  suggestion: {
    body: [PROMPT, "Recommended: Unpin it", "- Unpin it: the toast says", "- Keep it pinned"],
    parsed: {
      context: null,
      choices: [
        { label: "Unpin it: the toast says", description: null, recommended: false, settled: false },
        { label: "Keep it pinned", description: null, recommended: false, settled: false },
      ],
      aliases: [null, null],
      recommendation: "Unpin it",
      suggested_text: "Unpin it",
      line: 4,
    },
  },
};

/** A store whose question carries the frozen 0.28.26 record, as it would after an upgrade. */
function oldStore(name: keyof typeof OLD_RECORDS) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-forgiving-old-"));
  roots.push(dataDir);
  const { body, parsed } = OLD_RECORDS[name]!;
  const full = ["Pins and archive:", "", ":::question", ...body, ":::"].join("\n");
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "inbox-ui", root: "/work/inbox-ui" });
  const message = store.sendMessage({ project_id: project.id, author: AGENT, body: full }).message;
  const record = store.questionRecord(`${message.id}/${store.questionsOf(message.id)[0]!.key}`)!;
  appendFileSync(
    join(store.dir, "projects", project.key, "questions.jsonl"),
    `${JSON.stringify({ v: 1, seq: store.cursor() + 1, at: new Date().toISOString(), kind: "question", id: record.id, record: { ...record, parsed } })}\n`,
  );
  const reopened = InboxStore.open(dataDir);
  const card = parseQuestionBlock("question", body.join("\n"), { decisionLines: false })!;
  return { store: reopened, message, card, key: record.key };
}

describe("records an Inbox through 0.28.26 stored", () => {
  for (const name of ["wrapped", "singleLine"] as const) {
    test(`${name}: the card's label for the bullet a Context: line ended is a pick the old record takes`, () => {
      const { store, message, card, key } = oldStore(name);
      expect(store.questionRecord(`${message.id}/${key}`)!.parsed.choices[1]!.label).toContain("Context:");
      const label = card.choices[1]!.label;
      expect(label).toBe(name === "wrapped" ? "Keep it pinned forever" : "Keep it pinned");
      const [picked] = store.savePicks(message.id, [{ key, revision: 0, answer: { v: 1, key, kind: card.kind, prompt: card.prompt, selected: [label] } }]);
      expect(picked!.state).toBe("picked");
      // Stored under the record's own label, which the card maps back.
      expect(picked!.answer!.selected).toEqual([OLD_RECORDS[name]!.parsed.choices[1]!.label]);
      expect(canonicalQuestionAnswer(card, picked!.answer!).selected).toEqual([label]);
      const sent = store.sendReply(message.id, { idempotency_key: `k-${name}`, questions: [{ key, revision: 1 }] });
      expect(sent.reply!.body).toContain("Answer: ");
    });
  }

  test("the other choice of an old record is picked by its label as before", () => {
    const { store, message, key } = oldStore("wrapped");
    const [picked] = store.savePicks(message.id, [{ key, revision: 0, answer: { v: 1, key, kind: "single", prompt: PROMPT, selected: ["Unpin it"] } }]);
    expect(picked!.answer!.selected).toEqual(["Unpin it"]);
  });

  test("a suggestion naming the start of a choice: the card's pick of that choice exports as the recommendation", () => {
    const { store, message, card, key } = oldStore("suggestion");
    expect(card.choices[0]!.recommended).toBe(true);
    const answer = recommendedQuestionAnswer({ line: 1, question: card })!;
    store.savePicks(message.id, [{ key, revision: 0, answer }]);
    const sent = store.sendReply(message.id, { idempotency_key: "k-old-sugg", questions: [{ key, revision: 1 }] });
    expect(sent.reply!.body).toContain("Answer: Unpin it: the toast says (your recommendation)");
  });

  test("a suggestion naming the start of a choice: the old card's Accept (the text as Other) still exports as the recommendation", () => {
    const { store, message, key } = oldStore("suggestion");
    store.savePicks(message.id, [{ key, revision: 0, answer: { v: 1, key, kind: "single", prompt: PROMPT, selected: [], other: "Unpin it" } }]);
    const sent = store.sendReply(message.id, { idempotency_key: "k-old-other", questions: [{ key, revision: 1 }] });
    expect(sent.reply!.body).toContain("(your recommendation)");
  });
});

describe("a recommendation that names no choice: the card's recommended row", () => {
  const UNMATCHED = ["Which store backs the cache?", "- [ ] Redis", "- [ ] Memcached", "Recommended: SQLite on the box"];
  test("its pick is the Other text, which the server takes and Send carries as the recommendation", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-forgiving-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "inbox-ui", root: "/work/inbox-ui" });
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: [":::question", ...UNMATCHED, ":::"].join("\n") }).message;
    const q = store.questionsOf(message.id)[0]!;
    // The row never becomes a choice: the record's labels are the agent's choices only.
    expect(q.choices.map((c) => c.label)).toEqual(["Redis", "Memcached"]);
    expect(q.suggested_text).toBe("SQLite on the box");
    const card = parseQuestionBlock("question", UNMATCHED.join("\n"), { decisionLines: false })!;
    // What the row stores is what Accept recommended stores.
    const answer = recommendedQuestionAnswer({ line: 1, question: card })!;
    expect(answer).toMatchObject({ selected: [], other: "SQLite on the box" });
    const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer }]);
    expect(picked!.state).toBe("picked");
    const sent = store.sendReply(message.id, { idempotency_key: "k-row", questions: [{ key: q.key, revision: 1 }] });
    expect(sent.reply!.body).toContain("SQLite on the box");
    expect(sent.reply!.body).toContain("(your recommendation)");
  });
});

describe("the legacy Context: alias on a stored record", () => {
  const record = (labels: string[], aliases: (string[] | null)[] = labels.map(() => null)) => ({
    key: "q-11111111",
    kind: "single" as const,
    prompt: "Pick?",
    parsed: {
      context: null,
      choices: labels.map((label) => ({ label, description: null, recommended: false, settled: false })),
      aliases,
      recommendation: null,
      suggested_text: null,
      line: 1,
    },
  });
  const pick = (r: ReturnType<typeof record>, label: string) =>
    checkInboxAnswer(r, { v: 1, key: r.key, kind: "single", prompt: r.prompt, selected: [label] }, "answer");

  test("every split point: a bullet whose own words hold \"context:\" still answers to the card's label", () => {
    // The bullet read `- Keep context: the thread` and a `Context:` line followed.
    const r = record(["Unpin it", "Keep context: the thread Context: an archived thread."]);
    const ok = pick(r, "Keep context: the thread");
    expect(ok.ok && ok.answer.selected).toEqual(["Keep context: the thread Context: an archived thread."]);
    // The first split (`Keep`) names it too: no other choice has it.
    const first = pick(r, "Keep");
    expect(first.ok && first.answer.selected).toEqual(["Keep context: the thread Context: an archived thread."]);
  });

  test("a head another choice already has is not added", () => {
    const r = record(["Keep it", "Keep it Context: an archived thread."]);
    const ok = pick(r, "Keep it");
    expect(ok.ok && ok.answer.selected).toEqual(["Keep it"]);
  });

  test("a head two choices would share is added to neither", () => {
    const r = record(["Keep it Context: one.", "Keep it Context: two.", "Unpin it"]);
    const refused = pick(r, "Keep it");
    expect(refused.ok).toBe(false);
    const one = pick(r, "Keep it Context: one.");
    expect(one.ok && one.answer.selected).toEqual(["Keep it Context: one."]);
  });
});
