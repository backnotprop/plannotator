import { describe, expect, test } from "bun:test";
import { createFakePRRuntime } from "../../tests/helpers/fake-pr-runtime";
import { fetchPRList, fetchPRStack } from "./pr-provider";
import type { GitlabMRRef, PRMetadata } from "./pr-types";

const ref: GitlabMRRef = { platform: "gitlab", host: "gitlab.example.com", projectPath: "northwind/ledger", iid: 12 };
const base = "projects/northwind%2Fledger/merge_requests?";

const mr = (iid: number, source: string, target: string, state = "opened") => ({
  iid,
  title: `MR ${iid}`,
  web_url: `https://gitlab.example.com/northwind/ledger/-/merge_requests/${iid}`,
  source_branch: source,
  target_branch: target,
  state,
  author: { username: "ada" },
});

const answers: Record<string, unknown[]> = {
  "source_branch=feature%2Fb&state=all&per_page=20": [mr(11, "feature/b", "feature/a")],
  "source_branch=feature%2Fa&state=all&per_page=20": [mr(9, "feature/a", "main", "closed"), mr(10, "feature/a", "main", "merged")],
  "target_branch=feature%2Fc&state=all&per_page=20": [mr(13, "feature/d", "feature/c")],
  "target_branch=feature%2Fd&state=all&per_page=20": [],
  "state=all&order_by=updated_at&sort=desc&per_page=30": [mr(13, "feature/d", "feature/c"), mr(10, "feature/a", "main", "merged"), mr(9, "feature/a", "main", "closed")],
};

function fakeGlab() {
  return createFakePRRuntime(({ cmd, args }) => {
    const [, endpoint, flag, host] = args;
    if (cmd !== "glab" || flag !== "--hostname" || host !== "gitlab.example.com" || !endpoint.startsWith(base)) return undefined;
    const body = answers[endpoint.slice(base.length)];
    return body ? { stdout: JSON.stringify(body), stderr: "", exitCode: 0 } : undefined;
  });
}

describe("GitLab MR stack and switcher", () => {
  test("walks up to the default branch and down to the leaf, skipping closed MRs", async () => {
    const metadata: PRMetadata = {
      platform: "gitlab", host: ref.host, projectPath: ref.projectPath, iid: 12, title: "MR 12",
      author: "ada", baseBranch: "feature/b", headBranch: "feature/c", defaultBranch: "main",
      baseSha: "a", headSha: "b", url: "https://gitlab.example.com/northwind/ledger/-/merge_requests/12",
    };
    const tree = await fetchPRStack(fakeGlab().runtime, ref, metadata);
    expect(tree?.nodes.map((n) => [n.branch, n.number ?? null, n.state ?? null, n.isCurrent])).toEqual([
      ["main", null, null, false],
      ["feature/a", 10, "merged", false],
      ["feature/b", 11, "open", false],
      ["feature/c", 12, null, true],
      ["feature/d", 13, "open", false],
    ]);
  });

  test("lists recent MRs for the switcher", async () => {
    const list = await fetchPRList(fakeGlab().runtime, ref);
    expect(list.map((p) => [p.number, p.state, p.author, p.baseBranch])).toEqual([
      [13, "open", "ada", "feature/c"],
      [10, "merged", "ada", "main"],
      [9, "closed", "ada", "main"],
    ]);
    expect(list[0].url).toBe("https://gitlab.example.com/northwind/ledger/-/merge_requests/13");
  });
});
