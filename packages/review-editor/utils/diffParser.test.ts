import { describe, expect, it } from "bun:test";

import { parseDiffToFiles } from "./diffParser";

describe("parseDiffToFiles", () => {
  it("uses file header lines so paths containing separator text stay intact", () => {
    const files = parseDiffToFiles([
      'diff --git "a/api/foo b/bar.ts" "b/api/foo b/bar.ts"',
      '--- "a/api/foo b/bar.ts"',
      '+++ "b/api/foo b/bar.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("api/foo b/bar.ts");
    expect(files[0].oldPath).toBeUndefined();
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
  });

  it("handles renamed quoted paths", () => {
    const files = parseDiffToFiles([
      'diff --git "a/api/old name.ts" "b/api/new name.ts"',
      '--- "a/api/old name.ts"',
      '+++ "b/api/new name.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("api/new name.ts");
    expect(files[0].oldPath).toBe("api/old name.ts");
  });

  it("parses unquoted headers from the right when file lines are absent", () => {
    const files = parseDiffToFiles([
      "diff --git a/api/foo b/old.bin b/api/new.bin",
      "new file mode 100644",
      "index 0000000..1234567",
      "GIT binary patch",
    ].join("\n"));

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("api/new.bin");
    expect(files[0].oldPath).toBe("api/foo b/old.bin");
  });

  it("does not treat hunk body lines as file headers", () => {
    const files = parseDiffToFiles([
      "diff --git a/api/file.txt b/api/file.txt",
      "--- a/api/file.txt",
      "+++ b/api/file.txt",
      "@@ -1,2 +1,2 @@",
      "---- a/not-a-header.txt",
      "++++ b/not-a-header.txt",
    ].join("\n"));

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("api/file.txt");
    expect(files[0].oldPath).toBeUndefined();
  });
});
