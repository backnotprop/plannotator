/**
 * Thread steps on a real Inbox (approval "inbox-thread-steps", 2026-11-03),
 * config.json deciding the switch:
 *
 *  - off (the default): the window's read shows no steps, whatever the store
 *    keeps; Settings reads `steps.on` false;
 *  - on (Settings → Capabilities): the read shows each session's list with
 *    its presence; turning it off again hides them and deletes nothing;
 *  - a steps line reaches the event stream as `kind: "steps"` with its
 *    thread and nothing else (the window reads the steps itself), and a
 *    saved switch tells every window (`event: capabilities`), never an
 *    agent's stream;
 *  - presence comes from the session, never from the list's age.
 *
 * What regresses: steps shown while the person has the switch off, a switch
 * that deletes lists, a steps record that carries its contents to every
 * stream, a window left showing the old state after another window flipped
 * the switch, and a mark that turns for a session that has ended.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxSteps } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_STEPS_IDLE_MS, INBOX_STEPS_WORKING_MS, inboxStepsPresenceOf, inboxStepsStale, type InboxStepsLive } from "./inbox-steps";
import { createInboxLiveSessions } from "./inbox-sessions";
import { INBOX_SESSION_LIVE_MS } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const PLAN = [
  { step: "Classify failed charges", status: "done" },
  { step: "Replay the failures in staging", status: "doing", note: "38 of 40 recovered" },
  { step: "Ship it behind a flag", status: "todo" },
];

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-steps-route-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env: this test's own, so the switch is the person's file.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const project = server.store.ensureProject({ name: "app", root: join(root, "app") });
  const thread = server.store.sendMessage({ project_id: project.id, author: AGENT, body: "Retry worker.", subject: "Retry worker" }).message.id;
  const setSteps = (on: boolean) =>
    fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: { on } }) });
  const read = async (id = thread) => (await (await fetch(`${base}/api/inbox/threads/${id}/steps`)).json()) as { on: boolean; steps: (InboxSteps & { presence: string })[] };
  return { dataDir, server, base, project: project.id, thread, setSteps, read };
}

/** An open event stream's named frames and their data, as they arrive. */
function listen(response: Response) {
  const frames: { event: string; data: string }[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const done = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        if (event) frames.push({ event, data });
      }
    }
  })();
  return { frames, stop: async () => (await reader.cancel().catch(() => {}), await done) };
}

/** Waits until `ready` holds, failing after a deadline (never a fixed sleep). */
async function until(ready: () => boolean, deadline = 5_000): Promise<void> {
  const end = Date.now() + deadline;
  while (!ready()) {
    if (Date.now() > end) throw new Error("timed out waiting for the event stream");
    await Bun.sleep(5);
  }
}

