import { describe, expect, test } from "bun:test";
import { parseDiffFilePathLines, parsePatchPathToken } from "./diff-paths";

describe("diff path parsing", () => {
  test("strips tab metadata from unquoted file path lines", () => {
    expect(parseDiffFilePathLines([
      "--- a/my file\t",
      "+++ b/my file\t",
      "@@ -1 +1 @@",
    ])).toEqual({
      oldPath: "my file",
      newPath: "my file",
    });
  });

  test("preserves escaped tabs inside quoted file paths", () => {
    expect(parseDiffFilePathLines([
      '--- "a/my\\tfile"',
      '+++ "b/my\\tfile"',
      "@@ -1 +1 @@",
    ])).toEqual({
      oldPath: "my\tfile",
      newPath: "my\tfile",
    });
  });

  test("preserves dev null paths with tab metadata", () => {
    expect(parsePatchPathToken("/dev/null\t", "a")).toBe("/dev/null");
  });
});
