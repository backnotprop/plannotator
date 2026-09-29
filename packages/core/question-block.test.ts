import { describe, expect, test } from "bun:test";
import {
  buildQuestionAnswerAnnotation,
  formatQuestionAnswerText,
  formatQuestionAnswersSection,
  indexQuestionBlocks,
  isQuestionAnswerEmpty,
  parseQuestionAnswer,
  parseQuestionBlock,
  questionExportItems,
  questionKey,
  questionStatus,
  recommendedQuestionAnswer,
  type QuestionAnswer,
} from "./question-block";

const SPEC_BODY = `Where should losing conflict versions be kept?

Last-write-wins silently drops the loser unless we keep it somewhere.

- [ ] Local only, purged after 30 days — cheap, no server change
- [ ] Server-side per user — survives reinstall, needs a retention policy
- [ ] Nowhere — accept silent loss for v1

Recommended: Local only, purged after 30 days`;

describe("parseQuestionBlock", () => {
  test("parses the spaced (GitHub-friendly) form", () => {
    const q = parseQuestionBlock("question", SPEC_BODY)!;
    expect(q.kind).toBe("single");
    expect(q.prompt).toBe("Where should losing conflict versions be kept?");
    expect(q.promptLine).toBe(0);
    expect(q.context).toBe("Last-write-wins silently drops the loser unless we keep it somewhere.");
    expect(q.choices.map((c) => c.label)).toEqual([
      "Local only, purged after 30 days",
      "Server-side per user",
      "Nowhere",
    ]);
    expect(q.choices[1].description).toBe("survives reinstall, needs a retention policy");
    expect(q.choices.map((c) => c.recommended)).toEqual([true, false, false]);
    expect(q.suggestedText).toBeUndefined();
  });

  test("parses the tight form, arrow aliases and a recommendation carrying a reason", () => {
    const q = parseQuestionBlock(
      "question",
      `Should sync run in the background?
iOS background execution is unreliable.
- [ ] Yes, best-effort via BGAppRefreshTask
- [ ] No — foreground only, sync on app-open
➡️ No — foreground only, sync on app-open`,
    )!;
    expect(q.context).toBe("iOS background execution is unreliable.");
    expect(q.choices[1].recommended).toBe(true);

    const reason = parseQuestionBlock("question", `Pick one\n- [ ] Alpha\n- [ ] Beta\n**Recommended:** beta — it is cheaper`)!;
    expect(reason.choices.map((c) => c.recommended)).toEqual([false, true]);
  });

  test("[x] means settled, not recommended", () => {
    const q = parseQuestionBlock("question", `Transport?\n- [x] REST\n- [ ] WebSocket\nRecommended: WebSocket`)!;
    expect(q.choices.map((c) => [c.settled, c.recommended])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test("multi questions resolve a list of recommended labels", () => {
    const q = parseQuestionBlock(
      "question-multi",
      `Which indicators ship?\n\n- [ ] Status dot\n- [ ] Offline banner\n- [ ] Toasts\n\nRecommended: Status dot and Offline banner`,
    )!;
    expect(q.kind).toBe("multi");
    expect(q.choices.map((c) => c.recommended)).toEqual([true, true, false]);
  });

  test("a recommendation that names no choice becomes a suggested answer", () => {
    const q = parseQuestionBlock("question", `Pick\n- [ ] A\n- [ ] B\nRecommended: something else entirely`)!;
    expect(q.choices.every((c) => !c.recommended)).toBe(true);
    expect(q.suggestedText).toBe("something else entirely");
  });

  test("free text: question-text, or any kind with no choices", () => {
    const text = parseQuestionBlock("question-text", `Describe the manual test.\n\nRecommended: Two phones, one offline.`)!;
    expect(text.kind).toBe("text");
    expect(text.choices).toEqual([]);
    expect(text.suggestedText).toBe("Two phones, one offline.");

    const noChoices = parseQuestionBlock("question", `What is the budget?`)!;
    expect(noChoices.kind).toBe("text");
  });

  test("tolerates numbered markers, plain bullets, indented continuations and a heading prompt", () => {
    const numbered = parseQuestionBlock("question", `Pick\n1. [ ] One\n2) [ ] Two`)!;
    expect(numbered.choices.map((c) => c.label)).toEqual(["One", "Two"]);

    const bullets = parseQuestionBlock("question", `### Pick a colour\n\n- Red\n- Blue — calmer\n\nRecommended: Blue`)!;
    expect(bullets.prompt).toBe("Pick a colour");
    expect(bullets.choices.map((c) => c.label)).toEqual(["Red", "Blue"]);
    expect(bullets.choices[1].recommended).toBe(true);
    expect(bullets.context).toBe("");

    const cont = parseQuestionBlock("question", `Pick\n- [ ] One — first line\n  continues here\n- [ ] Two`)!;
    expect(cont.choices[0].description).toBe("first line continues here");
  });

  test("malformed blocks return null instead of throwing", () => {
    expect(parseQuestionBlock("note", SPEC_BODY)).toBeNull();
    expect(parseQuestionBlock("question", "")).toBeNull();
    expect(parseQuestionBlock("question", "- [ ] only choices\n- [ ] no prompt")).toBeNull();
    expect(parseQuestionBlock("question", "Recommended: nothing to ask")).toBeNull();
    expect(parseQuestionBlock("question", `Q?\n${"x".repeat(25_000)}`)).toBeNull();
    expect(parseQuestionBlock("question", undefined as unknown as string)).toBeNull();
  });
});

describe("question identity", () => {
  test("the key ignores case, whitespace and emphasis but not the kind", () => {
    expect(questionKey("single", "Where  is **it**?")).toBe(questionKey("single", "where is it?"));
    expect(questionKey("single", "Where is it?")).not.toBe(questionKey("multi", "Where is it?"));
    expect(questionKey("single", "Where is it?")).toMatch(/^q-[0-9a-f]{8}$/);
  });

  test("indexQuestionBlocks numbers, locates and de-duplicates questions", () => {
    const blocks = [
      { id: "block-0", type: "heading", content: "Plan", startLine: 1 },
      { id: "block-1", type: "directive", directiveKind: "question", content: "\nSame?\n- [ ] a", startLine: 3 },
      { id: "block-2", type: "directive", directiveKind: "note", content: "not a question", startLine: 8 },
      { id: "block-3", type: "directive", directiveKind: "question", content: "- [ ] no prompt", startLine: 11 },
      { id: "block-4", type: "directive", directiveKind: "question", content: "Same?\n- [ ] a", startLine: 14 },
    ];
    const index = indexQuestionBlocks(blocks);
    expect(index.map((q) => [q.blockId, q.number, q.line])).toEqual([
      ["block-1", 1, 5],
      ["block-4", 2, 15],
    ]);
    expect(index[1].question.key).toBe(`${index[0].question.key}-2`);
  });
});

const answer = (over: Partial<QuestionAnswer>): QuestionAnswer => ({
  v: 1,
  key: "q-0000000a",
  kind: "single",
  prompt: "Where?",
  selected: [],
  ...over,
});

describe("parseQuestionAnswer", () => {
  test("accepts a well-formed answer and drops unknown or empty fields", () => {
    const parsed = parseQuestionAnswer({ ...answer({ selected: ["A", "A", " "], other: "", note: "n" }), extra: 1 });
    expect(parsed).toEqual(answer({ selected: ["A"], note: "n" }));
  });

  test("fails closed on malformed input", () => {
    for (const bad of [
      null,
      "x",
      [],
      { ...answer({}), v: 2 },
      { ...answer({}), key: "../etc" },
      { ...answer({}), kind: "rank" },
      { ...answer({}), selected: "A" },
      { ...answer({}), selected: [1] },
      { ...answer({}), note: 3 },
      { ...answer({}), skipped: "yes" },
      { ...answer({}), sourceLine: -1 },
    ]) {
      expect(parseQuestionAnswer(bad)).toBeNull();
    }
  });

  test("truncates to the caps", () => {
    const parsed = parseQuestionAnswer(answer({ prompt: "p".repeat(900), text: "t".repeat(9000), selected: Array.from({ length: 30 }, (_, i) => `c${i}`) }))!;
    expect(parsed.prompt.length).toBe(400);
    expect(parsed.text!.length).toBe(4000);
    expect(parsed.selected.length).toBe(20);
  });
});

describe("answer helpers", () => {
  const indexed = indexQuestionBlocks([
    { id: "block-1", type: "directive", directiveKind: "question-multi", content: "Which?\n- [ ] A\n- [ ] B\n- [ ] C\nRecommended: A, C", startLine: 2 },
  ])[0];

  test("recommendedQuestionAnswer fills the recommended choices and clears a skip", () => {
    const rec = recommendedQuestionAnswer(indexed, answer({ key: indexed.question.key, kind: "multi", skipped: true, note: "keep" }))!;
    expect(rec.selected).toEqual(["A", "C"]);
    expect(rec.skipped).toBeUndefined();
    expect(rec.note).toBe("keep");
  });

  test("empty answers and the one-line text", () => {
    expect(isQuestionAnswerEmpty(answer({}))).toBe(true);
    expect(isQuestionAnswerEmpty(answer({ skipped: true }))).toBe(false);
    expect(formatQuestionAnswerText(answer({ selected: ["A"], other: "x\ny", note: "why" }))).toBe("Answer: A; Other: x y — note: why");
    expect(formatQuestionAnswerText(answer({ skipped: true }))).toBe("Skipped");
  });

  test("buildQuestionAnswerAnnotation carries the answer on a stable id", () => {
    const a = answer({ selected: ["A"] });
    const record = buildQuestionAnswerAnnotation("block-1", a, 5);
    expect(record).toMatchObject({ id: "ann-question-q-0000000a", blockId: "block-1", type: "COMMENT", originalText: "Where?", createdA: 5 });
    expect(record.questionAnswer).toBe(a);
  });
});

describe("formatQuestionAnswersSection", () => {
  const blocks = [
    { id: "b1", type: "directive", directiveKind: "question", content: SPEC_BODY, startLine: 21 },
    { id: "b2", type: "directive", directiveKind: "question", content: "Background sync?\n- [ ] Yes\n- [ ] No", startLine: 33 },
    { id: "b3", type: "directive", directiveKind: "question-multi", content: "Which indicators?\n- [ ] Dot\n- [ ] Banner\n- [ ] Toasts", startLine: 44 },
    { id: "b4", type: "directive", directiveKind: "question-text", content: "Describe the manual test.", startLine: 57 },
    { id: "b5", type: "directive", directiveKind: "question", content: "Transport?\n- [x] REST\n- [ ] WS", startLine: 70 },
  ];
  const index = indexQuestionBlocks(blocks);
  const items = questionExportItems(index);
  const key = (n: number) => index[n - 1].question.key;

  test("reports answers in document order with notes, lists, quotes and the open questions", () => {
    const out = formatQuestionAnswersSection(items, [
      answer({ key: key(3), kind: "multi", prompt: "Which indicators?", selected: ["Dot", "Banner"] }),
      answer({ key: key(1), prompt: "Where…", selected: ["Local only, purged after 30 days"], note: "keep it reachable" }),
      answer({ key: key(2), prompt: "Background sync?", other: "foreground only" }),
    ]);
    expect(out).toBe(`## Answers to your questions

3 of 4 questions answered. 1 already settled in the document was left as is.

### Q1. Where should losing conflict versions be kept? (line 22)
Answer: Local only, purged after 30 days (your recommendation)
Note: keep it reachable

### Q2. Background sync? (line 34)
Answer: Other: foreground only

### Q3. Which indicators? (line 45)
Answer:
- Dot
- Banner

### Unanswered
- Q4. Describe the manual test. (line 58)

`);
  });

  test("free text is quoted, a skip is reported, and a stale answer is kept", () => {
    const out = formatQuestionAnswersSection(items, [
      answer({ key: key(4), kind: "text", prompt: "Describe", text: "Two phones.\nOne offline." }),
      answer({ key: key(2), prompt: "Background sync?", skipped: true, note: "not sure yet" }),
      answer({ key: "q-deadbeef", prompt: "An old question", selected: ["Old"] }),
    ], { headingLevel: 3 });
    expect(out).toContain("#### Q2. Background sync? (line 34)\nSkipped\nNote: not sure yet\n");
    expect(out).toContain("#### Q4. Describe the manual test. (line 58)\nAnswer:\n> Two phones.\n> One offline.\n");
    expect(out).toContain("#### An old question (this question is no longer in the document)\nAnswer: Old\n");
    expect(out.startsWith("### Answers to your questions\n\n1 of 4 questions answered.")).toBe(true);
  });

  test("changing a settled question reports it and counts it", () => {
    const out = formatQuestionAnswersSection(items, [answer({ key: key(5), prompt: "Transport?", selected: ["WS"] })]);
    expect(out).toContain("1 of 5 questions answered.\n");
    expect(out).toContain("### Q5. Transport? (line 71)\nAnswer: WS\n");
  });

  test("a note alone on a settled question counts it answered by the settled choice", () => {
    // PR 1 review: the note printed alone and the question read as unanswered.
    const out = formatQuestionAnswersSection(items, [answer({ key: key(5), prompt: "Transport?", note: "REST is fine for v1" })]);
    expect(out).toContain("1 of 5 questions answered.\n");
    expect(out).toContain("### Q5. Transport? (line 71)\nAnswer: REST (already settled in the document)\nNote: REST is fine for v1\n");
  });

  test("a multi-line note keeps its line breaks; a one-line note stays on the Note line", () => {
    const multi = formatQuestionAnswersSection(items, [
      answer({ key: key(1), prompt: "Where", selected: ["Nowhere"], note: "First line.\nSecond line." }),
    ]);
    expect(multi).toContain("Answer: Nowhere\nNote:\n> First line.\n> Second line.\n");
    const single = formatQuestionAnswersSection(items, [answer({ key: key(1), prompt: "Where", selected: ["Nowhere"], note: "one line" })]);
    expect(single).toContain("Answer: Nowhere\nNote: one line\n");
  });

  test("no reportable answer means no section", () => {
    expect(formatQuestionAnswersSection(items, [])).toBe("");
    expect(formatQuestionAnswersSection(items, [answer({ key: key(1) })])).toBe("");
  });
});

describe("questionStatus", () => {
  const parsed = (body: string) => parseQuestionBlock("question", body)!;
  const settledQ = parsed("Transport?\n- [x] REST\n- [ ] WS");
  const openQ = parsed("Transport?\n- [ ] REST\n- [ ] WS");
  const base = (over: Partial<QuestionAnswer>): QuestionAnswer => ({ v: 1, key: settledQ.key, kind: "single", prompt: "Transport?", selected: [], ...over });

  test("answered beats skipped beats settled beats open; a note alone changes nothing", () => {
    expect(questionStatus(openQ)).toBe("open");
    expect(questionStatus(openQ, base({ note: "hm" }))).toBe("open");
    expect(questionStatus(settledQ)).toBe("settled");
    expect(questionStatus(settledQ, base({ note: "hm" }))).toBe("settled");
    expect(questionStatus(settledQ, base({ skipped: true }))).toBe("skipped");
    expect(questionStatus(settledQ, base({ selected: ["WS"] }))).toBe("answered");
    expect(questionStatus(openQ, base({ other: "gRPC" }))).toBe("answered");
  });
});