describe("the steps switch", () => {
  test("off by default: no steps shown though the store keeps them; on shows them; off again deletes nothing", async () => {
    const w = await world();
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: PLAN });

    const settings = (await (await fetch(`${w.base}/api/inbox/settings`)).json()) as { steps: { on: boolean } };
    expect(settings.steps.on).toBe(false);
    expect(await w.read()).toMatchObject({ on: false, steps: [] });

    expect((await w.setSteps(true)).status).toBe(200);
    expect(JSON.parse(readFileSync(join(w.dataDir, "config.json"), "utf8")).inboxSteps).toBe(true);
    const on = await w.read();
    expect(on.on).toBe(true);
    expect(on.steps.map((list) => list.steps.map((s) => s.step))).toEqual([PLAN.map((s) => s.step)]);

    expect((await w.setSteps(false)).status).toBe(200);
    expect((await w.read()).steps).toEqual([]);
    expect(w.server.store.threadSteps(w.thread)).toHaveLength(1);
  });

  test("a malformed switch is refused and changes nothing", async () => {
    const w = await world();
    const response = await fetch(`${w.base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: true }) });
    expect(response.status).toBe(422);
    expect((await w.read()).on).toBe(false);
  });
});

// Part 4: the lane card's pie and the opened card's checklist ride on the Board's one cards read.
describe("the Board's cards read", () => {
  test("carries each linked thread's lists with presence only while the switch is on; a cleared list is gone", async () => {
    const w = await world();
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: PLAN });
    w.server.store.createCard({ project_id: w.project, by: AGENT, title: "Retry worker", column: "in_progress", threads: [w.thread] });
    const cards = async () => {
      const response = await fetch(`${w.base}/api/inbox/cards`);
      expect(response.status).toBe(200);
      return (await response.json()) as { cards: unknown[]; steps?: Record<string, (InboxSteps & { presence: string })[]> };
    };
    const off = await cards();
    expect(off.cards).toHaveLength(1);
    expect("steps" in off).toBe(false);

    await w.setSteps(true);
    const on = await cards();
    expect(Object.keys(on.steps!)).toEqual([w.thread]);
    expect(on.steps![w.thread]!.map((list) => [list.steps.length, list.presence])).toEqual([[3, "working"]]);

    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: [] });
    expect((await cards()).steps).toEqual({});
  });
});

// The calm row (approval "inbox-checklist-spinners-2026-11-07"): the list row wears the still amber pause only while a
// checklist waits on the person, and only while the switch is on; never on what an agent reads.
describe("the list's rows", () => {
  test("`steps_waiting` while a step waits on the person and the switch is on; absent while the agent works, with the switch off, and on an agent's read", async () => {
    const w = await world();
    const row = async () => {
      const model = (await (await fetch(`${w.base}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string; steps_waiting?: true }[] }[] };
      return model.sections.flatMap((section) => section.threads).find((r) => r.thread_id === w.thread)!;
    };
    const waiting = [PLAN[0]!, { step: "Pick the backfill window", status: "waiting" }, PLAN[2]!];
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: waiting });
    // Off: nothing on the row, whatever the store keeps.
    expect("steps_waiting" in (await row())).toBe(false);
    await w.setSteps(true);
    expect((await row()).steps_waiting).toBe(true);
    // Agents read rows through the store: never the person's checklist mark.
    expect("steps_waiting" in (w.server.store.listRow(w.thread) ?? {})).toBe(false);
    // The agent works on a step and nothing waits on the person: the row stays plain.
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: PLAN });
    expect("steps_waiting" in (await row())).toBe(false);
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: waiting });
    expect((await row()).steps_waiting).toBe(true);
    await w.setSteps(false);
    expect("steps_waiting" in (await row())).toBe(false);
  });

  test("the person replied, the flag is gone", async () => {
    const w = await world();
    const row = async () => {
      const model = (await (await fetch(`${w.base}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string; steps_waiting?: true }[] }[] };
      return model.sections.flatMap((section) => section.threads).find((r) => r.thread_id === w.thread)!;
    };
    await w.setSteps(true);
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: [PLAN[0]!, { step: "Pick the backfill window", status: "waiting" }, PLAN[2]!] });
    expect((await row()).steps_waiting).toBe(true);
    // The person answers in the thread: it waits on the agent now, though its list still says "waiting".
    w.server.store.sendMessage({ project_id: w.server.store.message(w.thread)!.project_id, author: { kind: "person" }, body: "The last 7 days.", reply_to: w.thread });
    expect("steps_waiting" in (await row())).toBe(false);
  });
});

describe("the event stream", () => {
  test("a steps line names its thread only; the switch tells windows, never an agent's stream", async () => {
    const w = await world();
    const cursor = w.server.store.cursor();
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: PLAN });
    const replay = await (await fetch(`${w.base}/api/inbox/events?cursor=${cursor}&once=1`)).text();
    const record = replay
      .split("\n\n")
      .filter((block) => block.includes("event: record"))
      .map((block) => JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as Record<string, unknown>);
    expect(record).toHaveLength(1);
    expect(Object.keys(record[0]!).sort()).toEqual(["id", "kind", "seq", "thread_id"]);
    expect(record[0]).toMatchObject({ kind: "steps", thread_id: w.thread });

    const windowStream = listen(await fetch(`${w.base}/api/inbox/events?window=window-one`, { headers: { "Sec-Fetch-Site": "same-origin" } }));
    const agentStream = listen(await fetch(`${w.base}/api/inbox/events`));
    // Both streams are open (each says hello) before anything is saved.
    await until(() => windowStream.frames.some((f) => f.event === "hello") && agentStream.frames.some((f) => f.event === "hello"));
    await w.setSteps(true);
    await until(() => windowStream.frames.some((frame) => frame.event === "capabilities"));
    // Saving the same state again says nothing more; then a change that does, so the stream has caught up past it.
    await w.setSteps(true);
    await w.setSteps(false);
    await until(() => windowStream.frames.filter((frame) => frame.event === "capabilities").length >= 2);
    const told = windowStream.frames.filter((frame) => frame.event === "capabilities");
    // The frame carries the window-followed capabilities (the Board's too); Code review and Shape, off here, are held until
    // the next big release (inbox.ts heldSwitch) and left out, so a window that never drew their rows does not start to.
    expect(told.map((frame) => JSON.parse(frame.data))).toEqual([
      { board: { on: false }, steps: { on: true } },
      { board: { on: false }, steps: { on: false } },
    ]);
    // The agent's stream, open all along, never gets one.
    expect(agentStream.frames.some((frame) => frame.event === "capabilities")).toBe(false);
    await Promise.all([windowStream.stop(), agentStream.stop()]);
  });
});

describe("presence", () => {
  const record = (host: string | null, updatedAt: number): InboxSteps => ({
    id: "stp_00000000000000000000000000",
    project_id: "prj_x",
    thread_id: "msg_x",
    agent: { kind: "agent", host, session: "ses_a", name: null },
    steps: [],
    updated_at: new Date(updatedAt).toISOString(),
  });
  const now = Date.parse("2026-11-03T15:00:00.000Z");
  const live = (connection: { busy: boolean | null } | null, heard: number | null = null, ended = false): InboxStepsLive => ({
    deliveryConnectionOf: () => connection,
    lastHeardOf: () => heard,
    endedOf: () => ended,
  });

  test("a polling session: working while a turn runs, idle between turns, ended once it stops polling", () => {
    const old = now - 5 * 60 * 60_000;
    expect(inboxStepsPresenceOf(record("claude-code", old), live({ busy: true }), now)).toBe("working");
    expect(inboxStepsPresenceOf(record("claude-code", now), live({ busy: false }, now), now)).toBe("idle");
    // A list written a moment ago does not make an ended session look alive.
    expect(inboxStepsPresenceOf(record("claude-code", now), live(null, now - 60_000, true), now)).toBe("ended");
  });

  test("a session with no connection that says: working only while heard of lately, ended after the idle bar", () => {
    expect(inboxStepsPresenceOf(record("codex", now - 60_000), live(null), now)).toBe("working");
    expect(inboxStepsPresenceOf(record("codex", now - INBOX_STEPS_WORKING_MS - 1), live(null), now)).toBe("idle");
    expect(inboxStepsPresenceOf(record("codex", now - INBOX_STEPS_IDLE_MS - 1), live(null), now)).toBe("ended");
    expect(inboxStepsPresenceOf(record("codex", now - INBOX_STEPS_IDLE_MS - 1), live({ busy: null }, now - 1000), now)).toBe("working");
  });

  // Part 5, Tidy's rule: "a step still in `doing` when the session has been idle over 2 h or has ended".
  test("stale for Tidy: a step still doing once its session sat idle 2 h or ended; never while it works, sooner, or with nothing doing", () => {
    const doing = (updatedAt: number, status: "doing" | "done" = "doing"): InboxSteps => ({ ...record("claude-code", updatedAt), steps: [{ step: "Replay", status }] });
    const idleSince = (at: number | null, base: InboxStepsLive) => ({ ...base, lastIdleOf: () => at });
    const longAgo = now - INBOX_STEPS_IDLE_MS - 60_000;
    // A connection that says idle: its last idle transition is the clock.
    expect(inboxStepsStale(doing(longAgo), idleSince(longAgo, live({ busy: false }, now)), now)).toBe(true);
    expect(inboxStepsStale(doing(longAgo), idleSince(now - 30 * 60_000, live({ busy: false }, now)), now)).toBe(false);
    // The list's own last write is never older than the quiet: written 10 min ago, it is not stale.
    expect(inboxStepsStale(doing(now - 10 * 60_000), idleSince(longAgo, live({ busy: false }, now)), now)).toBe(false);
    // Working, whatever the ages.
    expect(inboxStepsStale(doing(longAgo), idleSince(longAgo, live({ busy: true }, now)), now)).toBe(false);
    // Ended: stale at once.
    expect(inboxStepsStale(doing(now - 60_000), idleSince(null, live(null, now - 60_000, true)), now)).toBe(true);
    // No connection: heard 1 h ago is idle (not 2 h); unheard past the bar is ended.
    expect(inboxStepsStale(doing(longAgo), idleSince(null, live(null, now - 60 * 60_000)), now)).toBe(false);
    expect(inboxStepsStale(doing(longAgo), idleSince(null, live(null, longAgo)), now)).toBe(true);
    // Nothing doing: never stale, even ended.
    expect(inboxStepsStale(doing(longAgo, "done"), idleSince(null, live(null, now, true)), now)).toBe(false);
  });

  // Review of #2565, finding 1: a session never seen polling is never ended for its host's name (inbox-compose.md,
  // "Replying when the asking session has ended"): OpenCode 1, Claude Code with the mod off, Pi without the wake.
  test("on a real Inbox, sessions of polling hosts that never polled read working, not ended", async () => {
    const w = await world();
    await w.setSteps(true);
    const sessions = [
      { host: "opencode", session: "ses_opencode1", name: "OpenCode" },
      { host: "claude-code", session: "ses_mod_off", name: "Claude Code" },
      { host: "pi", session: "ses_pi_no_wake", name: "Pi" },
    ];
    for (const who of sessions) w.server.store.setThreadSteps({ thread_id: w.thread, agent: { kind: "agent", ...who }, steps: PLAN });
    const read = await w.read();
    expect(Object.fromEntries(read.steps.map((list) => [list.agent.session, list.presence]))).toEqual({ ses_opencode1: "working", ses_mod_off: "working", ses_pi_no_wake: "working" });
  });

  test("the live sessions say ended only for a session seen polling that stopped, or a woken thread known gone", async () => {
    let t = 1_000_000;
    let codex: "alive" | "dead" | null = null;
    const tracker = createInboxLiveSessions({ store: {} as InboxStore, serverSession: "s", resolveRoot: async (path) => path, now: () => t, wakeOnlyStatus: (session) => (session === "thr-codex" ? codex : null) });
    const done = await tracker.pollStarted("ses-polled", "claude-code", {});
    done();
    tracker.seenOverMcp("ses-mcp-only");
    t += INBOX_SESSION_LIVE_MS + 1;
    expect(tracker.endedOf("ses-polled")).toBe(true);
    expect(tracker.endedOf("ses-mcp-only")).toBe(false);
    expect(tracker.endedOf("ses-never-heard")).toBe(false);
    codex = "alive";
    expect(tracker.endedOf("thr-codex")).toBe(false);
    codex = "dead";
    expect(tracker.endedOf("thr-codex")).toBe(true);
    // Polling again: no longer ended.
    await tracker.pollStarted("ses-polled", "claude-code", {});
    expect(tracker.endedOf("ses-polled")).toBe(false);
  });
});
