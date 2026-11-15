/**
 * The PR board across linked machines, on two real Inboxes linked both ways (docs/agent-guides/inbox-machines.md,
 * "The PR board"). Each has its own scripted gh (a `refRunner`, signed in as the same person) listing different PRs,
 * one PR on both. What regresses: a machine's PRs missing from the other's board, or the shared one shown twice; a
 * close, reopen or merge of the other machine's PR running this machine's gh (or none); a script, an agent or a phone
 * reaching the other machine's gh; Undo going anywhere but the machine that closed; a forge write held for an asleep
 * machine; an asleep machine's rows dropped; a thread's PRs on the other machine not read or changed there; a review
 * thread's PRs (`pulls/owner`) kept anywhere but the thread's machine, or by a call without the window's mark; the
 * board of an Inbox with no machine linked changing at all.
 *
 * Starts Inboxes: CI runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { RefRunner } from "@plannotator/shared/ref-cards";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** GitHub's GraphQL node for a PR, as the list's query asks it. */
const node = (repo: string, number: number, author = "dana") => ({
  number,
  title: `PR ${number} of ${repo}`,
  url: `https://github.com/${repo}/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-14T10:00:00Z",
  mergedAt: null,
  baseRefName: "main",
  headRefName: `b${number}`,
  headRefOid: String(number).padStart(40, "a"),
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

/** A scripted gh: the person's own PRs (`authored`), each PR's state for the close route's read, and its writes kept. */
function fakeGh(prs: [string, number][]) {
  const states = new Map(prs.map(([repo, n]) => [`${repo}#${n}`, "open"]));
  const writes: string[] = [];
  const run: RefRunner = async (cli, args) => {
    if (cli !== "gh") return { stdout: "", stderr: "not found", exitCode: 127 };
    if (args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("InboxPullsOthers")) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } }), stderr: "", exitCode: 0 };
    if (args.includes("graphql")) {
      const open = prs.filter(([repo, n]) => states.get(`${repo}#${n}`) === "open").map(([repo, n]) => node(repo, n));
      const none = { issueCount: 0, nodes: [] };
      const data = { viewer: { login: "dana" }, rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-11-14T11:00:00Z" }, requested: none, assigned: none, authored: { issueCount: open.length, nodes: open }, merged: { nodes: [] }, everyRequested: none, everyAssigned: none, everyAuthored: { issueCount: open.length, nodes: open }, everyMerged: { nodes: [] } };
      return { stdout: JSON.stringify({ data }), stderr: "", exitCode: 0 };
    }
    // The close route: `api --hostname h repos/o/r/pulls/N` reads its state; `-X PATCH … -f state=…` writes it.
    const path = args.find((a) => /^repos\/.+\/pulls\/\d+$/.test(a));
    if (args[0] === "api" && path) {
      const [, repo, n] = /^repos\/(.+)\/pulls\/(\d+)$/.exec(path)!;
      const key = `${repo}#${n}`;
      if (args.includes("PATCH")) {
        const to = args.find((a) => a.startsWith("state="))!.slice("state=".length);
        writes.push(`${key} ${to}`);
        states.set(key, to);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify({ state: states.get(key) ?? "open", merged: false }), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "HTTP 404", exitCode: 1 };
  };
  return { run, writes };
}

/** No real tailscale ever runs: the loopback transport is the test sandbox's, and serve holds nothing. */
const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });

