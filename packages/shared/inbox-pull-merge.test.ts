/**
 * The Pull requests page's Merge guard (inbox-pull-merge.ts): the forge's answer, asked at the moment of the merge,
 * decides; a PR that moved, closed, went back to draft or that the forge won't merge is never merged; the merge pins
 * the head the person saw and uses the repository's own method. A scripted runner stands in for gh / glab.
 */
import { describe, expect, test } from "bun:test";
import { githubMergeMethodOf, githubMergeStateOf, gitlabMergeStateOf, mergePull, pullMergeVerdict, type PullMergeTarget } from "./inbox-pull-merge";
import type { RefCli, RefRunner } from "./ref-cards";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const GH: PullMergeTarget = { platform: "github", host: "github.com", repo: "northwind/ledger", number: 412 };
const GL: PullMergeTarget = { platform: "gitlab", host: "gitlab.com", repo: "northwind/group/web", number: 61 };

const ghPull = (over: Record<string, unknown> = {}) => JSON.stringify({ state: "open", draft: false, merged_at: null, mergeable: true, mergeable_state: "clean", head: { sha: HEAD }, ...over });
const glMr = (over: Record<string, unknown> = {}) => JSON.stringify({ state: "opened", draft: false, detailed_merge_status: "mergeable", sha: HEAD, ...over });

