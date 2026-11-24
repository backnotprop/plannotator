/** Ship's one read of a pull request (inbox-ship-read.ts), from a GraphQL answer and a fake gh: never the real CLI. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxShip } from "@plannotator/core/inbox-pull-handoff";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { parseGitlabPulls } from "./inbox-pulls";
import { createShipReader, parseShipPull, readShipPull, shipReadFailure } from "./inbox-ship-read";
import { createInboxShipRoutes } from "./inbox-ship-routes";
import { createInboxShipStore } from "./inbox-ship-store";
import { createInboxShipWatch } from "./inbox-ship-watch";

const answer = (pr: Record<string, unknown>) => JSON.stringify({ data: { viewer: { login: "charlie-dunn" }, repository: { pullRequest: pr } } });
const base = {
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "CONFLICTING",
  mergeStateStatus: "DIRTY",
  latestReviews: { nodes: [{ state: "APPROVED", author: { login: "bob-tully" } }, { state: "CHANGES_REQUESTED", author: { login: "ada-novak" } }] },
  comments: { nodes: [{ id: "IC_1", createdAt: "2026-11-24T14:00:00Z", author: { login: "ada-novak" } }, { id: "IC_2", createdAt: "2026-11-24T14:30:00Z", author: { login: "charlie-dunn" } }] },
  reviewThreads: { nodes: [{ comments: { nodes: [{ id: "RC_1", createdAt: "2026-11-24T14:10:00Z", author: { login: "bob-tully" } }] } }] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "FAILURE",
            contexts: { nodes: [{ __typename: "CheckRun", name: "e2e-checkout", conclusion: "FAILURE", status: "COMPLETED" }, { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" }, { __typename: "StatusContext", context: "ci/deploy", state: "ERROR" }] },
          },
        },
      },
    ],
  },
};

describe("parseShipPull", () => {
  test("the facts the watch needs: failing checks by name, who asked for changes, every comment with its author, the signed-in login", () => {
    const read = parseShipPull(answer(base))!;
    expect(read.state).toBe("open");
    expect(read.failing).toEqual(["e2e-checkout", "ci/deploy"]);
    expect(read.checks).toBe("failure");
    expect(read.review).toBe("changes_requested");
    expect(read.reviewer).toBe("ada-novak");
    expect(read.conflicts).toBe(true);
    // Oldest first, code comments among them: the watch tells which are news (the signed-in login's may be the agent's).
    expect(read.comments).toEqual([
      { id: "IC_1", by: "ada-novak" },
      { id: "RC_1", by: "bob-tully" },
      { id: "IC_2", by: "charlie-dunn" },
    ]);
    expect(read.viewer).toBe("charlie-dunn");
  });

  test("merged, draft and behind", () => {
    expect(parseShipPull(answer({ ...base, state: "MERGED", mergedAt: "2026-11-24T14:47:00Z" }))!.merged_at).toBe("2026-11-24T14:47:00Z");
    expect(parseShipPull(answer({ ...base, isDraft: true }))!.state).toBe("draft");
    expect(parseShipPull(answer({ ...base, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }))!.behind).toBe(true);
  });

  test("not an answer: null", () => {
    expect(parseShipPull("nope")).toBeNull();
    expect(parseShipPull(JSON.stringify({ data: { repository: { pullRequest: null } } }))).toBeNull();
  });
});

describe("readShipPull", () => {
  test("one gh graphql call on the PR's host; a failed call says why", async () => {
    const calls: string[][] = [];
    const run = async (cli: string, args: string[]) => {
      calls.push([cli, ...args]);
      return { exitCode: 0, stdout: answer(base), stderr: "" };
    };
    const read = await readShipPull(run as never, { host: "github.com", repo: "harbor/fern-api", number: 614 });
    expect("failing" in read && read.failing).toContain("e2e-checkout");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 5)).toEqual(["gh", "api", "graphql", "--hostname", "github.com"]);
    expect(calls[0]).toContain("number=614");
    const signedOut = async () => ({ exitCode: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" });
    expect(await readShipPull(signedOut as never, { host: "github.com", repo: "harbor/fern-api", number: 614 })).toEqual({ failed: "gh isn't signed in to github.com" });
    const missing = async () => ({ exitCode: 127, stdout: "", stderr: "gh: command not found" });
    expect(await readShipPull(missing as never, { host: "github.com", repo: "harbor/fern-api", number: 614 })).toEqual({ failed: "gh isn't installed" });
    expect(shipReadFailure("gh", "github.com", null)).toBe("gh didn't run");
  });
});

describe("a GitLab merge request ships", () => {
  // A merge request as GitLab answers the Reviews list's own query (parseGitlabPulls), not a pull made by hand.
  const mr = (over: Record<string, unknown> = {}) => ({
    iid: 45,
    title: "Send a receipt after checkout",
    webUrl: "https://gitlab.com/harbor/fern-api/-/merge_requests/45",
    state: "opened",
    draft: false,
    project: { fullPath: "harbor/fern-api", repository: { rootRef: "main" } },
    sourceProject: { fullPath: "harbor/fern-api" },
    author: { username: "dana" },
    targetBranch: "main",
    sourceBranch: "receipts",
    diffHeadSha: "d".repeat(40),
    headPipeline: { status: "RUNNING" },
    detailedMergeStatus: "MERGEABLE",
    conflicts: false,
    approvedBy: { nodes: [] },
    reviewers: { nodes: [] },
    diffStatsSummary: { additions: 1, deletions: 0, fileCount: 1 },
    updatedAt: "2026-11-24T14:00:00Z",
    mergedAt: null,
    ...over,
  });
  const listOf = (item: Record<string, unknown>): InboxPull =>
    parseGitlabPulls(JSON.stringify({ data: { currentUser: { username: "dana", authored: { nodes: [item] }, requested: { nodes: [] }, merged: { nodes: [] } } } }), "gitlab.com")!.pulls[0]!;

  test("its record says GitLab, its watch reads the list (no gh), a failed pipeline wakes the agent, and merged ends it", async () => {
    let listed = listOf(mr());
    const ships = createInboxShipStore(mkdtempSync(join(tmpdir(), "ship-gitlab-")));
    const cli: string[] = [];
    const read = createShipReader({
      run: (async (name: string) => {
        cli.push(name);
        return { exitCode: 1, stdout: "", stderr: "" };
      }) as never,
      listed: async () => listed,
    });
    const notes: string[] = [];
    const watch = createInboxShipWatch({ ships, read, note: (_s, body) => notes.push(body), everyMs: 60 * 60_000 });
    try {
      const routes = createInboxShipRoutes({
        ships,
        watch,
        serverSession: "s1",
        json: (body, status = 200) => Response.json(body, { status }),
        readBody: async (req) => (await req.json()) as Record<string, unknown>,
        findPull: async (key) => (key === listed.key ? listed : null),
        threadProject: () => "prj_fern",
        threadAgent: () => null,
        repoProjects: async () => ({}),
        sendInstruction: async () => ({ agent: { host: "codex", session: "ses_1", name: "Codex" }, message_id: "msg_ship" }),
        fromMachine: () => null,
        guard: () => null,
      });
      const path = "/api/inbox/ships";
      const res = await routes(new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify({ key: listed.key, thread_id: "msg_thread", to: { host: "codex", session: "ses_1" }, idempotency_key: "k1" }) }), path, new URL(`http://127.0.0.1${path}`));
      expect(res!.status).toBe(200);
      expect(ships.get(listed.key)!.platform).toBe("gitlab");
      await watch.tick();
      listed = listOf(mr({ headPipeline: { status: "FAILED" } }));
      await watch.tick();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("Checks failed on ddddddd: pipeline.");
      listed = listOf(mr({ state: "merged", mergedAt: "2026-11-24T15:00:00Z" }));
      await watch.tick();
      expect(ships.get(listed.key)!.state).toBe("merged");
      expect(cli).toEqual([]);
    } finally {
      watch.close();
    }
  });

  test("a forge the Inbox reads no pull requests of is refused: nothing ships", async () => {
    const ships = createInboxShipStore(mkdtempSync(join(tmpdir(), "ship-forge-")));
    const watch = createInboxShipWatch({ ships, read: async () => null, note: () => {}, everyMs: 60 * 60_000 });
    try {
      const other = { ...listOf(mr()), platform: "bitbucket" } as unknown as InboxPull;
      const routes = createInboxShipRoutes({
        ships,
        watch,
        serverSession: "s1",
        json: (body, status = 200) => Response.json(body, { status }),
        readBody: async (req) => (await req.json()) as Record<string, unknown>,
        findPull: async () => other,
        threadProject: () => "prj_fern",
        threadAgent: () => null,
        repoProjects: async () => ({}),
        sendInstruction: async () => ({ agent: { host: "codex", session: "ses_1", name: "Codex" }, message_id: "msg_ship" }),
        fromMachine: () => null,
        guard: () => null,
      });
      const path = "/api/inbox/ships";
      const call = routes(new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify({ key: other.key, thread_id: "msg_thread", to: { host: "codex", session: "ses_1" }, idempotency_key: "k1" }) }), path, new URL(`http://127.0.0.1${path}`));
      await expect(call).rejects.toMatchObject({ code: "pull_not_shippable" });
      expect(ships.all()).toEqual([] as InboxShip[]);
    } finally {
      watch.close();
    }
  });
});
