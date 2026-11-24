/**
 * Steering a reply into a running Codex turn (inbox-codex-steer.ts, through the Codex wake): through Plannotator's
 * `PostToolUse` hook (the Codex app, any Codex that runs hooks), with `codex queue` the fallback for everything else.
 * A steer is only handed on: Delivered once the thread's rollout shows the text (inbox-codex-sight.ts), the next turn
 * when the turn ended without it, never twice. All of it only behind the experimental `codex-steer` switch.
 *
 * Against fakes only: a fake `codex` on a scratch PATH that logs its argv (tests/helpers/fake-agents.ts), a scratch
 * rollout and hooks.json, and a store in a temp folder. No Inbox server, no real Codex.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { deliveryLine, INTO_RUNNING_TURN_TEXT } from "@plannotator/core/inbox-delivery-line";
import { CODEX_HOOK_RAN_FILE, codexHookCommand } from "@plannotator/shared/codex-hook-command";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { CODEX_HOOK_CLAIM_MARK, CODEX_HOOK_DIR, codexHookClaimDir, takeForCodexHook } from "@plannotator/shared/inbox/codex-hook-mailbox";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { runCodexHook } from "../../apps/hook/server/codex-hook";
import { createFakeAgents } from "../../tests/helpers/fake-agents";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { CODEX_HOOK_CLAIM_GRACE_MS, codexSteerOn, createCodexSteerRoute } from "./inbox-codex-steer";
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
 * `switch`: the experimental `codex-steer` switch as config.json says it (absent: on, given to the route). The data dir
 * is the world's own (PLANNOTATOR_DATA_DIR, restored after).
 */
