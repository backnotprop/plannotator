/**
 * Tidy (owner-approved design, 2026-10-28) through the server's real doors:
 * the window's routes, a connection's poll and delivery, an MCP-only agent's
 * next tool call. Each test runs its own Inbox in a temp data dir, with
 * the store's clock set back (`storeNow`) while a test writes, so it reads as
 * hours or days old.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxQuestion, InboxThread, InboxTidyPlan, InboxTidyRun } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxTidyBody, inboxTidyBodyStepsOff, inboxTidyIsStepsOnly, inboxTidyRun } from "@plannotator/shared/inbox/tidy";
import { INBOX_TIDY_HOW, INBOX_TIDY_INSTRUCTION, parseInboxSessionRef } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxWakeText, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const HOUR = 60 * 60_000;
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

/**
 * `steps`: the checklist switch, fixed for the test (true, false), or "file": this test's own config.json, on at
 * the start, which the window's Settings route can turn off (the person's switch).
 */
async function setup(options: { steps?: boolean | "file" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-tidy-")));
  roots.push(root);
  const billing = join(root, "billing");
  const docs = join(root, "docs");
  mkdirSync(billing, { recursive: true });
  mkdirSync(docs, { recursive: true });
  // What a test writes while `behind` is set reads as that much older.
  const clock = { behind: 0 };
  const dataDir = join(root, "data");
  // The checklist switch is this test's (never the person's config.json): off unless a test turns it on.
  if (options.steps === "file") {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxSteps: true }));
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
  }
  const steps = options.steps === "file" ? undefined : (options.steps ?? false);
  // On the JSONL files (`sqlite: false`): this test reads the record files or reopens the store on them.
  const server = await startInboxServer({ sqlite: false, dataDir, binaryPath: null, board: true, steps, storeNow: () => new Date(Date.now() - clock.behind) });
  servers.push(server);
  const client = new Client({ name: "inbox-tidy-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, billing, docs, clock, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const block = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ? JSON.stringify(result.content) : "").toBe("");
  return result as { structuredContent: Record<string, unknown>; content: { type: string; text: string }[] };
}
const send = async (client: Client, project: string, session: string, args: Record<string, unknown>, host = "claude-code") =>
  (await call(client, "send_message", { project_path: project, agent_session: session, agent_host: host, ...args })).structuredContent as { message_id: string; thread_id: string };

const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
const bridge = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });

/** Hands `session` its pending commands and says each was delivered. */
async function deliver(server: InboxServer, session: string, project: string) {
  const commands = await poll(server, session, project);
  for (const command of commands) await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host: "claude-code", type: "delivered", id: command.id });
  return commands;
}
const stateOf = async (server: InboxServer, session: string) => (await plan(server)).run!.agents.find((a) => a.session === session)!.state;

/** One poll of a session's connection (live for the next 30 s); the commands it was handed. */
async function poll(server: InboxServer, session: string, project: string, state: { busy?: boolean; idle_since?: number } = {}) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host: "claude-code", project_path: project, waitMs: 0, busy: state.busy ?? false, idle_since: state.idle_since ?? Date.now() - HOUR });
  return parseInboxBridgeCommands(await response.text());
}

