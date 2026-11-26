/**
 * The person's own GitLab lists, read as one query per list (GitLab refuses the four in one query: its complexity is
 * over GitLab's limit), with a scripted glab: no real CLI or forge.
 *
 * What regresses:
 *  - the lists asked in one query again, or one asked without `--hostname`;
 *  - the answers not merged into one list (a list lost, or an MR asked of the person losing its mark);
 *  - one list failing taking the others' fresh answers with it once that list has answered before, or that list
 *    shown empty instead of its last answer; the host not said to have failed then;
 *  - one list failing on the first read reading as a whole answer with that list empty;
 *  - a kept list's old row (its checks, or open for an MR since merged) overwriting a fresh list's row of the same MR.
 */
import { describe, expect, test } from "bun:test";
import { createInboxPulls, INBOX_PULLS_FRESH_MS } from "./inbox-pulls";
import { REF_FAILURE_MS, type RefRunner } from "./ref-cards";

const HOST = "git.northwind.example";
const repos = [{ host: HOST, repo: "northwind/data/ledger", project_id: "prj_1" }];

const MR = (iid: number) => ({
  iid: String(iid),
  title: `MR ${iid}`,
  webUrl: `https://${HOST}/northwind/data/ledger/-/merge_requests/${iid}`,
  state: iid >= 90 ? "merged" : "opened",
  draft: false,
  updatedAt: "2026-11-03T10:00:00Z",
  mergedAt: iid >= 90 ? "2026-11-02T10:00:00Z" : null,
  sourceBranch: `b${iid}`,
  targetBranch: "main",
  diffHeadSha: String(iid).padStart(40, "b"),
  approved: false,
  detailedMergeStatus: "NOT_APPROVED",
  diffStatsSummary: { additions: 3, deletions: 1, fileCount: 2 },
  headPipeline: { status: "SUCCESS" },
  project: { fullPath: "northwind/data/ledger" },
  sourceProject: { fullPath: "northwind/data/ledger" },
  author: { username: iid === 62 || iid === 90 ? "dana" : "jun" },
  approvedBy: { nodes: [] },
  reviewers: { nodes: [] },
});

/** Each list's answer, by the alias its query asks. */
const LISTS: Record<string, unknown> = {
  requested: { count: 1, nodes: [MR(61)] },
  authored: { count: 1, nodes: [MR(62)] },
  assigned: { count: 1, nodes: [MR(63)] },
  merged: { nodes: [MR(90)] },
};

function gitlab() {
  const calls: string[][] = [];
  /** A list whose query fails, and how. */
  const failing = new Map<string, { stderr: string; exitCode: number; stdout?: string }>();
  const run: RefRunner = async (cli, args) => {
    if (cli === "gh") return { stdout: "", stderr: "not logged in", exitCode: 1 };
    if (args[0] === "auth") return { stdout: "", stderr: `${HOST}\n  ✓ Logged in to ${HOST} as dana (keyring)\n`, exitCode: 0 };
    const query = args.find((a) => a.startsWith("query="));
    if (!query || query.startsWith("query=query InboxPullsOthers")) return { stdout: JSON.stringify({ data: { currentUser: { username: "dana" } } }), stderr: "", exitCode: 0 };
    calls.push(args);
    const alias = /\b(requested|authored|assigned|merged): /.exec(query)?.[1] ?? "";
    const failure = failing.get(alias);
    if (failure) return { stdout: failure.stdout ?? "", stderr: failure.stderr, exitCode: failure.exitCode };
    return { stdout: JSON.stringify({ data: { currentUser: { username: "dana", [alias]: LISTS[alias] } } }), stderr: "", exitCode: 0 };
  };
  return { run, calls, failing };
}

const numbers = (answer: { pulls: { number: number }[] }) => answer.pulls.map((p) => p.number).sort();

