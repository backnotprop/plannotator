import { describe, expect, test, spyOn } from "bun:test";
import { fetchGhPR, reconstructGhPatch, type GitHubFileEntry } from "./pr-github";
import { parseDiffGitHeader, parseDiffFilePathLines, parseDiffMetadataPathLines } from "./diff-paths";
import type { PRRuntime } from "./pr-types";

const REF = { platform: "github" as const, host: "github.com", owner: "o", repo: "r", number: 123 };

const VIEW_JSON = JSON.stringify({
  id: "PR_node123",
  title: "Big change",
  author: { login: "dev" },
  baseRefName: "main",
  headRefName: "feature",
  baseRefOid: "a".repeat(40),
  headRefOid: "b".repeat(40),
  url: "https://github.com/o/r/pull/123",
});

/**
 * Mock gh runtime. Routes by subcommand; records every invocation so tests can
 * assert on exactly which commands ran (and which didn't).
 */
function githubRuntime(opts: {
  prDiff: { stdout?: string; stderr?: string; exitCode: number };
  files?: { stdout?: string; stderr?: string; exitCode: number };
  view?: { stdout?: string; stderr?: string; exitCode: number };
}): { runtime: PRRuntime; calls: string[] } {
  const calls: string[] = [];
  const runtime: PRRuntime = {
    async runCommand(command, args) {
      calls.push([command, ...args].join(" "));
      if (args[0] === "pr" && args[1] === "diff") {
        return { stdout: opts.prDiff.stdout ?? "", stderr: opts.prDiff.stderr ?? "", exitCode: opts.prDiff.exitCode };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: opts.view?.stdout ?? VIEW_JSON, stderr: opts.view?.stderr ?? "", exitCode: opts.view?.exitCode ?? 0 };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: "main\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1]?.includes("/compare/")) {
        return { stdout: `${"c".repeat(40)}\n`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1]?.includes("/pulls/123/files")) {
        return { stdout: opts.files?.stdout ?? "", stderr: opts.files?.stderr ?? "", exitCode: opts.files?.exitCode ?? 1 };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, exitCode: 1 };
    },
  };
  return { runtime, calls };
}