describe("the PR board across linked machines (mark `pulls`)", () => {
  const dirs: string[] = [];
  const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
  beforeAll(() => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  });
  afterAll(() => {
    if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const start = (dataDir: string, run: RefRunner) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, codeReview: true, refRunner: run, readProjectRepo: async () => null });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const board = async (port: number) => (await (await fetch(`${at(port)}/api/inbox/pulls?everywhere=1&machines=1`)).json()) as Json;
  const rows = async (port: number) => ((await board(port)).pulls as Json[]).map((p) => [p.key, p.machine ?? null, p.state]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const session = async (port: number) => ((await (await fetch(`${at(port)}/api/inbox/health`)).json()) as Json).serverSession as string;
  let keys = 0;
  /** A press in A's window: its own Origin and page session, the key the window adds. */
  const press = async (port: number, path: string, body: Json, window = true) =>
    fetch(`${at(port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(window ? { Origin: at(port) } : {}) },
      body: JSON.stringify({ serverSession: await session(port), idempotency_key: `window-pull-${++keys}`, ...body }),
    });

  const API7 = "github.com/northwind/api#7";
  const API8 = "github.com/northwind/api#8";
  const WEB1 = "github.com/northwind/web#1";
  const WEB2 = "github.com/northwind/web#2";

  test("one board both ways; B's PR closed, undone and merged-refused by B's gh from A's window only; B asleep, its rows stay and nothing is held", async () => {
    const ghA = fakeGh([["northwind/web", 1], ["northwind/web", 2]]);
    const ghB = fakeGh([["northwind/web", 1], ["northwind/api", 7], ["northwind/api", 8]]);
    const dataA = scratch("plannotator-pulls-linked-a-");
    const dataB = scratch("plannotator-pulls-linked-b-");
    const a = await start(dataA, ghA.run);
    let b: InboxServer = await start(dataB, ghB.run);
    let client: Client | null = null;
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const linkOnA = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0];
      const bId = linkOnA.id as string;
      const view = async () => (((await (await fetch(`${at(a.port)}/api/inbox/machines`)).json()) as Json).machines as Json[]).find((m) => m.id === bId)!;
      await waitFor("B's list on A", async () => typeof (await view()).list_cursor === "number");
      expect((await view()).marks).toContain("pulls");
      const aId = ((await (await fetch(`${at(a.port)}/api/inbox/threads?machines=1`)).json()) as Json).self as string;

      // One board on each: the PR both list once, as the viewer's own; the other's PRs with that machine.
      await waitFor("B's PRs on A's board", async () => (await rows(a.port)).length === 4, 20_000);
      expect(await rows(a.port)).toEqual([
        [API7, bId, "open"],
        [API8, bId, "open"],
        [WEB1, null, "open"],
        [WEB2, null, "open"],
      ]);
      await waitFor("A's PRs on B's board", async () => (await rows(b.port)).length === 4, 20_000);
      expect((await rows(b.port)).map((r) => [r[0], r[1]])).toEqual([
        [API7, null],
        [API8, null],
        [WEB1, null],
        [WEB2, aId],
      ]);

      // A script or an agent on A (no window): refused here, nothing runs on B.
      const bare = await press(a.port, `/api/inbox/m/${bId}/pulls/close`, { key: API7 }, false);
      expect(bare.status).toBe(403);
      expect(((await bare.json()) as Json).code).toBe("window_only");
      // A's machine token at B's door, without the window's word: refused there too.
      const atDoor = await fetch(`${at(b.port)}/api/inbox/device/pulls/close`, { method: "POST", headers: { Authorization: `Bearer ${linkOnA.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ key: API7, idempotency_key: "door-1" }) });
      expect(atDoor.status).toBe(403);
      expect(ghB.writes).toEqual([]);

      // A's window closes B's PR: B's gh writes it, A's never does; A's board reads it back closed.
      const closed = await press(a.port, `/api/inbox/m/${bId}/pulls/close`, { key: API7, idempotency_key: "close-7" });
      expect(closed.status).toBe(200);
      expect(ghB.writes).toEqual([`northwind/api#7 closed`]);
      expect(ghA.writes).toEqual([]);
      // The same press again (a retry with its key): the answer again, no second write.
      const again = await press(a.port, `/api/inbox/m/${bId}/pulls/close`, { key: API7, idempotency_key: "close-7" });
      expect(again.headers.get("Idempotent-Replayed")).toBe("true");
      expect(ghB.writes).toHaveLength(1);
      await waitFor("closed on A's board", async () => (await rows(a.port)).find((r) => r[0] === API7)?.[2] !== "open");

      // Undo goes to the machine that closed it; A never closed it, so A refuses a reopen of its own.
      expect((await press(a.port, "/api/inbox/pulls/reopen", { key: API7 })).status).toBe(409);
      const reopened = await press(a.port, `/api/inbox/m/${bId}/pulls/reopen`, { key: API7 });
      expect(reopened.status).toBe(200);
      expect(ghB.writes).toEqual([`northwind/api#7 closed`, `northwind/api#7 open`]);
      // A PR B did not close is not reopened by an Undo from anywhere.
      expect((await press(a.port, `/api/inbox/m/${bId}/pulls/reopen`, { key: API8 })).status).toBe(409);
      // The PR both list is A's: its close runs A's gh.
      expect((await press(a.port, "/api/inbox/pulls/close", { key: WEB1 })).status).toBe(200);
      expect(ghA.writes).toEqual([`northwind/web#1 closed`]);
      expect(ghB.writes).toHaveLength(2);

      // B's thread's PRs, read and changed on B from A's window.
      client = new Client({ name: "inbox-pulls-linked", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${at(b.port)}/mcp`)));
      const project = scratch("plannotator-pulls-linked-project-");
      const sent = (await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_b", body: "Opened the API change" } })) as { structuredContent: { thread_id: string } };
      const thread = sent.structuredContent.thread_id;
      await waitFor("B's thread on A", async () => {
        const list = (await (await fetch(`${at(a.port)}/api/inbox/threads?machines=1`)).json()) as Json;
        return (list.sections as Json[]).some((s) => (s.threads as Json[]).some((row) => row.thread_id === thread));
      });
      const added = await press(a.port, `/api/inbox/m/${bId}/threads/${thread}/pulls`, { add: ["northwind/api#7"] });
      expect(added.status).toBe(200);
      expect(b.store.threadPulls(thread).map((p) => p.pull)).toEqual([API7]);
      const read = (await (await fetch(`${at(a.port)}/api/inbox/m/${bId}/threads/${thread}/pulls`)).json()) as Json;
      expect((read.pulls as Json[]).length).toBe(1);
      expect(a.store.message(thread)).toBeNull();
      // Start review thread ties B's PRs to B's thread on B: only with A's window's mark, answered by B's
      // route (B knows the thread; its project has no repository here, so B refuses the PR in its own words).
      expect((await press(a.port, `/api/inbox/m/${bId}/pulls/owner`, { keys: [API7], thread_id: thread }, false)).status).toBe(403);
      const ownerAtDoor = await fetch(`${at(b.port)}/api/inbox/device/pulls/owner`, { method: "POST", headers: { Authorization: `Bearer ${linkOnA.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ keys: [API7], thread_id: thread, idempotency_key: "door-owner" }) });
      expect(ownerAtDoor.status).toBe(403);
      const owned = (await (await press(a.port, `/api/inbox/m/${bId}/pulls/owner`, { keys: [API7], thread_id: thread })).json()) as Json;
      expect(owned.error).toBe("thread_id: a thread in a project of that pull request's repository.");

      // B asleep: its rows stay as last read; a close says plainly it cannot run, and nothing waits to run later.
      await client.close();
      client = null;
      b.stop();
      await waitFor("B offline on A", async () => (await view()).state === "offline", 30_000);
      const away = await board(a.port);
      expect((away.pulls as Json[]).filter((p) => p.machine === bId).map((p) => p.key).sort()).toEqual([API7, API8]);
      expect(away.machines[bId].pending).toBe(false);
      const asleep = await press(a.port, `/api/inbox/m/${bId}/pulls/close`, { key: API8 });
      expect(asleep.status).toBe(503);
      expect(((await asleep.json()) as Json).code).toBe("machine_offline");
      expect((((await (await fetch(`${at(a.port)}/api/inbox/outbox`)).json()) as Json).waiting as Json[]).filter((e) => e.route.startsWith("pulls/"))).toEqual([]);
      b = await start(dataB, ghB.run);
      await waitFor("B back on A", async () => (await view()).state === "online", 45_000);
      expect(ghB.writes).toHaveLength(2);
    } finally {
      await client?.close().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 150_000);

  test("an Inbox with no machine linked: the board's answer is the same with or without `machines=1`", async () => {
    const gh = fakeGh([["northwind/web", 1]]);
    const alone = await start(scratch("plannotator-pulls-alone-"), gh.run);
    try {
      const plain = (await (await fetch(`${at(alone.port)}/api/inbox/pulls?everywhere=1`)).json()) as Json;
      const merged = await board(alone.port);
      expect(merged.machines).toBeUndefined();
      expect(merged.far_risk).toBeUndefined();
      expect({ ...merged, fetched_at: null }).toEqual({ ...plain, fetched_at: null });
    } finally {
      alone.stop();
    }
  });
});
