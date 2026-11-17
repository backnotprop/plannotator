/**
 * Bounds on the untracked files one review diff reads (#940).
 *
 * Each untracked file was capped at 5 MB, but not their number or total, so
 * an unignored build or dependency folder made the review server run out of
 * memory building the patch, and the page then showed the demo diff. Guards:
 *  - past MAX_UNTRACKED_REVIEW_FILES, later files (by path) are never read,
 *    and are still listed as marked stubs;
 *  - past MAX_UNTRACKED_REVIEW_TOTAL_BYTES, a file that does not fit is left
 *    out the same way, and a smaller later file that fits is still read;
 *  - the full-payload patch (analysis snapshots, applied with `git apply`)
 *    is never capped;
 *  - the UI labels match the enforced numbers.
 *
 * A scripted Git runtime stands in for Git, so the test needs no thousand real
 * spawns: it answers ls-files with the scripted paths, records every
 * `diff --no-index` (one per file read), and reports the scripted sizes.
 */
import { describe, expect, test } from "bun:test";
import {
  isUntrackedCapStubPatch,
  UNTRACKED_CAP_BYTES_LABEL,
  UNTRACKED_CAP_FILES_LABEL,
} from "./diff-paths";
import {
  getGitSnapshotMaterializationPatch,
  getWorkingTreeDiffFromBase,
  listPatchFiles,
  MAX_REVIEW_FILE_CONTENT_BYTES,
  MAX_UNTRACKED_REVIEW_FILES,
  MAX_UNTRACKED_REVIEW_TOTAL_BYTES,
  type ReviewGitRuntime,
} from "./review-core";
import { parseDiffToFiles } from "@plannotator/core/diff-files";

const ROOT = "/repo";

function scriptedRuntime(sizes: Map<string, number>): { runtime: ReviewGitRuntime; read: string[] } {
  const read: string[] = [];
  const runtime: ReviewGitRuntime = {
    async runGit(args) {
      const command = args[0] === "--no-optional-locks" ? args.slice(1) : args;
      if (command[0] === "rev-parse" && command.includes("--show-toplevel")) {
        return { stdout: `${ROOT}\n`, stderr: "", exitCode: 0 };
      }
      if (command[0] === "ls-files") {
        return { stdout: `${[...sizes.keys()].join("\n")}\n`, stderr: "", exitCode: 0 };
      }
      if (command[0] === "diff" && command.includes("--no-index")) {
        const file = command[command.length - 1];
        read.push(file);
        return {
          stdout: [
            `diff --git a/${file} b/${file}`,
            "new file mode 100644",
            "index 0000000..1111111",
            "--- /dev/null",
            `+++ b/${file}`,
            "@@ -0,0 +1 @@",
            "+x",
            "",
          ].join("\n"),
          stderr: "",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readTextFile() { return null; },
    async getFileInfo(_base, file) {
      const size = sizes.get(file);
      if (size === undefined) return null;
      return { path: `${ROOT}/${file}`, size, mtimeMs: 0, isFile: true, isSymbolicLink: false, isExecutable: false };
    },
    async readLink() { return null; },
  };
  return { runtime, read };
}

function leftOutPaths(patch: string): string[] {
  return parseDiffToFiles(patch).filter((file) => isUntrackedCapStubPatch(file.patch)).map((file) => file.path);
}

describe("untracked files in a review diff are bounded", () => {
  test("past the file count, later files are listed but never read", async () => {
    const sizes = new Map<string, number>();
    const total = MAX_UNTRACKED_REVIEW_FILES + 5;
    for (let i = 0; i < total; i++) sizes.set(`gen/f${String(i).padStart(5, "0")}.js`, 10);
    const { runtime, read } = scriptedRuntime(sizes);

    const patch = await getWorkingTreeDiffFromBase(runtime, "HEAD", ROOT);

    expect(read).toHaveLength(MAX_UNTRACKED_REVIEW_FILES);
    expect(listPatchFiles(patch)).toHaveLength(total);
    const paths = [...sizes.keys()];
    expect(leftOutPaths(patch)).toEqual(paths.slice(MAX_UNTRACKED_REVIEW_FILES));
    expect(read).not.toContain(paths[total - 1]);
  });

  test("past the byte budget, a file that does not fit is left out and a smaller later one is still read", async () => {
    // Under the per-file cap, and leaving room in the budget for a small file.
    const big = MAX_REVIEW_FILE_CONTENT_BYTES - 1024 * 1024;
    const fits = Math.floor(MAX_UNTRACKED_REVIEW_TOTAL_BYTES / big);
    expect(MAX_UNTRACKED_REVIEW_TOTAL_BYTES - fits * big).toBeGreaterThan(100);
    const sizes = new Map<string, number>();
    for (let i = 0; i < fits + 1; i++) sizes.set(`assets/a${String(i).padStart(3, "0")}.bin`, big);
    sizes.set("src/zz-small.ts", 100);
    const { runtime, read } = scriptedRuntime(sizes);

    const patch = await getWorkingTreeDiffFromBase(runtime, "HEAD", ROOT);

    const overBudget = `assets/a${String(fits).padStart(3, "0")}.bin`;
    expect(leftOutPaths(patch)).toEqual([overBudget]);
    expect(read).not.toContain(overBudget);
    expect(read).toContain("src/zz-small.ts");
    expect(listPatchFiles(patch).map((file) => file.path)).toContain(overBudget);
  });

  test("under both bounds nothing is left out", async () => {
    const sizes = new Map([["a.ts", 10], ["b.ts", 20]]);
    const { runtime, read } = scriptedRuntime(sizes);

    const patch = await getWorkingTreeDiffFromBase(runtime, "HEAD", ROOT);

    expect(read).toEqual(["a.ts", "b.ts"]);
    expect(leftOutPaths(patch)).toEqual([]);
  });

  test("the applyable analysis patch still carries every untracked file", async () => {
    const sizes = new Map<string, number>();
    const total = MAX_UNTRACKED_REVIEW_FILES + 3;
    for (let i = 0; i < total; i++) sizes.set(`gen/f${String(i).padStart(5, "0")}.js`, 10);
    const { runtime, read } = scriptedRuntime(sizes);

    const patch = await getGitSnapshotMaterializationPatch(runtime, "unstaged", "main", ROOT);

    expect(read).toHaveLength(total);
    expect(leftOutPaths(patch ?? "")).toEqual([]);
  });

  test("the UI's labels match the enforced bounds", () => {
    expect(UNTRACKED_CAP_FILES_LABEL).toBe(MAX_UNTRACKED_REVIEW_FILES.toLocaleString("en-US"));
    expect(UNTRACKED_CAP_BYTES_LABEL).toBe(`${MAX_UNTRACKED_REVIEW_TOTAL_BYTES / (1024 * 1024)} MB`);
  });
});
