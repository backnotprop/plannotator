import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGlMR, fetchGlMRContext, parsePaginatedArray, submitGlMRReview } from "./pr-gitlab";
import type { PRReviewFileComment, PRRuntime } from "./pr-types";

describe("fetchGlMR", () => {
  test("uses GitLab raw diffs so binary markers and collapsed files are preserved", async () => {
    const calls: string[] = [];
    const rawPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -0,0 +1,3 @@",
      "+export function created() {",
      "+  return true;",
      "+}",
      "diff --git a/package-lock.json b/package-lock.json",
      "index 2222222222222222222222222222222222222222..3333333333333333333333333333333333333333 100644",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1,3 +1,3 @@",
      "-  \"old\": true",
      "+  \"new\": true",
      "diff --git a/tests/snap.png b/tests/snap.png",
      "new file mode 100644",
      "index 0000000000000000000000000000000000000000..4444444444444444444444444444444444444444",
      "Binary files /dev/null and b/tests/snap.png differ",
      "",
    ].join("\n");

    const runtime: PRRuntime = {
      async runCommand(command, args) {
        calls.push([command, ...args].join(" "));
        const endpoint = args[1];
        if (endpoint === "projects/group%2Fproject/merge_requests/42/raw_diffs") {
          return {
            stdout: rawPatch,
            stderr: "",
            exitCode: 0,
          };
        }
        if (endpoint === "projects/group%2Fproject/merge_requests/42") {
          return {
            stdout: JSON.stringify({
              title: "Add app",
              author: { username: "reviewer" },
              source_branch: "feature/app",
              target_branch: "main",
              diff_refs: {
                base_sha: "a".repeat(40),
                head_sha: "b".repeat(40),
                start_sha: "a".repeat(40),
              },
              web_url: "https://gitlab.com/group/project/-/merge_requests/42",
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (endpoint === "projects/group%2Fproject") {
          return {
            stdout: JSON.stringify({ default_branch: "main" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: `unexpected endpoint: ${endpoint}`, exitCode: 1 };
      },
    };

    const result = await fetchGlMR(runtime, {
      platform: "gitlab",
      host: "gitlab.com",
      projectPath: "group/project",
      iid: 42,
    });

    expect(result.metadata).toMatchObject({
      platform: "gitlab",
      projectPath: "group/project",
      iid: 42,
      baseBranch: "main",
      headBranch: "feature/app",
    });
    expect(result.rawPatch).toBe(rawPatch);
    expect(result.rawPatch).toContain("diff --git a/package-lock.json b/package-lock.json");
    expect(result.rawPatch).toContain("Binary files /dev/null and b/tests/snap.png differ");
    expect(calls).toContain("glab api projects/group%2Fproject/merge_requests/42/raw_diffs");
    expect(calls.some((call) => call.includes("/diffs?per_page=100"))).toBe(false);
  });
});

// --- raw_diffs → JSON /diffs fallback (older self-hosted GitLab + oversized MRs) ---

const REF = { platform: "gitlab" as const, host: "gitlab.com", projectPath: "g/p", iid: 1 };

const DIFF_ENTRIES_JSON = JSON.stringify([
  {
    old_path: "src/a.ts",
    new_path: "src/a.ts",
    new_file: false,
    deleted_file: false,
    renamed_file: false,
    diff: "@@ -1 +1 @@\n-old\n+new\n",
  },
]);

function gitlabRuntime(opts: {
  rawDiffs: { stdout?: string; stderr?: string; exitCode: number };
  diffs?: { stdout?: string; stderr?: string; exitCode: number };
}): { runtime: PRRuntime; calls: string[] } {
  const calls: string[] = [];
  const metadata = JSON.stringify({
    title: "T",
    author: { username: "u" },
    source_branch: "feature",
    target_branch: "main",
    diff_refs: { base_sha: "a".repeat(40), head_sha: "b".repeat(40), start_sha: "a".repeat(40) },
    web_url: "https://gitlab.com/g/p/-/merge_requests/1",
  });
  const runtime: PRRuntime = {
    async runCommand(command, args) {
      calls.push([command, ...args].join(" "));
      const endpoint = args[1] ?? "";
      if (endpoint.endsWith("/raw_diffs")) {
        return { stdout: opts.rawDiffs.stdout ?? "", stderr: opts.rawDiffs.stderr ?? "", exitCode: opts.rawDiffs.exitCode };
      }
      if (endpoint.includes("/diffs?per_page=100")) {
        return { stdout: opts.diffs?.stdout ?? "", stderr: opts.diffs?.stderr ?? "", exitCode: opts.diffs?.exitCode ?? 1 };
      }
      if (/merge_requests\/\d+$/.test(endpoint)) {
        return { stdout: metadata, stderr: "", exitCode: 0 };
      }
      if (/^projects\/[^/]+$/.test(endpoint)) {
        return { stdout: JSON.stringify({ default_branch: "main" }), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unexpected endpoint: ${endpoint}`, exitCode: 1 };
    },
  };
  return { runtime, calls };
}

describe("fetchGlMR raw_diffs fallback", () => {
  test("falls back to the JSON diffs API when raw_diffs is unavailable (older GitLab)", async () => {
    const { runtime, calls } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "404 Not Found" },
      diffs: { exitCode: 0, stdout: DIFF_ENTRIES_JSON },
    });
    const result = await fetchGlMR(runtime, REF);
    expect(result.rawPatch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(result.rawPatch).toContain("+new");
    expect(calls.some((c) => c.includes("/diffs?per_page=100"))).toBe(true);
  });

  test("reconstructed renames carry a similarity line so parsers classify them as renames", async () => {
    const entries = JSON.stringify([
      {
        old_path: "src/old.ts",
        new_path: "src/new.ts",
        new_file: false,
        deleted_file: false,
        renamed_file: true,
        diff: "", // pure rename — GitLab sends an empty diff
      },
      {
        old_path: "src/before.ts",
        new_path: "src/after.ts",
        new_file: false,
        deleted_file: false,
        renamed_file: true,
        diff: "@@ -1 +1 @@\n-a\n+b\n",
      },
    ]);
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "404 Not Found" },
      diffs: { exitCode: 0, stdout: entries },
    });
    const result = await fetchGlMR(runtime, REF);
    expect(result.rawPatch).toContain(
      "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts",
    );
    expect(result.rawPatch).toContain(
      "diff --git a/src/before.ts b/src/after.ts\nsimilarity index 99%\nrename from src/before.ts\nrename to src/after.ts",
    );
  });

  test("falls back when raw_diffs returns empty (oversized MR)", async () => {
    const { runtime, calls } = gitlabRuntime({
      rawDiffs: { exitCode: 0, stdout: "" },
      diffs: { exitCode: 0, stdout: DIFF_ENTRIES_JSON },
    });
    const result = await fetchGlMR(runtime, REF);
    expect(result.rawPatch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(calls.some((c) => c.includes("/diffs?per_page=100"))).toBe(true);
  });

  test("flags the patch incomplete when GitLab withholds content for a modified file", async () => {
    const entries = JSON.stringify([
      {
        old_path: "src/big.ts",
        new_path: "src/big.ts",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        diff: "", // modified file with no content = withheld
      },
      {
        old_path: "src/old.ts",
        new_path: "src/new.ts",
        new_file: false,
        deleted_file: false,
        renamed_file: true,
        diff: "", // pure rename — complete information, must not flag
      },
    ]);
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "404 Not Found" },
      diffs: { exitCode: 0, stdout: entries },
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fetchGlMR(runtime, REF);
      expect(result.patchIncomplete).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("too_large/collapsed flags catch withheld ADDED files (modern GitLab)", async () => {
    // A too-large added file has new_file:true and an empty diff — without
    // the explicit flag it would be indistinguishable from a legitimately
    // empty new file and the upgrade would never be offered.
    const entries = JSON.stringify([
      {
        old_path: "src/huge.ts",
        new_path: "src/huge.ts",
        new_file: true,
        deleted_file: false,
        renamed_file: false,
        too_large: true,
        collapsed: false,
        diff: "",
      },
    ]);
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "404 Not Found" },
      diffs: { exitCode: 0, stdout: entries },
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fetchGlMR(runtime, REF);
      expect(result.patchIncomplete).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("null too_large/collapsed are inconclusive — the legacy heuristic still decides", async () => {
    const entries = JSON.stringify([
      {
        old_path: "src/big.ts",
        new_path: "src/big.ts",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        too_large: null,
        collapsed: null,
        diff: "", // modified file, no content, flags unknown → withheld
      },
    ]);
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "404 Not Found" },
      diffs: { exitCode: 0, stdout: entries },
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fetchGlMR(runtime, REF);
      expect(result.patchIncomplete).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("explicit too_large:false exonerates empty-diff entries (binary/empty files, modern GitLab)", async () => {
    const entries = JSON.stringify([
      {
        old_path: "logo.png",
        new_path: "logo.png",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        too_large: false,
        collapsed: false,
        diff: "", // binary — complete information, must not flag
      },
      {
        old_path: "src/ok.ts",
        new_path: "src/ok.ts",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        too_large: false,
        collapsed: false,
        diff: "@@ -1 +1 @@\n-a\n+b\n",
      },
    ]);
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "404 Not Found" },
      diffs: { exitCode: 0, stdout: entries },
    });
    const result = await fetchGlMR(runtime, REF);
    expect(result.patchIncomplete).toBeFalsy();
  });

  test("does not flag a fallback where every entry carries content", async () => {
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "404 Not Found" },
      diffs: { exitCode: 0, stdout: DIFF_ENTRIES_JSON },
    });
    const result = await fetchGlMR(runtime, REF);
    expect(result.patchIncomplete).toBeFalsy();
  });

  test("throws a clear empty-diff error when both raw_diffs and diffs are empty", async () => {
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 0, stdout: "" },
      diffs: { exitCode: 0, stdout: "[]" },
    });
    await expect(fetchGlMR(runtime, REF)).rejects.toThrow(/MR diff is empty/);
  });

  test("throws a combined error when both raw_diffs and diffs fail", async () => {
    const { runtime } = gitlabRuntime({
      rawDiffs: { exitCode: 1, stderr: "raw boom" },
      diffs: { exitCode: 1, stderr: "diffs boom" },
    });
    await expect(fetchGlMR(runtime, REF)).rejects.toThrow(/Failed to fetch MR diff/);
  });
});

describe("fetchGlMRContext", () => {
  test("throws when the primary MR details request fails", async () => {
    const runtime: PRRuntime = {
      async runCommand(_command, args) {
        const endpoint = args[1] ?? "";
        if (endpoint === "projects/g%2Fp/merge_requests/1") {
          return { stdout: "", stderr: "429 Too Many Requests", exitCode: 1 };
        }
        return { stdout: "[]", stderr: "", exitCode: 0 };
      },
    };

    await expect(fetchGlMRContext(runtime, REF)).rejects.toThrow(
      "Failed to fetch MR context: 429 Too Many Requests",
    );
  });

  test("normalizes resolved discussions as review threads without duplicating their notes", async () => {
    const calls: string[] = [];
    const runtime: PRRuntime = {
      async runCommand(command, args) {
        calls.push([command, ...args].join(" "));
        const endpoint = args[1] ?? "";
        if (endpoint === "projects/g%2Fp/merge_requests/1") {
          return {
            stdout: JSON.stringify({
              title: "Artifacts",
              description: "",
              state: "opened",
              author: { username: "author" },
              web_url: "https://gitlab.com/g/p/-/merge_requests/1",
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (endpoint.endsWith("/discussions?per_page=100")) {
          return {
            stdout: JSON.stringify([
              {
                id: "discussion-1",
                individual_note: false,
                notes: [
                  {
                    id: 101,
                    body: "![resolved artifact](/uploads/hash/resolved.png)",
                    author: { username: "reviewer" },
                    created_at: "2026-07-16T12:00:00Z",
                    resolvable: true,
                    resolved: true,
                    position: {
                      old_path: "src/widget.ts",
                      new_path: "src/widget.ts",
                      new_line: 17,
                    },
                  },
                ],
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (endpoint.endsWith("/notes?sort=asc&per_page=100")) {
          return {
            stdout: JSON.stringify([
              {
                id: 101,
                body: "![resolved artifact](/uploads/hash/resolved.png)",
                author: { username: "reviewer" },
                created_at: "2026-07-16T12:00:00Z",
              },
              {
                id: 102,
                body: "ordinary comment",
                author: { username: "commenter" },
                created_at: "2026-07-16T13:00:00Z",
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "[]", stderr: "", exitCode: 0 };
      },
    };

    const result = await fetchGlMRContext(runtime, REF);

    expect(calls).toContain(
      "glab api projects/g%2Fp/merge_requests/1/discussions?per_page=100 --paginate",
    );
    expect(calls).toContain(
      "glab api projects/g%2Fp/merge_requests/1/notes?sort=asc&per_page=100 --paginate",
    );
    expect(result.comments.map((comment) => comment.id)).toEqual(["102"]);
    expect(result.reviewThreads).toEqual([
      {
        id: "discussion-1",
        isResolved: true,
        isOutdated: false,
        path: "src/widget.ts",
        line: 17,
        startLine: null,
        diffSide: "RIGHT",
        comments: [
          {
            id: "101",
            author: "reviewer",
            body: "![resolved artifact](/uploads/hash/resolved.png)",
            createdAt: "2026-07-16T12:00:00Z",
            url: "https://gitlab.com/g/p/-/merge_requests/1#note_101",
          },
        ],
      },
    ]);
  });
});

describe("parsePaginatedArray", () => {
  test("merges adjacent JSON array pages from glab --paginate", () => {
    expect(parsePaginatedArray<{ a: number }>('[{"a":1}][{"a":2},{"a":3}]')).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  test("round-trips single-page output", () => {
    expect(parsePaginatedArray<{ a: number }>('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test("returns [] for empty output", () => {
    expect(parsePaginatedArray("")).toEqual([]);
  });

  test("does not split on bracket characters inside strings", () => {
    expect(parsePaginatedArray<{ s: string }>('[{"s":"a][b"}]')).toEqual([{ s: "a][b" }]);
  });
});

describe("submitGlMRReview", () => {
  const comments: PRReviewFileComment[] = [
    {
      path: "src/first.ts",
      line: 12,
      side: "RIGHT",
      body: "First finding",
    },
    {
      path: "src/second.ts",
      line: 27,
      side: "LEFT",
      body: "Second finding",
    },
  ];

  function makeSubmissionRuntime(
    discussionFailures: ReadonlySet<string>,
    options: {
      diffRefsReject?: boolean;
      approvalReject?: boolean;
    } = {},
  ): { runtime: PRRuntime; postedBodies: string[] } {
    const postedBodies: string[] = [];
    return {
      postedBodies,
      runtime: {
        async runCommand(_command, args) {
          const endpoint = args[1] ?? "";
          if (endpoint === "projects/g%2Fp/merge_requests/1") {
            if (options.diffRefsReject) {
              throw new Error("spawn glab ENOENT");
            }
            return {
              stdout: JSON.stringify({
                diff_refs: {
                  base_sha: "base",
                  start_sha: "start",
                  head_sha: "head",
                },
              }),
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: "", stderr: `unexpected endpoint: ${endpoint}`, exitCode: 1 };
        },
        async runCommandWithInput(_command, args, input) {
          const endpoint = args[1] ?? "";
          const payload = JSON.parse(input) as { body?: string };
          if (payload.body) postedBodies.push(payload.body);
          if (endpoint.endsWith("/notes")) {
            return { stdout: "{}", stderr: "", exitCode: 0 };
          }
          if (endpoint.endsWith("/discussions")) {
            return discussionFailures.has(payload.body ?? "")
              ? { stdout: "", stderr: `rejected ${payload.body}`, exitCode: 1 }
              : { stdout: "{}", stderr: "", exitCode: 0 };
          }
          if (endpoint.endsWith("/approve") && options.approvalReject) {
            throw new Error("spawn glab ENOENT");
          }
          return { stdout: "", stderr: `unexpected endpoint: ${endpoint}`, exitCode: 1 };
        },
      },
    };
  }

  async function withFailedCommentDataDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
    const original = process.env.PLANNOTATOR_DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), "plannotator-gitlab-submit-"));
    process.env.PLANNOTATOR_DATA_DIR = dir;
    try {
      return await run(dir);
    } finally {
      if (original === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = original;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("reports complete when every inline discussion is posted", async () => {
    const { runtime } = makeSubmissionRuntime(new Set());

    await expect(
      submitGlMRReview(runtime, REF, "head", "comment", "", comments),
    ).resolves.toEqual({ status: "complete" });
  });

  test("throws when every inline discussion fails before anything is posted", async () => {
    await withFailedCommentDataDir(async () => {
      const { runtime } = makeSubmissionRuntime(new Set(["First finding", "Second finding"]));

      await expect(
        submitGlMRReview(runtime, REF, "head", "comment", "", comments),
      ).rejects.toThrow("Failed to post inline comments");
    });
  });

  test("reports all inline failures as partial when the review body already posted", async () => {
    await withFailedCommentDataDir(async () => {
      const { runtime } = makeSubmissionRuntime(new Set(["First finding", "Second finding"]));

      const result = await submitGlMRReview(
        runtime,
        REF,
        "head",
        "comment",
        "Already posted body",
        comments,
      );

      expect(result).toMatchObject({
        status: "partial",
        postedFileCommentCount: 0,
        reviewBodyPosted: true,
        failedFileComments: [
          { comment: comments[0] },
          { comment: comments[1] },
        ],
        retry: {
          action: "comment",
          fileComments: comments,
        },
      });
    });
  });

  test("reports mixed outcomes with exact failed comments and a durable recovery file", async () => {
    await withFailedCommentDataDir(async () => {
      const { runtime, postedBodies } = makeSubmissionRuntime(new Set(["Second finding"]));

      const result = await submitGlMRReview(
        runtime,
        REF,
        "head",
        "comment",
        "Overall review",
        comments,
      );

      expect(result).toMatchObject({
        status: "partial",
        postedFileCommentCount: 1,
        reviewBodyPosted: true,
        approval: "not-requested",
        failedFileComments: [
          {
            comment: comments[1],
            error: "src/second.ts:27: rejected Second finding",
          },
        ],
        retry: {
          action: "comment",
          fileComments: [comments[1]],
        },
      });
      expect(result.status === "partial" ? result.recoveryFile : undefined).toBeString();
      if (result.status !== "partial" || !result.recoveryFile) {
        throw new Error("Expected a partial result with a recovery file");
      }
      const persisted = JSON.parse(readFileSync(result.recoveryFile, "utf-8")) as {
        failedComments: PRReviewFileComment[];
      };
      expect(persisted.failedComments).toEqual([comments[1]]);
      expect(postedBodies).toEqual(["Overall review", "First finding", "Second finding"]);
    });
  });

  test("turns a diff-ref spawn rejection after posting the body into a safe partial retry", async () => {
    await withFailedCommentDataDir(async () => {
      const { runtime } = makeSubmissionRuntime(new Set(), { diffRefsReject: true });

      const result = await submitGlMRReview(
        runtime,
        REF,
        "head",
        "comment",
        "Already posted body",
        comments,
      );

      expect(result).toMatchObject({
        status: "partial",
        postedFileCommentCount: 0,
        reviewBodyPosted: true,
        failedFileComments: [
          { comment: comments[0], error: expect.stringContaining("spawn glab ENOENT") },
          { comment: comments[1], error: expect.stringContaining("spawn glab ENOENT") },
        ],
        retry: { action: "comment", fileComments: comments },
      });
    });
  });

  test("keeps a diff-ref spawn rejection retryable when no mutation occurred", async () => {
    await withFailedCommentDataDir(async () => {
      const { runtime } = makeSubmissionRuntime(new Set(), { diffRefsReject: true });

      await expect(
        submitGlMRReview(runtime, REF, "head", "comment", "", comments),
      ).rejects.toThrow("Failed to post inline comments");
    });
  });

  test("reports a failed approval as partial after inline comments have posted", async () => {
    const { runtime } = makeSubmissionRuntime(new Set());

    const result = await submitGlMRReview(
      runtime,
      REF,
      "head",
      "approve",
      "",
      comments,
    );

    expect(result).toMatchObject({
      status: "partial",
      postedFileCommentCount: 2,
      failedFileComments: [],
      reviewBodyPosted: false,
      approval: "failed",
      approvalError: "Failed to approve MR: unexpected endpoint: projects/g%2Fp/merge_requests/1/approve",
      retry: {
        action: "approve",
        fileComments: [],
      },
    });
  });

  test("reports repeated approval-only spawn failures consistently as partial", async () => {
    const { runtime } = makeSubmissionRuntime(new Set(), { approvalReject: true });

    const first = await submitGlMRReview(
      runtime,
      REF,
      "head",
      "approve",
      "",
      [],
    );
    const retry = await submitGlMRReview(
      runtime,
      REF,
      "head",
      "approve",
      "",
      [],
    );

    const expected = {
      status: "partial",
      postedFileCommentCount: 0,
      failedFileComments: [],
      reviewBodyPosted: false,
      approval: "failed",
      approvalError: "Failed to approve MR: spawn glab ENOENT",
      retry: { action: "approve", fileComments: [] },
    };
    expect(first).toEqual(expected);
    expect(retry).toEqual(expected);
  });
});
