import { describe, expect, test } from "bun:test";
import {
  parsePaginatedArray,
  mapGlMrToListItem,
  mapGlMrToDetailedItem,
  fetchGlMRList,
  fetchGlMRDetailedList,
} from "./pr-gitlab";
import { detectPlatformCore } from "./pr-provider";
import type { PRRuntime, CommandResult, GitlabMRRef } from "./pr-types";

describe("parsePaginatedArray", () => {
  test("parses a single-page array", () => {
    const stdout = JSON.stringify([{ a: 1 }, { a: 2 }]);
    expect(parsePaginatedArray<{ a: number }>(stdout)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("merges adjacent JSON arrays from --paginate output", () => {
    const stdout = JSON.stringify([{ a: 1 }]) + JSON.stringify([{ a: 2 }, { a: 3 }]);
    expect(parsePaginatedArray<{ a: number }>(stdout)).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  test("merges three or more pages with whitespace between them", () => {
    const stdout = [
      JSON.stringify([1, 2]),
      JSON.stringify([3, 4]),
      JSON.stringify([5]),
    ].join("\n");
    expect(parsePaginatedArray<number>(stdout)).toEqual([1, 2, 3, 4, 5]);
  });

  test("handles strings containing brackets without splitting prematurely", () => {
    // Diff content frequently contains `][` inside JSON strings — must not be
    // confused with a page boundary.
    const page1 = [{ diff: "before][after", new_path: "a" }];
    const page2 = [{ diff: "second", new_path: "b" }];
    const stdout = JSON.stringify(page1) + JSON.stringify(page2);
    expect(parsePaginatedArray(stdout)).toEqual([...page1, ...page2]);
  });

  test("handles escaped quotes inside strings", () => {
    const page1 = [{ diff: 'has \\"quote\\" and ] bracket', new_path: "a" }];
    const page2 = [{ diff: "second", new_path: "b" }];
    const stdout = JSON.stringify(page1) + JSON.stringify(page2);
    expect(parsePaginatedArray(stdout)).toEqual([...page1, ...page2]);
  });

  test("returns empty array for empty input", () => {
    expect(parsePaginatedArray("")).toEqual([]);
    expect(parsePaginatedArray("   \n")).toEqual([]);
  });

  test("handles empty pages mixed with non-empty ones", () => {
    const stdout = "[]" + JSON.stringify([{ a: 1 }]) + "[]";
    expect(parsePaginatedArray<{ a: number }>(stdout)).toEqual([{ a: 1 }]);
  });
});

// Hand-written fixture shaped like a real `glab api projects/:id/merge_requests`
// response. Only the fields the mappers consume are exercised, but extra fields
// are present to mirror the real payload and prove they're ignored.
const MR_LIST_FIXTURE = [
  {
    iid: 42,
    title: "Add login flow",
    author: { username: "alice", name: "Alice" },
    web_url: "https://gitlab.com/group/project/-/merge_requests/42",
    source_branch: "feature/login",
    target_branch: "main",
    state: "opened",
    user_notes_count: 3,
    updated_at: "2026-05-20T10:00:00Z",
    draft: false,
  },
  {
    iid: 41,
    title: "Refactor parser",
    author: { username: "bob" },
    web_url: "https://gitlab.com/group/project/-/merge_requests/41",
    source_branch: "refactor/parser",
    target_branch: "main",
    state: "merged",
    user_notes_count: 0,
    updated_at: "2026-05-18T08:30:00Z",
    draft: false,
  },
  {
    iid: 40,
    title: "Old idea",
    author: { username: "carol" },
    web_url: "https://gitlab.com/group/project/-/merge_requests/40",
    source_branch: "spike/idea",
    target_branch: "main",
    state: "closed",
    user_notes_count: 5,
    updated_at: "2026-05-10T12:00:00Z",
    draft: false,
  },
  {
    iid: 39,
    title: "WIP: experiment",
    author: { username: "dave" },
    web_url: "https://gitlab.com/group/project/-/merge_requests/39",
    source_branch: "wip/experiment",
    target_branch: "develop",
    state: "opened",
    user_notes_count: 1,
    updated_at: "2026-05-22T09:15:00Z",
    draft: true,
  },
] as const;

describe("mapGlMrToListItem", () => {
  test("maps GitLab MR JSON fields to PRListItem", () => {
    const items = MR_LIST_FIXTURE.map((m) => mapGlMrToListItem(m as any));

    expect(items[0]).toEqual({
      id: "42",
      number: 42,
      title: "Add login flow",
      author: "alice",
      url: "https://gitlab.com/group/project/-/merge_requests/42",
      baseBranch: "main",
      headBranch: "feature/login",
      state: "open",
    });
    // iid drives both number and the stringified id
    expect(items[0].id).toBe("42");
    expect(items[0].number).toBe(42);
  });

  test("normalizes all GitLab MR states", () => {
    const states = MR_LIST_FIXTURE.map((m) => mapGlMrToListItem(m as any).state);
    // opened, merged, closed, opened
    expect(states).toEqual(["open", "merged", "closed", "open"]);
  });

  test("maps locked state to closed", () => {
    const item = mapGlMrToListItem({
      iid: 1,
      title: "Locked",
      author: { username: "x" },
      web_url: "u",
      source_branch: "s",
      target_branch: "t",
      state: "locked",
    } as any);
    expect(item.state).toBe("closed");
  });

  test("falls back to empty author when author is missing or null", () => {
    const base = {
      iid: 1,
      title: "No author",
      web_url: "u",
      source_branch: "s",
      target_branch: "t",
      state: "opened",
    };
    expect(mapGlMrToListItem({ ...base, author: null } as any).author).toBe("");
    expect(mapGlMrToListItem({ ...base, author: {} } as any).author).toBe("");
    expect(mapGlMrToListItem(base as any).author).toBe("");
  });
});

describe("mapGlMrToDetailedItem", () => {
  test("maps detailed fields and degrades additions/deletions to 0", () => {
    const item = mapGlMrToDetailedItem(MR_LIST_FIXTURE[0] as any);
    expect(item).toEqual({
      id: "42",
      number: 42,
      title: "Add login flow",
      author: "alice",
      url: "https://gitlab.com/group/project/-/merge_requests/42",
      baseBranch: "main",
      headBranch: "feature/login",
      state: "open",
      additions: 0,
      deletions: 0,
      commentCount: 3,
      updatedAt: "2026-05-20T10:00:00Z",
      isDraft: false,
      reviewDecision: "",
    });
  });

  test("maps user_notes_count to commentCount and updated_at to updatedAt", () => {
    const item = mapGlMrToDetailedItem(MR_LIST_FIXTURE[2] as any);
    expect(item.commentCount).toBe(5);
    expect(item.updatedAt).toBe("2026-05-10T12:00:00Z");
  });

  test("detects draft via the `draft` field", () => {
    expect(mapGlMrToDetailedItem(MR_LIST_FIXTURE[3] as any).isDraft).toBe(true);
    expect(mapGlMrToDetailedItem(MR_LIST_FIXTURE[0] as any).isDraft).toBe(false);
  });

  test("detects draft via the legacy `work_in_progress` field", () => {
    const item = mapGlMrToDetailedItem({
      iid: 7,
      title: "Legacy WIP",
      author: { username: "x" },
      web_url: "u",
      source_branch: "s",
      target_branch: "t",
      state: "opened",
      work_in_progress: true,
    } as any);
    expect(item.isDraft).toBe(true);
  });

  test("defaults missing detailed fields", () => {
    const item = mapGlMrToDetailedItem({
      iid: 8,
      title: "Bare",
      author: { username: "x" },
      web_url: "u",
      source_branch: "s",
      target_branch: "t",
      state: "opened",
    } as any);
    expect(item.commentCount).toBe(0);
    expect(item.updatedAt).toBe("");
    expect(item.isDraft).toBe(false);
    expect(item.reviewDecision).toBe("");
    expect(item.additions).toBe(0);
    expect(item.deletions).toBe(0);
  });
});

describe("detectPlatformCore", () => {
  // A runtime that records calls and returns a canned result. Used to prove the
  // host-name fast paths never touch the subprocess, and the probe behaves on
  // ambiguous hosts.
  function makeRuntime(behavior: "success" | "authfail" | "missing"): {
    runtime: PRRuntime;
    calls: Array<{ cmd: string; args: string[] }>;
  } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runtime: PRRuntime = {
      async runCommand(cmd, args): Promise<CommandResult> {
        calls.push({ cmd, args });
        if (behavior === "missing") {
          const err = new Error("spawn glab ENOENT") as Error & { code: string };
          err.code = "ENOENT";
          throw err;
        }
        if (behavior === "authfail") {
          return { stdout: "", stderr: "not logged in", exitCode: 1 };
        }
        return { stdout: "Logged in to code.company.com", stderr: "", exitCode: 0 };
      },
    };
    return { runtime, calls };
  }

  test("github.com → github without probing", async () => {
    const { runtime, calls } = makeRuntime("success");
    expect(await detectPlatformCore(runtime, "github.com")).toBe("github");
    expect(calls).toHaveLength(0);
  });

  test("gitlab.com → gitlab without probing", async () => {
    const { runtime, calls } = makeRuntime("success");
    expect(await detectPlatformCore(runtime, "gitlab.com")).toBe("gitlab");
    expect(calls).toHaveLength(0);
  });

  test("host containing gitlab (self-hosted subdomain) → gitlab without probing", async () => {
    const { runtime, calls } = makeRuntime("authfail");
    expect(await detectPlatformCore(runtime, "gitlab.example.com")).toBe("gitlab");
    expect(calls).toHaveLength(0);
  });

  test("host containing github (GHE) → github without probing", async () => {
    const { runtime, calls } = makeRuntime("success");
    expect(await detectPlatformCore(runtime, "github.acme.com")).toBe("github");
    expect(calls).toHaveLength(0);
  });

  test("ambiguous custom domain + successful glab probe → gitlab", async () => {
    const { runtime, calls } = makeRuntime("success");
    expect(await detectPlatformCore(runtime, "code.company.com")).toBe("gitlab");
    // The probe shelled out exactly once, to `glab auth status --hostname <host>`.
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("glab");
    expect(calls[0].args).toEqual(["auth", "status", "--hostname", "code.company.com"]);
  });

  test("ambiguous custom domain + glab auth failure → github (no regression)", async () => {
    const { runtime } = makeRuntime("authfail");
    expect(await detectPlatformCore(runtime, "code.company.com")).toBe("github");
  });

  test("ambiguous custom domain + glab not installed (ENOENT) → github (no regression)", async () => {
    const { runtime } = makeRuntime("missing");
    expect(await detectPlatformCore(runtime, "code.company.com")).toBe("github");
  });
});

describe("fetchGlMRList / fetchGlMRDetailedList", () => {
  // A runtime that records its calls and returns a canned result, so we can
  // assert the exact `glab` args and the throw-on-failure contract without
  // spawning glab.
  function makeRuntime(result: CommandResult): {
    runtime: PRRuntime;
    calls: Array<{ cmd: string; args: string[] }>;
  } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runtime: PRRuntime = {
      async runCommand(cmd, args): Promise<CommandResult> {
        calls.push({ cmd, args });
        return result;
      },
    };
    return { runtime, calls };
  }

  const REF: GitlabMRRef = {
    platform: "gitlab",
    host: "gitlab.com",
    projectPath: "group/project",
    iid: 0,
  };

  test("fetchGlMRList issues the exact glab args and maps entries", async () => {
    const { runtime, calls } = makeRuntime({
      stdout: JSON.stringify(MR_LIST_FIXTURE),
      stderr: "",
      exitCode: 0,
    });

    const items = await fetchGlMRList(runtime, REF);

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("glab");
    // group/project → group%2Fproject, gitlab.com host omits --hostname.
    expect(calls[0].args).toEqual([
      "api",
      "projects/group%2Fproject/merge_requests?per_page=30&state=all",
    ]);
    expect(items.map((i) => i.number)).toEqual([42, 41, 40, 39]);
  });

  test("fetchGlMRDetailedList issues the exact glab args and maps entries", async () => {
    const { runtime, calls } = makeRuntime({
      stdout: JSON.stringify(MR_LIST_FIXTURE),
      stderr: "",
      exitCode: 0,
    });

    const items = await fetchGlMRDetailedList(runtime, REF);

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("glab");
    expect(calls[0].args).toEqual([
      "api",
      "projects/group%2Fproject/merge_requests?per_page=30&state=all",
    ]);
    expect(items[0].commentCount).toBe(3);
    expect(items[0].additions).toBe(0);
  });

  test("self-hosted host appends --hostname", async () => {
    const { runtime, calls } = makeRuntime({ stdout: "[]", stderr: "", exitCode: 0 });
    await fetchGlMRList(runtime, { ...REF, host: "gitlab.example.com" });
    expect(calls[0].args).toEqual([
      "api",
      "projects/group%2Fproject/merge_requests?per_page=30&state=all",
      "--hostname",
      "gitlab.example.com",
    ]);
  });

  test("non-zero exit THROWS instead of returning [] (no silent-empty)", async () => {
    const { runtime } = makeRuntime({ stdout: "", stderr: "403 Forbidden", exitCode: 1 });
    await expect(fetchGlMRList(runtime, REF)).rejects.toThrow(/403 Forbidden/);
    await expect(fetchGlMRDetailedList(runtime, REF)).rejects.toThrow(/403 Forbidden/);
  });

  test("non-zero exit with empty stderr still throws with exit-code detail", async () => {
    const { runtime } = makeRuntime({ stdout: "", stderr: "", exitCode: 22 });
    await expect(fetchGlMRList(runtime, REF)).rejects.toThrow(/exit code 22/);
  });
});
