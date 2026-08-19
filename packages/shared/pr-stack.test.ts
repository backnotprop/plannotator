import { describe, expect, test } from "bun:test";
import type { PRMetadata } from "./pr-types";
import {
  MAX_REVIEW_FILE_CONTENT_BYTES,
  type GitCommandResult,
  type ReviewGitRuntime,
} from "./review-core";
import { runPRFullStackDiff, runPRLayerLocalDiff } from "./pr-stack";

function result(stdout = "", stderr = "", exitCode = 0): GitCommandResult {
  return { stdout, stderr, exitCode };
}

const unavailableFileMethods = {
  async getFileInfo() { return null; },
  async readLink() { return null; },
};

const metadata: PRMetadata = {
  platform: "github",
  host: "github.com",
  owner: "backnotprop",
  repo: "plannotator-stack-fixture",
  number: 3,
  title: "Validate user id",
  author: "backnotprop",
  baseBranch: "stack/auth-refactor",
  headBranch: "stack/validation",
  defaultBranch: "main",
  baseSha: "base",
  headSha: "head",
  url: "https://github.com/backnotprop/plannotator-stack-fixture/pull/3",
};

describe("runPRFullStackDiff", () => {
  test("uses origin default branch when it is available", async () => {
    const calls: string[][] = [];
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args) {
        calls.push(args);
        if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
          return result();
        }
        if (args[0] === "diff" && args.includes("--raw")) {
          return result();
        }
        if (args[0] === "diff") {
          return result("diff --git a/src/auth.ts b/src/auth.ts\n");
        }
        return result("", "unexpected", 1);
      },
      async readTextFile() {
        return null;
      },
    };

    const diff = await runPRFullStackDiff(runtime, metadata, "/tmp/repo");

    expect(diff).toEqual({
      patch: "diff --git a/src/auth.ts b/src/auth.ts\n",
      label: "Full stack diff vs origin/main",
    });
    expect(calls.at(-1)).toEqual([
      "diff",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      "origin/main...HEAD",
    ]);
  });

  test("falls back to a local default branch", async () => {
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args) {
        if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
          return result("", "", 1);
        }
        if (args[0] === "show-ref" && args[3] === "refs/heads/main") {
          return result();
        }
        if (args[0] === "diff" && args.includes("--raw")) {
          return result();
        }
        if (args[0] === "diff") {
          return result("local branch patch");
        }
        return result("", "unexpected", 1);
      },
      async readTextFile() {
        return null;
      },
    };

    const diff = await runPRFullStackDiff(runtime, metadata);

    expect(diff).toEqual({
      patch: "local branch patch",
      label: "Full stack diff vs main",
    });
  });

  test("returns an error when no default branch ref exists locally", async () => {
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit() {
        return result("", "", 1);
      },
      async readTextFile() {
        return null;
      },
    };

    const diff = await runPRFullStackDiff(runtime, metadata);

    expect(diff.patch).toBe("");
    expect(diff.label).toBe("Full stack diff unavailable");
    expect(diff.error).toContain("Could not find origin/main or local main");
  });

  test("omits oversized tracked object content with literal pathspec exclusions", async () => {
    const calls: string[][] = [];
    const oldObjectId = "a".repeat(40);
    const newObjectId = "b".repeat(40);
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        calls.push(args);
        if (args[0] === "show-ref") return result();
        if (args[0] === "cat-file" && args.some((arg) => arg.startsWith("--batch-check"))) {
          return result(
            (options?.stdin ?? "").trim().split("\n").filter(Boolean).map((objectId) =>
              `${objectId} blob ${MAX_REVIEW_FILE_CONTENT_BYTES + 1}`,
            ).join("\n"),
          );
        }
        if (args[0] === "diff" && args.includes("--raw")) {
          return result(
            `:100644 100644 ${oldObjectId} ${newObjectId} M\0large [*]?.txt\0`,
          );
        }
        if (args[0] === "diff" && args.some((arg) => arg.startsWith(":(top,exclude,literal)"))) {
          return result();
        }
        if (args[0] === "diff") return result("x".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1));
        return result("", "unexpected", 1);
      },
      async readTextFile() {
        return null;
      },
    };

    const diff = await runPRFullStackDiff(runtime, metadata, "/repo");

    expect(diff.patch.length).toBeLessThan(2_000);
    expect(diff.patch).toContain("Binary files");
    expect(diff.patch).not.toContain("xxxxxxxxxx");
    expect(calls.some((args) => args[0] === "diff" && args.includes("--raw"))).toBe(true);
    expect(calls.some((args) => args.some((arg) => arg === ":(top,exclude,literal)large [*]?.txt"))).toBe(true);
  });
});

