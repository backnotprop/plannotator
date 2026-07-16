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

describe("parseDiffToFiles — change-type status", () => {
  const parse = (...lines: string[]) => parseDiffToFiles(lines.join("\n"));

  it("classifies modified files", () => {
    const [file] = parse(
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    );
    expect(file.status).toBe("modified");
  });

  it("classifies added files", () => {
    const [file] = parse(
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+hello",
    );
    expect(file.status).toBe("added");
  });

  it("classifies deleted files", () => {
    const [file] = parse(
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    );
    expect(file.status).toBe("deleted");
  });

  it("classifies renames with edits and keeps the old path", () => {
    const [file] = parse(
      "diff --git a/src/before.ts b/src/after.ts",
      "similarity index 90%",
      "rename from src/before.ts",
      "rename to src/after.ts",
      "--- a/src/before.ts",
      "+++ b/src/after.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    );
    expect(file.status).toBe("renamed");
    expect(file.path).toBe("src/after.ts");
    expect(file.oldPath).toBe("src/before.ts");
  });

  it("classifies header-only pure renames (no hunks at all)", () => {
    const [file] = parse(
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    );
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("src/old.ts");
  });

  it("falls back to renamed when paths differ without rename metadata", () => {
    const [file] = parse(
      "diff --git a/src/old.ts b/src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    );
    expect(file.status).toBe("renamed");
  });

  it("is not fooled by diff content containing metadata-looking lines", () => {
    const [file] = parse(
      "diff --git a/docs/git.md b/docs/git.md",
      "index 1111111..2222222 100644",
      "--- a/docs/git.md",
      "+++ b/docs/git.md",
      "@@ -1,2 +1,3 @@",
      " how git renames work:",
      "+rename from and rename to lines appear in headers",
      " new file mode is another header",
    );
    expect(file.status).toBe("modified");
  });
});
