/**
 * The PR board across linked machines, on two real Inboxes linked both ways (docs/agent-guides/inbox-machines.md,
 * "The PR board"). Each has its own scripted gh (a `refRunner`, signed in as the same person) listing different PRs,
 * one PR on both. What regresses: a machine's PRs missing from the other's board, or the shared one shown twice; a
 * close, reopen or merge of the other machine's PR running this machine's gh (or none); a bare call (an agent's curl,
 * no Origin) or a machine token without the window's mark reaching the other machine's gh; a merge losing the head the
 * person saw or the second click on the way; a key the other machine does not list written there; Undo going anywhere
 * but the machine that closed; a forge write held for an asleep
 * machine; an asleep machine's rows dropped; a thread's PRs on the other machine not read or changed there; a review
 * thread's PRs (`pulls/owner`) kept anywhere but the thread's machine, or by a call without the window's mark; a look at
 * the other machine's PR ("Changed since you looked") not kept there or not read back; the board of an Inbox with no
 * machine linked changing at all.
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

/**
 * A scripted gh: the person's own PRs (`authored`), each PR's state for the close route's read, and its writes kept.
 * `hang`: its list waits for it (a machine that is online but does not answer).
 */
function fakeGh(prs: [string, number][], hang?: Promise<void>) {
  const states = new Map(prs.map(([repo, n]) => [`${repo}#${n}`, "open"]));
  const writes: string[] = [];
  const run: RefRunner = async (cli, args) => {
    if (cli !== "gh") return { stdout: "", stderr: "not found", exitCode: 127 };
    if (args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("InboxPullsOthers")) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } }), stderr: "", exitCode: 0 };
    if (args.includes("graphql")) {
      await hang;
      const open = prs.filter(([repo, n]) => states.get(`${repo}#${n}`) === "open").map(([repo, n]) => node(repo, n));
      const none = { issueCount: 0, nodes: [] };
      const data = { viewer: { login: "dana" }, rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-11-14T11:00:00Z" }, requested: none, assigned: none, authored: { issueCount: open.length, nodes: open }, merged: { nodes: [] }, everyRequested: none, everyAssigned: none, everyAuthored: { issueCount: open.length, nodes: open }, everyMerged: { nodes: [] } };
      return { stdout: JSON.stringify({ data }), stderr: "", exitCode: 0 };
    }
    // Merge: `-X PUT repos/o/r/pulls/N/merge … -f sha=…` writes it, at the head it was read at.
    const merge = args.find((a) => /^repos\/.+\/pulls\/\d+\/merge$/.test(a));
    if (args[0] === "api" && merge && args.includes("PUT")) {
      const [, repo, n] = /^repos\/(.+)\/pulls\/(\d+)\/merge$/.exec(merge)!;
      writes.push(`${repo}#${n} merged ${args.find((a) => a.startsWith("sha="))!.slice("sha=".length, "sha=".length + 7)}`);
      states.set(`${repo}#${n}`, "merged");
      return { stdout: JSON.stringify({ merged: true }), stderr: "", exitCode: 0 };
    }
    // The repository's merge methods (the merge reads them before it writes).
    if (args[0] === "api" && args.some((a) => /^repos\/[^/]+\/[^/]+$/.test(a))) return { stdout: JSON.stringify({ full_name: "x", allow_merge_commit: true }), stderr: "", exitCode: 0 };
    // Close and merge read `api --hostname h repos/o/r/pulls/N` first; `-X PATCH … -f state=…` writes a close or reopen.
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
      const state = states.get(key) ?? "open";
      const head = { sha: n!.padStart(40, "a") };
      return { stdout: JSON.stringify({ state: state === "merged" ? "closed" : state, merged: state === "merged", merged_at: state === "merged" ? "2026-11-14T10:05:00Z" : null, draft: false, head, mergeable: true, mergeable_state: "clean" }), stderr: "", exitCode: 0 };
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
  /**
   * A press in A's window: its own Origin and page session, the key the window adds. A local program can send the same
   * and is taken as the window ("Accepted, not defended" in inbox-launch.md); `window = false` is an agent's bare call.
   */
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

  test("one board both ways; B's PR closed, undone and merged by B's gh for A's window's request only; B asleep, its rows stay and nothing is held", async () => {
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

      // "Changed since you looked": A's window looks at B's PR. The look is kept on B (mark `pulls-looked`), so B's own
      // board carries it, and A's merged board reads it back from B.
      expect((await board(a.port)).machines[bId].looked).toBe(true);
      const look = { key: API7, sha: "c".repeat(40), at: Date.now() };
      expect((await press(a.port, `/api/inbox/m/${bId}/pulls/looked`, { seen: [look] })).status).toBe(200);
      expect(((await board(b.port)).pulls as Json[]).find((p) => p.key === API7)!.looked).toEqual({ sha: look.sha, at: look.at });
      await waitFor("B's look on A's board", async () => ((await board(a.port)).pulls as Json[]).find((p) => p.key === API7)?.looked?.sha === look.sha);
      expect(((await board(a.port)).pulls as Json[]).find((p) => p.key === WEB2)!.looked).toBeUndefined();

      // An agent's bare call on A (no Origin, no page session): refused here, nothing runs on B.
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

      // Merge through the forward: the head the person saw and the second click reach B, which asks its forge again.
      const head7 = "7".padStart(40, "a");
      const merge = (fields: Json, window = true) => press(a.port, `/api/inbox/m/${bId}/pulls/merge`, { key: API7, ...fields }, window);
      expect((await merge({ head_sha: head7, confirmed: true }, false)).status).toBe(403);
      const unconfirmed = await merge({ head_sha: head7 });
      expect([unconfirmed.status, ((await unconfirmed.json()) as Json).code]).toEqual([409, "merge_unconfirmed"]);
      const moved = await merge({ head_sha: "b".repeat(40), confirmed: true });
      expect([moved.status, ((await moved.json()) as Json).code]).toEqual([409, "pull_moved"]);
      expect(ghB.writes).toHaveLength(2);
      const merged = await merge({ head_sha: head7, confirmed: true });
      expect(merged.status).toBe(200);
      expect(((await merged.json()) as Json).method).toBe("merge");
      expect(ghB.writes.at(-1)).toBe(`northwind/api#7 merged aaaaaaa`);
      expect(ghA.writes).toEqual([`northwind/web#1 closed`]);
      // A key B's list does not hold is never written there: B reads its list again, then refuses it.
      const unknown = await press(a.port, `/api/inbox/m/${bId}/pulls/close`, { key: "github.com/northwind/api#999" });
      expect([unknown.status, ((await unknown.json()) as Json).code]).toEqual([404, "pull_unknown"]);
      expect(ghB.writes).toHaveLength(3);

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
      const farKeys = (answer: Json) => (answer.pulls as Json[]).filter((p) => p.machine === bId).map((p) => p.key).sort();
      const lastRead = farKeys(await board(a.port));
      expect(lastRead).toContain(API8);
      b.stop();
      await waitFor("B offline on A", async () => (await view()).state === "offline", 30_000);
      const away = await board(a.port);
      expect(farKeys(away)).toEqual(lastRead);
      expect(away.machines[bId].pending).toBe(false);
      const asleep = await press(a.port, `/api/inbox/m/${bId}/pulls/close`, { key: API8 });
      expect(asleep.status).toBe(503);
      expect(((await asleep.json()) as Json).code).toBe("machine_offline");
      expect((((await (await fetch(`${at(a.port)}/api/inbox/outbox`)).json()) as Json).waiting as Json[]).filter((e) => e.route.startsWith("pulls/"))).toEqual([]);
      b = await start(dataB, ghB.run);
      await waitFor("B back on A", async () => (await view()).state === "online", 45_000);
      expect(ghB.writes).toHaveLength(3);
    } finally {
      await client?.close().catch(() => {});
      a.stop();
      b.stop();
    }
  }, 150_000);

  test("a linked machine online but not answering: this machine's board answers at once, the other's pending, then joins", async () => {
    let answer = () => {};
    const ghA = fakeGh([["northwind/web", 1]]);
    const ghB = fakeGh([["northwind/api", 7]], new Promise<void>((done) => (answer = done)));
    const dataA = scratch("plannotator-pulls-hang-a-");
    const a = await start(dataA, ghA.run);
    const b = await start(scratch("plannotator-pulls-hang-b-"), ghB.run);
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      expect((await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) })).status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      await waitFor("B online with `pulls` on A", async () => {
        const view = (((await (await fetch(`${at(a.port)}/api/inbox/machines`)).json()) as Json).machines as Json[]).find((m) => m.id === bId);
        return view?.state === "online" && (view.marks as string[]).includes("pulls");
      });
      // Before, the first read waited 8 s for B (3 s after). Now never: a bound far under either, and over any slow runner.
      for (const round of [1, 2]) {
        const at0 = performance.now();
        const first = await board(a.port);
        expect([round, performance.now() - at0 < 2_500]).toEqual([round, true]);
        expect((first.pulls as Json[]).map((p) => p.key)).toEqual([WEB1]);
        expect(first.machines[bId]).toMatchObject({ read_at: null, pending: true });
      }
      answer();
      await waitFor("B's PR joins A's board", async () => (await rows(a.port)).some((r) => r[0] === API7 && r[1] === bId), 20_000);
    } finally {
      answer();
      a.stop();
      b.stop();
    }
  }, 60_000);

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
