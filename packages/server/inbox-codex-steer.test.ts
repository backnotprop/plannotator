/**
 * Steering a reply into a running Codex turn (inbox-codex-steer.ts, through the Codex wake): through Plannotator's
 * `PostToolUse` hook (the Codex app, any Codex that runs hooks), and over Codex's control socket (off by default, kept
 * with these tests), with `codex queue` the fallback for everything else. A steer is only handed on: Delivered once the
 * thread's rollout shows the text (inbox-codex-sight.ts), the next turn when the turn ended without it, never twice.
 *
 * Against fakes only: a fake `codex` on a scratch PATH that logs its argv (tests/helpers/fake-agents.ts), a fake
 * control socket in a scratch Codex home (tests/helpers/fake-codex-control.ts), a scratch rollout and hooks.json, and a
 * store in a temp folder. No Inbox server, no real Codex, no real socket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { deliveryLine } from "@plannotator/core/inbox-delivery-line";
import { CODEX_HOOK_RAN_FILE, codexHookCommand } from "@plannotator/shared/codex-hook-command";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { CODEX_HOOK_DIR, codexHookClaimDir, takeForCodexHook } from "@plannotator/shared/inbox/codex-hook-mailbox";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { runCodexHook } from "../../apps/hook/server/codex-hook";
import { createFakeAgents } from "../../tests/helpers/fake-agents";
import { startFakeCodexControl, type FakeCodexControl, type FakeCodexControlState } from "../../tests/helpers/fake-codex-control";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { CODEX_HOOK_CLAIM_GRACE_MS, codexBusyReply, createCodexSteerRoute, INBOX_CODEX_STEER_SOCKET } from "./inbox-codex-steer";
import { codexQueueMessage, createInboxCodexWake, type InboxCodexWake } from "./inbox-codex-wake";
import { InboxOutbox } from "./inbox-outbox";
import { MACHINE_PLATFORM } from "./inbox-devices";
import { inboxRequestSentFrom } from "./inbox-sent-from";
import { inboxSentFromPlaceOf } from "@plannotator/core/inbox-types";

const THREAD = "019a7c00-0000-7000-8000-0000000000c3";
const SUBAGENT = "019a7c00-0000-7000-8000-0000000000d4";

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

/**
 * `switch`: the experimental `codex-steer` switch as config.json says it (absent: the policy is "steer", as the switch
 * on). The data dir is the world's own (PLANNOTATOR_DATA_DIR, restored after).
 */
