/**
 * A PR page's compares beyond Whole stack (inbox-pull-diff-scope.ts and `diff` in inbox-pulls.ts), with a scripted gh:
 * no real CLI or forge. What regresses: "Layers i–j" running from anywhere but the branch layer i is based on (the
 * head of layer i-1), a range reaching across a sibling branch or from a merged layer, "since you looked" running from
 * anywhere but the commit named, and the route taking a `from` that is no layer key or no commit.
 */
import { describe, expect, test } from "bun:test";
import { createInboxPulls } from "./inbox-pulls";
import { pullDiffScopeOf } from "./inbox-pull-diff-scope";

const ghPull = (number: number, head: string, base: string, fields: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/northwind/ledger/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-03T10:00:00Z",
  mergedAt: null,
  baseRefName: base,
  headRefName: head,
  headRefOid: String(number).padStart(40, "a"),
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: "northwind/ledger" },
  headRepository: { nameWithOwner: "northwind/ledger" },
  author: { login: "dana" },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...fields,
});

// main ← #1 (merged) ← #2 ← #3 ← #4, and #5 a sibling of #4 on #3.
const ANSWER = {
  data: {
    viewer: { login: "dana" },
    requested: { nodes: [] },
    authored: { nodes: [ghPull(2, "two", "one"), ghPull(3, "three", "two"), ghPull(4, "four", "three"), ghPull(5, "five", "three")] },
    merged: { nodes: [ghPull(1, "one", "main", { state: "MERGED", mergedAt: "2026-11-02T10:00:00Z" })] },
  },
};
const key = (n: number) => `github.com/northwind/ledger#${n}`;

async function forge(compareFails: (endpoint: string) => boolean = () => false) {
  const compares: string[] = [];
  const run = async (cli: string, args: string[]) => {
    if (cli === "gh" && args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    if (cli === "gh" && args.includes("graphql")) return { stdout: JSON.stringify(ANSWER), stderr: "", exitCode: 0 };
    if (cli === "gh" && args.includes("--jq")) return { stdout: `${JSON.stringify({ sha: "f".repeat(40), body: null })}\n`, stderr: "", exitCode: 0 };
    if (cli === "gh" && args[0] === "api" && args[3]?.includes("/compare/")) {
      compares.push(args[3]!);
      if (compareFails(args[3]!)) return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
      return { stdout: `diff of ${args[3]}\n`, stderr: "", exitCode: 0 };
    }
    if (cli === "gh" && args[0] === "api") return { stdout: `diff of ${args[3]}\n`, stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  const pulls = createInboxPulls({ run });
  await pulls.list([{ host: "github.com", repo: "northwind/ledger", project_id: "prj_1" }]);
  return { pulls, compares };
}

describe("Layers i–j", () => {
  test("runs from the branch layer i is based on (layer i-1's head) to layer j's head", async () => {
    const { pulls, compares } = await forge();
    const answer = await pulls.diff(key(4), "range", key(3));
    expect(compares).toEqual(["repos/northwind/ledger/compare/two...four"]);
    expect(answer).toMatchObject({ scope: "range", base: "two", head: "four" });
  });

  test("its lowest layer's branch gone: from the stack's own base", async () => {
    const { pulls, compares } = await forge((endpoint) => endpoint.includes("compare/two..."));
    expect((await pulls.diff(key(4), "range", key(3))).base).toBe("main");
    expect(compares).toEqual(["repos/northwind/ledger/compare/two...four", "repos/northwind/ledger/compare/main...four"]);
  });

  test("never across a sibling branch, from a merged layer or from above: nothing is read", async () => {
    const { pulls, compares } = await forge();
    await expect(pulls.diff(key(5), "range", key(4))).rejects.toMatchObject({ code: "pull_diff_failed" });
    await expect(pulls.diff(key(4), "range", key(1))).rejects.toMatchObject({ code: "pull_diff_failed" });
    await expect(pulls.diff(key(3), "range", key(4))).rejects.toMatchObject({ code: "pull_diff_failed" });
    expect(compares).toEqual([]);
  });
});

describe("since you looked", () => {
  test("runs from the commit named to the layer's head", async () => {
    const { pulls, compares } = await forge();
    const sha = "c".repeat(40);
    const answer = await pulls.diff(key(3), "since", sha);
    expect(compares).toEqual([`repos/northwind/ledger/compare/${sha}...three`]);
    expect(answer).toMatchObject({ scope: "since", base: sha, head: "three" });
  });
});

describe("the route's scope", () => {
  const of = (query: string) => pullDiffScopeOf(new URLSearchParams(query));

  test("layer and stack as before; a range needs a layer key, since a whole commit id", () => {
    expect(of("")).toEqual({ scope: "layer" });
    expect(of("scope=stack")).toEqual({ scope: "stack" });
    expect(of(`scope=range&from=${encodeURIComponent(key(3))}`)).toEqual({ scope: "range", from: key(3) });
    expect(of(`scope=since&from=${"C".repeat(40)}`)).toEqual({ scope: "since", from: "c".repeat(40) });
  });

  test("anything else is refused", () => {
    expect(of("scope=range")).toBeNull();
    expect(of(`scope=range&from=${"x".repeat(601)}`)).toBeNull();
    expect(of("scope=since&from=main")).toBeNull();
    expect(of("scope=since&from=abc123")).toBeNull();
    expect(of("scope=all")).toBeNull();
  });
});