function world(options: { rollout?: "running" | "idle" | null; hook?: boolean; reviewed?: boolean; switch?: "on" | "off" | "unset" } = {}) {
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
  /** Nothing written for 21 minutes (a Codex that crashed mid-turn). */
  const stale = () => {
    const old = new Date(Date.now() - 21 * 60_000);
    utimesSync(rollout, old, old);
  };
  const wakes: InboxCodexWake[] = [];
  cleanup.push(() => {
    for (const wake of wakes) wake.stop();
  });
  const clock = { shift: 0 };
  const now = () => Date.now() + clock.shift;
  const logs: string[] = [];
  /** `extra`: more of the wake's options (a launched thread's host: `deliver`, `launched`, `turnRunning`); `home`: another Codex home. */
  const start = (extra: Partial<Parameters<typeof createInboxCodexWake>[0]> = {}, home = codexHome) => {
    // The route under this scratch Codex home; the switch from config.json when the test names it, else on.
    const steering = options.switch ? {} : { steering: true };
    const steer = createCodexSteerRoute({ codexHomeDir: () => home, inboxDir: () => store.dir, allowed: () => true, likelyFolders: () => [], now, ...steering });
    const wake = createInboxCodexWake({ store, environment, commandOf, extraClis: [], log: (line) => logs.push(line), steer, now, ...extra });
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
  /** How many `codex queue` calls carried this reply. */
  const queuesOf = (id: string) => queues().filter((call) => call.args.some((arg) => arg.includes(`(${id})`))).length;
  return { store, project, codexHome, dataDir, rollout, subRollout, hooksFile, clock, logs, turn, append, shows, aborted, modelStep, quiet, stale, reviewed, start, ask, reply, queues, queuesOf, held, hookRun, contextOf, handed };
}

/** Every path the fs calls name while `run` runs (sync and promise forms), for "nothing of the steering is touched". */
async function pathsTouched(run: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const spies = [
    ...(["readFileSync", "readdirSync", "existsSync", "statSync", "writeFileSync", "rmSync", "mkdirSync", "openSync", "renameSync", "utimesSync"] as const).map((name) => spyOn(fs, name)),
    ...(["open", "stat", "readdir", "readFile", "writeFile"] as const).map((name) => spyOn(fsp, name)),
  ];
  try {
    await run();
  } finally {
    for (const spy of spies) {
      for (const call of spy.mock.calls) if (typeof call[0] === "string") seen.push(call[0]);
      spy.mockRestore();
    }
  }
  return seen;
}

describe("the experimental codex-steer switch: off by default, and off is the queue as before", () => {
  for (const state of ["unset", "off"] as const) {
    test(`switch ${state}: a busy Codex with the hook reviewed gets codex queue; nothing of the steering is read or written, nothing new is logged`, async () => {
      const w = world({ switch: state, rollout: "running", hook: true });
      // Left by an earlier run with the switch on: a held file. Off, it is left exactly as it is (never read, never cleared).
      const leftHeld = join(w.store.dir, CODEX_HOOK_DIR, `${THREAD}.m-left.json`);
      mkdirSync(join(w.store.dir, CODEX_HOOK_DIR), { recursive: true });
      writeFileSync(leftHeld, "{}");
      const wake = w.start();
      const reply = w.reply(w.ask(), "Just queue it.");
      const touched = await pathsTouched(async () => {
        await wake.sweep();
        await until("queued", () => w.queues().length === 1);
        await wake.sweep();
      });
      expect(w.queues()).toHaveLength(1);
      expect(existsSync(leftHeld)).toBe(true);
      // (The wake reads a thread's rollout as before this, for T3 Code's threads; nothing of the steering's own.)
      const steering = touched.filter((path) => /codex-hook|hooked\.json|steered\.json|hook-claim|hooks\.json|config\.json|steer-on|next-turn/.test(path));
      expect(steering).toEqual([]);
      expect(w.logs).toEqual([]);
      expect(w.store.message(reply.id)!.delivery?.into_turn).toBeUndefined();
    });
  }

  test("off: a claim this Inbox did not make is left alone, as before (never re-sent after any wait)", async () => {
    const w = world({ switch: "off", rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Another Inbox has it.");
    mkdirSync(codexHookClaimDir(w.store.dir, reply.id, THREAD), { recursive: true });
    await wake.sweep();
    w.clock.shift = CODEX_HOOK_CLAIM_GRACE_MS + 60_000;
    await wake.sweep();
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    expect(existsSync(codexHookClaimDir(w.store.dir, reply.id, THREAD))).toBe(true);
  });

  test("switch on in config.json: held for the hook; PLANNOTATOR_EXPERIMENTAL decides over config.json", async () => {
    const w = world({ switch: "on", rollout: "running", hook: true });
    const wake = w.start();
    w.reply(w.ask(), "Into the turn.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.queues()).toHaveLength(0);
    expect(codexSteerOn({})).toBe(true);
    expect(codexSteerOn({ PLANNOTATOR_EXPERIMENTAL: "-codex-steer" })).toBe(false);
    writeFileSync(join(process.env.PLANNOTATOR_DATA_DIR!, "config.json"), "{}");
    expect(codexSteerOn({})).toBe(false);
    expect(codexSteerOn({ PLANNOTATOR_EXPERIMENTAL: "x, Codex-Steer" })).toBe(true);
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

  test("a hook that died mid-claim (its mark, no hooked.json): once Codex gave up on it, the next turn, once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Half taken.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    mkdirSync(codexHookClaimDir(w.store.dir, reply.id, THREAD), { recursive: true });
    writeFileSync(join(codexHookClaimDir(w.store.dir, reply.id, THREAD), CODEX_HOOK_CLAIM_MARK), "");
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

describe("the line: into its running turn only for a real steer", () => {
  test("a Claude Code item marked to go by itself, its attempt failed (deliver_now_at cleared), then delivered into the turn: no steer words", () => {
    const base = { name: "Claude Code", deliveredAt: "2026-11-24T17:12:00.000Z", time: () => "5:12 PM", wakes: true, sendingNow: false, connection: undefined };
    const plain = deliveryLine(base).text;
    // deliver_now_by "auto" kept, deliver_now_at cleared by the failed attempt, into_turn true from the connection.
    expect(deliveryLine({ ...base, nowBy: "auto", nowAt: null, waitingSince: "2026-11-24T17:00:00.000Z", intoTurn: true }).text).toBe(plain);
    // The Codex wake's own steer (no mark, into_turn true): the words.
    expect(deliveryLine({ ...base, name: "Codex", intoTurn: true }).text).toContain(INTO_RUNNING_TURN_TEXT);
  });
});

describe("the switch on: what Codex crashes and other Inboxes leave behind", () => {
  test("taken by the hook, then Codex crashed before recording it (no rollout writes for 20 minutes): the next turn, once", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Before the crash.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.contextOf(w.hookRun()).additionalContext).toContain("Before the crash.");
    await wake.sweep();
    expect(w.handed(reply.id)).toBe(true);
    expect(w.queues()).toHaveLength(0);
    // 20 minutes without a write, but only just handed on: still waiting (counted from the hand-off too).
    w.stale();
    await wake.sweep();
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    w.clock.shift = 21 * 60_000;
    await wake.sweep();
    await until("queued", () => w.queues().length === 1);
    await wake.sweep();
    await wake.sweep();
    expect(w.queues()).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
  });

  test("a claim without the hook's mark (another Inbox on this data dir) is left alone, while held or not: never re-sent", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    // Held, and then another Inbox claims it.
    const heldOne = w.reply(w.ask(), "Held here, claimed there.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    mkdirSync(codexHookClaimDir(w.store.dir, heldOne.id, THREAD), { recursive: true });
    // Never held here: claimed there first.
    const other = w.reply(w.ask(), "Claimed there first.");
    mkdirSync(codexHookClaimDir(w.store.dir, other.id, THREAD), { recursive: true });
    await wake.sweep();
    w.clock.shift = CODEX_HOOK_CLAIM_GRACE_MS + 60_000;
    await wake.sweep();
    await wake.sweep();
    expect(w.queues()).toHaveLength(0);
    expect(w.held()).toHaveLength(0);
    expect(existsSync(codexHookClaimDir(w.store.dir, heldOne.id, THREAD))).toBe(true);
    expect(existsSync(codexHookClaimDir(w.store.dir, other.id, THREAD))).toBe(true);
  });
});

describe("a launched thread's steer: steered once, never judged dropped while its turn runs", () => {
  /** A launched thread's host: `turn/steer` while `busy`, a new turn otherwise; every call kept. */
  const host = () => {
    const calls: { text: string; intoTurn: boolean }[] = [];
    const state = { busy: true };
    const options = {
      deliver: async (_session: string, text: string, intoTurn?: boolean) => {
        calls.push({ text, intoTurn: intoTurn === true });
        return intoTurn && state.busy ? ("steered" as const) : ("delivered" as const);
      },
      launched: () => true,
      turnRunning: () => state.busy,
    };
    return { calls, state, options };
  };
  const ago = (file: string, ms: number, shift: number) => {
    const at = new Date(Date.now() + shift - ms);
    utimesSync(file, at, at);
  };

  test("a 25-minute build, a reply steered in at minute 19: not given up at minute 20, delivered once when the build ends", async () => {
    const w = world({ rollout: "running" });
    const h = host();
    // Minute 19 of the build: the rollout was last written when the build's tool call began.
    ago(w.rollout, 19 * 60_000, 0);
    const wake = w.start(h.options);
    const reply = w.reply(w.ask(), "Also bump the version.");
    await wake.sweep();
    await until("steered", () => h.calls.length === 1);
    expect(h.calls[0]!.intoTurn).toBe(true);
    // Minute 20: 20 minutes without a rollout write, 1 since the steer, the build still runs.
    w.clock.shift = 60_000;
    ago(w.rollout, 20 * 60_000, w.clock.shift);
    await wake.sweep();
    await wake.sweep();
    // Minute 24, after an Inbox restart: still the one steer.
    wake.stop();
    const second = w.start(h.options);
    w.clock.shift = 5 * 60_000;
    ago(w.rollout, 24 * 60_000, w.clock.shift);
    await second.sweep();
    await second.sweep();
    expect(h.calls).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
    expect(w.queuesOf(reply.id)).toBe(0);
    // Minute 25: the build ends and Codex records the steered text before the model's next request.
    w.clock.shift = 6 * 60_000;
    w.shows(h.calls[0]!.text, "user");
    await second.sweep();
    expect((await until("delivered", () => w.store.message(reply.id)!.delivery)).into_turn).toBe(true);
    await second.sweep();
    expect(h.calls).toHaveLength(1);
    expect(w.queuesOf(reply.id)).toBe(0);
  });

  test("a turn that runs on long past the give-up time is never given up; when it ends without the text, one new turn", async () => {
    const w = world({ rollout: "running" });
    const h = host();
    const wake = w.start(h.options);
    const reply = w.reply(w.ask(), "Lost in a long turn?");
    await wake.sweep();
    await until("steered", () => h.calls.length === 1);
    // 45 minutes on, nothing written, the host says the turn still runs.
    w.clock.shift = 45 * 60_000;
    ago(w.rollout, 45 * 60_000, w.clock.shift);
    await wake.sweep();
    await wake.sweep();
    expect(h.calls).toHaveLength(1);
    // The turn ends without it (Esc): one new turn, never a second steer, and nothing more after a restart.
    h.state.busy = false;
    w.aborted();
    ago(w.rollout, 60_000, w.clock.shift);
    await wake.sweep();
    await until("a new turn", () => h.calls.length === 2);
    expect(h.calls[1]!.intoTurn).toBe(false);
    wake.stop();
    const second = w.start(h.options);
    await second.sweep();
    await second.sweep();
    expect(h.calls).toHaveLength(2);
    expect(w.store.message(reply.id)!.delivery).toBeDefined();
    expect(w.queuesOf(reply.id)).toBe(0);
  });

  test("a reply a turn ended without is never steered again after a restart, even while a new turn runs", async () => {
    const w = world({ rollout: "running" });
    const h = host();
    const first = w.start(h.options);
    const reply = w.reply(w.ask(), "Once into a turn.");
    await first.sweep();
    await until("steered", () => h.calls.length === 1);
    // The Inbox stops right after the steer; the turn ends without the text and a new one starts.
    first.stop();
    w.aborted();
    w.append({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } });
    w.modelStep();
    const second = w.start(h.options);
    await second.sweep();
    await until("a new turn", () => h.calls.length === 2);
    expect(h.calls[1]!.intoTurn).toBe(false);
    await second.sweep();
    expect(h.calls).toHaveLength(2);
    expect(w.store.message(reply.id)!.delivery).toBeDefined();
  });
});

describe("switched on once, then off", () => {
  test("never on: starting and sweeping with the switch off touches nothing of the steering's", async () => {
    const w = world({ switch: "off", rollout: "running", hook: true });
    w.reply(w.ask(), "Plain queue.");
    const touched = await pathsTouched(async () => {
      const wake = w.start();
      await wake.sweep();
      await until("queued", () => w.queues().length === 1);
    });
    expect(touched.filter((path) => /codex-hook|hooked\.json|steered\.json|hook-claim|hooks\.json|steer-on|next-turn/.test(path))).toEqual([]);
  });

  test("on before: what that run left is cleared once at the next start with the switch off; the hook takes nothing", async () => {
    const w = world({ switch: "on", rollout: "running", hook: true });
    const on = w.start();
    const reply = w.reply(w.ask(), "Held, then the switch goes off.");
    await on.sweep();
    await until("held", () => w.held().length === 1);
    on.stop();
    // The hook still in hooks.json with the switch off: it takes nothing, before and after the Inbox starts again.
    writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ experimental: { codexSteer: false } }));
    expect(w.hookRun()).toBe("");
    expect(w.held()).toHaveLength(1);
    const off = w.start();
    expect(w.held()).toHaveLength(0);
    expect(existsSync(join(w.store.dir, "codex-queue", "steer-on"))).toBe(false);
    await off.sweep();
    await until("queued", () => w.queuesOf(reply.id) === 1);
    expect(w.hookRun()).toBe("");
    off.stop();
    // Cleared once: the next start with the switch off does no steering file work at all.
    const touched = await pathsTouched(async () => {
      const again = w.start();
      await again.sweep();
    });
    expect(touched.filter((path) => /codex-hook|hooked\.json|steered\.json|hook-claim|hooks\.json|steer-on|next-turn/.test(path))).toEqual([]);
    expect(w.queuesOf(reply.id)).toBe(1);
  });

  test("the hook takes nothing without the on-mark, or with PLANNOTATOR_EXPERIMENTAL turning it off", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    w.reply(w.ask(), "Mark first.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    const payload = JSON.stringify({ session_id: THREAD, transcript_path: w.rollout, hook_event_name: "PostToolUse" });
    expect(runCodexHook(payload, w.store.dir, Date.now(), { PLANNOTATOR_EXPERIMENTAL: "-codex-steer" })).toBe("");
    const mark = join(w.store.dir, "codex-queue", "steer-on");
    fs.renameSync(mark, `${mark}-away`);
    expect(runCodexHook(payload, w.store.dir, Date.now(), {})).toBe("");
    expect(w.held()).toHaveLength(1);
    fs.renameSync(`${mark}-away`, mark);
    expect(runCodexHook(payload, w.store.dir, Date.now(), {})).not.toBe("");
  });
});

describe("every way a steer cannot happen falls back to the next turn exactly once", () => {
  const settle = async (wake: InboxCodexWake) => {
    for (let i = 0; i < 3; i++) await wake.sweep();
  };

  test("Esc after the hook took it", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Esc case.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.hookRun()).not.toBe("");
    w.aborted();
    w.quiet();
    await settle(wake);
    await until("queued", () => w.queuesOf(reply.id) === 1);
    w.clock.shift = 40 * 60_000;
    await settle(wake);
    expect(w.queuesOf(reply.id)).toBe(1);
  });

  test("Codex crashed after the hook took it, and the Inbox restarted meanwhile", async () => {
    const w = world({ rollout: "running", hook: true });
    const first = w.start();
    const reply = w.reply(w.ask(), "Crash case.");
    await first.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.hookRun()).not.toBe("");
    first.stop();
    w.clock.shift = 21 * 60_000;
    w.stale();
    const second = w.start();
    await settle(second);
    await until("queued", () => w.queuesOf(reply.id) === 1);
    second.stop();
    const third = w.start();
    await settle(third);
    expect(w.queuesOf(reply.id)).toBe(1);
  });

  test("two replies the turn ended without", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const asked = w.ask();
    const one = w.reply(asked, "First of two.");
    const two = w.reply(asked, "Second of two.");
    await wake.sweep();
    await until("both held", () => w.held().length === 2);
    expect(w.contextOf(w.hookRun()).additionalContext).toContain("Second of two.");
    w.aborted();
    w.quiet();
    await settle(wake);
    await until("both queued", () => w.queuesOf(one.id) === 1 && w.queuesOf(two.id) === 1);
    await settle(wake);
    expect([w.queuesOf(one.id), w.queuesOf(two.id)]).toEqual([1, 1]);
  });

  test("the size cap", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), `Long:\n${"word ".repeat(3_000)}`);
    await settle(wake);
    await until("queued", () => w.queuesOf(reply.id) === 1);
    w.turn("idle");
    await settle(wake);
    expect(w.queuesOf(reply.id)).toBe(1);
    expect(w.held()).toHaveLength(0);
  });

  test("only a sub-thread's tool calls came, then the turn ended", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Sub-thread case.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    expect(w.hookRun({ agent_id: "sub-1" })).toBe("");
    expect(w.hookRun({ transcript_path: w.subRollout })).toBe("");
    w.turn("idle");
    await settle(wake);
    await until("queued", () => w.queuesOf(reply.id) === 1);
    await settle(wake);
    expect(w.queuesOf(reply.id)).toBe(1);
    expect(w.hookRun()).toBe("");
  });

  test("a hook Codex has not run (not reviewed)", async () => {
    const w = world({ rollout: "running", hook: true, reviewed: false });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Unreviewed case.");
    await settle(wake);
    await until("queued", () => w.queuesOf(reply.id) === 1);
    w.turn("idle");
    await settle(wake);
    expect(w.queuesOf(reply.id)).toBe(1);
    expect(w.held()).toHaveLength(0);
  });

  test("Codex runs with another CODEX_HOME than the Inbox reads", async () => {
    const w = world({ rollout: "running", hook: true });
    const elsewhere = join(w.dataDir, "..", "other-codex-home");
    mkdirSync(elsewhere, { recursive: true });
    const wake = w.start({}, elsewhere);
    const reply = w.reply(w.ask(), "Other home case.");
    await settle(wake);
    await until("queued", () => w.queuesOf(reply.id) === 1);
    w.turn("idle");
    await settle(wake);
    expect(w.queuesOf(reply.id)).toBe(1);
    expect(w.held()).toHaveLength(0);
  });
});