/** A runner that answers by endpoint and keeps every call. */
function forge(answers: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  const calls: { cli: RefCli; args: string[] }[] = [];
  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    const put = args.includes("PUT");
    const endpoint = args.find((a) => /^(repos|projects)\//.test(a)) ?? "";
    const answer = answers[`${put ? "PUT " : ""}${endpoint}`] ?? { stderr: "HTTP 404: Not Found", exitCode: 1 };
    return { stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", exitCode: answer.exitCode ?? 0 };
  };
  return { run, calls, puts: () => calls.filter((c) => c.args.includes("PUT")) };
}

describe("pullMergeVerdict", () => {
  test("GitHub: clean, unstable and has_hooks may merge; blocked, behind, dirty and unknown may not", () => {
    for (const detail of ["clean", "unstable", "has_hooks"]) {
      expect(pullMergeVerdict("github", githubMergeStateOf(ghPull({ mergeable_state: detail })), HEAD)).toEqual({ ok: true });
    }
    for (const detail of ["blocked", "behind", "dirty", "unknown", "draft"]) {
      const verdict = pullMergeVerdict("github", githubMergeStateOf(ghPull({ mergeable_state: detail })), HEAD);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("pull_not_mergeable");
    }
    // Still being worked out (`mergeable: null`) is not a yes.
    const unknown = pullMergeVerdict("github", githubMergeStateOf(ghPull({ mergeable: null, mergeable_state: "unknown" })), HEAD);
    expect(unknown.ok).toBe(false);
  });

  test("the words say why, plainly", () => {
    const verdict = pullMergeVerdict("github", githubMergeStateOf(ghPull({ mergeable_state: "blocked" })), HEAD);
    expect(verdict.ok ? "" : verdict.message).toBe("GitHub won't merge it now: a required review or check hasn't passed.");
  });

  test("a push since the person looked, a closed PR, a draft and an unread forge are refused", () => {
    const moved = pullMergeVerdict("github", githubMergeStateOf(ghPull({ head: { sha: OTHER } })), HEAD);
    expect(moved.ok ? null : moved.code).toBe("pull_moved");
    const closed = pullMergeVerdict("github", githubMergeStateOf(ghPull({ state: "closed" })), HEAD);
    expect(closed.ok ? null : closed.code).toBe("pull_closed");
    const merged = pullMergeVerdict("github", githubMergeStateOf(ghPull({ merged_at: "2026-11-08T10:00:00Z" })), HEAD);
    expect(merged.ok ? null : merged.code).toBe("pull_closed");
    const draft = pullMergeVerdict("github", githubMergeStateOf(ghPull({ draft: true })), HEAD);
    expect(draft.ok ? null : draft.code).toBe("pull_draft");
    const unread = pullMergeVerdict("github", null, HEAD);
    expect(unread.ok ? null : unread.code).toBe("pull_merge_unknown");
  });

  test("GitLab: only detailed_merge_status mergeable merges", () => {
    expect(pullMergeVerdict("gitlab", gitlabMergeStateOf(glMr()), HEAD)).toEqual({ ok: true });
    const running = pullMergeVerdict("gitlab", gitlabMergeStateOf(glMr({ detailed_merge_status: "ci_still_running" })), HEAD);
    expect(running.ok ? "" : running.message).toBe("GitLab won't merge it now: its pipeline is still running.");
  });
});

describe("githubMergeMethodOf", () => {
  test("the first method the repository allows, in GitHub's button order", () => {
    expect(githubMergeMethodOf(JSON.stringify({ full_name: "o/r", allow_merge_commit: true, allow_squash_merge: true }))).toBe("merge");
    expect(githubMergeMethodOf(JSON.stringify({ full_name: "o/r", allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true }))).toBe("squash");
    expect(githubMergeMethodOf(JSON.stringify({ full_name: "o/r", allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true }))).toBe("rebase");
    expect(githubMergeMethodOf(JSON.stringify({ full_name: "o/r", allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }))).toBeNull();
  });
});

describe("mergePull", () => {
  test("GitHub: merges with the repository's method, the seen head pinned", async () => {
    const f = forge({
      "repos/northwind/ledger/pulls/412": { stdout: ghPull() },
      "repos/northwind/ledger": { stdout: JSON.stringify({ full_name: "northwind/ledger", allow_merge_commit: false, allow_squash_merge: true }) },
      "PUT repos/northwind/ledger/pulls/412/merge": { stdout: JSON.stringify({ merged: true, sha: "c".repeat(40) }) },
    });
    expect(await mergePull(f.run, GH, HEAD)).toEqual({ ok: true, method: "squash", sha: HEAD });
    expect(f.puts()).toHaveLength(1);
    expect(f.puts()[0]!.args).toEqual(["api", "--hostname", "github.com", "-X", "PUT", "repos/northwind/ledger/pulls/412/merge", "-f", "merge_method=squash", "-f", `sha=${HEAD}`]);
  });

  test("never merges what the forge won't, or what moved", async () => {
    const blocked = forge({ "repos/northwind/ledger/pulls/412": { stdout: ghPull({ mergeable_state: "blocked" }) } });
    const one = await mergePull(blocked.run, GH, HEAD);
    expect(one.ok).toBe(false);
    expect(blocked.puts()).toHaveLength(0);
    const moved = forge({ "repos/northwind/ledger/pulls/412": { stdout: ghPull({ head: { sha: OTHER } }) } });
    const two = await mergePull(moved.run, GH, HEAD);
    expect(two.ok ? null : two.code).toBe("pull_moved");
    expect(moved.puts()).toHaveLength(0);
    const offline = forge({});
    const three = await mergePull(offline.run, GH, HEAD);
    expect(three.ok ? null : three.code).toBe("pull_merge_unknown");
    expect(offline.puts()).toHaveLength(0);
  });

  test("a refusal from the forge comes back in its own words", async () => {
    const f = forge({
      "repos/northwind/ledger/pulls/412": { stdout: ghPull() },
      "repos/northwind/ledger": { stdout: JSON.stringify({ full_name: "northwind/ledger", allow_merge_commit: true }) },
      "PUT repos/northwind/ledger/pulls/412/merge": { stdout: JSON.stringify({ message: "Head branch was modified. Review and try the merge again." }), stderr: "gh: Head branch was modified. (HTTP 409)", exitCode: 1 },
    });
    expect(await mergePull(f.run, GH, HEAD)).toEqual({ ok: false, code: "pull_merge_failed", message: "Head branch was modified. Review and try the merge again." });
  });

  test("GitLab: the project's own method, the head pinned", async () => {
    const f = forge({
      [`projects/${encodeURIComponent("northwind/group/web")}/merge_requests/61`]: { stdout: glMr() },
      [`PUT projects/${encodeURIComponent("northwind/group/web")}/merge_requests/61/merge`]: { stdout: JSON.stringify({ state: "merged" }) },
    });
    expect(await mergePull(f.run, GL, HEAD)).toEqual({ ok: true, method: null, sha: HEAD });
    expect(f.puts()[0]!.cli).toBe("glab");
    expect(f.puts()[0]!.args.slice(-2)).toEqual(["-f", `sha=${HEAD}`]);
  });
});
