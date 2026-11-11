/**
 * The window's route for a thread's PRs and the state reader behind it
 * (approval "inbox-pr-binding", 2026-11-08). The forge is a stand-in runner:
 * no gh runs. The failures these guard: a tailnet guest (or any request the
 * Inbox does not count as the owner's) that changes a thread's PRs; a bad ref
 * that half-writes; the person's change recorded as an agent's; one gh call
 * per PR instead of one per repository; a merged PR read again on every view;
 * a state that lands on one thread but not on another holding the same PR;
 * a fixture that is not read in the sandbox; and a window's read that waits
 * on the forge (a stuck glab once kept a hover on "Loading" and, with the
 * browser's few connections held, stopped threads from opening).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxThreadPullRefs, type InboxAuthor, type InboxThreadPullsAnswer } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createThreadPullStates, createThreadPullsRoute, THREAD_PULLS_ADD_WAIT_MS, threadPullsChangedForWake, type ThreadPullFixture } from "./inbox-thread-pulls";

/** Let the reads behind an answer land (the stand-in forges answer at once). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };

/** A gh stand-in answering one GraphQL query per repository with the PRs it names. */
function fakeGh(states: Record<number, { state: string; isDraft?: boolean; base?: string; head?: string; checks?: string }>) {
  const calls: string[][] = [];
  const run = async (cli: string, args: string[]) => {
    calls.push([cli, ...args]);
    const numbers = [...args.join(" ").matchAll(/n(\d+): pullRequest/g)].map((m) => Number(m[1]));
    const repository: Record<string, unknown> = {};
    for (const number of numbers) {
      const s = states[number];
      repository[`n${number}`] = s
        ? { state: s.state, isDraft: s.isDraft ?? false, title: `PR ${number}`, baseRefName: s.base ?? "main", headRefName: s.head ?? `b${number}`, reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: s.checks ? { state: s.checks } : null } }] } }
        : null;
    }
    return { stdout: JSON.stringify({ data: { repository } }), stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

function world(options: { fixture?: () => ThreadPullFixture | null; gh?: { run: unknown; calls: string[][] }; onLiveChange?: (threadIds: readonly string[]) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-pulls-route-"));
  roots.push(dir);
  let now = Date.parse("2026-11-08T10:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date(now) });
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "Opened the retry PR.", subject: "Invoice retries" }).message.id;
  const gh = options.gh ?? fakeGh({});
  const states = createThreadPullStates({ store, run: gh.run as never, now: () => now, fixture: options.fixture ?? null, onLiveChange: options.onLiveChange });
  const route = createThreadPullsRoute({
    store,
    states,
    serverSession: "srv_1",
    json: (data, status = 200) => Response.json(data, { status }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    sessionMismatch: (body) => (typeof body.serverSession === "string" && body.serverSession !== "srv_1" ? Response.json({ error: "stale" }, { status: 409 }) : null),
    localOnly: () => Response.json({ error: "owner only" }, { status: 403 }),
    now: () => now,
  });
  const path = (id: string) => `/api/inbox/threads/${id}/pulls`;
  const get = (id: string, owner = true) => route.route(new Request(`http://x${path(id)}`), path(id), owner);
  const post = (id: string, body: Record<string, unknown>, owner = true) =>
    route.route(new Request(`http://x${path(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), path(id), owner);
  const agentAdd = (id: string, ...values: string[]) => {
    const parsed = parseInboxThreadPullRefs(values, "add");
    if ("error" in parsed) throw new Error(parsed.error);
    return store.changeThreadPulls({ thread_id: id, add: parsed.refs, by: { kind: "agent", session: "ses_a", host: "claude-code", name: "Claude Code" } });
  };
  return { store, project, thread, get, post, agentAdd, gh, advance: (ms: number) => (now += ms) };
}

describe("the window's route", () => {
  test("only the owner's window may change a thread's PRs; anyone else gets 403 and nothing is written", async () => {
    const w = world();
    const refused = await w.post(w.thread, { add: ["o/r#1"] }, false);
    expect(refused!.status).toBe(403);
    expect(w.store.threadPulls(w.thread)).toEqual([]);
    // A window from before a restart is told so, and writes nothing either.
    expect((await w.post(w.thread, { serverSession: "srv_old", add: ["o/r#1"] }))!.status).toBe(409);
    expect(w.store.threadPulls(w.thread)).toEqual([]);
  });

  test("the person's add is written as the person's and answers the list; a bad ref refuses the whole change", async () => {
    const w = world();
    const answer = (await (await w.post(w.thread, { add: ["o/r#1", "acme/api!3"] }))!.json()) as InboxThreadPullsAnswer & { serverSession: string };
    expect(answer.serverSession).toBe("srv_1");
    expect(answer.pulls.map((p) => [p.ref, p.added_by.kind])).toEqual([
      ["o/r#1", "person"],
      ["acme/api!3", "person"],
    ]);
    let error: unknown = null;
    await w.post(w.thread, { add: ["o/r#2", "#5"] }).catch((e) => (error = e));
    expect(error).toBeInstanceOf(InboxError);
    expect((error as InboxError).code).toBe("validation_error");
    expect(w.store.threadPulls(w.thread)).toHaveLength(2);
  });

  test("remove [\"all\"] takes every PR off, and the answer lists them as removed", async () => {
    const w = world();
    w.agentAdd(w.thread, "o/r#1", "o/r#2");
    const answer = (await (await w.post(w.thread, { remove: ["all"] }))!.json()) as InboxThreadPullsAnswer;
    expect(answer.pulls).toEqual([]);
    expect(answer.removed.map((p) => p.removed_by?.kind)).toEqual(["person", "person"]);
  });

  test("an unknown thread is 404; another path is not this route's", async () => {
    const w = world();
    expect((await w.get("msg_nope"))!.status).toBe(404);
    expect(await w.get(`${w.thread}/x`)).toBeNull();
  });
});

describe("the state reader", () => {
  test("one gh call per repository; the state lands on every thread holding the PR, and stacks come out of it", async () => {
    const gh = fakeGh({ 1: { state: "MERGED", base: "main", head: "schema" }, 2: { state: "OPEN", base: "schema", head: "worker", checks: "PENDING" }, 3: { state: "OPEN", isDraft: true } });
    const w = world({ gh });
    const other = w.store.sendMessage({ project_id: w.project.id, author: { ...AGENT, session: "ses_b" }, body: "Another thread.", subject: "Other" }).message.id;
    expect(other).not.toBe(w.thread);
    w.agentAdd(w.thread, "o/r#1", "o/r#2", "o/r#3");
    w.agentAdd(other, "o/r#2");
    // The read answers what is known at once (nothing read yet), and reads behind it.
    const first = (await (await w.get(w.thread))!.json()) as InboxThreadPullsAnswer;
    expect(first.pulls.map((p) => p.state)).toEqual(["unknown", "unknown", "unknown"]);
    await settle();
    const answer = (await (await w.get(w.thread))!.json()) as InboxThreadPullsAnswer;
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(answer.pulls.map((p) => [p.label, p.state, p.checks])).toEqual([
      ["#1", "merged", null],
      ["#2", "open", "running"],
      ["#3", "draft", null],
    ]);
    expect(answer.groups).toEqual([
      { kind: "stack", pulls: ["github.com/o/r#1", "github.com/o/r#2"] },
      { kind: "related", pulls: ["github.com/o/r#3"] },
    ]);
    expect(w.store.threadPulls(other)[0]!.state).toBe("open");
  });

  test("a merged PR is never read again; an open one is read again only once its answer is 30 s old on a view", async () => {
    const gh = fakeGh({ 1: { state: "MERGED" }, 2: { state: "OPEN" } });
    const w = world({ gh });
    w.agentAdd(w.thread, "o/r#1", "o/r#2");
    await w.get(w.thread);
    await settle();
    await w.get(w.thread);
    await settle();
    expect(gh.calls).toHaveLength(1);
    w.advance(31_000);
    await w.get(w.thread);
    await settle();
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[1]!.join(" ")).toContain("n2: pullRequest");
    expect(gh.calls[1]!.join(" ")).not.toContain("n1: pullRequest");
  });

  test("a tailnet guest's read runs no gh: it gets the stored state", async () => {
    const gh = fakeGh({ 1: { state: "OPEN" } });
    const w = world({ gh });
    w.agentAdd(w.thread, "o/r#1");
    const answer = (await (await w.get(w.thread, false))!.json()) as InboxThreadPullsAnswer;
    expect(gh.calls).toEqual([]);
    expect(answer.pulls[0]!.state).toBe("unknown");
  });

  test("the sandbox's stand-in states are read instead of the forge, by ref, key or URL", async () => {
    const gh = fakeGh({});
    const w = world({ gh, fixture: () => ({ "o/r#1": { state: "open", checks: "failing" }, "gitlab.com/acme/api#3:pull": { state: "merged" } }) });
    w.agentAdd(w.thread, "o/r#1", "acme/api!3");
    const answer = (await (await w.get(w.thread))!.json()) as InboxThreadPullsAnswer;
    expect(gh.calls).toEqual([]);
    expect(answer.pulls.map((p) => [p.ref, p.state, p.checks])).toEqual([
      ["o/r#1", "open", "failing"],
      ["acme/api!3", "merged", null],
    ]);
  });
});

describe("a forge that never answers", () => {
  /** A gh that never exits (a stuck CLI the runner has not ended yet): every call stays pending. */
  const stuckGh = () => {
    const calls: string[][] = [];
    return { calls, run: (cli: string, args: string[]) => (calls.push([cli, ...args]), new Promise(() => {})) };
  };
  const within = async <T>(work: Promise<T>, ms: number): Promise<T | "late"> =>
    Promise.race([work, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), ms))]);

  test("the window's read answers at once with what is known, for this thread and every later one", async () => {
    const gh = stuckGh();
    const w = world({ gh });
    w.agentAdd(w.thread, "o/r#1");
    const others = [1, 2, 3, 4, 5].map((i) => {
      const id = w.store.sendMessage({ project_id: w.project.id, author: { ...AGENT, session: `ses_${i}` }, body: `Thread ${i}.`, subject: `T${i}` }).message.id;
      w.agentAdd(id, `o/r${i}#${i}`);
      return id;
    });
    // Hovered again and again, then every other thread opened: each read answers, none waits on the stuck gh.
    for (const id of [w.thread, w.thread, w.thread, ...others]) {
      const res = await within(w.get(id)!, 200);
      expect(res).not.toBe("late");
      const answer = (await (res as Response).json()) as InboxThreadPullsAnswer;
      expect(answer.pulls).toHaveLength(1);
      expect(answer.pulls[0]!.state).toBe("unknown");
    }
    // The reads behind them did start (two at once at most, the others queued), so a forge that comes back is read.
    expect(gh.calls.length).toBeGreaterThan(0);
  });

  test("the person's Add waits for the new PR's read only briefly", async () => {
    const w = world({ gh: stuckGh() });
    const started = Date.now();
    const res = await within(w.post(w.thread, { add: ["o/r#7"] })!, THREAD_PULLS_ADD_WAIT_MS + 1_000);
    expect(res).not.toBe("late");
    expect(Date.now() - started).toBeGreaterThanOrEqual(THREAD_PULLS_ADD_WAIT_MS - 50);
    const answer = (await (res as Response).json()) as InboxThreadPullsAnswer;
    expect(answer.pulls.map((p) => [p.ref, p.state])).toEqual([["o/r#7", "unknown"]]);
  });

  test("checks and the review read behind the answer reach the windows (they write no record)", async () => {
    const heard: string[][] = [];
    const gh = fakeGh({ 2: { state: "OPEN", checks: "FAILURE" } });
    const w = world({ gh, onLiveChange: (ids) => heard.push([...ids]) });
    w.agentAdd(w.thread, "o/r#2");
    await w.get(w.thread);
    await settle();
    expect(heard).toEqual([[w.thread]]);
    const answer = (await (await w.get(w.thread))!.json()) as InboxThreadPullsAnswer;
    expect(answer.pulls.map((p) => [p.state, p.checks])).toEqual([["open", "failing"]]);
    // The same answer again (a later read): nothing new to say.
    w.advance(31_000);
    await w.get(w.thread);
    await settle();
    expect(heard).toHaveLength(1);
  });
});