describe("runPRLayerLocalDiff", () => {
  const MERGE_BASE = "a".repeat(40);
  const BASE = "b".repeat(40);
  const HEAD = "c".repeat(40);
  const layerMetadata: PRMetadata = {
    ...metadata,
    baseSha: BASE,
    headSha: HEAD,
    mergeBaseSha: MERGE_BASE,
  };

  function layerRuntime(opts: {
    missingObjects?: Set<string>;
    /** Objects that become available after a `fetch origin -- <sha>` */
    fetchable?: Set<string>;
    diffStdout?: string;
    diffExitCode?: number;
    diffStderr?: string;
  }): { runtime: ReviewGitRuntime; calls: string[][] } {
    const calls: string[][] = [];
    const missing = new Set(opts.missingObjects ?? []);
    return {
      calls,
      runtime: {
        ...unavailableFileMethods,
        async runGit(args) {
          calls.push(args);
          if (args[0] === "cat-file") {
            const sha = args.at(-1)!;
            return missing.has(sha) ? result("", "missing", 1) : result("commit");
          }
          if (args[0] === "fetch") {
            const sha = args.at(-1)!;
            if (opts.fetchable?.has(sha)) missing.delete(sha);
            return result();
          }
          if (args[0] === "diff" && args.includes("--raw")) {
            return result();
          }
          if (args[0] === "diff") {
            return result(
              opts.diffStdout ?? "diff --git a/x.ts b/x.ts\n",
              opts.diffStderr ?? "",
              opts.diffExitCode ?? 0,
            );
          }
          return result("", "unexpected", 1);
        },
        async readTextFile() {
          return null;
        },
      },
    };
  }

  test("diffs the platform merge-base against the PR head (exact layer diff)", async () => {
    const { runtime, calls } = layerRuntime({});
    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/tmp/checkout");

    expect(diff.error).toBeUndefined();
    expect(diff.patch).toBe("diff --git a/x.ts b/x.ts\n");
    expect(calls.at(-1)).toEqual([
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "-l100000",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      MERGE_BASE,
      HEAD,
    ]);
  });

  test("fetches a missing merge-base by SHA before diffing (shallow clone)", async () => {
    const { runtime, calls } = layerRuntime({
      missingObjects: new Set([MERGE_BASE]),
      fetchable: new Set([MERGE_BASE]),
    });
    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/tmp/checkout");

    expect(diff.error).toBeUndefined();
    expect(calls.some((c) => c[0] === "fetch" && c.at(-1) === MERGE_BASE)).toBe(true);
    expect(calls.at(-1)?.slice(-2)).toEqual([MERGE_BASE, HEAD]);
  });

  test("falls back to three-dot against baseSha when the merge-base is unavailable", async () => {
    const { runtime, calls } = layerRuntime({ missingObjects: new Set([MERGE_BASE]) });
    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/tmp/checkout");

    expect(diff.error).toBeUndefined();
    expect(calls.at(-1)?.at(-1)).toBe(`${BASE}...${HEAD}`);
  });

  test("falls back to three-dot when no merge-base SHA is reported (GitLab)", async () => {
    const { runtime, calls } = layerRuntime({});
    const noMergeBase: PRMetadata = { ...layerMetadata };
    delete (noMergeBase as { mergeBaseSha?: string }).mergeBaseSha;
    const diff = await runPRLayerLocalDiff(runtime, noMergeBase, "/tmp/checkout");

    expect(diff.error).toBeUndefined();
    expect(calls.at(-1)?.at(-1)).toBe(`${BASE}...${HEAD}`);
  });

  test("errors when the PR head cannot be made available", async () => {
    const { runtime } = layerRuntime({ missingObjects: new Set([HEAD]) });
    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/tmp/checkout");

    expect(diff.patch).toBe("");
    expect(diff.error).toContain("not available in the local checkout");
  });

  test("errors when neither merge-base nor baseSha resolve locally", async () => {
    const { runtime } = layerRuntime({ missingObjects: new Set([MERGE_BASE, BASE]) });
    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/tmp/checkout");

    expect(diff.patch).toBe("");
    expect(diff.error).toContain("Could not resolve the PR base commit");
  });

  test("surfaces git diff failures and never returns a partial patch", async () => {
    const { runtime } = layerRuntime({ diffExitCode: 128, diffStderr: "fatal: bad object\nmore" });
    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/tmp/checkout");

    expect(diff.patch).toBe("");
    expect(diff.error).toBe("fatal: bad object");
  });

  test("treats an empty recompute as an error (must not blank a working review)", async () => {
    const { runtime } = layerRuntime({ diffStdout: "" });
    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/tmp/checkout");

    expect(diff.error).toContain("empty diff");
  });

  test("rejects an invalid head SHA without running git", async () => {
    const { runtime, calls } = layerRuntime({});
    const bad: PRMetadata = { ...layerMetadata, headSha: "HEAD; rm -rf /" };
    const diff = await runPRLayerLocalDiff(runtime, bad, "/tmp/checkout");

    expect(diff.error).toContain("Invalid PR head SHA");
    expect(calls.length).toBe(0);
  });

  test("omits oversized layer objects before rendering their patch", async () => {
    const calls: string[][] = [];
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        calls.push(args);
        if (args[0] === "cat-file" && args[1] === "-t") return result();
        if (args[0] === "cat-file" && args[1] === "-s") {
          return result(`${MAX_REVIEW_FILE_CONTENT_BYTES + 1}\n`);
        }
        if (args[0] === "cat-file" && args.some((arg) => arg.startsWith("--batch-check"))) {
          return result(
            (options?.stdin ?? "").trim().split("\n").filter(Boolean).map((objectId) =>
              `${objectId} blob ${MAX_REVIEW_FILE_CONTENT_BYTES + 1}`,
            ).join("\n"),
          );
        }
        if (args[0] === "diff" && args.includes("--raw")) {
          return result(
            `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} A\0large [*]?.txt\0`,
          );
        }
        if (args[0] === "diff" && args.some((arg) => arg.startsWith(":(top,exclude,literal)"))) {
          return result();
        }
        if (args[0] === "diff") return result("x".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1));
        return result("", "unexpected", 1);
      },
      async readTextFile() {
        return null;
      },
    };

    const diff = await runPRLayerLocalDiff(runtime, layerMetadata, "/repo");

    expect(diff.patch.length).toBeLessThan(2_000);
    expect(diff.patch).toContain("Binary files");
    expect(diff.patch).not.toContain("xxxxxxxxxx");
    expect(calls.some((args) => args[0] === "diff" && args.includes("--raw"))).toBe(true);
  });
});
