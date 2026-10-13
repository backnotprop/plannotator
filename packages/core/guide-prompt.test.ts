import { describe, it, expect } from "bun:test";
import { GUIDE_NO_SECTIONS_ERROR, validateGuideOutput } from "./guide-prompt";

// Moved from packages/server/guide/guide-review.test.ts with the validator
// itself. Pins the behaviors the PR-993 review rounds fixed: the validator is
// pure logic otherwise exercised only end-to-end through live agent runs,
// which is exactly where regressions hide.

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];

function guideJson(sections: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ title: "T", intent: "I", sections, unplacedFiles: [], ...extra });
}

describe("validateGuideOutput", () => {
  it("gives a diffs-only section a fallback title instead of a blank chapter (round 12)", () => {
    const raw = JSON.parse(guideJson([{ title: "", overview: "", diffs: [{ file: "src/a.ts" }] }]));
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections[0].title).toBe("Untitled section");
    expect(result.guide.sections[0].diffs).toEqual([{ file: "src/a.ts" }]);
  });

  it("first placement wins on duplicate refs; loser section keeps its other files", () => {
    const raw = JSON.parse(
      guideJson([
        { title: "One", overview: "o", diffs: [{ file: "src/a.ts" }] },
        { title: "Two", overview: "o", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections[0].diffs).toEqual([{ file: "src/a.ts" }]);
    expect(result.guide.sections[1].diffs).toEqual([{ file: "src/b.ts" }]);
  });

  it("drops refs outside changedFiles and fails closed when nothing survives", () => {
    const raw = JSON.parse(guideJson([{ title: "X", overview: "", diffs: [{ file: "not/changed.ts" }] }]));
    const result = validateGuideOutput(raw, FILES);
    expect("error" in result).toBe(true);
  });

  it("explains a fully-invalidated guide whose refs were outside the changeset (count + example paths)", () => {
    // The model guided a different commit than the one under review — the
    // failure card must say so instead of the bare generic message. Asserts
    // the data the message carries (count, example paths, the Commits-panel
    // pointer), not the surrounding prose.
    const raw = JSON.parse(
      guideJson([
        { title: "X", overview: "o", diffs: [{ file: "other/one.ts" }, { file: "other/two.ts" }] },
        { title: "Y", overview: "o", diffs: [{ file: "other/three.ts" }, { file: "other/four.ts" }] },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if (!("error" in result)) throw new Error("expected a validation error");
    expect(result.error).toContain("4 file(s) outside the changeset");
    expect(result.error).toContain("other/one.ts");
    expect(result.error).toContain("Commits panel");
    // Examples are capped at 3 — the fourth path must not be listed.
    expect(result.error).not.toContain("other/four.ts");
  });

  it("keeps the generic message for genuinely structural emptiness (no outside-changeset drops)", () => {
    const noSections = validateGuideOutput(JSON.parse(guideJson([])), FILES);
    if (!("error" in noSections)) throw new Error("expected a validation error");
    expect(noSections.error).toBe(GUIDE_NO_SECTIONS_ERROR);

    // A zero-diff section with a blank overview dies structurally, not
    // because of the changeset — same generic message.
    const blankOverview = validateGuideOutput(
      JSON.parse(guideJson([{ title: "S", overview: "", diffs: [] }])),
      FILES,
    );
    if (!("error" in blankOverview)) throw new Error("expected a validation error");
    expect(blankOverview.error).toBe(GUIDE_NO_SECTIONS_ERROR);
  });

  it("keeps a deliberate prose-only section but drops one that LOST its diffs to validation", () => {
    const raw = JSON.parse(
      guideJson([
        { title: "Context", overview: "Background reading.", diffs: [] },
        { title: "Ghost", overview: "Had only invalid refs.", diffs: [{ file: "not/changed.ts" }] },
        { title: "Real", overview: "o", diffs: [{ file: "src/a.ts" }] },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections.map((s) => s.title)).toEqual(["Context", "Real"]);
  });

  it("unplacedFiles = unplaced changed files, deduped against placements, ignoring fabricated entries", () => {
    const raw = JSON.parse(
      guideJson([{ title: "S", overview: "o", diffs: [{ file: "src/a.ts" }] }], {
        // a.ts is placed (must not double-render); fake.ts is not a changed file.
        unplacedFiles: ["src/a.ts", "fake.ts", "src/b.ts"],
      }),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.unplacedFiles?.sort()).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("carries per-file summaries through, omitting blank/non-string ones without dropping the ref", () => {
    const raw = JSON.parse(
      guideJson([
        {
          title: "S",
          overview: "o",
          diffs: [
            { file: "src/a.ts", summary: "Adds the thing." },
            { file: "src/b.ts", summary: "   " },
            { file: "src/c.ts", summary: 42 },
          ],
        },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections[0].diffs).toEqual([
      { file: "src/a.ts", summary: "Adds the thing." },
      { file: "src/b.ts" },
      { file: "src/c.ts" },
    ]);
  });

  it("coerces non-string title/intent from prompt-only marker engines", () => {
    const raw = JSON.parse(guideJson([{ title: "S", overview: "o", diffs: [{ file: "src/a.ts" }] }]));
    raw.title = 42;
    raw.intent = { nested: true };
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.title).toBe("Guided review");
    expect(result.guide.intent).toBe("");
  });
});