describe("what the owner's next wake says", () => {
  test("the person's changes since the owner last saw the thread, net; nothing once it has seen them; never for another session", () => {
    const w = world();
    w.agentAdd(w.thread, "o/r#1", "o/r#2");
    w.advance(60_000);
    const person = (values: string[], op: "add" | "remove") => {
      const parsed = parseInboxThreadPullRefs(values, op);
      if ("error" in parsed) throw new Error(parsed.error);
      w.store.changeThreadPulls({ thread_id: w.thread, [op]: parsed.refs, by: { kind: "person" } });
    };
    person(["o/r#3"], "add");
    person(["o/r#1"], "remove");
    person(["o/r#4"], "add");
    person(["o/r#4"], "remove");
    expect(threadPullsChangedForWake(w.store, w.thread, "ses_a")).toEqual({ added: ["o/r#3"], removed: ["o/r#1"] });
    expect(threadPullsChangedForWake(w.store, w.thread, "ses_other")).toBeNull();
    // The owner writes in the thread: it has seen the thread since, so the next wake says nothing of them.
    w.advance(60_000);
    w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: "Noted.", reply_to: w.thread });
    expect(threadPullsChangedForWake(w.store, w.thread, "ses_a")).toBeNull();
    // A later change by the person is named again; the owner's own change after it settles it.
    w.advance(60_000);
    person(["o/r#2"], "remove");
    expect(threadPullsChangedForWake(w.store, w.thread, "ses_a")).toEqual({ added: [], removed: ["o/r#2"] });
    w.advance(60_000);
    w.agentAdd(w.thread, "o/r#9");
    expect(threadPullsChangedForWake(w.store, w.thread, "ses_a")).toBeNull();
  });
});
