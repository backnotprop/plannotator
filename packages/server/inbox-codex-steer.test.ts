/**
 * Steering a reply into a running Codex turn (inbox-codex-steer.ts, through the Codex wake): over Codex's control
 * socket (a terminal Codex on the background server), and through Plannotator's `PostToolUse` hook (the Codex app,
 * or any Codex the socket cannot reach), with `codex queue` the fallback for everything else.
 *
 * Against fakes only: a fake `codex` on a scratch PATH that logs its argv (tests/helpers/fake-agents.ts), a fake
 * control socket in a scratch Codex home (tests/helpers/fake-codex-control.ts), a scratch rollout and hooks.json, and a
 * store in a temp folder. No Inbox server, no real Codex, no real socket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { deliveryLine } from "@plannotator/core/inbox-delivery-line";
import { codexHookCommand } from "@plannotator/shared/codex-hook-command";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { CODEX_HOOK_DIR, takeForCodexHook } from "@plannotator/shared/inbox/codex-hook-mailbox";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { runCodexHook } from "../../apps/hook/server/codex-hook";
import { createFakeAgents } from "../../tests/helpers/fake-agents";
import { startFakeCodexControl, type FakeCodexControl, type FakeCodexControlState } from "../../tests/helpers/fake-codex-control";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createCodexSteerRoute } from "./inbox-codex-steer";
import { codexQueueMessage, createInboxCodexWake, type InboxCodexWake } from "./inbox-codex-wake";

const THREAD = "019a7c00-0000-7000-8000-0000000000c3";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

async function until<T>(what: string, check: () => T | Promise<T>, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(15);
  }
}

const commandOf = (item: InboxMessage): InboxReplyCommand => ({ type: "reply", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: null, body: item.body, url: "http://127.0.0.1/#thread" });

function world(options: { socket?: FakeCodexControlState; rollout?: "running" | "idle" | null; hook?: boolean; requestMs?: number } = {}) {
  const agents = createFakeAgents("plannotator-codex-steer-");
  cleanup.push(() => agents.remove());
  agents.install("codex");
  const codexHome = agents.env.CODEX_HOME!;
  mkdirSync(codexHome, { recursive: true });
  const dataDir = join(agents.root, "data");
  const store = InboxStore.open(join(dataDir, "inbox"));
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: agents.home, env: agents.env });
  const rolloutDir = join(codexHome, "sessions", "2026", "11", "24");
  mkdirSync(rolloutDir, { recursive: true });
  const rollout = join(rolloutDir, `rollout-2026-11-24T10-00-00-${THREAD}.jsonl`);
  /** The rollout as Codex writes it: its session_meta, then the turn's events. */
  const turn = (state: "running" | "idle") => {
    const lines = [
      { type: "session_meta", payload: { id: THREAD, source: "vscode", originator: "Codex Desktop", cwd: "/work/ledger" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      ...(state === "idle" ? [{ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }] : []),
    ];
    writeFileSync(rollout, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  };
  if (options.rollout) turn(options.rollout);
  if (options.hook) {
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/opt/bin/plannotator", timeout: 345600 }] }], PostToolUse: [{ hooks: [{ type: "command", command: codexHookCommand("/opt/bin/plannotator"), timeout: 10 }] }] } }));
  }
  let control: FakeCodexControl | null = null;
  if (options.socket) {
    control = startFakeCodexControl(codexHome, options.socket);
    cleanup.push(() => control!.stop());
  }
  const wakes: InboxCodexWake[] = [];
  cleanup.push(() => {
    for (const wake of wakes) wake.stop();
  });
  const start = () => {
    // The default route under this scratch Codex home; only a short answer time is the test's own.
    const steer = options.requestMs ? createCodexSteerRoute({ codexHomeDir: () => codexHome, allowed: () => true, likelyFolders: () => [], requestMs: options.requestMs }) : undefined;
    const wake = createInboxCodexWake({ store, environment, commandOf, extraClis: [], log: () => {}, ...(steer ? { steer } : {}) });
    wakes.push(wake);
    return wake;
  };
  const ask = () => store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "codex", session: THREAD, name: "Codex" }, body: "Ship it today?", wakes: true }).message;
  const reply = (asked: InboxMessage, words: string, extra: Record<string, unknown> = {}) => store.sendReply(asked.id, { words, idempotency_key: `k-${words}`, ...extra }).reply!;
  const queues = () => agents.calls().filter((call) => call.name === "codex" && call.args[0] === "queue");
  const held = () => (existsSync(join(store.dir, CODEX_HOOK_DIR)) ? readdirSync(join(store.dir, CODEX_HOOK_DIR)).filter((name) => name.endsWith(".json")) : []);
  /** One run of the hook as Codex would run it after a tool call of the thread's turn. */
  const hookRun = (extra: Record<string, unknown> = {}) =>
    runCodexHook(JSON.stringify({ session_id: THREAD, turn_id: "t1", transcript_path: rollout, cwd: "/work/ledger", hook_event_name: "PostToolUse", model: "gpt-5.5", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a\nb", tool_use_id: "call_1", ...extra }), store.dir, Date.now());
  return { store, control: () => control!, turn, start, ask, reply, queues, held, hookRun };
}

describe("a reply to a busy Codex goes into its running turn", () => {
  test("over the control socket: turn/steer into the running turn, delivered at once, never codex queue", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t7" } } });
    const wake = w.start();
    const asked = w.ask();
    const reply = w.reply(asked, "Use the staging bucket.");
    await wake.sweep();
    const delivered = await until("delivered", () => w.store.message(reply.id)!.delivery);
    expect(delivered.into_turn).toBe(true);
    expect(w.control().steers().map((s) => s.expectedTurnId)).toEqual(["t7"]);
    expect(w.control().steers()[0]!.text).toBe(codexQueueMessage(commandOf(w.store.message(reply.id)!)));
    expect(w.queues()).toHaveLength(0);
    // The person's line says it went into the turn.
    const line = deliveryLine({ name: "Codex", deliveredAt: delivered.at, time: () => "5:12 PM", wakes: true, sendingNow: false, connection: undefined, intoTurn: delivered.into_turn });
    expect(line.state).toBe("delivered");
    expect(line.text).not.toBe(deliveryLine({ name: "Codex", deliveredAt: delivered.at, time: () => "5:12 PM", wakes: true, sendingNow: false, connection: undefined }).text);
  });

  test("an idle thread starts its turn as before: codex queue, no steer", async () => {
    const w = world({ socket: { loaded: [THREAD], running: {} } });
    const wake = w.start();
    w.reply(w.ask(), "Go ahead.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.control().steers()).toHaveLength(0);
  });

  test("the turn ended between the look and the steer: queued once, as the next turn", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t1" }, moved: { t1: "ended" } } });
    const wake = w.start();
    const reply = w.reply(w.ask(), "One more thing.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    await wake.sweep();
    expect(w.queues()).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
  });

  test("another turn began between the look and the steer: steered into that one, once", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t1" }, moved: { t1: { next: "t2" } } } });
    const wake = w.start();
    const reply = w.reply(w.ask(), "And the docs.");
    await wake.sweep();
    await until("delivered", () => w.store.message(reply.id)!.delivery);
    expect(w.control().steers().map((s) => s.expectedTurnId)).toEqual(["t1", "t2"]);
    expect(w.queues()).toHaveLength(0);
  });

  test("an older server without thread/turns/list: the whole thread is read for the running turn", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t9" }, noTurnsList: true } });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Check CI.");
    await wake.sweep();
    await until("delivered", () => w.store.message(reply.id)!.delivery);
    expect(w.control().steers().map((s) => s.expectedTurnId)).toEqual(["t9"]);
  });

  test("Codex refuses the steer (a review turn): queued as the next turn", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t3" }, refuseSteer: "cannot steer a review turn" } });
    const wake = w.start();
    w.reply(w.ask(), "After the review.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
  });

  test("no socket (an older Codex, --no-daemon), or the thread not on it (the Codex app): codex queue as before", async () => {
    const none = world();
    const wake = none.start();
    none.reply(none.ask(), "Hello.");
    await wake.sweep();
    await until("queued", () => none.queues().length === 1);

    const elsewhere = world({ socket: { loaded: [], running: {} } });
    const other = elsewhere.start();
    elsewhere.reply(elsewhere.ask(), "Hello there.");
    await other.sweep();
    await until("queued", () => elsewhere.queues().length === 1);
    expect(elsewhere.control().steers()).toHaveLength(0);
  });

  test("a steer that never answers is never sent again, and never queued", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t1" }, silentSteer: true }, requestMs: 300 });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Are you there?");
    await wake.sweep();
    await until("uncertain", () => wake.uncertain(THREAD, reply.id));
    await wake.sweep();
    expect(w.control().steers()).toHaveLength(1);
    expect(w.queues()).toHaveLength(0);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
  });
});