describe("fetchGhPR", () => {
  test("uses gh pr diff verbatim when it succeeds and never touches the files API", async () => {
    const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const { runtime, calls } = githubRuntime({ prDiff: { exitCode: 0, stdout: patch } });

    const result = await fetchGhPR(runtime, REF);

    expect(result.rawPatch).toBe(patch);
    expect(result.metadata).toMatchObject({
      platform: "github",
      number: 123,
      baseBranch: "main",
      headBranch: "feature",
      mergeBaseSha: "c".repeat(40),
    });
    expect(calls.some((c) => c.includes("/pulls/123/files"))).toBe(false);
  });

  test("falls back to the paginated files API when gh pr diff fails (oversized PR)", async () => {
    // Two concatenated pages — the actual shape `gh api --paginate` emits.
    const page1 = JSON.stringify([
      { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
    ]);
    const page2 = JSON.stringify([
      { filename: "src/b.ts", status: "added", patch: "@@ -0,0 +1 @@\n+hello" },
    ]);
    const { runtime, calls } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "diff exceeded the maximum number of lines (20000)" },
      files: { exitCode: 0, stdout: page1 + page2 },
    });

    const result = await fetchGhPR(runtime, REF);

    expect(calls).toContain("gh api repos/o/r/pulls/123/files?per_page=100 --paginate");
    expect(result.rawPatch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(result.rawPatch).toContain("+new");
    expect(result.rawPatch).toContain("diff --git a/src/b.ts b/src/b.ts");
    expect(result.rawPatch).toContain("new file mode 100644");
    // Every entry carried a patch — nothing is missing, no upgrade needed.
    expect(result.patchIncomplete).toBeFalsy();
    // Metadata path is unaffected by the fallback.
    expect(result.metadata).toMatchObject({ number: 123, mergeBaseSha: "c".repeat(40) });
  });

  test("flags the patch incomplete when GitHub omits content for non-rename entries", async () => {
    // The real shape from oversized PRs: status added/modified with zeroed
    // counts and no patch field at all.
    const entries = JSON.stringify([
      { filename: "src/big.rs", status: "added" },
      { filename: "src/also.zig", status: "modified" },
      { filename: "src/ok.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);
    const { runtime } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "406" },
      files: { exitCode: 0, stdout: entries },
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fetchGhPR(runtime, REF);
      expect(result.patchIncomplete).toBe(true);
      const warned = errSpy.mock.calls.some((args) => String(args[0]).includes("omitted diff content for 2 file(s)"));
      expect(warned).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("pure renames without patches are complete information — not flagged", async () => {
    const entries = JSON.stringify([
      { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" },
      { filename: "src/ok.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);
    const { runtime } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "406" },
      files: { exitCode: 0, stdout: entries },
    });

    const result = await fetchGhPR(runtime, REF);
    expect(result.patchIncomplete).toBeFalsy();
  });

  test("never flags the verbatim gh pr diff path as incomplete", async () => {
    const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const { runtime } = githubRuntime({ prDiff: { exitCode: 0, stdout: patch } });

    const result = await fetchGhPR(runtime, REF);
    expect(result.patchIncomplete).toBeFalsy();
  });

  test("passes --hostname to the files API on GitHub Enterprise", async () => {
    const { runtime, calls } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "406" },
      files: { exitCode: 0, stdout: JSON.stringify([{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }]) },
    });

    await fetchGhPR(runtime, { ...REF, host: "ghe.corp.com" });

    const filesCall = calls.find((c) => c.includes("/pulls/123/files"));
    expect(filesCall).toContain("--hostname ghe.corp.com");
  });

  test("surfaces both errors when gh pr diff and the files API both fail", async () => {
    const { runtime } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "diff too large" },
      files: { exitCode: 1, stderr: "files boom" },
    });

    await expect(fetchGhPR(runtime, REF)).rejects.toThrow(/diff too large.*files boom|files boom.*diff too large/s);
  });

  test("throws a clear empty-diff error when the files API returns no entries", async () => {
    const { runtime } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "406" },
      files: { exitCode: 0, stdout: "[]" },
    });

    await expect(fetchGhPR(runtime, REF)).rejects.toThrow(/PR diff is empty/);
  });

  test("warns when the files API returns fewer files than the PR reports (3000-file cap)", async () => {
    const view = JSON.parse(VIEW_JSON);
    view.changedFiles = 3500;
    const { runtime } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "406" },
      files: { exitCode: 0, stdout: JSON.stringify([{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }]) },
      view: { exitCode: 0, stdout: JSON.stringify(view) },
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fetchGhPR(runtime, REF);
      expect(result.rawPatch).toContain("diff --git a/a.ts b/a.ts"); // partial diff still served
      expect(result.patchIncomplete).toBe(true); // 3000-file cap → upgrade offered
      const warned = errSpy.mock.calls.some((args) => String(args[0]).includes("3500 changed files"));
      expect(warned).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("metadata failure wins over diff failure — no fallback attempted", async () => {
    const { runtime, calls } = githubRuntime({
      prDiff: { exitCode: 1, stderr: "406" },
      files: { exitCode: 0, stdout: "[]" },
      view: { exitCode: 1, stderr: "no such PR" },
    });

    await expect(fetchGhPR(runtime, REF)).rejects.toThrow(/Failed to fetch PR metadata/);
    expect(calls.some((c) => c.includes("/pulls/123/files"))).toBe(false);
  });
});

