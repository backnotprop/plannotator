import { describe, expect, test } from "bun:test";
import { parsePaginatedArray } from "./pr-gitlab";

describe("parsePaginatedArray", () => {
  test("parses a single-page array", () => {
    const stdout = JSON.stringify([{ a: 1 }, { a: 2 }]);
    expect(parsePaginatedArray<{ a: number }>(stdout)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("merges adjacent JSON arrays from --paginate output", () => {
    const stdout = JSON.stringify([{ a: 1 }]) + JSON.stringify([{ a: 2 }, { a: 3 }]);
    expect(parsePaginatedArray<{ a: number }>(stdout)).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  test("merges three or more pages with whitespace between them", () => {
    const stdout = [
      JSON.stringify([1, 2]),
      JSON.stringify([3, 4]),
      JSON.stringify([5]),
    ].join("\n");
    expect(parsePaginatedArray<number>(stdout)).toEqual([1, 2, 3, 4, 5]);
  });

  test("handles strings containing brackets without splitting prematurely", () => {
    // Diff content frequently contains `][` inside JSON strings — must not be
    // confused with a page boundary.
    const page1 = [{ diff: "before][after", new_path: "a" }];
    const page2 = [{ diff: "second", new_path: "b" }];
    const stdout = JSON.stringify(page1) + JSON.stringify(page2);
    expect(parsePaginatedArray(stdout)).toEqual([...page1, ...page2]);
  });

  test("handles escaped quotes inside strings", () => {
    const page1 = [{ diff: 'has \\"quote\\" and ] bracket', new_path: "a" }];
    const page2 = [{ diff: "second", new_path: "b" }];
    const stdout = JSON.stringify(page1) + JSON.stringify(page2);
    expect(parsePaginatedArray(stdout)).toEqual([...page1, ...page2]);
  });

  test("returns empty array for empty input", () => {
    expect(parsePaginatedArray("")).toEqual([]);
    expect(parsePaginatedArray("   \n")).toEqual([]);
  });

  test("handles empty pages mixed with non-empty ones", () => {
    const stdout = "[]" + JSON.stringify([{ a: 1 }]) + "[]";
    expect(parsePaginatedArray<{ a: number }>(stdout)).toEqual([{ a: 1 }]);
  });
});
