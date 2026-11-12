import { describe, expect, test } from "bun:test";
import { chunkSegments, codeSegmentsToHtml, indentRanges, slicePieces, wordDiffSegments } from "./codeDiffSegments";
import { computeCodeInlineDiff } from "./planDiffEngine";
import type { HighlightRun } from "./codeHighlight";

const runsFor = (text: string): HighlightRun[] =>
  [...text.matchAll(/\d+|[^\d\n]+/g)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    style: /\d/.test(m[0]) ? "color:#00ff00" : "color:#cccccc",
  }));

describe("indentRanges", () => {
  test("each line's leading spaces and tabs are their own range", () => {
    const text = "spec:\n    image: a\n\tb\n";
    expect(indentRanges(text, 0, text.length).filter((r) => r.indent).map((r) => text.slice(r.start, r.end))).toEqual([
      "    ",
      "\t",
    ]);
  });

  test("a range that starts mid-line has no indentation to split off", () => {
    const text = "key:   value";
    expect(indentRanges(text, 4, text.length)).toEqual([{ start: 4, end: text.length, indent: false }]);
  });
});

describe("chunkSegments", () => {
  test("a removed chunk strikes its text, never a line's indentation", () => {
    const text = "      image: registry/notes-api:1.4.2\n      value: \"50\"";
    const segments = chunkSegments(text, runsFor(text), true);
    const struck = segments.filter((s) => s.struck).map((s) => s.pieces.map((p) => p.text).join(""));
    expect(struck.every((t) => !/^[ \t]/.test(t))).toBe(true);
    expect(segments.filter((s) => !s.struck).map((s) => s.pieces.map((p) => p.text).join(""))).toEqual(["      ", "      "]);
    expect(segments.some((s) => s.struck && s.pieces.some((p) => p.style === "color:#00ff00"))).toBe(true);
  });

  test("the markup keeps the indentation outside the struck span", () => {
    const html = codeSegmentsToHtml(chunkSegments("  a: 1", null, true));
    expect(html).toBe('  <span class="line-through decoration-destructive/30" data-plan-diff-struck="">a: 1</span>');
  });
});

describe("wordDiffSegments", () => {
  const oldText = "poll_ms = 50";
  const newText = "poll_ms = 40";
  const tokens = computeCodeInlineDiff(oldText, newText)!;
  const segments = wordDiffSegments(oldText, newText, tokens, runsFor(oldText), runsFor(newText));

  test("added and removed words keep their side's colours", () => {
    const removed = segments.find((s) => s.mark === "removed")!;
    const added = segments.find((s) => s.mark === "added")!;
    expect(removed.pieces).toEqual([{ text: "50", style: "color:#00ff00" }]);
    expect(added.pieces).toEqual([{ text: "40", style: "color:#00ff00" }]);
    expect(segments.find((s) => !s.mark)!.pieces[0]).toEqual({ text: "poll_ms = ", style: "color:#cccccc" });
  });

  test("the marks wrap the coloured spans", () => {
    const html = codeSegmentsToHtml(segments);
    expect(html).toContain('<del class="plan-diff-word-removed"><span style="color:#00ff00">50</span></del>');
    expect(html).toContain('<ins class="plan-diff-word-added"><span style="color:#00ff00">40</span></ins>');
  });

  test("without runs every word is plain, and the text is unchanged", () => {
    const plain = wordDiffSegments(oldText, newText, tokens, null, null);
    expect(plain.flatMap((s) => s.pieces).every((p) => p.style === undefined)).toBe(true);
    expect(plain.filter((s) => s.mark !== "removed").flatMap((s) => s.pieces).map((p) => p.text).join("")).toBe(newText);
  });

  test("a removed line inside a modified block keeps its indentation unstruck", () => {
    const o = "spec:\n  replicas: 1\n";
    const n = "spec:\n";
    const segs = wordDiffSegments(o.replace(/\n$/, ""), n.replace(/\n$/, ""), computeCodeInlineDiff(o, n)!, null, null);
    const removedText = segs.filter((s) => s.mark === "removed").map((s) => s.pieces.map((p) => p.text).join(""));
    expect(removedText.every((t) => !/^[ \t]/.test(t.replace(/^\n/, "")))).toBe(true);
  });
});

describe("slicePieces", () => {
  test("cuts at run boundaries and leaves gaps between runs unstyled", () => {
    const runs: HighlightRun[] = [{ start: 2, end: 4, style: "color:red" }];
    expect(slicePieces("abcdef", runs, 1, 5)).toEqual([
      { text: "b" },
      { text: "cd", style: "color:red" },
      { text: "e" },
    ]);
  });
});