describe("reconstructGhPatch", () => {
  test("modified file round-trips through the real diff header parsers", () => {
    const patch = reconstructGhPatch([
      { filename: "src/app.ts", status: "modified", patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n context" },
    ]);

    const lines = patch.split("\n");
    expect(lines[0]).toBe("diff --git a/src/app.ts b/src/app.ts");
    expect(parseDiffGitHeader(lines[0])).toEqual({ oldPath: "src/app.ts", newPath: "src/app.ts" });
    expect(parseDiffFilePathLines(lines)).toEqual({ oldPath: "src/app.ts", newPath: "src/app.ts" });
    expect(patch).toContain("\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n");
    expect(patch.endsWith("\n")).toBe(true);
  });

  test("added file uses /dev/null for the old side and new file mode", () => {
    const patch = reconstructGhPatch([
      { filename: "new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+x" },
    ]);

    expect(patch).toContain("diff --git a/new.ts b/new.ts");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("\n--- /dev/null\n+++ b/new.ts\n");
  });

  test("removed file uses /dev/null for the new side and deleted file mode", () => {
    const patch = reconstructGhPatch([
      { filename: "gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-x" },
    ]);

    expect(patch).toContain("diff --git a/gone.ts b/gone.ts");
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("\n--- a/gone.ts\n+++ /dev/null\n");
  });

  test("renamed file emits rename metadata that the real parser extracts", () => {
    const patch = reconstructGhPatch([
      { filename: "after.ts", previous_filename: "before.ts", status: "renamed", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);

    const lines = patch.split("\n");
    expect(lines[0]).toBe("diff --git a/before.ts b/after.ts");
    expect(parseDiffGitHeader(lines[0])).toEqual({ oldPath: "before.ts", newPath: "after.ts" });
    expect(parseDiffMetadataPathLines(lines)).toEqual({ oldPath: "before.ts", newPath: "after.ts" });
    // Pierre's parser classifies renames off the similarity line — a patched
    // rename must carry a sub-100% score or it renders as a plain change.
    expect(lines[1]).toBe("similarity index 99%");
  });

  test("pure rename (no patch field) emits a header-only section", () => {
    const patch = reconstructGhPatch([
      { filename: "after.ts", previous_filename: "before.ts", status: "renamed" },
    ]);

    expect(patch).toBe(
      "diff --git a/before.ts b/after.ts\nsimilarity index 100%\nrename from before.ts\nrename to after.ts\n",
    );
  });

  test("entry without patch (binary / per-file too large) doesn't corrupt the next file's section", () => {
    const patch = reconstructGhPatch([
      { filename: "huge.json", status: "modified" },
      { filename: "small.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);

    // Every diff --git header must start at the beginning of its own line —
    // this is what the UI's file splitter (split on /^diff --git /) relies on.
    const headerLines = patch.split("\n").filter((l) => l.startsWith("diff --git "));
    expect(headerLines).toEqual([
      "diff --git a/huge.json b/huge.json",
      "diff --git a/small.ts b/small.ts",
    ]);
    expect(patch).toContain("diff --git a/huge.json b/huge.json\ndiff --git a/small.ts");
  });

  test("terminates a patch that lacks a trailing newline (GitHub omits it)", () => {
    const patch = reconstructGhPatch([
      { filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
      { filename: "b.ts", status: "modified", patch: "@@ -1 +1 @@\n-c\n+d" },
    ]);

    expect(patch).toContain("+b\ndiff --git a/b.ts b/b.ts");
  });

  test("leaves paths with bare spaces unquoted — git parity, so the header parser round-trips them", () => {
    // Git only C-quotes paths containing quotes/backslashes/control chars.
    // Over-quoting (e.g. quoting spaces) breaks parseDiffGitHeader's regex
    // branch and silently drops files downstream.
    const patch = reconstructGhPatch([
      { filename: "docs/my file.md", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);

    const headerLine = patch.split("\n")[0];
    expect(headerLine).toBe("diff --git a/docs/my file.md b/docs/my file.md");
    expect(parseDiffGitHeader(headerLine)).toEqual({ oldPath: "docs/my file.md", newPath: "docs/my file.md" });
  });

  test("pure rename with a space in the new name still yields parseable paths (file must not vanish)", () => {
    // Regression: GitHub omits `patch` for 100%-similarity renames; if the
    // header is unparseable the UI's file splitter drops the file silently.
    const patch = reconstructGhPatch([
      { filename: "docs/road map.md", previous_filename: "docs/roadmap.md", status: "renamed" },
    ]);

    const headerLine = patch.split("\n")[0];
    expect(headerLine).toBe("diff --git a/docs/roadmap.md b/docs/road map.md");
    expect(parseDiffGitHeader(headerLine)).toEqual({ oldPath: "docs/roadmap.md", newPath: "docs/road map.md" });
  });

  test("C-quotes paths containing double quotes, matching git, and the parser round-trips them", () => {
    const patch = reconstructGhPatch([
      { filename: 'he"llo.ts', status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);

    const headerLine = patch.split("\n")[0];
    expect(headerLine).toBe('diff --git "a/he\\"llo.ts" "b/he\\"llo.ts"');
    expect(parseDiffGitHeader(headerLine)).toEqual({ oldPath: 'he"llo.ts', newPath: 'he"llo.ts' });
  });

  test("copied file emits copy metadata", () => {
    const patch = reconstructGhPatch([
      { filename: "copy.ts", previous_filename: "orig.ts", status: "copied", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);

    expect(patch).toContain("similarity index 99%");
    expect(patch).toContain("copy from orig.ts");
    expect(patch).toContain("copy to copy.ts");
    expect(patch.split("\n")[0]).toBe("diff --git a/orig.ts b/copy.ts");
  });
});
