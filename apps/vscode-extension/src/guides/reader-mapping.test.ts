import { describe, expect, it } from "bun:test";
import { changedPatchFiles, locateToken, patchExcerpt, patchSideLines, splitHoverMarkdown } from "./reader-mapping";

const file = [
  "import { computeBackoff } from \"./retryPolicy\";",
  "",
  "export function deliver(job: Job) {",
  "  const delay = computeBackoff(job.attempt, policy);",
  "  return { kind: \"retry\", delayMs: delay };",
  "}",
];
const lineAt = (lines: string[]) => (n: number) => lines[n - 1];

describe("where a diff's token is in the file on disk", () => {
  it("is exactly where the diff says when the file has not changed", () => {
    expect(locateToken(lineAt(file), 4, 16, "computeBackoff")).toEqual({ line: 4, character: 16, stale: false });
  });

  it("finds it on the same line when the column moved, and says the file changed", () => {
    const edited = [...file];
    edited[3] = "  const nextDelay = computeBackoff(job.attempt, policy);";
    expect(locateToken(lineAt(edited), 4, 16, "computeBackoff")).toEqual({ line: 4, character: 20, stale: true });
  });

  it("finds it on the nearest line when lines were added above", () => {
    const edited = ["// a new comment", "// and another", ...file];
    expect(locateToken(lineAt(edited), 4, 44, "policy")).toEqual({ line: 6, character: 44, stale: true });
  });

  it("matches whole words only: `job` is not found inside `jobs`", () => {
    expect(locateToken(lineAt(["const jobs = 1;", "use(job);"]), 1, 6, "job")).toEqual({ line: 2, character: 4, stale: true });
  });

  it("is nothing when the token is gone, empty, or the line is out of range", () => {
    expect(locateToken(lineAt(file), 4, 16, "removedFunction")).toBeNull();
    expect(locateToken(lineAt(file), 4, 16, "")).toBeNull();
    expect(locateToken(lineAt(file), 0, 0, "deliver")).toBeNull();
  });
});

describe("the language server's hover as the card shows it", () => {
  it("splits signatures from the docs, in order, and drops command links and rules", () => {
    const md = "```typescript\nfunction computeBackoff(attempt: number, policy: RetryPolicy): number\n```\n---\nExponential backoff with full jitter. See [the policy](command:editor.action.revealDefinition).\n\n*@param* `attempt` — 1-based";
    expect(splitHoverMarkdown(md)).toEqual([
      { kind: "code", language: "typescript", text: "function computeBackoff(attempt: number, policy: RetryPolicy): number" },
      { kind: "markdown", text: "Exponential backoff with full jitter. See the policy.\n\n*@param* `attempt` — 1-based" },
    ]);
  });

  it("keeps a hover without code as markdown, and nothing for an empty one", () => {
    expect(splitHoverMarkdown("Just words")).toEqual([{ kind: "markdown", text: "Just words" }]);
    expect(splitHoverMarkdown("")).toEqual([]);
    expect(splitHoverMarkdown("```ts\n\n```")).toEqual([]);
  });
});

describe("files edited since the guide was written", () => {
  const patch = (path: string, line: string, index = "abc123..def456") => `diff --git a/${path} b/${path}\nindex ${index} 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-old\n+${line}\n`;
  it("names the files whose diff on disk is not the guide's", () => {
    const guide = patch("a.ts", "new") + patch("b.ts", "new");
    const now = patch("a.ts", "new", "abc123..999999") + patch("b.ts", "newer");
    expect(changedPatchFiles(guide, now)).toEqual(["b.ts"]);
  });

  it("leaves out a file the fresh diff does not list (an untracked file the guide added)", () => {
    expect(changedPatchFiles(patch("a.ts", "new") + patch("c.ts", "x"), patch("a.ts", "new"))).toEqual([]);
  });
});

