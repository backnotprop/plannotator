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
import { INBOX_STEPS_IDLE_MS, INBOX_STEPS_WORKING_MS, inboxStepsPresenceOf, type InboxStepsLive } from "./inbox-steps";

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
  return { dataDir, server, base, thread, setSteps, read };
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
    await Bun.sleep(100);
    await w.setSteps(true);
    await Bun.sleep(100);
    // Saving the same state again says nothing more.
    await w.setSteps(true);
    await Bun.sleep(100);
    const told = windowStream.frames.filter((frame) => frame.event === "capabilities");
    expect(told.map((frame) => JSON.parse(frame.data))).toEqual([{ steps: { on: true } }]);
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
  const live = (connection: { busy: boolean | null } | null, heard: number | null = null, idle: number | null = null): InboxStepsLive => ({
    deliveryConnectionOf: () => connection,
    lastHeardOf: () => heard,
    lastIdleOf: () => idle,
  });
  const bridged = (host: string | null) => host === "claude-code";

  test("a polling session: working while a turn runs, idle between turns, ended once it stops polling", () => {
    const old = now - 5 * 60 * 60_000;
    expect(inboxStepsPresenceOf(record("claude-code", old), live({ busy: true }), bridged, now).presence).toBe("working");
    expect(inboxStepsPresenceOf(record("claude-code", now), live({ busy: false }, now, now - 1000), bridged, now)).toEqual({ presence: "idle", since: now - 1000 });
    // A list written a moment ago does not make an ended session look alive.
    expect(inboxStepsPresenceOf(record("claude-code", now), live(null, now - 60_000), bridged, now).presence).toBe("ended");
  });

  test("a session with no connection that says: working only while heard of lately, ended after the idle bar", () => {
    expect(inboxStepsPresenceOf(record("codex", now - 60_000), live(null), bridged, now).presence).toBe("working");
    expect(inboxStepsPresenceOf(record("codex", now - INBOX_STEPS_WORKING_MS - 1), live(null), bridged, now).presence).toBe("idle");
    expect(inboxStepsPresenceOf(record("codex", now - INBOX_STEPS_IDLE_MS - 1), live(null), bridged, now).presence).toBe("ended");
    expect(inboxStepsPresenceOf(record("codex", now - INBOX_STEPS_IDLE_MS - 1), live({ busy: null }, now - 1000), bridged, now).presence).toBe("working");
  });
});
