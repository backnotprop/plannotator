import { describe, expect, test } from "bun:test";
import type { PRMetadata } from "./pr-provider";
import type { GitCommandResult, ReviewGitRuntime } from "./review-core";
import { runPRFullStackDiff } from "./pr-stack";

function result(stdout = "", stderr = "", exitCode = 0): GitCommandResult {
  return { stdout, stderr, exitCode };
}

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
      async runGit(args) {
        calls.push(args);
        if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
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
      async runGit(args) {
        if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
          return result("", "", 1);
        }
        if (args[0] === "show-ref" && args[3] === "refs/heads/main") {
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
});
