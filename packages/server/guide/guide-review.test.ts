import { describe, it, expect } from "bun:test";
import { repairGuideJsonText, validateGuideOutput, parseGuideStreamOutput } from "./guide-review";

// Pins the behaviors the PR-993 review rounds fixed. This module previously
// had NO direct coverage — the repair ladder and validation are pure logic
// exercised only end-to-end through live agent runs, which is exactly where
// regressions hide.

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

describe("repairGuideJsonText", () => {
  it("passes valid JSON through", () => {
    const out = repairGuideJsonText(guideJson([{ title: "S", overview: "o", diffs: [{ file: "f" }] }]));
    expect(out?.sections?.length).toBe(1);
  });

  it("strips trailing commas outside strings (but not inside them)", () => {
    const text = `{"title":"a, b,","intent":"","sections":[{"title":"S","overview":"o","diffs":[{"file":"f"},]},],"unplacedFiles":[]}`;
    const out = repairGuideJsonText(text);
    expect(out?.sections?.length).toBe(1);
    expect((out as { title?: string })?.title).toBe("a, b,");
  });

  it("closes unbalanced brackets from truncated output, including a dangling string", () => {
    const truncated = `{"title":"T","intent":"","sections":[{"title":"S","overview":"cut off mid-sent`;
    const out = repairGuideJsonText(truncated);
    expect(out).not.toBeNull();
    expect(Array.isArray(out?.sections)).toBe(true);
  });

  it("returns null for hopeless input (fail-closed, recovery flow takes over)", () => {
    expect(repairGuideJsonText("not json at all")).toBeNull();
    expect(repairGuideJsonText("")).toBeNull();
  });
});

describe("parseGuideStreamOutput", () => {
  it("extracts structured_output from the last claude stream-json result event", () => {
    const guide = JSON.parse(guideJson([{ title: "S", overview: "o", diffs: [{ file: "f" }] }]));
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", structured_output: guide }),
    ].join("\n");
    const out = parseGuideStreamOutput(stream);
    expect(out?.sections?.length).toBe(1);
  });

  it("repairs a truncated final result line via the embedded structured_output value", () => {
    const guide = guideJson([{ title: "S", overview: "o", diffs: [{ file: "f" }] }]);
    // Simulate the NDJSON result event cut off mid-stream: valid prefix,
    // then the structured_output value truncated before its closing braces.
    const truncatedLine = `{"type":"result","structured_output":${guide.slice(0, guide.length - 20)}`;
    const out = parseGuideStreamOutput(truncatedLine);
    expect(out).not.toBeNull();
    expect(Array.isArray(out?.sections)).toBe(true);
  });

  it("returns null on empty stdout", () => {
    expect(parseGuideStreamOutput("")).toBeNull();
  });
});
