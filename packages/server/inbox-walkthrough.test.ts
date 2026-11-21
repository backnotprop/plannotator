/**
 * A walkthrough's read: what an agent names becomes a patch of context lines, or a refusal that says which file. The
 * read is the same for an agent here and a paired cloud agent: a .env file is never read (as named or through a link),
 * nothing outside the folder is, and no file past its cap, nor more than the guide's cap in all, is read whole.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { INBOX_WALKTHROUGH_FILE_MAX_BYTES, INBOX_WALKTHROUGH_TOTAL_MAX_BYTES, readInboxWalkthrough, walkthroughFilePatch, walkthroughRangesOf } from "./inbox-walkthrough";
import { registerInboxGuideTools } from "./inbox-guides";
import type { InboxMcpContext } from "./inbox-mcp";

const folder = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-walkthrough-")));
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/retry.ts"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(root, "secret.txt"), "not the project's\n");
  return { root, project };
};
const guideOf = (diffs: unknown[], extra: Record<string, unknown> = {}) => ({ title: "How retries work", intent: "Follow one.", sections: [{ title: "The loop", overview: "It waits.", diffs }], ...extra });
const refused = (read: ReturnType<typeof readInboxWalkthrough>) => (read.ok ? "" : read.error);

describe("lines", () => {
  test("the shapes a real agent writes all read the same", () => {
    for (const lines of ["10-40, 80-95", "L10-L40,L80-L95", "10..40, 80–95", ["10-40", "80-95"], [[10, 40], [80, 95]]]) {
      expect(walkthroughRangesOf(lines)).toEqual([[10, 40], [80, 95]]);
    }
    expect(walkthroughRangesOf("12")).toEqual([[12, 12]]);
    expect(walkthroughRangesOf(12)).toEqual([[12, 12]]);
    expect(walkthroughRangesOf([10, 40])).toEqual([[10, 40]]);
  });

  test("what isn't lines is null, not a guess", () => {
    for (const lines of ["the loop", "40-10", 0, -3, [], "10-", {}]) expect(walkthroughRangesOf(lines)).toBeNull();
  });
});

describe("the patch", () => {
  test("only context lines at the real line numbers, so nothing reads as changed", () => {
    const patch = walkthroughFilePatch("a b.ts", "one\ntwo\nthree\nfour\nfive\n", [[2, 3], [5, 5]]) as string;
    const [file] = parseDiffToFiles(patch);
    expect(file).toMatchObject({ path: "a b.ts", additions: 0, deletions: 0 });
    expect(patch).toContain("@@ -2,2 +2,2 @@\n two\n three\n");
    expect(patch).toContain("@@ -5,1 +5,1 @@\n five\n");
    expect(patch).not.toContain("one");
    expect(patch).not.toContain("four");
  });

  test("overlapping ranges are one hunk, in order, and a range past the end stops there", () => {
    expect(walkthroughFilePatch("x", "1\n2\n3\n4\n5\n", [[4, 90], [1, 2], [2, 3]])).toBe(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n 1\n 2\n 3\n 4\n 5\n",
    );
  });

  test("a file with no last newline says so, only when its last line shows", () => {
    expect(walkthroughFilePatch("x", "1\n2", null)).toContain(" 2\n\\ No newline at end of file\n");
    expect(walkthroughFilePatch("x", "1\n2", [[1, 1]])).not.toContain("No newline");
  });

  test("a start past the end, and an empty file, are refused by name", () => {
    expect(walkthroughFilePatch("x", "1\n2\n", [[9, 12]])).toEqual({ error: "x has 2 lines, so line 9 isn't there." });
    expect(walkthroughFilePatch("x", "", null)).toEqual({ error: "x is empty." });
  });
});

describe("reading a guide", () => {
  test("files and lines become the patch, `lines` and `unplacedFiles` leave the guide, and no lines is the whole file", () => {
    const { project } = folder();
    writeFileSync(join(project, "short.ts"), "a\nb\n");
    const read = readInboxWalkthrough(guideOf([{ file: "src/retry.ts", lines: "3-4", summary: "The wait." }, { file: "./short.ts", summary: "All of it." }], { unplacedFiles: ["nope.ts"] }), [project]);
    if (!read.ok) throw new Error(read.error);
    expect(parseDiffToFiles(read.patch).map((file) => file.path)).toEqual(["src/retry.ts", "short.ts"]);
    expect(read.patch).toContain(" line 3\n line 4\n");
    expect(read.patch).not.toContain(" line 5\n");
    expect(read.patch).toContain(" a\n b\n");
    expect(read.guide.unplacedFiles).toBeUndefined();
    expect((read.guide.sections as { diffs: unknown[] }[])[0]!.diffs).toEqual([{ file: "src/retry.ts", summary: "The wait." }, { file: "short.ts", summary: "All of it." }]);
  });

  test("looks in the agent's own folder first: a worktree's copy, not the project root's", () => {
    const { root, project } = folder();
    const worktree = join(root, "worktree");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src/retry.ts"), "the worktree's\n");
    const read = readInboxWalkthrough(guideOf([{ file: "src/retry.ts" }]), [worktree, project]);
    expect(read.ok && read.patch).toContain(" the worktree's\n");
  });

  test("a file in only the project is still found from a subfolder's agent", () => {
    const { project } = folder();
    const read = readInboxWalkthrough(guideOf([{ file: "src/retry.ts", lines: 1 }]), [join(project, "src"), project]);
    expect(read.ok && read.patch).toContain(" line 1\n");
  });

  test("nothing outside the folder is read, by path or through a link", () => {
    const { root, project } = folder();
    symlinkSync(join(root, "secret.txt"), join(project, "link.txt"));
    for (const file of ["../secret.txt", join(root, "secret.txt"), "link.txt"]) {
      const read = readInboxWalkthrough(guideOf([{ file }]), [project]);
      expect(refused(read)).toBe(`${file} isn't a file in the project.`);
    }
  });

  test("a .env file is never read, by its name or through a link to one; a hidden folder inside the project still is", () => {
    const { project } = folder();
    writeFileSync(join(project, ".env"), "TOKEN=secret\n");
    writeFileSync(join(project, ".env.local"), "TOKEN=secret\n");
    symlinkSync(join(project, ".env"), join(project, "settings.txt"));
    for (const file of [".env", ".env.local", "settings.txt"]) {
      const read = readInboxWalkthrough(guideOf([{ file }]), [project]);
      expect(refused(read)).toBe(`${file}: .env files are never read into a walkthrough (they hold secrets).`);
    }
    mkdirSync(join(project, ".github"), { recursive: true });
    writeFileSync(join(project, ".github", "ci.yml"), "on: push\n");
    const read = readInboxWalkthrough(guideOf([{ file: ".github/ci.yml" }]), [project]);
    expect(read.ok && read.patch).toContain(" on: push");
  });

  test("a file past the per-file cap, or files past the guide's cap in all, are refused by name, never read whole", () => {
    const { project } = folder();
    expect([INBOX_WALKTHROUGH_FILE_MAX_BYTES, INBOX_WALKTHROUGH_TOTAL_MAX_BYTES]).toEqual([5 * 1024 * 1024, 16 * 1024 * 1024]);
    writeFileSync(join(project, "huge.ts"), Buffer.alloc(INBOX_WALKTHROUGH_FILE_MAX_BYTES + 1, "a"));
    expect(refused(readInboxWalkthrough(guideOf([{ file: "huge.ts", lines: "1" }]), [project]))).toBe("huge.ts is larger than 5 MB, the most a walkthrough reads of one file. Name a smaller file, or send guide with patch instead.");
    // Four files of 4.5 MB: each under its cap, the fourth past the guide's 16 MB.
    const part = Buffer.alloc(4.5 * 1024 * 1024, "b");
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) writeFileSync(join(project, name), part);
    expect(refused(readInboxWalkthrough(guideOf([{ file: "a.ts", lines: "1" }, { file: "b.ts", lines: "1" }, { file: "c.ts", lines: "1" }, { file: "d.ts", lines: "1" }]), [project]))).toBe(
      "d.ts: the files this walkthrough names come to more than 16 MB, the most one reads. Name fewer or smaller files, or send guide with patch instead.",
    );
    expect(readInboxWalkthrough(guideOf([{ file: "a.ts", lines: "1" }, { file: "b.ts", lines: "1" }, { file: "c.ts", lines: "1" }]), [project]).ok).toBe(true);
  });

  test("every problem at once, each by name: a missing file, bad lines, a binary", () => {
    const { project } = folder();
    writeFileSync(join(project, "logo.png"), Buffer.from([1, 0, 2]));
    expect(refused(readInboxWalkthrough(guideOf([{ file: "gone.ts" }, { file: "src/retry.ts", lines: "the loop" }]), [project]))).toBe(
      'gone.ts isn\'t a file in the project.\nsrc/retry.ts: `lines` should look like "10-40" or "10-40, 80-95".',
    );
    expect(refused(readInboxWalkthrough(guideOf([{ file: "logo.png" }]), [project]))).toBe("logo.png isn't text.");
  });

  test("a guide with no file, or not a guide, says what to send", () => {
    const { project } = folder();
    expect(refused(readInboxWalkthrough(guideOf([]), [project]))).toContain("Name at least one file");
    expect(refused(readInboxWalkthrough("{not json", [project]))).toContain("isn't valid JSON");
    expect(refused(readInboxWalkthrough({ title: "t" }, [project]))).toContain("guide.sections");
  });
});

// The owner: a walkthrough is part of code review, so with Code review off an agent gets nothing about it.
describe("Code review off: nothing of walkthroughs reaches an agent", () => {
  type Tool = { config: { description: string; inputSchema: { shape: Record<string, { description?: string }> } }; handler: (input: unknown, ctx: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> };
  const toolsWith = (on: boolean) => {
    const { project } = folder();
    const tools = new Map<string, Tool>();
    const server = { registerTool: (name: string, config: Tool["config"], handler: Tool["handler"]) => void tools.set(name, { config, handler }) };
    const context = {
      codeReviewOn: () => on,
      walkthroughThread: () => true,
      resolveProject: async () => ({ id: "prj_1", key: "project", name: "project", root: project, created_at: "" }),
      store: {},
    } as unknown as InboxMcpContext;
    registerInboxGuideTools(server as never, context);
    return { tools, project };
  };
  const words = (tool: Tool) => [tool.config.description, ...Object.entries(tool.config.inputSchema.shape).flatMap(([key, field]) => [key, field.description ?? ""])].join("\n");

  test("submit_guide and get_guide_brief name no walkthrough while off; on, submit_guide has the field", async () => {
    const off = toolsWith(false).tools;
    for (const name of ["submit_guide", "get_guide_brief"]) expect(words(off.get(name)!)).not.toMatch(/walkthrough/i);
    const brief = await off.get("get_guide_brief")!.handler({}, {});
    expect(JSON.stringify(brief)).not.toMatch(/walkthrough/i);
    expect(Object.keys(toolsWith(true).tools.get("submit_guide")!.config.inputSchema.shape)).toContain("walkthrough");
  });

  test("a stale session's `walkthrough: true` while off gets no line about walkthroughs", async () => {
    const { tools } = toolsWith(false);
    const result = await tools.get("submit_guide")!.handler({ project_path: "/x", walkthrough: true, guide: guideOf([{ file: "src/retry.ts", lines: "3-4", summary: "The wait." }]) }, {});
    expect(result.isError).toBe(true);
    expect(result.content.map((part) => part.text).join("\n")).not.toMatch(/walkthrough/i);
    expect(result.content[0]!.text).not.toContain("code_review_off");
  });
});
