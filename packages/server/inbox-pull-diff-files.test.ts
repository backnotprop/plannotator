import { describe, expect, test } from "bun:test";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { changedFileOf } from "./inbox-pull-diff-files";

const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+${line}\n`;

describe("changedFileOf", () => {
  test("finds what parseDiffToFiles(...).find finds", () => {
    const answer = { patch: file("a.ts", "one") + file("b/c.ts", "two") };
    expect(changedFileOf(answer, "b/c.ts")).toEqual(parseDiffToFiles(answer.patch).find((f) => f.path === "b/c.ts"));
    expect(changedFileOf(answer, "nope.ts")).toBeUndefined();
  });

  test("parses one answer once, and a new answer afresh", () => {
    const answer = { patch: file("a.ts", "one") };
    const first = changedFileOf(answer, "a.ts");
    expect(changedFileOf(answer, "a.ts")).toBe(first!);
    const moved = { patch: file("a.ts", "two") };
    expect(changedFileOf(moved, "a.ts")).not.toBe(first!);
    expect(changedFileOf(moved, "a.ts")!.patch).toContain("+two");
  });
});