describe("a renamed file is not 'changed on disk since the guide'", () => {
  const { mkdtempSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const { changedFilesFromPatch } = require("./sources/git") as typeof import("./sources/git");
  const { changedSinceDiffArgs } = require("./reader-mapping") as typeof import("./reader-mapping");
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };

  // The guide's patch as the reader's local source makes it (`getWorkingTreeDiffFromBase`): the user's rename config.
  const guideDiff = (dir: string) => git(dir, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--end-of-options", "HEAD"]);
  const run = (dir: string, files: Array<{ path: string; oldPath?: string }>, max?: number) => changedSinceDiffArgs("HEAD", files, max).map((args) => git(dir, args)).join("");
  const repo = (renames: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "pn-rename-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "T"]);
    if (renames !== null) git(dir, ["config", "diff.renames", renames]);
    writeFileSync(join(dir, "old-name.ts"), Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    writeFileSync(join(dir, "other.ts"), "export const x = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    git(dir, ["mv", "old-name.ts", "new-name.ts"]);
    writeFileSync(join(dir, "other.ts"), "export const x = 2;\n");
    return dir;
  };

  for (const renames of [null, "true", "false", "copies"]) {
    it(`a pure \`git mv\` reads as unchanged; an edit after the guide reads as changed (diff.renames=${renames ?? "unset"})`, () => {
      const dir = repo(renames);
      try {
        const guidePatch = guideDiff(dir);
        const files = changedFilesFromPatch(guidePatch);
        if (renames === "false") expect(files.map((f) => f.path).sort()).toEqual(["new-name.ts", "old-name.ts", "other.ts"]);
        else expect(files.find((f) => f.path === "new-name.ts")?.oldPath).toBe("old-name.ts");
        expect(changedPatchFiles(guidePatch, run(dir, files))).toEqual([]);
        // Edited after the guide: changed.
        writeFileSync(join(dir, "new-name.ts"), "export const changed = true;\n");
        expect(changedPatchFiles(guidePatch, run(dir, files))).toContain("new-name.ts");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("without the old path in the pathspec, git shows the rename as a new file (the bug the old path fixes)", () => {
    const dir = repo(null);
    try {
      const guidePatch = guideDiff(dir);
      const naive = git(dir, ["diff", "--no-color", "HEAD", "--", "new-name.ts", "other.ts"]);
      expect(changedPatchFiles(guidePatch, naive)).toEqual(["new-name.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a large guide is batched (a rename's two paths in one run), never skipped", () => {
    const files = [{ path: "a" }, { path: "new", oldPath: "old" }, { path: "b" }, { path: "c" }];
    const batches = changedSinceDiffArgs("HEAD", files, 3).map((a) => a.slice(a.indexOf("--") + 1));
    expect(batches).toEqual([["a", "new", "old"], ["b", "c"]]);
    expect(changedSinceDiffArgs("HEAD", Array.from({ length: 1200 }, (_, i) => ({ path: `f${i}.ts` }))).length).toBe(3);
    expect(changedSinceDiffArgs("HEAD", [])).toEqual([]);
    const dir = repo(null);
    try {
      writeFileSync(join(dir, "third.ts"), "export const t = 1;\n");
      git(dir, ["add", "third.ts"]);
      const guidePatch = guideDiff(dir);
      const all = changedFilesFromPatch(guidePatch);
      writeFileSync(join(dir, "other.ts"), "export const x = 3;\n");
      writeFileSync(join(dir, "third.ts"), "export const t = 2;\n");
      expect(changedPatchFiles(guidePatch, run(dir, all, 2)).sort()).toEqual(["other.ts", "third.ts"]);
      expect(changedPatchFiles(guidePatch, run(dir, all, 2)).sort()).toEqual(changedPatchFiles(guidePatch, run(dir, all)).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the code an ask carries comes from the guide's diff, on the side selected", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,4 +10,4 @@ function f() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
    "@@ -30,1 +31,1 @@",
    "-old tail",
    "+new tail",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-one",
    "-two",
    "",
  ].join("\n");

  it("numbers each side's lines as the diff shows them", () => {
    const file = patch.split("diff --git a/src/gone.ts")[0];
    expect([...patchSideLines(file, "new")]).toEqual([[10, "const a = 1;"], [11, "const b = 3;"], [12, "const c = 4;"], [13, "return a;"], [31, "new tail"]]);
    expect([...patchSideLines(file, "old")]).toEqual([[10, "const a = 1;"], [11, "const b = 2;"], [12, "return a;"], [30, "old tail"]]);
  });

  it("an excerpt on the new side, on the old side (removed lines), and of a deleted file", () => {
    expect(patchExcerpt(patch, "src/a.ts", "new", 10, 12)).toBe("const a = 1;\nconst b = 3;\nconst c = 4;");
    expect(patchExcerpt(patch, "src/a.ts", "old", 11, 12)).toBe("const b = 2;\nreturn a;");
    expect(patchExcerpt(patch, "src/gone.ts", "old", 1, 2)).toBe("one\ntwo");
  });

  it("nothing when the diff does not show every selected line, or the file is not in it", () => {
    expect(patchExcerpt(patch, "src/a.ts", "new", 12, 20)).toBeNull();
    expect(patchExcerpt(patch, "src/gone.ts", "new", 1, 1)).toBeNull();
    expect(patchExcerpt(patch, "src/missing.ts", "new", 1, 1)).toBeNull();
  });
});
