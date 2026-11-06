/**
 * The PR page's All files: the PR's repository at the head this Inbox read, answered as the review app's
 * `/api/repo-files` and `/api/repo-file` so its tree and file view read it unchanged. What regresses:
 *  - a listing at a commit the Inbox never read for that PR (any sha a page names), or for a PR the list did not name;
 *  - a file read that is not in the listing (`..`, an unlisted path), or the forge asked twice for one listing;
 *  - a failed listing kept (it never comes back), or a rate-limited forge asked again before its hold ends.
 * Through a fake gh (no Inbox, no real CLI).
 */
import { describe, expect, test } from "bun:test";
import { createInboxPulls } from "./inbox-pulls";

const repos = [{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }];
const KEY = "github.com/northwind/billing-svc#412";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const pull = (number: number) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/northwind/billing-svc/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-03T10:00:00Z",
  mergedAt: null,
  baseRefName: "main",
  headRefName: `branch-${number}`,
  headRefOid: HEAD,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: "northwind/billing-svc" },
  headRepository: { nameWithOwner: "northwind/billing-svc" },
  author: { login: "dana", avatarUrl: "https://a/dana" },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [] },
});

function forge() {
  const state = { trees: [] as string[], files: [] as string[], tree: { exitCode: 0, stderr: "" } };
  const run = async (cli: string, args: string[]) => {
    const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
    if (args[0] === "auth") return cli === "gh" ? ok({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }) : { stdout: "", stderr: "no", exitCode: 1 };
    const tree = args.find((a) => a.includes("/git/trees/"));
    if (tree) {
      state.trees.push(tree);
      if (state.tree.exitCode) return { stdout: "", stderr: state.tree.stderr, exitCode: state.tree.exitCode };
      // gh's `--jq` has already shaped it.
      return ok({ truncated: false, paths: ["src/b.ts", "README.md", "src/a.ts"] });
    }
    const contents = args.find((a) => a.includes("/contents/"));
    if (contents) {
      state.files.push(contents);
      const text = "export const a = 1;\n";
      return ok({ type: "file", sha: "c".repeat(40), size: text.length, encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    if (args.some((a) => a.startsWith("query=query InboxPullsOthers"))) return ok({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } });
    if (args.includes("graphql")) return ok({ data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [pull(412)] }, merged: { nodes: [] } } });
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  return { state, run: run as never };
}
const q = (fields: Record<string, string>) => new URLSearchParams(fields);

describe("All files on the PR page", () => {
  test("the repository at the head the list read, sorted, once while it is kept", async () => {
    const f = forge();
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list(repos);
    const [one, two] = await Promise.all([pulls.repoFiles(KEY, q({ snapshot: HEAD })), pulls.repoFiles(KEY, q({ snapshot: HEAD }))]);
    expect(one).toEqual({ status: 200, body: { available: true, revision: { kind: "commit", label: "aaaaaaa" }, total: 3, live: false, paths: ["README.md", "src/a.ts", "src/b.ts"] } });
    expect(two).toEqual(one);
    expect(f.state.trees).toEqual([`repos/northwind/billing-svc/git/trees/${HEAD}?recursive=1`]);
  });

  test("never at a commit this Inbox did not read for that PR, nor for a PR the list did not name", async () => {
    const f = forge();
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list(repos);
    expect((await pulls.repoFiles(KEY, q({ snapshot: OTHER }))).status).toBe(409);
    expect((await pulls.repoFile(KEY, q({ snapshot: OTHER, path: "README.md" }))).status).toBe(409);
    expect(await pulls.repoFiles("github.com/elsewhere/thing#9", q({ snapshot: HEAD }))).toMatchObject({ status: 200, body: { available: false, reason: "unsupported" } });
    expect(f.state.trees).toEqual([]);
  });

  test("one listed file as text; nothing outside the listing is read", async () => {
    const f = forge();
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list(repos);
    expect(await pulls.repoFile(KEY, q({ snapshot: HEAD, path: "src/a.ts" }))).toEqual({ status: 200, body: { path: "src/a.ts", revision: { kind: "commit", label: "aaaaaaa" }, content: "export const a = 1;\n" } });
    expect(f.state.files).toEqual([`repos/northwind/billing-svc/contents/src%2Fa.ts?ref=${HEAD}`]);
    expect((await pulls.repoFile(KEY, q({ snapshot: HEAD, path: "src/secret.env" }))).status).toBe(404);
    expect((await pulls.repoFile(KEY, q({ snapshot: HEAD, path: "../etc/passwd" }))).status).toBe(400);
    expect(f.state.files).toHaveLength(1);
  });

  test("a failed listing is not kept; a rate limit holds the host's reads until it ends", async () => {
    let now = 1_000_000;
    const f = forge();
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    await pulls.list(repos);
    f.state.tree = { exitCode: 1, stderr: "HTTP 502" };
    expect(await pulls.repoFiles(KEY, q({ snapshot: HEAD }))).toMatchObject({ body: { available: false, reason: "failed" } });
    f.state.tree = { exitCode: 0, stderr: "" };
    expect(await pulls.repoFiles(KEY, q({ snapshot: HEAD }))).toMatchObject({ body: { available: true, total: 3 } });
    expect(f.state.trees).toHaveLength(2);

    const held = forge();
    const second = createInboxPulls({ run: held.run, now: () => now });
    await second.list(repos);
    held.state.tree = { exitCode: 1, stderr: "API rate limit exceeded" };
    await second.repoFiles(KEY, q({ snapshot: HEAD }));
    held.state.tree = { exitCode: 0, stderr: "" };
    expect(await second.repoFiles(KEY, q({ snapshot: HEAD }))).toMatchObject({ body: { available: false, reason: "failed" } });
    expect(held.state.trees).toHaveLength(1);
    now += 60 * 60_000;
    expect(await second.repoFiles(KEY, q({ snapshot: HEAD }))).toMatchObject({ body: { available: true } });
    expect(held.state.trees).toHaveLength(2);
  });
});