describe("the Codex hook: a reply goes into the running turn after its next tool call", () => {
  test("held while the turn runs, taken by the hook, delivered into the turn, never queued", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Stop and use the other API.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.queues()).toHaveLength(0);

    const out = w.hookRun();
    const said = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(said.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    // The agent reads the reply framed exactly as a queued one.
    expect(said.hookSpecificOutput.additionalContext).toBe(codexQueueMessage(commandOf(w.store.message(reply.id)!)));
    expect(w.held()).toHaveLength(0);

    await wake.sweep();
    const delivered = await until("delivered", () => w.store.message(reply.id)!.delivery);
    expect(delivered.into_turn).toBe(true);
    // The turn ends afterwards: nothing is queued for it.
    w.turn("idle");
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    expect(w.hookRun()).toBe("");
  });

  test("the turn ends with no tool call: the hold ends and it is queued once as the next turn; the hook then finds nothing", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Later is fine.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    w.turn("idle");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.held()).toHaveLength(0);
    expect(w.hookRun()).toBe("");
    await wake.sweep();
    expect(w.queues()).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
  });

  test("the hook and the queue at the same moment: the one claim decides, it goes once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Race me.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    // The hook read and claimed it; the turn ends before the Inbox looks again.
    expect(takeForCodexHook(w.store.dir, THREAD, Date.now())).toHaveLength(1);
    w.turn("idle");
    await wake.sweep();
    await until("delivered", () => w.store.message(reply.id)!.delivery);
    expect(w.queues()).toHaveLength(0);
  });

  test("no hook installed, or the turn not running: codex queue at once, nothing held", async () => {
    const noHook = world({ rollout: "running" });
    const wake = noHook.start();
    noHook.reply(noHook.ask(), "Plain.");
    await wake.sweep();
    await until("queued", () => noHook.queues().length === 1);
    expect(noHook.held()).toHaveLength(0);

    const idle = world({ rollout: "idle", hook: true });
    const other = idle.start();
    idle.reply(idle.ask(), "Idle.");
    await other.sweep();
    await until("queued", () => idle.queues().length === 1);
    expect(idle.held()).toHaveLength(0);
  });

  test("a subagent's tool call (it names the root thread) never takes the root's reply", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    w.reply(w.ask(), "For the root.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.hookRun({ agent_id: "sub-1", agent_type: "worker" })).toBe("");
    expect(w.held()).toHaveLength(1);
  });

  test("a reply sent from the linked computer takes the same route", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "From the other Mac.", { sent_from: { kind: "machine", name: "Mini" } });
    expect(w.store.message(reply.id)!.sent_from).toEqual({ kind: "machine", name: "Mini" });
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(JSON.parse(w.hookRun()).hookSpecificOutput.additionalContext).toContain("From the other Mac.");
    await wake.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    expect(w.queues()).toHaveLength(0);
  });

  test("a hook claim from before an Inbox restart is recorded as delivered, not sent again", async () => {
    const w = world({ rollout: "running", hook: true });
    const first = w.start();
    const reply = w.reply(w.ask(), "Across a restart.");
    await first.sweep();
    await until("held", () => w.held().length === 1);
    first.stop();
    expect(w.hookRun()).not.toBe("");
    const second = w.start();
    await second.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    expect(w.queues()).toHaveLength(0);
  });
});
