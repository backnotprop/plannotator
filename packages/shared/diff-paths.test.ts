import { describe, expect, test } from "bun:test";
import { parseDiffFilePathLines, parsePatchPathToken, unquoteGitPath } from "./diff-paths";

describe("diff path parsing", () => {
  test("unquoteGitPath decodes octal (UTF-8 byte) escapes", () => {
    // git C-quotes non-ASCII names as raw UTF-8 bytes in octal — the exact
    // form ls-files/status/diff emit for "café.txt" with core.quotePath on.
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe("café.txt");
    expect(unquoteGitPath('"\\346\\227\\245\\346\\234\\254.md"')).toBe("日本.md");
    expect(unquoteGitPath('"tab\\there"')).toBe("tab\there");
    expect(unquoteGitPath('"quote\\"in name"')).toBe('quote"in name');
    // Our own quoteGitPath (JSON.stringify) leaves unicode LITERAL inside
    // quotes — synthesized workspace headers round-trip through here too.
    expect(unquoteGitPath('"café file.txt"')).toBe("café file.txt");
    expect(unquoteGitPath('"emoji 🎉.txt"')).toBe("emoji 🎉.txt");
    // …and emits \uXXXX for control chars without a short JSON escape.
    expect(unquoteGitPath('"a\\u000bb.txt"')).toBe("a\u000bb.txt");
    // Malformed \u (too few hex digits) keeps the backslash literally.
    expect(unquoteGitPath('"a\\u0b.txt"')).toBe("a\\u0b.txt");
    // Unquoted input passes through untouched.
    expect(unquoteGitPath("plain space.txt")).toBe("plain space.txt");
  });

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
