/**
 * A `Recommended:` line naming a choice whose label is written as markdown
 * (`- [ ] [Pagefind](x.html)`): the line says `Pagefind`, the label's raw
 * text is `[Pagefind](x.html)`. Exact matching runs first; then the label's
 * plain words name it, only when exactly one choice has them.
 *
 * What regresses if this fails: the card shows no recommendation and the
 * line turns into a suggested free-text answer (and a `(Recommended)` marker
 * beside it is dropped with nothing marked), or two choices with the same
 * plain words get one picked at random.
 */
import { describe, expect, test } from "bun:test";
import { parseQuestionBlock, type ParsedQuestion } from "./question-block";

const block = (choices: string[], line: string) =>
  ["Which search should the docs use?", "", ...choices, "", line].join("\n");

const ms = (run: () => void) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

const recommendedOf = (q: ParsedQuestion) => q.choices.filter((c) => c.recommended).map((c) => c.label);

describe("a Recommended: line names a choice by the plain words of its label", () => {
  test("a link label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](x.html) — static index", "- [ ] Algolia — hosted"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["[Pagefind](x.html)"]);
    expect(q.suggestedText).toBeUndefined();
  });

  test("a link label with a (Recommended) marker: the line names it and the marker leaves the label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](x.html) (Recommended)", "- [ ] Algolia"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["[Pagefind](x.html)"]);
    expect(q.suggestedText).toBeUndefined();
  });

  test("a code-span label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] `pagefind` — static index", "- [ ] Algolia"], "Recommended: pagefind"))!;
    expect(recommendedOf(q)).toEqual(["`pagefind`"]);
  });

  test("a bold label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] **Pagefind** — static index", "- [ ] Algolia"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["**Pagefind**"]);
  });

  test("two choices with the same plain words: neither is named, the line stays a suggested answer as before", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](a.html) — v1", "- [ ] [Pagefind](b.html) — v2"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual([]);
    expect(q.suggestedText).toBe("Pagefind");
  });

  test("pick any: each part of the line names a markdown label by its plain words, markers left out", () => {
    const q = parseQuestionBlock(
      "question-multi",
      block(["- [ ] [Pagefind](x.html) (Recommended)", "- [ ] [Algolia](y.html) (Recommended)", "- [ ] Lunr"], "Recommended: Pagefind and Algolia"),
    )!;
    expect(recommendedOf(q)).toEqual(["[Pagefind](x.html)", "[Algolia](y.html)"]);
    expect(q.suggestedText).toBeUndefined();
    const mixed = parseQuestionBlock("question-multi", block(["- [ ] [Pagefind](x.html)", "- [ ] Algolia", "- [ ] Lunr"], "Recommended: Pagefind, Lunr"))!;
    expect(recommendedOf(mixed)).toEqual(["[Pagefind](x.html)", "Lunr"]);
  });

  test("a 19,000-character label of brackets or tags (the body cap is 20,000) parses in linear time", () => {
    // `![` runs are left out: the picture-choice pattern (CHOICE_IMAGE_RE) takes ~160 ms on them, as on main
    // before this; stripInlineMarkup's own `![` case is guarded in inline-markdown.test.ts.
    for (const run of ["[", "[[", "<a", "[a](", "[[a|", "[a]((", "[a](x("]) {
      const label = run.repeat(Math.ceil(19_000 / run.length)).slice(0, 19_000);
      for (const kind of ["question", "question-multi"] as const) {
        const elapsed = ms(() => parseQuestionBlock(kind, block([`- [ ] ${label}`, "- [ ] Algolia"], "Recommended: Pagefind and Algolia")));
        expect(elapsed).toBeLessThan(50);
      }
    }
  });

  test("an exact match still wins over plain words", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](x.html)", "- [ ] Pagefind"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["Pagefind"]);
  });
});