function world(options: { socket?: FakeCodexControlState; rollout?: "running" | "idle" | null; hook?: boolean; reviewed?: boolean; requestMs?: number; switch?: "on" | "off" | "unset" } = {}) {
  const agents = createFakeAgents("plannotator-codex-steer-");
  cleanup.push(() => agents.remove());
  agents.install("codex");
  const codexHome = agents.env.CODEX_HOME!;
  mkdirSync(codexHome, { recursive: true });
  const dataDir = join(agents.root, "data");
  mkdirSync(dataDir, { recursive: true });
  const dataBefore = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (dataBefore === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = dataBefore;
  });
  if (options.switch === "on" || options.switch === "off") writeFileSync(join(dataDir, "config.json"), JSON.stringify({ experimental: { codexSteer: options.switch === "on" } }));
  const store = InboxStore.open(join(dataDir, "inbox"));
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: agents.home, env: agents.env });
  const rolloutDir = join(codexHome, "sessions", "2026", "11", "24");
  mkdirSync(rolloutDir, { recursive: true });
  const rollout = join(rolloutDir, `rollout-2026-11-24T10-00-00-${THREAD}.jsonl`);
  const subRollout = join(rolloutDir, `rollout-2026-11-24T10-05-00-${SUBAGENT}.jsonl`);
  /** The rollout as Codex writes it: its session_meta, then the turn's events. */
  const turn = (state: "running" | "idle") => {
    const lines = [
      { type: "session_meta", payload: { id: THREAD, source: "vscode", originator: "Codex Desktop", cwd: "/work/ledger" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      ...(state === "idle" ? [{ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }] : []),
    ];
    writeFileSync(rollout, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  };
  const append = (...entries: unknown[]) => appendFileSync(rollout, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  /** Codex recorded `text` as a message of the conversation (a steer as the user's, the hook's context as the developer's). */
  const shows = (text: string, role: "user" | "developer") => append({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  /** The person pressed Esc: the turn ends aborted. */
  const aborted = () => append({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t1", reason: "interrupted" } });
  const modelStep = () => append({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c9" } });
  /** Nothing more written for a minute (the thread went idle). */
  const quiet = () => {
    const old = new Date(Date.now() - 60_000);
    utimesSync(rollout, old, old);
  };
  if (options.rollout) turn(options.rollout);
  const hooksFile = join(codexHome, "hooks.json");
  if (options.hook) {
    writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/opt/bin/plannotator", timeout: 345600 }] }], PostToolUse: [{ hooks: [{ type: "command", command: codexHookCommand("/opt/bin/plannotator", hooksFile), timeout: 10 }] }] } }));
  }
  /** The hook's gate ran once Codex ran the hook (after hooks.json last changed). */
  const reviewed = () => {
    const file = join(store.dir, CODEX_HOOK_RAN_FILE);
    writeFileSync(file, "");
    const later = new Date(Date.now() + 1_000);
    utimesSync(file, later, later);
  };
  if (options.hook && options.reviewed !== false) reviewed();
  let control: FakeCodexControl | null = null;
  if (options.socket) {
    control = startFakeCodexControl(codexHome, options.socket);
    cleanup.push(() => control!.stop());
  }
  const wakes: InboxCodexWake[] = [];
  cleanup.push(() => {
    for (const wake of wakes) wake.stop();
  });
  const clock = { shift: 0 };
  const now = () => Date.now() + clock.shift;
  const start = (how: { socket?: boolean } = {}) => {
    // The route under this scratch Codex home; the socket route is on only where a test turns it on.
    const socket = how.socket ?? !!options.socket;
    const policy = options.switch ? {} : { policy: "steer" as const };
    const steer = createCodexSteerRoute({ codexHomeDir: () => codexHome, inboxDir: () => store.dir, allowed: () => true, likelyFolders: () => [], now, socket, ...policy, ...(options.requestMs ? { requestMs: options.requestMs } : {}) });
    const wake = createInboxCodexWake({ store, environment, commandOf, extraClis: [], log: () => {}, steer, now });
    wakes.push(wake);
    return wake;
  };
  const ask = () => store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "codex", session: THREAD, name: "Codex" }, body: "Ship it today?", wakes: true }).message;
  const reply = (asked: InboxMessage, words: string, extra: Record<string, unknown> = {}) => store.sendReply(asked.id, { words, idempotency_key: `k-${words.slice(0, 40)}`, ...extra }).reply!;
  const queues = () => agents.calls().filter((call) => call.name === "codex" && call.args[0] === "queue");
  const held = () => (existsSync(join(store.dir, CODEX_HOOK_DIR)) ? readdirSync(join(store.dir, CODEX_HOOK_DIR)).filter((name) => name.endsWith(".json")) : []);
  /** One run of the hook as Codex would run it after a tool call of the thread's turn. */
  const hookRun = (extra: Record<string, unknown> = {}) =>
    runCodexHook(JSON.stringify({ session_id: THREAD, turn_id: "t1", transcript_path: rollout, cwd: "/work/ledger", hook_event_name: "PostToolUse", model: "gpt-5.5", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a\nb", tool_use_id: "call_1", ...extra }), store.dir, Date.now());
  const contextOf = (out: string) => (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
  const handed = (id: string) => store.handover.handedTo(THREAD).includes(id);
  return { store, project, rollout, subRollout, hooksFile, clock, control: () => control!, turn, append, shows, aborted, modelStep, quiet, reviewed, start, ask, reply, queues, held, hookRun, contextOf, handed };
}

describe("the experimental codex-steer switch: off by default, and off is the queue as before", () => {
  for (const state of ["unset", "off"] as const) {
    test(`switch ${state}: a busy Codex with the hook reviewed and a socket gets codex queue, nothing held, nothing steered`, async () => {
      const w = world({ switch: state, rollout: "running", hook: true, socket: { loaded: [THREAD], running: { [THREAD]: "t7" } } });
      const wake = w.start({ socket: true });
      const reply = w.reply(w.ask(), "Just queue it.");
      await wake.sweep();
      await until("queued", () => w.queues().length === 1);
      expect(w.held()).toHaveLength(0);
      expect(w.control().calls).toHaveLength(0);
      // The hook, if Codex runs it anyway, finds nothing to take.
      expect(w.hookRun()).toBe("");
      await wake.sweep();
      expect(w.queues()).toHaveLength(1);
      expect(w.store.message(reply.id)!.delivery?.into_turn).toBeUndefined();
    });
  }

  test("switch on in config.json: held for the hook; PLANNOTATOR_EXPERIMENTAL decides over config.json", async () => {
    const w = world({ switch: "on", rollout: "running", hook: true });
    const wake = w.start();
    w.reply(w.ask(), "Into the turn.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.queues()).toHaveLength(0);
    expect(codexBusyReply({})).toBe("steer");
    expect(codexBusyReply({ PLANNOTATOR_EXPERIMENTAL: "-codex-steer" })).toBe("next_turn");
    writeFileSync(join(process.env.PLANNOTATOR_DATA_DIR!, "config.json"), "{}");
    expect(codexBusyReply({})).toBe("next_turn");
    expect(codexBusyReply({ PLANNOTATOR_EXPERIMENTAL: "x, Codex-Steer" })).toBe("steer");
  });
});

describe("the Codex hook: a reply goes into the running turn after its next tool call", () => {
  test("held, taken by the hook, handed (not Delivered) until the rollout shows it, then delivered into the turn once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Stop and use the other API.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.queues()).toHaveLength(0);

    const said = w.contextOf(w.hookRun());
    expect(said.hookEventName).toBe("PostToolUse");
    // The agent reads the reply framed exactly as a queued one.
    expect(said.additionalContext).toBe(codexQueueMessage(commandOf(w.store.message(reply.id)!)));
    expect(w.held()).toHaveLength(0);

    // Taken, but Codex has not recorded it: still handed, never Delivered.
    await wake.sweep();
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
    expect(w.handed(reply.id)).toBe(true);
    w.shows(said.additionalContext, "developer");
    await wake.sweep();
    const delivered = await until("delivered", () => w.store.message(reply.id)!.delivery);
    expect(delivered.into_turn).toBe(true);
    const line = deliveryLine({ name: "Codex", deliveredAt: delivered.at, time: () => "5:12 PM", wakes: true, sendingNow: false, connection: undefined, intoTurn: delivered.into_turn });
    expect(line.text).not.toBe(deliveryLine({ name: "Codex", deliveredAt: delivered.at, time: () => "5:12 PM", wakes: true, sendingNow: false, connection: undefined }).text);
    // The turn ends afterwards: nothing is queued for it, nothing is held.
    w.turn("idle");
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    expect(w.hookRun()).toBe("");
  });

  test("Esc during the hook (the turn aborts before Codex records it): it goes as the next turn, once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Before you push.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.hookRun()).not.toBe("");
    w.aborted();
    // Codex carries input it kept into a new turn at once: a few seconds of nothing more, and it was dropped.
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    w.quiet();
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.queues()[0]!.args).toContain(`--message=${codexQueueMessage(commandOf(w.store.message(reply.id)!))}`);
    await wake.sweep();
    await wake.sweep();
    expect(w.queues()).toHaveLength(1);
    expect(w.held()).toHaveLength(0);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
  });

  test("recorded, then Esc: delivered once, never queued", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Keep the old schema.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    w.shows(w.contextOf(w.hookRun()).additionalContext, "developer");
    w.aborted();
    await wake.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
  });

  test("the hook's output lost and the turn goes on to its next step without it: the next turn, once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Timed out hook.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.hookRun()).not.toBe("");
    // Same turn, a later step, no text: not decided yet (it may be in a later step's history).
    w.modelStep();
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    // The turn ends and the next model step goes on without it.
    w.append({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }, { type: "event_msg", payload: { type: "task_started", turn_id: "t2" } });
    w.modelStep();
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
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

  test("the hook and the turn's end at the same moment: the one claim decides, it goes once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Race me.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    // The hook claimed it and Codex recorded it; the turn ends before the Inbox looks again.
    const taken = takeForCodexHook(w.store.dir, THREAD, Date.now());
    expect(taken).toHaveLength(1);
    w.shows(taken[0]!, "developer");
    w.append({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } });
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

  test("a hook Codex has not run (not yet reviewed in Codex, or hooks.json changed since): the next turn, nothing held", async () => {
    const w = world({ rollout: "running", hook: true, reviewed: false });
    const wake = w.start();
    w.reply(w.ask(), "Unreviewed.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.held()).toHaveLength(0);

    // Codex ran it once: the next reply is held for it.
    const reviewedWorld = world({ rollout: "running", hook: true });
    const ran = reviewedWorld.start();
    reviewedWorld.reply(reviewedWorld.ask(), "Reviewed.");
    await ran.sweep();
    await until("held", () => reviewedWorld.held().length === 1);

    // hooks.json changed after its last run (an update rewrote the command): Codex asks for a review again.
    const changed = world({ rollout: "running", hook: true });
    const later = new Date(Date.now() + 60_000);
    utimesSync(changed.hooksFile, later, later);
    const after = changed.start();
    changed.reply(changed.ask(), "Changed.");
    await after.sweep();
    await until("queued", () => changed.queues().length === 1);
    expect(changed.held()).toHaveLength(0);
  });

  test("a reply too long for the hook's context goes as the next turn; a short one is held", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const long = w.reply(w.ask(), `Spec:\n${"word ".repeat(3_000)}`);
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.held()).toHaveLength(0);
    expect(w.queues()[0]!.args.join(" ")).toContain(`(${long.id})`);
    // Every alphabet: 3,000 characters outside ASCII are more tokens than the hook carries whole.
    const wide = w.reply(w.ask(), "表".repeat(2_500));
    await wake.sweep();
    await until("queued", () => w.queues().length === 2);
    expect(w.queues()[1]!.args.join(" ")).toContain(`(${wide.id})`);
    w.reply(w.ask(), "Short.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
  });

  test("two held replies: one hook run hands both in order, each delivered once when recorded", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const asked = w.ask();
    const first = w.reply(asked, "First, rename the table.");
    await wake.sweep();
    const second = w.reply(asked, "Second, then migrate.");
    await wake.sweep();
    await until("both held", () => w.held().length === 2);
    const context = w.contextOf(w.hookRun()).additionalContext;
    expect(context.indexOf("First, rename the table.")).toBeGreaterThanOrEqual(0);
    expect(context.indexOf("First, rename the table.")).toBeLessThan(context.indexOf("Second, then migrate."));
    w.shows(context, "developer");
    await wake.sweep();
    await until("both delivered", () => w.store.message(first.id)!.delivery && w.store.message(second.id)!.delivery);
    expect(w.queues()).toHaveLength(0);
  });

  test("a held reply cannot be taken back (Codex has it); one read another way meanwhile is cleared and never taken", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Read it yourself.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(() => w.store.takeBack(reply.id)).toThrow();
    // The agent read the thread (read_thread): the reply no longer waits.
    w.store.recordOwnRead(reply.thread_id, THREAD);
    await wake.sweep();
    await until("cleared", () => w.held().length === 0);
    expect(w.hookRun()).toBe("");
    expect(w.queues()).toHaveLength(0);
  });

  test("held files no reply is held for (a stopped Inbox's, a stray one) are cleared: at start, and on the next look", async () => {
    const w = world({ rollout: "running", hook: true });
    mkdirSync(join(w.store.dir, CODEX_HOOK_DIR), { recursive: true });
    writeFileSync(join(w.store.dir, CODEX_HOOK_DIR, `${THREAD}.msg_gone.json`), JSON.stringify({ at: 1, text: "Plannotator Inbox: old (msg_gone)" }));
    const wake = w.start();
    expect(w.held()).toHaveLength(0);
    writeFileSync(join(w.store.dir, CODEX_HOOK_DIR, `${THREAD}.msg_stray.json`), JSON.stringify({ at: 2, text: "Plannotator Inbox: stray (msg_stray)" }));
    const reply = w.reply(w.ask(), "The real one.");
    await wake.sweep();
    await until("only the real one", () => w.held().length === 1 && w.held()[0]!.includes(reply.id));
    expect(w.contextOf(w.hookRun()).additionalContext).not.toContain("msg_stray");
  });

  test("Codex quit mid-turn while a reply was held (its rollout stopped): the hold ends and it goes as the next turn", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    w.reply(w.ask(), "Still there?");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    const old = new Date(Date.now() - 21 * 60_000);
    utimesSync(w.rollout, old, old);
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.held()).toHaveLength(0);
  });

  test("a hook that died mid-claim (no hooked.json): once Codex gave up on it, the next turn, once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Half taken.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    mkdirSync(codexHookClaimDir(w.store.dir, reply.id, THREAD), { recursive: true });
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    w.clock.shift = CODEX_HOOK_CLAIM_GRACE_MS + 1_000;
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.hookRun()).toBe("");
    await wake.sweep();
    expect(w.queues()).toHaveLength(1);
  });

  test("a subagent's tool call never takes the root's reply: with agent_id, or (older Codex) only its own rollout", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    w.reply(w.ask(), "For the root.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.hookRun({ agent_id: "sub-1", agent_type: "worker" })).toBe("");
    expect(w.hookRun({ transcript_path: w.subRollout })).toBe("");
    expect(w.hookRun({ transcript_path: null })).toBe("");
    expect(w.held()).toHaveLength(1);
    expect(w.hookRun()).not.toBe("");
  });

  test("an Inbox restart before the hook claimed it: held again, taken once, delivered once", async () => {
    const w = world({ rollout: "running", hook: true });
    const first = w.start();
    const reply = w.reply(w.ask(), "Across a restart.");
    await first.sweep();
    await until("held", () => w.held().length === 1);
    first.stop();
    const second = w.start();
    await second.sweep();
    await until("held again", () => w.held().length === 1);
    w.shows(w.contextOf(w.hookRun()).additionalContext, "developer");
    await second.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    expect(w.queues()).toHaveLength(0);
  });

  test("a hook claim from before an Inbox restart is looked for in the rollout, not sent again", async () => {
    const w = world({ rollout: "running", hook: true });
    const first = w.start();
    const reply = w.reply(w.ask(), "Claimed, then restarted.");
    await first.sweep();
    await until("held", () => w.held().length === 1);
    first.stop();
    const context = w.contextOf(w.hookRun()).additionalContext;
    const second = w.start();
    await second.sweep();
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
    w.shows(context, "developer");
    await second.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    expect(w.queues()).toHaveLength(0);
  });

  test("a reply forwarded from the linked computer (its outbox entry, the door's place, a retry) takes the same route once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const asked = w.ask();
    // The other computer's outbox holds the write as it forwards it, and sends it again after its own restart.
    const outboxDir = join(w.store.dir, "..", "..", "mini-data");
    mkdirSync(outboxDir, { recursive: true });
    const words = "From the other Mac.";
    InboxOutbox.open(outboxDir).submit("ibx_01K00000000000000000000000", `messages/${asked.id}/reply`, { idempotency_key: "fwd-1", words }, null, true, "tailnet");
    const entry = InboxOutbox.open(outboxDir).get("fwd-1")!;
    // This computer's door: the machine's token, its name, the place it says on.
    const sentFrom = inboxRequestSentFrom({ via: "tailnet", ownNode: false, cloudflare: false, door: { platform: MACHINE_PLATFORM, machineName: "Mini", place: inboxSentFromPlaceOf(entry.sent_from) } });
    const land = () => w.store.sendReply(asked.id, { words, idempotency_key: "fwd-1", sent_from: sentFrom }).reply!;
    const reply = land();
    expect(w.store.message(reply.id)!.sent_from).toEqual({ kind: "machine", name: "Mini", via: "tailnet" });
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    // The retry lands on the same reply: nothing more is held or sent.
    expect(land().id).toBe(reply.id);
    await wake.sweep();
    expect(w.held()).toHaveLength(1);
    const context = w.contextOf(w.hookRun()).additionalContext;
    expect(context).toContain(words);
    w.shows(context, "developer");
    await wake.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    expect(w.queues()).toHaveLength(0);
  });
});

describe("over the control socket (off by default)", () => {
  test("off by default: a Codex with a socket and a running turn gets the hook or the queue, never a steer", async () => {
    expect(INBOX_CODEX_STEER_SOCKET).toBe(false);
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t7" } }, rollout: "running" });
    const wake = w.start({ socket: false });
    w.reply(w.ask(), "Default route.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.control().steers()).toHaveLength(0);
  });

  test("turn/steer into the running turn: handed until the rollout shows it, then delivered into the turn", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t7" } }, rollout: "running" });
    const wake = w.start();
    const asked = w.ask();
    const reply = w.reply(asked, "Use the staging bucket.");
    await wake.sweep();
    await until("steered", () => w.control().steers().length === 1);
    expect(w.control().steers().map((s) => s.expectedTurnId)).toEqual(["t7"]);
    const text = w.control().steers()[0]!.text;
    expect(text).toBe(codexQueueMessage(commandOf(w.store.message(reply.id)!)));
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
    expect(w.handed(reply.id)).toBe(true);
    w.shows(text, "user");
    await wake.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    expect(w.queues()).toHaveLength(0);
  });

  test("steered, then Esc before the model read it: the next turn by codex queue, once, never steered again", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t7" } }, rollout: "running" });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Dropped by Esc.");
    await wake.sweep();
    await until("steered", () => w.control().steers().length === 1);
    w.aborted();
    w.quiet();
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    await wake.sweep();
    expect(w.queues()).toHaveLength(1);
    expect(w.control().steers()).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
  });

  test("steered, read, then Esc: delivered once, never queued", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t7" } }, rollout: "running" });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Read before Esc.");
    await wake.sweep();
    await until("steered", () => w.control().steers().length === 1);
    w.shows(w.control().steers()[0]!.text, "user");
    w.aborted();
    await wake.sweep();
    await until("delivered", () => w.store.message(reply.id)!.delivery);
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
  });

  test("steered, and the turn ended quietly without it: the next turn once the rollout stays quiet", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t7" } }, rollout: "running" });
    const wake = w.start();
    w.reply(w.ask(), "Left at the end.");
    await wake.sweep();
    await until("steered", () => w.control().steers().length === 1);
    w.append({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } });
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    w.quiet();
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
  });

  test("an idle thread starts its turn as before: codex queue, no steer", async () => {
    const w = world({ socket: { loaded: [THREAD], running: {} }, rollout: "idle" });
    const wake = w.start();
    w.reply(w.ask(), "Go ahead.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    expect(w.control().steers()).toHaveLength(0);
  });

  test("the turn ended between the look and the steer: queued once, as the next turn", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t1" }, moved: { t1: "ended" } }, rollout: "running" });
    const wake = w.start();
    const reply = w.reply(w.ask(), "One more thing.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    await wake.sweep();
    expect(w.queues()).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
  });

  test("another turn began between the look and the steer: steered into that one, once", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t1" }, moved: { t1: { next: "t2" } } }, rollout: "running" });
    const wake = w.start();
    const reply = w.reply(w.ask(), "And the docs.");
    await wake.sweep();
    await until("steered", () => w.control().steers().length === 2);
    expect(w.control().steers().map((s) => s.expectedTurnId)).toEqual(["t1", "t2"]);
    w.shows(w.control().steers()[1]!.text, "user");
    await wake.sweep();
    await until("delivered", () => w.store.message(reply.id)!.delivery);
    expect(w.queues()).toHaveLength(0);
  });

  test("an older server without thread/turns/list: the whole thread is read for the running turn", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t9" }, noTurnsList: true }, rollout: "running" });
    const wake = w.start();
    w.reply(w.ask(), "Check CI.");
    await wake.sweep();
    await until("steered", () => w.control().steers().length === 1);
    expect(w.control().steers().map((s) => s.expectedTurnId)).toEqual(["t9"]);
  });

  test("Codex refuses the steer (a review turn): queued as the next turn", async () => {
    const w = world({ socket: { loaded: [THREAD], running: { [THREAD]: "t3" }, refuseSteer: "cannot steer a review turn" }, rollout: "running" });
    const wake = w.start();
    w.reply(w.ask(), "After the review.");
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
  });

  test("no socket (an older Codex, --no-daemon), or the thread not on it (the Codex app): codex queue as before", async () => {
    const none = world();
    const wake = none.start({ socket: true });
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
