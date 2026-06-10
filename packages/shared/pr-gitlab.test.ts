import { describe, expect, test } from "bun:test";
import { fetchGlMR, parsePaginatedArray } from "./pr-gitlab";
import type { PRRuntime } from "./pr-types";

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

  test("falls back when raw_diffs returns empty (oversized MR)", async () => {
    const { runtime, calls } = gitlabRuntime({
      rawDiffs: { exitCode: 0, stdout: "" },
      diffs: { exitCode: 0, stdout: DIFF_ENTRIES_JSON },
    });
    const result = await fetchGlMR(runtime, REF);
    expect(result.rawPatch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(calls.some((c) => c.includes("/diffs?per_page=100"))).toBe(true);
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
