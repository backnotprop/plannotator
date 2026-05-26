import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import path from "path";
import {
  applyEdits,
  formatWithLineNumbers,
  getPlanBackingPath,
  validateEdits,
} from "./index";

// ── applyEdits ─────────────────────────────────────────────────────────────

describe("applyEdits", () => {
  test("initial full write (start=1, no end)", () => {
    const result = applyEdits([], [{ start: 1, content: "# Plan\n\n## Goals\nDo the thing" }]);
    expect(result).toEqual(["# Plan", "", "## Goals", "Do the thing"]);
  });

  test("replaces a single line", () => {
    const lines = ["a", "b", "c", "d", "old", "f"];
    const result = applyEdits(lines, [{ start: 5, end: 5, content: "new" }]);
    expect(result).toEqual(["a", "b", "c", "d", "new", "f"]);
  });

  test("replaces a range of lines", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    const result = applyEdits(lines, [{ start: 5, end: 10, content: "new section" }]);
    expect(result).toEqual(["a", "b", "c", "d", "new section", "k"]);
  });

  test("deletes lines (empty content)", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    const result = applyEdits(lines, [{ start: 5, end: 10, content: "" }]);
    expect(result).toEqual(["a", "b", "c", "d", "k"]);
  });

  test("inserts at end (start = line count + 1)", () => {
    const lines = ["a", "b", "c"];
    const result = applyEdits(lines, [{ start: 4, content: "new" }]);
    expect(result).toEqual(["a", "b", "c", "new"]);
  });

  test("applies multiple non-overlapping edits with correct offset tracking", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const result = applyEdits(lines, [
      { start: 1, end: 1, content: "A" },
      { start: 3, end: 3, content: "C" },
      { start: 5, end: 5, content: "E" },
    ]);
    expect(result).toEqual(["A", "b", "C", "d", "E"]);
  });

  test("edit on empty file (start=1, no end)", () => {
    const result = applyEdits([], [{ start: 1, content: "hello" }]);
    expect(result).toEqual(["hello"]);
  });

  test("edit on empty file (start=1, end=1) — splice clamps gracefully (#742)", () => {
    const result = applyEdits([], [{ start: 1, end: 1, content: "# Plan\nGoals" }]);
    expect(result).toEqual(["# Plan", "Goals"]);
  });

  test("content with trailing newline produces trailing empty string", () => {
    const result = applyEdits([], [{ start: 1, content: "line1\nline2\n" }]);
    expect(result).toEqual(["line1", "line2", ""]);
  });

  test("content without trailing newline does not add empty string", () => {
    const result = applyEdits([], [{ start: 1, content: "line1\nline2" }]);
    expect(result).toEqual(["line1", "line2"]);
  });
});

// ── validateEdits ──────────────────────────────────────────────────────────

describe("validateEdits", () => {
  test("rejects start < 1", () => {
    expect(validateEdits([], [{ start: -5, content: "x" }])).not.toBeNull();
  });

  test("rejects start = 0", () => {
    expect(validateEdits([], [{ start: 0, content: "x" }])).not.toBeNull();
  });

  test("rejects end < start", () => {
    const lines = ["a", "b", "c"];
    expect(validateEdits(lines, [{ start: 3, end: 2, content: "x" }])).not.toBeNull();
  });

  test("rejects start beyond file length + 1", () => {
    const lines = ["a", "b", "c"];
    // file has 3 lines; max valid start is 4 (append); start=5 is beyond
    expect(validateEdits(lines, [{ start: 5, content: "x" }])).not.toBeNull();
  });

  test("rejects end beyond file length", () => {
    const lines = ["a", "b", "c"];
    expect(validateEdits(lines, [{ start: 1, end: 4, content: "x" }])).not.toBeNull();
  });

  test("rejects overlapping edits", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    const result = validateEdits(lines, [
      { start: 5, end: 10, content: "a" },
      { start: 8, end: 12, content: "b" },
    ]);
    expect(result).not.toBeNull();
  });

  test("accepts adjacent edits (no gap between end and next start)", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    const result = validateEdits(lines, [
      { start: 5, end: 10, content: "a" },
      { start: 11, end: 15, content: "b" },
    ]);
    expect(result).toBeNull();
  });

  test("accepts a valid single edit", () => {
    const lines = ["a", "b", "c"];
    expect(validateEdits(lines, [{ start: 2, end: 2, content: "x" }])).toBeNull();
  });

  test("accepts valid multiple non-overlapping edits", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const result = validateEdits(lines, [
      { start: 1, end: 2, content: "x" },
      { start: 4, end: 5, content: "y" },
    ]);
    expect(result).toBeNull();
  });

  test("passes for empty file with start=1", () => {
    expect(validateEdits([], [{ start: 1, content: "hello" }])).toBeNull();
  });

  test("passes for empty file with start=1 and end=1 (#742)", () => {
    // Agent or framework may include end on first call; validation should
    // not reject it since applyEdits handles this via splice clamping.
    expect(validateEdits([], [{ start: 1, end: 1, content: "# Plan\nGoals" }])).toBeNull();
  });
});

// ── formatWithLineNumbers ──────────────────────────────────────────────────

describe("formatWithLineNumbers", () => {
  test("formats a single line", () => {
    expect(formatWithLineNumbers("hello")).toBe("1| hello");
  });

  test("9 lines use 1-digit padding", () => {
    const content = Array.from({ length: 9 }, (_, i) => `line${i + 1}`).join("\n");
    const result = formatWithLineNumbers(content);
    const resultLines = result.split("\n");
    expect(resultLines[0]).toBe("1| line1");
    expect(resultLines[8]).toBe("9| line9");
    // Width is 1, so no leading spaces
    expect(resultLines[0]).not.toMatch(/^ /);
  });

  test("10 lines use 2-digit padding", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const result = formatWithLineNumbers(content);
    const resultLines = result.split("\n");
    // Width is 2, so single-digit lines get a leading space
    expect(resultLines[0]).toBe(" 1| line1");
    expect(resultLines[9]).toBe("10| line10");
  });

  test("empty content formats as single empty line", () => {
    expect(formatWithLineNumbers("")).toBe("1| ");
  });
});

// ── getPlanBackingPath ─────────────────────────────────────────────────────

describe("getPlanBackingPath", () => {
  test("returns path inside data dir active/{project}/_active-plan.md", () => {
    const result = getPlanBackingPath("myproject");
    const dataDir = process.env.PLANNOTATOR_DATA_DIR || path.join(homedir(), ".plannotator");
    expect(result).toBe(path.join(dataDir, "active", "myproject", "_active-plan.md"));
  });

  test("uses the provided project name as the directory segment", () => {
    const result = getPlanBackingPath("some-project");
    expect(result).toContain(path.join("active", "some-project"));
    expect(result).toContain("_active-plan.md");
  });
});