async function plan(server: InboxServer, query = ""): Promise<InboxTidyPlan> {
  const response = await fetch(`${base(server)}/api/inbox/tidy${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as InboxTidyPlan;
}
const tidy = (server: InboxServer, body: Record<string, unknown>) => post(server, "/api/inbox/tidy", body);
async function thread(server: InboxServer, id: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
}
async function rows(server: InboxServer): Promise<InboxListRow[]> {
  const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return list.sections.flatMap((s) => s.threads);
}
const projectOf = async (server: InboxServer, name: string) =>
  ((await (await fetch(`${base(server)}/api/inbox/projects`)).json()) as { projects: { id: string; name: string }[] }).projects.find((p) => p.name === name)!.id;

describe("Tidy: who gets asked", () => {
  test("lists a live session's old open question and the reply it never answered; an ended session's thread goes apart; nothing young", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-live", billing);
    const asked = await send(client, billing, "ses-live", { subject: "Backfill", thread: "Backfill", body: `Before I cut over.\n\n${block("Backfill the ledger first?")}` });
    const update = await send(client, billing, "ses-live", { subject: "Webhooks", thread: "Webhooks", body: "Webhooks are done; screenshots next." });
    expect((await post(server, `/api/inbox/messages/${update.message_id}/reply`, { words: "Still waiting on those screenshots.", idempotency_key: "r1" })).status).toBe(200);
    await poll(server, "ses-live", billing).then(async (commands) => {
      for (const command of commands) await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-live", host: "claude-code", type: "delivered", id: command.id });
    });
    // An agent that named no session: nothing can ask it again.
    const gone = (await call(client, "send_message", { project_path: billing, subject: "Old lane", thread: "Old lane", body: block("Keep the old lane?") })).structuredContent as { thread_id: string };

    clock.behind = 0;
    // Just asked: not old enough to list.
    await send(client, billing, "ses-live", { subject: "Fresh", thread: "Fresh", body: block("Rename the flag?") });
    await poll(server, "ses-live", billing);
    const later = await plan(server);
    expect(later.agents.map((a) => a.session)).toEqual(["ses-live"]);
    const threads = later.agents[0]!.items.map((i) => i.thread_id).sort();
    expect(threads).toEqual([asked.thread_id, update.thread_id].sort());
    // The session that ended is not offered, nor its thread listed anywhere.
    expect(later.agents.flatMap((a) => a.items.map((i) => i.thread_id))).not.toContain(gone.thread_id);
    expect("ended" in later).toBe(false);
  });

  test("scope follows the project filter", async () => {
    const { server, client, billing, docs, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", docs);
    const inBilling = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    await send(client, docs, "ses-b", { subject: "Docs", thread: "Docs", body: block("Ship docs?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", docs);
    expect((await plan(server)).agents.map((a) => a.session).sort()).toEqual(["ses-a", "ses-b"]);
    const scoped = await plan(server, `?project=${await projectOf(server, "billing")}`);
    expect(scoped.agents.map((a) => a.session)).toEqual(["ses-a"]);
    expect(scoped.agents[0]!.items.map((i) => i.thread_id)).toEqual([inBilling.thread_id]);
  });

  test("the Board's Tidy asks only the agents owning cards in view, with their stale cards", async () => {
    const { server, client, billing, docs, clock } = await setup();
    clock.behind = 3 * 24 * HOUR;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", docs);
    await poll(server, "ses-c", billing);
    const lane = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: "Starting the ledger lane." });
    await call(client, "card", { op: "create", title: "Ledger lane", column: "in_progress", say: "lane started", thread_id: lane.thread_id, project_path: billing, agent_session: "ses-a", agent_host: "claude-code" });
    await send(client, docs, "ses-b", { subject: "Docs", thread: "Docs", body: "Docs lane." });
    await call(client, "card", { op: "create", title: "Docs lane", column: "in_progress", project_path: docs, agent_session: "ses-b", agent_host: "claude-code" });
    // A session with an old open question but no card: the list asks it, the Board does not.
    await send(client, billing, "ses-c", { subject: "Refunds", thread: "Refunds", body: block("Move refunds now?") });
    clock.behind = 0;
    for (const [s, p] of [["ses-a", billing], ["ses-b", docs], ["ses-c", billing]] as const) await poll(server, s, p);

    const board = await plan(server, `?surface=board&project=${await projectOf(server, "billing")}`);
    expect(board.agents.map((a) => a.session)).toEqual(["ses-a"]);
    expect(board.agents[0]!.items).toEqual([expect.objectContaining({ thread_id: lane.thread_id, reasons: [expect.stringContaining("card idle")] })]);
    expect((await plan(server, `?project=${await projectOf(server, "billing")}`)).agents.map((a) => a.session).sort()).toEqual(["ses-a", "ses-c"]);
  });
});

// Thread steps (approval "inbox-thread-steps", part 5): "Tidy asks about a step still in `doing` when the session has
// been idle over 2 h or has ended", and with the switch off agents get "no Tidy rule".
describe("Tidy: a checklist step left in progress", () => {
  const PLAN = [
    { step: "Classify failed charges", status: "done" },
    { step: "Replay the failures in staging", status: "doing" },
    { step: "Ship it behind a flag", status: "todo" },
  ];
  /** ses-a's thread with a step doing, written 3 h ago; its connection says it has been idle since `idleFor` ago. */
  async function quietStep(steps: boolean | "file", idleFor: number, plan: { step: string; status: string }[] = PLAN) {
    const w = await setup({ steps });
    w.clock.behind = 3 * HOUR;
    await poll(w.server, "ses-a", w.billing, { busy: true });
    const lane = await send(w.client, w.billing, "ses-a", { subject: "Retry worker", thread: "Retry worker", body: "Starting the retry worker." });
    w.server.store.setThreadSteps({ thread_id: lane.thread_id, agent: { kind: "agent", host: "claude-code", session: "ses-a", name: "Claude Code" }, steps: plan });
    w.clock.behind = 0;
    await poll(w.server, "ses-a", w.billing, { busy: false, idle_since: Date.now() - idleFor });
    return { ...w, lane };
  }

  test("on: listed for its session once it sat idle 2 h, and the wake names the step and how to update it", async () => {
    const { server, billing, lane } = await quietStep(true, 3 * HOUR);
    const found = await plan(server);
    expect(found.agents.map((a) => a.session)).toEqual(["ses-a"]);
    expect(found.agents[0]!.items).toEqual([expect.objectContaining({ thread_id: lane.thread_id, reasons: ["step in progress, 3 h"] })]);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t-steps" })).status).toBe(200);
    const commands = await deliver(server, "ses-a", billing);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.body).toContain(
      `Your steps here: 1 of 3 done; doing: Replay the failures in staging, unchanged for 3 h. Update them if that changed (the steps action, thread_id ${lane.thread_id}).`,
    );
  });

  test("off: the same quiet step is no Tidy item and no words", async () => {
    const { server } = await quietStep(false, 3 * HOUR);
    expect((await plan(server)).agents).toEqual([]);
  });

  /**
   * ses-a, idle 3 h, with a quiet step in two threads: "Retry worker" also has an open question 3 h old, "Ledger"
   * has the step alone.
   */
  async function quietWork(steps: boolean | "file") {
    const w = await setup({ steps });
    w.clock.behind = 3 * HOUR;
    await poll(w.server, "ses-a", w.billing, { busy: true });
    const asked = await send(w.client, w.billing, "ses-a", { subject: "Retry worker", thread: "Retry worker", body: `Starting the retry worker.\n\n${block("Backfill first?")}` });
    const lane = await send(w.client, w.billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: "Starting the ledger lane." });
    for (const id of [asked.thread_id, lane.thread_id]) {
      w.server.store.setThreadSteps({ thread_id: id, agent: { kind: "agent", host: "claude-code", session: "ses-a", name: "Claude Code" }, steps: PLAN });
    }
    w.clock.behind = 0;
    await poll(w.server, "ses-a", w.billing, { busy: false, idle_since: Date.now() - 3 * HOUR });
    return { ...w, asked, lane };
  }
  /** The thread list's lines of a Tidy body (`1. Retry worker · billing (reply_to …)`). */
  const listed = (body: string) => body.split("\n").filter((line) => /^\d+\. /.test(line));

  test("off: a run with other items in it adds no steps words, and a thread with only a quiet step is not listed", async () => {
    const { server, billing, asked } = await quietWork(false);
    const found = await plan(server);
    expect(found.agents.map((a) => a.session)).toEqual(["ses-a"]);
    expect(found.agents[0]!.items).toEqual([expect.objectContaining({ thread_id: asked.thread_id, reasons: ["question, 3 h"] })]);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t-off" })).status).toBe(200);
    const [command] = await deliver(server, "ses-a", billing);
    const wake = inboxWakeText(command!);
    expect(wake).toContain("Backfill first?");
    expect(wake).not.toMatch(/steps/i);
    expect(listed(wake)).toEqual([expect.stringMatching(/^1\. Retry worker · billing \(reply_to /)]);
  });

  test("off at delivery: a thread listed first for its step alone goes, and the rest renumber from 1", () => {
    const body = [
      INBOX_TIDY_INSTRUCTION,
      INBOX_TIDY_HOW,
      "1. Ledger · billing (reply_to msg_b)\n   - Your steps here: 1 of 3 done; doing: X, unchanged for 3 h. Update them if that changed (the steps action, thread_id msg_b).",
      "2. Retry worker · billing (reply_to msg_a)\n   - Action item open since 3 h ago: msg_a/a-1  Rotate the key\n   - Your steps here: 0 of 2 done; doing: Y, unchanged for 3 h. Update them if that changed (the steps action, thread_id msg_a).",
    ].join("\n\n");
    expect(inboxTidyBodyStepsOff(body)).toBe([INBOX_TIDY_INSTRUCTION, INBOX_TIDY_HOW, "1. Retry worker · billing (reply_to msg_a)\n   - Action item open since 3 h ago: msg_a/a-1  Rotate the key"].join("\n\n"));
    // Only steps listed: nothing is left, so the wake is withdrawn, not handed over empty.
    expect(inboxTidyIsStepsOnly(body)).toBe(false);
    const stepsOnly = body.split("\n\n").slice(0, 3).join("\n\n");
    expect(inboxTidyIsStepsOnly(stepsOnly)).toBe(true);
    expect(inboxTidyIsStepsOnly([INBOX_TIDY_INSTRUCTION, INBOX_TIDY_HOW, "1. Ledger · billing (reply_to msg_b)\n   - Action item open since 3 h ago: msg_b/a-1  X"].join("\n\n"))).toBe(false);
  });

  test("on when the run starts, off before delivery: the wake goes without its steps lines, by a poll and by a next read", async () => {
    // A poll.
    const polled = await quietWork("file");
    expect((await plan(polled.server)).agents[0]!.items.map((i) => i.reasons).sort()).toEqual([["question, 3 h", "step in progress, 3 h"], ["step in progress, 3 h"]]);
    expect((await tidy(polled.server, { sessions: ["ses-a"], idempotency_key: "t-flip" })).status).toBe(200);
    // The run's stored note has the steps lines (that is what the switch must hold back).
    expect((await thread(polled.server, polled.lane.thread_id)).messages.find((m) => m.tidy)!.body).toContain("Your steps here: ");
    expect((await post(polled.server, "/api/inbox/settings", { steps: { on: false } })).status).toBe(200);
    const [command] = await deliver(polled.server, "ses-a", polled.billing);
    const wake = inboxWakeText(command!);
    expect(wake).toContain("Backfill first?");
    expect(wake).not.toMatch(/steps/i);
    expect(listed(wake)).toEqual([expect.stringMatching(/^1\. Retry worker · billing \(reply_to /)]);

    // A next read: the bridge stopped polling, so the session's next Inbox call carries the note.
    const read = await quietWork("file");
    expect((await tidy(read.server, { sessions: ["ses-a"], idempotency_key: "t-flip-read" })).status).toBe(200);
    // The stored wake has the steps line (what the next call must hold back).
    expect((await thread(read.server, read.asked.thread_id)).messages.find((m) => m.tidy)!.body).toContain("Your steps here: ");
    expect((await post(read.server, "/api/inbox/settings", { steps: { on: false } })).status).toBe(200);
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      const result = await call(read.client, "read_thread", { thread_id: read.asked.thread_id, agent_session: "ses-a", project_path: read.billing });
      const text = result.content.map((c) => c.text).join("\n");
      expect(text).toContain(INBOX_TIDY_INSTRUCTION);
      expect(text).toContain("Backfill first?");
      expect(text).not.toContain("Your steps here");
      expect(JSON.stringify(result.structuredContent.tidy)).not.toContain("Your steps here");
    } finally {
      setSystemTime();
    }
  });

  // Amendment 2: "turning the switch off stops a Tidy that is already running". A wake that listed only steps has
  // nothing left to say: no turn goes out, by a poll or by a next read, and the run reads Nothing to change.
  test("on when the run starts, off before delivery, only steps listed: no wake at all, and the run reads nothing", async () => {
    // Off from Settings (the switch withdraws it), or by hand in config.json (the poll or the read withdraws it).
    for (const [off, via] of [["settings", "poll"], ["file", "poll"], ["file", "read"]] as const) {
      const w = await quietStep("file", 3 * HOUR);
      expect((await plan(w.server)).agents[0]!.items.map((i) => i.reasons)).toEqual([["step in progress, 3 h"]]);
      expect((await tidy(w.server, { sessions: ["ses-a"], idempotency_key: `t-only-${off}-${via}` })).status).toBe(200);
      if (off === "settings") {
        expect((await post(w.server, "/api/inbox/settings", { steps: { on: false } })).status).toBe(200);
        // The switch itself withdrew it, before any poll or call.
        expect(await stateOf(w.server, "ses-a")).toBe("nothing");
      } else writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxSteps: false }));
      if (via === "poll") {
        expect(await poll(w.server, "ses-a", w.billing)).toEqual([]);
      } else {
        setSystemTime(new Date(Date.now() + 31_000));
        try {
          const result = await call(w.client, "read_thread", { thread_id: w.lane.thread_id, agent_session: "ses-a", project_path: w.billing });
          expect(result.content.map((c) => c.text).join("\n")).not.toContain(INBOX_TIDY_INSTRUCTION);
          expect(result.structuredContent.tidy).toBeUndefined();
        } finally {
          setSystemTime();
        }
      }
      // Withdrawn, the run asked it nothing: the thread shows no Tidy note either.
      {
        setSystemTime(new Date(Date.now() + 31_000));
        try {
          const again = await call(w.client, "read_thread", { thread_id: w.lane.thread_id, agent_session: "ses-a", project_path: w.billing });
          expect(again.content.map((c) => c.text).join("\n")).not.toContain("to tidy its threads");
        } finally {
          setSystemTime();
        }
      }
      expect(await stateOf(w.server, "ses-a")).toBe("nothing");
      // It writes later: still nothing (it was never asked).
      await send(w.client, w.billing, "ses-a", { reply_to: w.lane.message_id, body: "Still on the replay." });
      expect(await stateOf(w.server, "ses-a")).toBe("nothing");
      // Nor did it start the cool-down: an old open question of that session is offered again at once.
      w.clock.behind = 3 * HOUR;
      await send(w.client, w.billing, "ses-a", { subject: "Refunds", thread: "Refunds", body: block("Move refunds now?") });
      w.clock.behind = 0;
      expect((await plan(w.server)).agents.map((a) => a.session)).toEqual(["ses-a"]);
    }
  });

  // The review of the withdrawal: it must settle nothing else in the thread. A reply the person sent that session
  // before the run is still handed over, by the next poll or the next call's read.
  test("a withdrawn wake keeps the person's earlier reply owed", async () => {
    for (const via of ["poll", "call"] as const) {
      const w = await quietStep("file", 3 * HOUR);
      // Another thread of the session, for a next call that reads something else.
      const other = await send(w.client, w.billing, "ses-a", { subject: "Docs", thread: "Docs", body: "Docs lane." });
      expect((await post(w.server, `/api/inbox/messages/${w.lane.message_id}/reply`, { words: "Please also check the refunds.", idempotency_key: `r-${via}` })).status).toBe(200);
      const reply = (await thread(w.server, w.lane.thread_id)).messages.find((m) => m.author.kind === "person" && !m.tidy)!;
      expect((await tidy(w.server, { sessions: ["ses-a"], idempotency_key: `t-reply-${via}` })).status).toBe(200);
      expect(w.server.store.pendingReplies("ses-a").map((m) => m.id)).toContain(reply.id);
      if (via === "poll") {
        expect((await post(w.server, "/api/inbox/settings", { steps: { on: false } })).status).toBe(200);
        expect((await poll(w.server, "ses-a", w.billing)).map((c) => c.id)).toEqual([reply.id]);
      } else {
        writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxSteps: false }));
        setSystemTime(new Date(Date.now() + 31_000));
        try {
          const result = await call(w.client, "read_thread", { thread_id: other.thread_id, agent_session: "ses-a", project_path: w.billing });
          expect(result.structuredContent.tidy).toBeUndefined();
        } finally {
          setSystemTime();
        }
        expect(w.server.store.pendingReplies("ses-a").map((m) => m.id)).toEqual([reply.id]);
      }
    }
  });

  test("on: not while the session went idle under 2 h ago, nor for a list with nothing doing", async () => {
    expect((await plan((await quietStep(true, 30 * 60_000)).server)).agents).toEqual([]);
    const finished = PLAN.map((step) => ({ ...step, status: "done" }));
    expect((await plan((await quietStep(true, 3 * HOUR, finished)).server)).agents).toEqual([]);
  });
});

describe("Tidy: asking", () => {
  test("one wake per session, a quiet note in each thread that never moves its row, the unsent pick left alone, then the cool-down", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const one = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    const two = await send(client, billing, "ses-a", { subject: "Refunds", thread: "Refunds", body: `${block("Move refunds now?")}\n\n${block("Keep the old webhook?")}` });
    // The person picked an answer in Refunds and did not send it.
    const picked = (await thread(server, two.thread_id)).messages[0]!.questions![0]! as InboxQuestion;
    const answer = { v: 1, key: picked.key, kind: picked.kind, prompt: picked.prompt, selected: ["Yes"] };
    expect((await post(server, `/api/inbox/messages/${two.message_id}/picks`, { questions: [{ key: picked.key, revision: 0, answer }] })).status).toBe(200);
    clock.behind = 0;
    await poll(server, "ses-a", billing, { busy: true });
    const before = (await rows(server)).map((r) => [r.thread_id, r.section, r.last_at]);

    const response = await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" });
    expect(response.status).toBe(200);
    expect((await rows(server)).map((r) => [r.thread_id, r.section, r.last_at])).toEqual(before);

    // A note in each listed thread; only one wake, held while the session is busy, handed out once it is idle.
    for (const id of [one.thread_id, two.thread_id]) expect((await thread(server, id)).messages.filter((m) => m.tidy)).toHaveLength(1);
    const commands = await deliver(server, "ses-a", billing);
    expect(commands).toHaveLength(1);
    const wake = inboxWakeText(commands[0]!).split("\n");
    expect(wake[0]).toBe(`Plannotator Inbox: Tidy (${commands[0]!.id})`);
    expect(wake[1]).toBe(INBOX_TIDY_INSTRUCTION);
    // The open question is listed; the one the person picked is not, and stays an unsent pick.
    expect(commands[0]!.body).toContain("Keep the old webhook?");
    expect(commands[0]!.body).not.toContain("Move refunds now?");
    const after = (await thread(server, two.thread_id)).messages[0]!.questions!.find((q) => q.key === picked.key)!;
    expect(after.state).toBe("picked");
    expect(after.sent_reply_id).toBeNull();

    // Asked a moment ago: not again, until the person writes to it.
    expect((await plan(server)).agents).toHaveLength(0);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t2" })).status).toBe(409);
    expect((await post(server, `/api/inbox/messages/${one.message_id}/reply`, { words: "Any news?", idempotency_key: "r2" })).status).toBe(200);
    expect((await plan(server)).agents.map((a) => a.session)).toEqual(["ses-a"]);
  });

  test("progress: an agent that writes reads tidied; one that goes idle with nothing written reads Nothing to change", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", billing);
    const a = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    await send(client, billing, "ses-b", { subject: "Docs", thread: "Docs", body: block("Ship docs?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", billing);
    const started = (await (await tidy(server, { sessions: ["ses-a", "ses-b"], idempotency_key: "t1" })).json()) as { run: InboxTidyRun };
    expect(started.run.agents.map((x) => x.state)).toEqual(["waiting", "waiting"]);
    for (const session of ["ses-a", "ses-b"]) {
      const [command] = await poll(server, session, billing);
      await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host: "claude-code", type: "delivered", id: command!.id });
    }
    // ses-a answers in its thread; ses-b's turn ends with nothing written.
    await send(client, billing, "ses-a", { reply_to: a.message_id, body: "That one no longer applies.", supersedes: [`${a.message_id}/${(await thread(server, a.thread_id)).messages[0]!.questions![0]!.key}`] });
    await poll(server, "ses-b", billing, { busy: true });
    await poll(server, "ses-b", billing, { idle_since: Date.now() + 5 });
    const run = (await plan(server)).run!;
    const state = Object.fromEntries(run.agents.map((x) => [x.session, x.state]));
    expect(state).toEqual({ "ses-a": "tidied", "ses-b": "nothing" });
    expect(run.done).toBe(2);
    expect(run.updated).toBe(1);
  });

  test("Nothing to change is set by a turn ending after delivery, not by a poll, and holds through the next turn", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    expect(await deliver(server, "ses-a", billing)).toHaveLength(1);
    // Still in the idle spell it was in before delivery (a later poll, on a later clock tick): no turn has ended since.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await poll(server, "ses-a", billing);
    expect(await stateOf(server, "ses-a")).toBe("delivered");
    await poll(server, "ses-a", billing, { busy: true });
    await poll(server, "ses-a", billing, { idle_since: Date.now() + 5 });
    expect(await stateOf(server, "ses-a")).toBe("nothing");
    // Its next turn (on other work) does not take that back.
    await poll(server, "ses-a", billing, { busy: true });
    expect(await stateOf(server, "ses-a")).toBe("nothing");
    expect((await plan(server)).run!.done).toBe(1);
  });

  test("N threads updated counts only the threads the run asked about", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const a = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    await deliver(server, "ses-a", billing);
    // A write counts once it is after the delivery (a later clock tick).
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Other work, in a thread the run never named: tidied, with no thread counted.
    await send(client, billing, "ses-a", { subject: "Elsewhere", thread: "Elsewhere", body: "Started the cache work." });
    let run = (await plan(server)).run!;
    expect(run.agents[0]!.state).toBe("tidied");
    expect([run.agents[0]!.updated, run.updated]).toEqual([0, 0]);
    await send(client, billing, "ses-a", { reply_to: a.message_id, body: "Ledger is done; closing this." });
    run = (await plan(server)).run!;
    expect([run.agents[0]!.updated, run.updated]).toEqual([1, 1]);
  });

  test("an undelivered wake is not sent again, even after the person writes to that session", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const a = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    // Busy: the wake waits for its turn to end.
    await poll(server, "ses-a", billing, { busy: true });
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    expect((await post(server, `/api/inbox/messages/${a.message_id}/reply`, { words: "Any news?", idempotency_key: "r1" })).status).toBe(200);
    expect((await plan(server)).agents).toHaveLength(0);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t2" })).status).toBe(409);
    // Once it is delivered, the person's writing since lets it be asked again.
    const handed = await deliver(server, "ses-a", billing);
    expect(handed.filter((c) => inboxWakeText(c).startsWith("Plannotator Inbox: Tidy"))).toHaveLength(1);
    expect((await plan(server)).agents.map((x) => x.session)).toEqual(["ses-a"]);
  });

  test("a session that ended before its wake was delivered reads Session ended, and counts as done", async () => {
    const { server, client, billing, clock, dataDir } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing, { busy: true });
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    expect((await plan(server)).run!.agents.map((x) => x.state)).toEqual(["waiting"]);
    // The session ends (no connection, no Inbox call) before its turn did: read the same store as gone.
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const store = InboxStore.open(dataDir);
    const run = inboxTidyRun(store, { now: Date.now(), idleSince: () => null, reachOf: () => null })!;
    expect(run.agents.map((x) => x.state)).toEqual(["ended"]);
    expect(run.done).toBe(1);
  });

  test("a session that got its wake and ended without writing reads Session ended, not Delivered all day", async () => {
    const { server, client, billing, clock, dataDir } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    await deliver(server, "ses-a", billing);
    expect(await stateOf(server, "ses-a")).toBe("delivered");
    // Closed mid-turn (or the Inbox restarted, its idle times gone): no connection, no idle time, no write.
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const run = inboxTidyRun(InboxStore.open(dataDir), { now: Date.now(), idleSince: () => null, reachOf: () => null })!;
    expect(run.agents.map((x) => x.state)).toEqual(["ended"]);
    expect(run.done).toBe(1);
  });

  test("an MCP-only agent gets the text once, at the end of its next Inbox tool result", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    const asked = await send(client, billing, "ses-cursor", { subject: "Keys", thread: "Keys", body: block("Rebind keys?") }, "cursor");
    clock.behind = 0;
    const found = await plan(server);
    expect(found.agents).toEqual([expect.objectContaining({ session: "ses-cursor", reach: "next_call" })]);
    expect((await tidy(server, { sessions: ["ses-cursor"], idempotency_key: "t1" })).status).toBe(200);
    const read = async () =>
      (await call(client, "read_thread", { thread_id: asked.thread_id, agent_session: "ses-cursor", project_path: billing })).content.map((c) => c.text).join("\n");
    const first = await read();
    expect(first).toContain(INBOX_TIDY_INSTRUCTION);
    expect(await read()).not.toContain(INBOX_TIDY_INSTRUCTION);
  });

  test("a read from the shell of a session its connection wakes leaves the wake to the connection", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const asked = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing, { busy: true });
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    // read_thread carries no agent_host: a script's read names only the session.
    const read = await call(client, "read_thread", { thread_id: asked.thread_id, agent_session: "ses-a", project_path: billing });
    expect(read.content.map((c) => c.text).join("\n")).not.toContain(INBOX_TIDY_INSTRUCTION);
    expect(read.structuredContent.tidy).toBeUndefined();
    const commands = await deliver(server, "ses-a", billing);
    expect(commands.map((c) => inboxWakeText(c).split("\n")[1])).toEqual([INBOX_TIDY_INSTRUCTION]);
  });

  test("a bridge that stopped polling cannot keep a Tidy: the session's next read carries it", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const asked = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing, { busy: true });
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      const read = await call(client, "read_thread", { thread_id: asked.thread_id, agent_session: "ses-a", project_path: billing });
      expect(read.content.map((c) => c.text).join("\n")).toContain(INBOX_TIDY_INSTRUCTION);
      expect(await stateOf(server, "ses-a")).toBe("delivered");
    } finally {
      setSystemTime();
    }
  });

  test("the wake gives each session the value that makes its script that session, for every host and none", () => {
    const body = (host: string | null, session: string) => inboxTidyBody({ session, host, name: "An agent", reach: "wakes", items: [] });
    for (const [host, session, value] of [
      ["claude-code", "ses-a", "claude-code:ses-a"],
      ["opencode", "ses_0abcDEF", "opencode:ses_0abcDEF"],
      ["cursor", "ses_01abc", "cursor:ses_01abc"],
      [null, "ses_01abc", "ses_01abc"],
    ] as const) {
      expect(/`--session ([^`]+)`/.exec(body(host, session))?.[1]).toBe(value);
      expect(parseInboxSessionRef(value)).toEqual({ host: host, session });
    }
    // An id an agent chose that a command line should not carry: no value, and the rest of the wake stands.
    const odd = body("cursor", "my session; rm -rf /");
    expect(odd).not.toContain("--session");
    expect(odd).not.toContain("rm -rf");
    expect(odd).toContain(INBOX_TIDY_HOW);
  });

  test("guards: another site's read and write, a stale tab", async () => {
    const { server } = await setup();
    expect((await fetch(`${base(server)}/api/inbox/tidy`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await post(server, "/api/inbox/tidy", { sessions: ["x"], idempotency_key: "k" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${base(server)}/api/inbox/tidy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "stale", sessions: ["x"], idempotency_key: "k" }) })).status).toBe(409);
  });
});
