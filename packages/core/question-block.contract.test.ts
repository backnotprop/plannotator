/**
 * The optional contract lines (`Stakes:`, `Shows:`, `Why:`, `Reversible:`)
 * and picture choices (approval "inbox-decision-mode", agent contract lines).
 *
 * What regresses if this fails: a contract line shows up as context (or as
 * the prompt), changes a question's key so a stored answer stops matching, a
 * picture choice keeps raw markdown in its label (the agent gets
 * `![B](b.png) B` back), or an answer stored against an older label stops
 * selecting its choice.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalQuestionAnswer,
  formatQuestionAnswersSection,
  indexQuestionBlocks,
  parseQuestionBlock,
  questionExportItems,
  questionKey,
  questionLabelWithoutImage,
  type QuestionAnswer,
} from "./question-block";

const DRAWERS = [
  "Which checkout drawer should ship?",
  "Stakes: ships to all of checkout on Thursday; changing it later costs a week of QA.",
  "",
  "- [ ] A · Total on top — ![Drawer A](drawer-a.png) closest to today",
  "- [ ] B · Total pinned with Pay — ![Drawer B](drawer-b.png) the total never scrolls away",
  "- [ ] C · Three steps — ![Drawer C](drawer-c.png)",
  "",
  "Recommended: B · Total pinned with Pay",
  "",
  "Why: on a 320 px screen only B keeps the total next to the button.",
].join("\n");

describe("contract lines", () => {
  test("each line is read into its own field, never context, never the prompt", () => {
    const q = parseQuestionBlock(
      "question",
      [
        "Restructure the docs nav?",
        "Stakes: 41% of visitors leave without finding a guide.",
        "Shows: ![Docs nav today and proposed](nav.png)",
        "Reversible: no — the old URLs stop redirecting",
        "",
        "Details are in the nav plan.",
        "",
        "- [ ] Yes",
        "- [ ] No",
        "",
        "Recommended: Yes",
        "",
        "Why: guides are where people convert.",
      ].join("\n"),
    )!;
    expect(q.prompt).toBe("Restructure the docs nav?");
    expect(q.stakes).toBe("41% of visitors leave without finding a guide.");
    expect(q.shows).toEqual({ kind: "image", label: "Docs nav today and proposed", src: "nav.png" });
    expect(q.reversible).toEqual({ value: false, why: "the old URLs stop redirecting" });
    expect(q.why).toBe("guides are where people convert.");
    expect(q.context).toBe("Details are in the nav plan.");
    expect(q.choices.find((c) => c.label === "Yes")!.recommended).toBe(true);
  });

  test("keys do not change: the same prompt with or without the lines has one key", () => {
    const bare = parseQuestionBlock("question", ["Which drawer?", "- [ ] A", "- [ ] B"].join("\n"))!;
    const full = parseQuestionBlock(
      "question",
      ["Which drawer?", "Stakes: ships Thursday.", "Why: B is clearer.", "Reversible: no", "- [ ] A", "- [ ] B", "Recommended: B"].join("\n"),
    )!;
    expect(full.key).toBe(bare.key);
    expect(full.key).toBe(questionKey("single", "Which drawer?"));
  });

  test("leniency: emphasis around the label, any case, a `**Label:**` with the colon inside", () => {
    const q = parseQuestionBlock(
      "question",
      ["Pick?", "**Stakes:** the whole release.", "why: lower case works", "*Reversible*: No, the data is gone", "- [ ] A", "- [ ] B"].join("\n"),
    )!;
    expect(q.stakes).toBe("the whole release.");
    expect(q.why).toBe("lower case works");
    expect(q.reversible).toEqual({ value: false, why: "the data is gone" });
    expect(q.context).toBe("");
  });

  test("only a line at the block's own indent is read: the prompt's, even when the whole block is indented", () => {
    const indented = parseQuestionBlock("question", ["Pick?", "  Why: indented under nothing", "- [ ] A"].join("\n"))!;
    expect(indented.why).toBeUndefined();
    expect(indented.context).toBe("Why: indented under nothing");
    // A question inside a list item: every line carries the item's indent.
    const nested = parseQuestionBlock("question", ["  Pick?", "  Stakes: the release.", "  - [ ] A", "    Why: A's own reason", "  - [ ] B"].join("\n"))!;
    expect(nested.stakes).toBe("the release.");
    expect(nested.why).toBeUndefined();
    expect(nested.choices[0]).toMatchObject({ label: "A", description: "Why: A's own reason" });
  });

  test("the reviewer's case: a `Why:` under each choice is that choice's text, never the block's Why", () => {
    for (const marker of ["- [ ]", "-"]) {
      const q = parseQuestionBlock(
        "question",
        [
          "Which drawer?",
          `${marker} A — closest to today`,
          "  Why: the team knows it",
          `${marker} B — the total never scrolls away`,
          "  Why: it keeps the total next to Pay",
          "",
          "Recommended: B",
        ].join("\n"),
      )!;
      expect(q.why).toBeUndefined();
      expect(q.choices.map((c) => c.label)).toEqual(["A", "B"]);
      expect(q.choices[0]!.description).toContain("Why: the team knows it");
      expect(q.choices[1]!.description).toContain("Why: it keeps the total next to Pay");
      expect(q.choices[1]!.recommended).toBe(true);
    }
  });

  test("`contractLines: false` keeps the lines as context, with the same prompt, key and choices", () => {
    const body = ["Pick?", "Stakes: the release.", "- [ ] A", "- [ ] B", "Recommended: B", "Why: it is faster", "Reversible: no -- it deletes"].join("\n");
    const read = parseQuestionBlock("question", body)!;
    const plain = parseQuestionBlock("question", body, { contractLines: false })!;
    expect(read.reversible).toEqual({ value: false, why: "it deletes" });
    for (const field of ["stakes", "shows", "why", "reversible"]) expect(plain).not.toHaveProperty(field);
    expect(plain.context).toBe(["Stakes: the release.", "Why: it is faster", "Reversible: no -- it deletes"].join("\n"));
    expect(plain.key).toBe(read.key);
    expect(plain.prompt).toBe(read.prompt);
    expect(plain.choices).toEqual(read.choices);
    // Picture choices are grammar, read either way.
    const pictures = parseQuestionBlock("question", ["Pick?", "- [ ] A — ![A](a.png)"].join("\n"), { contractLines: false })!;
    expect(pictures.choices[0]!.image).toEqual({ alt: "A", src: "a.png" });
  });

  test("a line before the prompt is the prompt, as for `Stopped:`", () => {
    const q = parseQuestionBlock("question", ["Stakes: which way?", "- [ ] A", "- [ ] B"].join("\n"))!;
    expect(q.prompt).toBe("Stakes: which way?");
    expect(q.stakes).toBeUndefined();
  });

  test("the first of each wins; a later one, an empty one and a value that does not fit are prose", () => {
    const q = parseQuestionBlock(
      "question",
      [
        "Pick?",
        "Stakes: first",
        "Stakes: second",
        "Why:",
        "Shows: the mock in the folder",
        "Reversible: maybe",
        "- [ ] A",
      ].join("\n"),
    )!;
    expect(q.stakes).toBe("first");
    expect(q.why).toBeUndefined();
    expect(q.shows).toBeUndefined();
    expect(q.reversible).toBeUndefined();
    expect(q.context).toBe(["Stakes: second", "Why:", "Shows: the mock in the folder", "Reversible: maybe"].join("\n"));
  });

  test("`Reversible: yes` (or no line) means reversible; `no` with or without a reason", () => {
    const yes = parseQuestionBlock("question", ["Pick?", "Reversible: yes", "- [ ] A"].join("\n"))!;
    expect(yes.reversible).toBeUndefined();
    expect(yes.context).toBe("");
    expect(parseQuestionBlock("question", ["Pick?", "Reversible: no", "- [ ] A"].join("\n"))!.reversible).toEqual({ value: false });
    expect(parseQuestionBlock("question", ["Pick?", "Reversible: no - it deletes", "- [ ] A"].join("\n"))!.reversible).toEqual({ value: false, why: "it deletes" });
    // "not easily" is not "no".
    const notEasily = parseQuestionBlock("question", ["Pick?", "Reversible: not easily", "- [ ] A"].join("\n"))!;
    expect(notEasily.reversible).toBeUndefined();
    expect(notEasily.context).toBe("Reversible: not easily");
  });

  test("`Shows:` takes one image or one link", () => {
    const link = parseQuestionBlock("question", ["Pick?", "Shows: [the nav plan](docs-nav-plan.md)", "- [ ] A"].join("\n"))!;
    expect(link.shows).toEqual({ kind: "link", label: "the nav plan", src: "docs-nav-plan.md" });
  });

  test("a contract line ends the choice, bullet or recommendation above it, as `Context:` does", () => {
    const task = parseQuestionBlock("question", ["Pick?", "- [ ] A — first", "Why: A is cheaper", "- [ ] B"].join("\n"))!;
    expect(task.choices[0]).toMatchObject({ label: "A", description: "first" });
    expect(task.why).toBe("A is cheaper");
    const plain = parseQuestionBlock("question", ["Pick?", "- Yes", "- No", "Why: no wrapping"].join("\n"))!;
    expect(plain.choices.map((c) => c.label)).toEqual(["Yes", "No"]);
    // An older build joined the line onto the bullet: kept as a name a stored answer may quote.
    expect(plain.choices[1].aliases).toContain("No Why: no wrapping");
    const rec = parseQuestionBlock("question", ["Pick?", "- [ ] A", "- [ ] B", "Recommended: B because", "why: it wraps"].join("\n"))!;
    expect(rec.recommendation).toBe("B because");
    expect(rec.why).toBe("it wraps");
  });

  test("a contract line inside a code fence is code", () => {
    const q = parseQuestionBlock("question", ["Pick?", "```", "Why: code", "```", "- [ ] A"].join("\n"))!;
    expect(q.why).toBeUndefined();
    expect(q.context).toBe(["```", "Why: code", "```"].join("\n"));
  });

  test("a block without any of the lines parses exactly as before", () => {
    const body = ["Where?", "", "Context.", "", "- [ ] Local — cheap", "- [ ] Server", "", "Recommended: Local"].join("\n");
    const q = parseQuestionBlock("question", body)!;
    expect(q).not.toHaveProperty("stakes");
    expect(q).not.toHaveProperty("shows");
    expect(q).not.toHaveProperty("why");
    expect(q).not.toHaveProperty("reversible");
    expect(q.choices.every((c) => !("image" in c))).toBe(true);
  });
});

describe("picture choices", () => {
  test("`- [ ] Label — ![alt](path) rest`: the image becomes choice.image, the label stays plain", () => {
    const q = parseQuestionBlock("question", DRAWERS)!;
    expect(q.choices.map((c) => c.label)).toEqual(["A · Total on top", "B · Total pinned with Pay", "C · Three steps"]);
    expect(q.choices[0]).toMatchObject({ description: "closest to today", image: { alt: "Drawer A", src: "drawer-a.png" } });
    expect(q.choices[2].description).toBeUndefined();
    expect(q.choices[1].recommended).toBe(true);
    expect(q.stakes).toContain("Thursday");
    expect(q.why).toContain("320 px");
  });

  test("a plain bullet takes a picture the same way, on single and multi blocks", () => {
    for (const kind of ["question", "question-multi"] as const) {
      const q = parseQuestionBlock(kind, ["Which?", "- Tabs — ![Tabs layout](a.png)", "- Sidebar — ![Sidebar](b.png) more room"].join("\n"))!;
      expect(q.kind).toBe(kind === "question" ? "single" : "multi");
      expect(q.choices.map((c) => [c.label, c.image?.src, c.description])).toEqual([
        ["Tabs", "a.png", undefined],
        ["Sidebar", "b.png", "more room"],
      ]);
    }
  });

  test("an image written in the label is taken out; the raw label stays an alias, so an old answer still selects it", () => {
    const q = parseQuestionBlock("question", ["Which?", "- [ ] ![A](a.png) A", "- [ ] ![B](mock-b.png) B"].join("\n"))!;
    expect(q.choices.map((c) => c.label)).toEqual(["A", "B"]);
    expect(q.choices[1].image).toEqual({ alt: "B", src: "mock-b.png" });
    expect(q.choices[1].aliases).toContain("![B](mock-b.png) B");
    const old: QuestionAnswer = { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["![B](mock-b.png) B"] };
    expect(canonicalQuestionAnswer(q, old).selected).toEqual(["B"]);
  });

  test("a choice with only a picture takes its alt text as its label", () => {
    const q = parseQuestionBlock("question", ["Which?", "- [ ] ![Drawer A](a.png)", "- [ ] ![Drawer B](b.png)"].join("\n"))!;
    expect(q.choices.map((c) => c.label)).toEqual(["Drawer A", "Drawer B"]);
  });

  test("a separator inside the alt text never splits the label; the label an older parser cut there stays an alias", () => {
    const q = parseQuestionBlock("question", ["Which?", "- [ ] ![Drawer - A](a.png) A — today"].join("\n"))!;
    expect(q.choices[0]).toMatchObject({ label: "A", description: "today", image: { alt: "Drawer - A", src: "a.png" } });
    expect(q.choices[0]!.aliases).toContain("![Drawer");
    const old: QuestionAnswer = { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["![Drawer"] };
    expect(canonicalQuestionAnswer(q, old).selected).toEqual(["A"]);
  });

  test("two choices that would share a label keep their labels as written", () => {
    const q = parseQuestionBlock("question", ["Which?", "- [ ] ![a](a.png) Same", "- [ ] ![b](b.png) Same"].join("\n"))!;
    expect(q.choices.map((c) => c.label)).toEqual(["![a](a.png) Same", "![b](b.png) Same"]);
    expect(q.choices.every((c) => !c.image)).toBe(true);
  });

  test("the plan review export prints the plain label", () => {
    const blocks = [{ id: "b1", type: "directive", directiveKind: "question", content: DRAWERS, startLine: 1 }];
    const indexed = indexQuestionBlocks(blocks);
    const answer: QuestionAnswer = { v: 1, key: indexed[0].question.key, kind: "single", prompt: indexed[0].question.prompt, selected: ["B · Total pinned with Pay"] };
    const out = formatQuestionAnswersSection(questionExportItems(indexed), [answer]);
    expect(out).toContain("Answer: B · Total pinned with Pay (your recommendation)");
    expect(out).not.toContain("![");
  });

  test("questionLabelWithoutImage", () => {
    expect(questionLabelWithoutImage("![B](b.png) B")).toBe("B");
    expect(questionLabelWithoutImage("![Only](o.png)")).toBe("Only");
    expect(questionLabelWithoutImage("Plain")).toBeNull();
  });
});