describe("a reply the hook took reads handed on at once, never only after the next line or a restart", () => {
  /** The hook part way through a take: its claim made, maybe its mark; `finish` writes the rest as the hook does. */
  const partTaken = (w: ReturnType<typeof world>, id: string, mark: boolean) => {
    const claim = codexHookClaimDir(w.store.dir, id, THREAD);
    mkdirSync(claim, { recursive: true });
    if (mark) writeFileSync(join(claim, CODEX_HOOK_CLAIM_MARK), "");
    return () => {
      if (!mark) writeFileSync(join(claim, CODEX_HOOK_CLAIM_MARK), "");
      writeFileSync(join(claim, "hooked.json"), `${JSON.stringify({ at: Date.now(), sight: null })}\n`);
    };
  };

  test("the hook between its mkdir and its mark when the Inbox looks: picked up by the next look by itself", async () => {
    const w = world({ rollout: "running", hook: true });
    const wake = w.start();
    const reply = w.reply(w.ask(), "Mid-take.");
    await wake.sweep();
    await until("held", () => w.held().length === 1);
    const finish = partTaken(w, reply.id, false);
    await wake.sweep();
    finish();
    // No sweep from here: only the wake's own looks.
    await until("delivered by the wake's own look", () => w.store.message(reply.id)!.delivery, 8_000);
    expect(w.queuesOf(reply.id)).toBe(0);
  }, 15_000);

  test("an Inbox restart while the hook finishes its take: picked up by the next look by itself", async () => {
    const w = world({ rollout: "running", hook: true });
    const first = w.start();
    const reply = w.reply(w.ask(), "Restart mid-take.");
    await first.sweep();
    await until("held", () => w.held().length === 1);
    first.stop();
    const finish = partTaken(w, reply.id, true);
    const second = w.start();
    await second.sweep();
    finish();
    await until("delivered by the wake's own look", () => w.store.message(reply.id)!.delivery, 8_000);
    expect(w.queuesOf(reply.id)).toBe(0);
  }, 15_000);
});