describe("GitLab: the person's own lists", () => {
  test("each list is its own query to the host, asked together, and the answers merge into one list", async () => {
    const g = gitlab();
    const pulls = createInboxPulls({ run: g.run });
    const answer = await pulls.list(repos);
    expect(g.calls).toHaveLength(4);
    for (const args of g.calls) expect(args.slice(0, 4)).toEqual(["api", "--hostname", HOST, "graphql"]);
    const asked = g.calls.map((args) => /\b(requested|authored|assigned|merged): /.exec(args.join(" "))?.[1]).sort();
    expect(asked).toEqual(["assigned", "authored", "merged", "requested"]);
    expect(numbers(answer)).toEqual([61, 62, 63, 90]);
    const byNumber = new Map(answer.pulls.map((p) => [p.number, p]));
    expect(byNumber.get(61)?.requested).toBe(true);
    expect(byNumber.get(63)?.assigned).toBe(true);
    expect(byNumber.get(62)?.mine).toBe(true);
    expect(byNumber.get(90)?.state).toBe("merged");
    expect(answer.hosts[0]).toMatchObject({ cli: "glab", host: HOST, login: "dana" });
    expect(answer.hosts[0]!.error).toBeUndefined();
  });

  test("one list failing after it answered once: the others are fresh, that one keeps its last answer, and the host says it failed", async () => {
    let now = 1_000_000;
    const g = gitlab();
    const pulls = createInboxPulls({ run: g.run, now: () => now });
    const first = await pulls.list(repos);
    expect(numbers(first)).toEqual([61, 62, 63, 90]);

    now += INBOX_PULLS_FRESH_MS + 1;
    LISTS.authored = { count: 2, nodes: [MR(62), MR(64)] };
    g.failing.set("requested", { stderr: "glab: 502 Bad Gateway", exitCode: 1 });
    const second = await pulls.list(repos);
    expect(g.calls).toHaveLength(8);
    // 64 is the authored list's new MR; 61, asked of the person, is the requested list's last answer.
    expect(numbers(second)).toEqual([61, 62, 63, 64, 90]);
    expect(second.pulls.find((p) => p.number === 61)?.requested).toBe(true);
    expect(second.hosts[0]!.error).toBe("unavailable");
    expect(second.hosts[0]!.last_read).toBe(new Date(1_000_000).toISOString());

    // That list answers again: the host is whole, and nothing is held from before.
    now += REF_FAILURE_MS + 1;
    g.failing.clear();
    const third = await pulls.list(repos, { refresh: true });
    expect(third.hosts[0]!.error).toBeUndefined();
    expect(numbers(third)).toEqual([61, 62, 63, 64, 90]);
    LISTS.authored = { count: 1, nodes: [MR(62)] };
  });

  test("one list failing on the first read fails the host: no list is shown empty in its place", async () => {
    const g = gitlab();
    g.failing.set("assigned", { stdout: JSON.stringify({ errors: [{ message: "Field 'assignedMergeRequests' doesn't exist on type 'CurrentUser'" }] }), stderr: "", exitCode: 0 });
    const pulls = createInboxPulls({ run: g.run });
    const answer = await pulls.list(repos);
    expect(answer.pulls).toEqual([]);
    expect(answer.hosts[0]!.error).toBe("unavailable");
    expect(answer.hosts[0]!.last_read).toBeUndefined();
  });

  test("an MR in a fresh list and a kept one shows the fresh row; between two kept ones, the newer", async () => {
    const saved = { ...LISTS };
    try {
      let now = 1_000_000;
      const g = gitlab();
      const pulls = createInboxPulls({ run: g.run, now: () => now });
      // 65 is assigned to the person and asked of them.
      LISTS.assigned = { count: 2, nodes: [MR(63), MR(65)] };
      LISTS.requested = { count: 2, nodes: [MR(61), MR(65)] };
      await pulls.list(repos);

      // Its pipeline fails; the requested list can't be read, so its answer is the one from before.
      now += INBOX_PULLS_FRESH_MS + 1;
      LISTS.assigned = { count: 2, nodes: [MR(63), { ...MR(65), headPipeline: { status: "FAILED" } }] };
      g.failing.set("requested", { stderr: "glab: 502 Bad Gateway", exitCode: 1 });
      const second = await pulls.list(repos);
      expect(second.hosts[0]!.error).toBe("unavailable");
      const row = second.pulls.find((p) => p.number === 65)!;
      expect(row.checks).toBe("failure");
      expect(row).toMatchObject({ requested: true, assigned: true });

      // Now neither can be read: the assigned list's answer is the newer of the two kept.
      now += REF_FAILURE_MS + 1;
      g.failing.set("assigned", { stderr: "glab: 502 Bad Gateway", exitCode: 1 });
      const third = await pulls.list(repos, { refresh: true });
      expect(g.calls).toHaveLength(12);
      expect(third.hosts[0]!.error).toBe("unavailable");
      expect(third.pulls.find((p) => p.number === 65)?.checks).toBe("failure");
    } finally {
      Object.assign(LISTS, saved);
    }
  });

  test("an MR a fresh list says is merged is never shown open from a kept list", async () => {
    const saved = { ...LISTS };
    try {
      let now = 1_000_000;
      const g = gitlab();
      const pulls = createInboxPulls({ run: g.run, now: () => now });
      // The person wrote 66 and reviews it.
      const mine = { ...MR(66), author: { username: "dana" } };
      LISTS.authored = { count: 2, nodes: [MR(62), mine] };
      LISTS.requested = { count: 2, nodes: [MR(61), mine] };
      await pulls.list(repos);

      // It is merged: it leaves the open authored list for the merged one, and the requested list can't be read.
      now += INBOX_PULLS_FRESH_MS + 1;
      LISTS.authored = { count: 1, nodes: [MR(62)] };
      LISTS.merged = { nodes: [MR(90), { ...mine, state: "merged", mergedAt: "2026-11-03T11:00:00Z" }] };
      g.failing.set("requested", { stderr: "glab: 502 Bad Gateway", exitCode: 1 });
      const second = await pulls.list(repos);
      expect(second.hosts[0]!.error).toBe("unavailable");
      expect(second.pulls.find((p) => p.number === 66)).toMatchObject({ state: "merged", merged_at: "2026-11-03T11:00:00Z" });
    } finally {
      Object.assign(LISTS, saved);
    }
  });

  test("a rate limit on one list holds the host, the others' answers notwithstanding", async () => {
    let now = 1_000_000;
    const g = gitlab();
    const pulls = createInboxPulls({ run: g.run, now: () => now });
    await pulls.list(repos);
    now += INBOX_PULLS_FRESH_MS + 1;
    g.failing.set("merged", { stderr: "glab: 429 Too Many Requests", exitCode: 1 });
    const limited = await pulls.list(repos);
    expect(limited.hosts[0]!.error).toBe("rate_limited");
    expect(numbers(limited)).toEqual([61, 62, 63, 90]);
  });
});
