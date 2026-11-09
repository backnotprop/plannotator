/**
 * The Pull requests page's scope (approval "inbox-pr-dashboard", q-aef3fb89, "Everywhere, mine"): the person's own
 * PRs in any repository, plus every open PR of the projects' repositories as the Reviews page reads them. A PR two
 * searches find is one PR; the scoped read (the Reviews page, the sidebar's count) and the everywhere read are kept
 * apart, so neither throws the other's answer away. A scripted gh stands in for GitHub.
 */
import { describe, expect, test } from "bun:test";
import type { InboxPull } from "@plannotator/core/inbox-types";
import type { RefRunner } from "@plannotator/shared/ref-cards";
import { createInboxPulls, mergeListedPulls } from "./inbox-pulls";

const pull = (repo: string, number: number, over: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/${repo}#${number}`,
  platform: "github",
  host: "github.com",
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  title: `PR ${number}`,
  author: "dana",
  mine: false,
  requested: false,
  state: "open",
  base: "main",
  head: `b${number}`,
  head_repo: repo,
  additions: 1,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: null,
  updated_at: "2026-11-08T10:00:00Z",
  merged_at: null,
  ...over,
});

describe("mergeListedPulls", () => {
  const wanted = new Set(["github.com/northwind/ledger"]);
  test("a PR found by the person's lists and by Others is one PR, the person's answer kept", () => {
    const mine = pull("northwind/ledger", 412, { requested: true });
    const theirs = pull("northwind/ledger", 412);
    const out = mergeListedPulls([mine], [theirs, pull("northwind/ledger", 413)], wanted);
    expect(out.map((p) => p.number)).toEqual([412, 413]);
    expect(out[0]!.requested).toBe(true);
  });
  test("scoped keeps the projects' repositories; everywhere keeps the person's own PRs anywhere, Others only in projects", () => {
    const own = [pull("northwind/ledger", 1), pull("elsewhere/tool", 2, { mine: true })];
    const others = [pull("elsewhere/tool", 3)];
    expect(mergeListedPulls(own, others, wanted).map((p) => p.number)).toEqual([1]);
    expect(mergeListedPulls(own, others, wanted, true).map((p) => p.number)).toEqual([1, 2]);
  });
  test("one search's duplicate is kept once", () => {
    expect(mergeListedPulls([pull("elsewhere/tool", 2), pull("elsewhere/tool", 2)], [], wanted, true)).toHaveLength(1);
  });
});

/** GitHub's GraphQL node for a PR, as the list's query asks it. */
const node = (repo: string, number: number, author = "dana") => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-08T10:00:00Z",
  mergedAt: null,
  baseRefName: "main",
  headRefName: `b${number}`,
  headRefOid: "a".repeat(40),
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  repository: { nameWithOwner: repo },
  baseRepository: { defaultBranchRef: { name: "main" } },
  headRepository: { nameWithOwner: repo },
  author: { login: author, avatarUrl: "" },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
});

function fakeGh() {
  const own: string[][] = [];
  const run: RefRunner = async (cli, args) => {
    if (cli !== "gh") return { stdout: "", stderr: "not found", exitCode: 127 };
    if (args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("InboxPullsOthers")) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } }), stderr: "", exitCode: 0 };
    if (query.includes("requested: search")) {
      own.push(args.filter((a) => /^(requested|authored|assigned|merged)=/.test(a)));
      // The same PR asked of the person and assigned to them: two searches, one PR.
      const data = {
        viewer: { login: "dana" },
        rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-11-08T11:00:00Z" },
        requested: { issueCount: 1, nodes: [node("elsewhere/tool", 7, "kim")] },
        assigned: { issueCount: 1, nodes: [node("elsewhere/tool", 7, "kim")] },
        authored: { issueCount: 1, nodes: [node("northwind/ledger", 412)] },
        merged: { nodes: [] },
      };
      return { stdout: JSON.stringify({ data }), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "HTTP 404", exitCode: 1 };
  };
  return { run, own };
}

describe("list everywhere", () => {
  const projects = [{ host: "github.com", repo: "northwind/ledger", project_id: "prj_1" }];
  test("unscoped searches; a PR outside the projects is kept once; the scoped read stays its own", async () => {
    const gh = fakeGh();
    const pulls = createInboxPulls({ run: gh.run });
    const wide = await pulls.list(projects, { everywhere: true });
    expect(gh.own).toHaveLength(1);
    expect(gh.own[0]!.every((a) => !a.includes("repo:"))).toBe(true);
    const tool = wide.pulls.filter((p) => p.repo === "elsewhere/tool");
    expect(tool).toHaveLength(1);
    expect(tool[0]!.requested).toBe(true);
    expect(tool[0]!.assigned).toBe(true);
    expect(wide.pulls.map((p) => p.key).sort()).toEqual(["github.com/elsewhere/tool#7", "github.com/northwind/ledger#412"]);

    // The Reviews page's read: its own (scoped) searches, the outside PR not in its list.
    const scoped = await pulls.list(projects);
    expect(gh.own).toHaveLength(2);
    expect(gh.own[1]!.some((a) => a.includes("repo:northwind/ledger"))).toBe(true);
    expect(scoped.pulls.map((p) => p.key)).toEqual(["github.com/northwind/ledger#412"]);
    // The page's PR is still one the Inbox knows (its view, its merge).
    expect(pulls.find("github.com/elsewhere/tool#7")?.number).toBe(7);

    // Each read is cached on its own: neither reads the forge again within the minute.
    await pulls.list(projects, { everywhere: true });
    await pulls.list(projects);
    expect(gh.own).toHaveLength(2);
  });
});
