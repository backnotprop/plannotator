/**
 * T3 Code on this machine: a reply to a T3 thread goes in through T3's own
 * `t3 thread send`, with no sign-in, for a Claude thread (the T3 wake) and a
 * Codex thread (the Codex wake, which never uses `codex queue` for a thread T3
 * runs: T3 runs a turn Codex starts by itself out of sight). One claim per
 * reply across the ways it can go (the Claude Code mod, `t3 thread send`, a
 * saved grant): a send that may have gone is never sent again, one T3 refused
 * outright leaves the reply to the next way. A closed T3 is looked for every
 * few seconds, and the reply goes in once it runs.
 *
 * The wakes against a fake `codex`, a fake T3 home and a scripted T3 MCP
 * (tests/helpers/fake-t3.ts), with a store in a temp folder. No Inbox server,
 * no Codex and no T3 run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxAuthor, InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { T3Credentials } from "@plannotator/t3-code/auth";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { type FakeT3, makeFakeT3Home, startFakeT3 } from "../../tests/helpers/fake-t3";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { codexQueueMessage, createInboxCodexWake, type InboxCodexWake } from "./inbox-codex-wake";
import { createT3Local, t3ThreadOfCodexThread, type T3Local } from "./inbox-t3-local";
import { createInboxT3Wake, type InboxT3Wake } from "./inbox-t3-wake";

const IN_T3 = "019a7c00-0000-7000-8000-0000000000a1";
const PLAIN = "019a7c00-0000-7000-8000-0000000000b2";
/** As T3 0.1.9 names a thread its app made, and one `t3 thread start` made (REAL-T3-PROOF). */
const T3_THREAD = "thread:project:5b1d2c3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e:7c6d5e4f-3a2b-4c1d-9e0f-1a2b3c4d5e6f";
const CLAUDE_T3 = "mcp:9843db4f-69c2-4891-9a2b-de6f0afaed58";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const commandOf = (item: InboxMessage): InboxReplyCommand => ({ type: "reply", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: null, body: item.body, url: "http://127.0.0.1/#thread" });

/** A Codex rollout's first line, as Codex writes it: T3's app-server names itself "T3 Code". */
function writeRollout(agents: FakeAgents, thread: string, originator: string) {
  const folder = join(agents.env.CODEX_HOME!, "sessions", "2026", "11", "14");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `rollout-2026-11-14T10-00-00-${thread}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: thread, source: "vscode", originator, cwd: "/work/ledger" } })}\n`);
}

async function until(done: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await Bun.sleep(10);
  return done();
}

function world(options: { t3Home?: boolean; schema?: "0.1.9" | "unknown" } = {}) {
  const agents = createFakeAgents("plannotator-t3-local-");
  cleanup.push(() => agents.remove());
  agents.install("codex");
  writeRollout(agents, IN_T3, "T3 Code");
  writeRollout(agents, PLAIN, "codex_vscode");
  const t3 = options.t3Home === false ? null : makeFakeT3Home(agents.home, { [IN_T3]: T3_THREAD }, { t3Threads: [CLAUDE_T3], ...(options.schema ? { schema: options.schema } : {}) });
  const dataDir = join(agents.root, "data");
  const store = InboxStore.open(join(dataDir, "inbox"));
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: agents.home, env: agents.env });
  const clock = { now: Date.now() };
  const stops: { stop(): void }[] = [];
  cleanup.push(() => {
    for (const one of stops) one.stop();
  });
  const local = (): T3Local => {
    const made = createT3Local({ environment, now: () => clock.now, sendTimeoutMs: 1_500, probeMs: 25 });
    stops.push(made);
    return made;
  };
  const startCodex = (): InboxCodexWake => {
    const wake = createInboxCodexWake({ store, environment, commandOf, t3: local(), extraClis: [], now: () => clock.now, log: () => {} });
    stops.push(wake);
    return wake;
  };
  const startT3 = (options: { skip?: (item: InboxMessage, session: string) => boolean; local?: boolean } = {}): InboxT3Wake => {
    const wake = createInboxT3Wake({ store, dataDir, commandOf, ...(options.local === false ? {} : { local: local() }), now: () => clock.now, log: () => {}, ...(options.skip ? { skip: options.skip } : {}) });
    stops.push(wake);
    return wake;
  };
  /** A grant `plannotator t3 login` saved, for a scripted T3 that has `threads`. */
  const grant = (threads: string[]): FakeT3 => {
    const mcp = startFakeT3({ threads });
    cleanup.push(() => mcp.stop());
    new T3Credentials(dataDir, mcp.endpoint).save({ endpoint: mcp.endpoint.href, epoch: "e1", tokens: { access_token: mcp.state.token, token_type: "Bearer" } });
    return mcp;
  };
  const author = (host: string, session: string, name: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host, session, name });
  const ask = (session: string, name: string, host = "codex") => store.sendMessage({ project_id: project.id, author: author(host, session, name), body: "Ship the worker today?", wakes: true }).message;
  const reply = (asked: InboxMessage, words: string, key: string) => store.sendReply(asked.id, { words, idempotency_key: key }).reply!;
  const queues = () => agents.calls().filter((call) => call.name === "codex" && call.args[0] === "queue");
  const textOf = (id: string) => codexQueueMessage(commandOf(store.message(id)!));
  const sendClaims = () => (existsSync(join(store.dir, "t3-send")) ? readdirSync(join(store.dir, "t3-send")) : []);
  return { agents, t3, store, clock, startCodex, startT3, grant, ask, reply, queues, textOf, sendClaims };
}

const meta = (thread: string) => ({ threadId: thread, "x-codex-turn-metadata": { thread_id: thread, turn_trigger: "user", turn_started_at_unix_ms: Date.now() } });

describe("a Codex thread T3 Code runs", () => {
  test("the reply goes into the T3 thread once, never through codex queue (no answer from a turn T3 hides)", async () => {
    const w = world();
    const wake = w.startCodex();
    expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(true);
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();

    expect(w.queues()).toEqual([]);
    expect(w.t3!.sends()).toEqual([["thread", "send", T3_THREAD, w.textOf(reply.id), "--json"]]);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ state: "delivered", host: "codex", session: IN_T3 });

    // Once, across a restart too.
    wake.stop();
    await w.startCodex().sweep();
    expect(w.t3!.sends()).toHaveLength(1);
    expect(w.queues()).toEqual([]);
  });

  test("a second reply is a second T3 turn and never sits on Handed", async () => {
    const w = world();
    const wake = w.startCodex();
    const asked = w.ask(IN_T3, "Codex from T3");
    w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    const again = w.ask(IN_T3, "Codex from T3");
    const second = w.reply(again, "In T3, reply back saying done.", "k2");
    await wake.sweep();
    expect(w.t3!.sends()).toHaveLength(2);
    expect(w.store.message(second.id)?.delivery?.state).toBe("delivered");
    expect(w.store.handover.handedTo(IN_T3)).toEqual([]);
    expect(w.queues()).toEqual([]);
  });

  test("T3 closed: nothing is run, the reply says why (not Handed), and it goes in within seconds of T3 starting", async () => {
    const w = world();
    w.t3!.setState("down");
    const wake = w.startCodex();
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery ?? null).toBeNull();
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
    expect(w.store.handover.holder(w.store.message(reply.id)!)).toBeNull();
    expect(w.t3!.calls()).toEqual([]);
    expect(w.queues()).toEqual([]);

    // No clock moves: the runtime file T3 writes when it starts is what sends it.
    w.t3!.setState("up");
    expect(await until(() => w.store.message(reply.id)?.delivery?.state === "delivered")).toBe(true);
    expect("t3_wait" in w.store.message(reply.id)!).toBe(false);
    expect(w.t3!.sends()).toHaveLength(1);
  });

  test("T3 running but not answering is tried again on the backoff, not every few seconds", async () => {
    const w = world();
    w.t3!.setState("stale");
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    await Bun.sleep(150);
    await wake.sweep();
    expect(w.t3!.sends()).toHaveLength(1);
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
    w.t3!.setState("up");
    w.clock.now += 31_000;
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(w.t3!.sends()).toHaveLength(2);
  });

  test("no T3 here (no launcher, no state): not promised a wake, and never queued", async () => {
    const w = world({ t3Home: false });
    const wake = w.startCodex();
    expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(false);
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.queues()).toEqual([]);
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
  });

  test("T3's state in a shape this build does not know names no thread: nothing is sent, the reply waits", async () => {
    const w = world({ schema: "unknown" });
    expect(await t3ThreadOfCodexThread(w.t3!.dir, IN_T3)).toBeNull();
    const wake = w.startCodex();
    expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(false);
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.t3!.sends()).toEqual([]);
    expect(w.queues()).toEqual([]);
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
  });

  test("a send that does not answer is never sent again: saved for the agent's next read", async () => {
    const w = world();
    w.t3!.setState("hang");
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    w.t3!.setState("up");
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    wake.stop();
    const after = w.startCodex();
    await after.sweep();
    expect(after.uncertain(IN_T3, reply.id)).toBe(true);
    expect(w.t3!.sends()).toHaveLength(1);
  });

  test("a reply codex queue already took before (the stuck Handed line) reads as saved, and is not sent twice", async () => {
    const w = world();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    // As an earlier Inbox left it: queued with `codex queue`, waiting for a turn T3 never shows.
    const claim = join(w.store.dir, "codex-queue", `${reply.id}.${IN_T3}`);
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "queued.json"), `${JSON.stringify({ at: Date.now() - 60_000 })}\n`);
    const wake = w.startCodex();
    await wake.sweep();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    expect(JSON.parse(readFileSync(join(claim, "queued.json"), "utf8")).uncertain).toBe(true);
    expect(w.t3!.calls()).toEqual([]);
    expect(w.queues()).toEqual([]);
  });

  test("T3 no longer has the thread: the session ends, the reply waits for the next agent, nothing is retried", async () => {
    const w = world();
    w.t3!.setState("gone");
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.status(IN_T3)).toBe("dead");
    expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    expect(w.t3!.sends()).toHaveLength(1);
    expect(w.queues()).toEqual([]);
  });
});

describe("a Codex thread T3 does not run", () => {
  test("is woken through codex queue exactly as before, and T3 is never asked", async () => {
    const w = world();
    const wake = w.startCodex();
    expect(await wake.wakes("codex", PLAIN, meta(PLAIN))).toBe(true);
    const reply = w.reply(w.ask(PLAIN, "Codex"), "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();
    expect(w.queues().map((call) => call.args)).toEqual([["queue", `--thread=${PLAIN}`, `--message=${w.textOf(reply.id)}`]]);
    expect(w.t3!.calls()).toEqual([]);
    expect(w.store.message(reply.id)?.delivery ?? null).toBeNull();
    expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
    // Queued, not delivered: delivered at the thread's next turn, as before.
    wake.noteToolCall(PLAIN, w.clock.now + 1_000);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ host: "codex", session: PLAIN });
  });
});

describe("a Claude thread in T3 Code", () => {
  test("wakes with no sign-in: the reply goes in once through t3 thread send, across a restart too", async () => {
    const w = world();
    const wake = w.startT3();
    expect(await wake.wakes("t3", CLAUDE_T3)).toBe(true);
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();
    expect(w.t3!.sends()).toEqual([["thread", "send", CLAUDE_T3, w.textOf(reply.id), "--json"]]);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ state: "delivered", host: "t3", session: CLAUDE_T3 });
    expect(wake.status(CLAUDE_T3)).toBe("alive");
    wake.stop();
    await w.startT3().sweep();
    expect(w.t3!.sends()).toHaveLength(1);
    // Its claim is done with once the reply is delivered.
    expect(w.sendClaims()).toEqual([]);
  });

  test("while the Claude Code mod polls as the thread, T3 is never sent to (one owner per reply)", async () => {
    const w = world();
    const wake = w.startT3({ skip: () => true });
    w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.t3!.calls().filter((call) => call[1] === "send")).toEqual([]);
  });

  test("a send T3 may have taken is saved, kept from the mod, and sent again by no way: not t3, not a grant, not after a restart", async () => {
    const w = world();
    const mcp = w.grant([CLAUDE_T3]);
    w.t3!.setState("hang");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.uncertain(CLAUDE_T3, reply.id)).toBe(true);
    // The bridge never hands the mod what the T3 wake holds.
    expect(w.store.handover.handedTo(CLAUDE_T3)).toEqual([reply.id]);
    w.t3!.setState("up");
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    wake.stop();
    const after = w.startT3();
    await after.sweep();
    expect(after.uncertain(CLAUDE_T3, reply.id)).toBe(true);
    expect(w.store.handover.handedTo(CLAUDE_T3)).toEqual([reply.id]);
    expect(w.t3!.sends()).toHaveLength(1);
    expect(mcp.sendCalls).toBe(0);
    expect(w.store.message(reply.id)?.delivery ?? null).toBeNull();
  });

  test("T3 here refused it outright: the claim goes, and a saved grant sends it, once", async () => {
    const w = world();
    const mcp = w.grant([CLAUDE_T3]);
    w.t3!.setState("gone");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();
    expect(w.t3!.sends()).toHaveLength(1);
    expect(mcp.turns.map((turn) => turn.clientRequestId)).toEqual([`plannotator-inbox-${reply.id}`]);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ host: "t3", session: CLAUDE_T3 });
    expect(w.sendClaims()).toEqual([]);
  });

  test("T3 here running but not answering, with a grant: the grant sends it in the same sweep, once", async () => {
    const w = world();
    const mcp = w.grant([CLAUDE_T3]);
    w.t3!.setState("stale");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.t3!.sends()).toHaveLength(1);
    expect(mcp.turns).toHaveLength(1);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ host: "t3", session: CLAUDE_T3 });
  });

  test("T3 closed, no sign-in: the reply waits on T3 (not on a sign-in), and goes in within seconds of T3 starting", async () => {
    const w = world();
    w.t3!.setState("down");
    const wake = w.startT3();
    expect(await wake.wakes("t3", CLAUDE_T3)).toBe(false);
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
    expect(w.store.handover.holder(w.store.message(reply.id)!)).toBeNull();
    expect(w.t3!.calls()).toEqual([]);
    w.t3!.setState("up");
    expect(await until(() => w.store.message(reply.id)?.delivery?.state === "delivered")).toBe(true);
    expect("t3_wait" in w.store.message(reply.id)!).toBe(false);
    expect(w.t3!.sends()).toHaveLength(1);
  });

  test("T3 here gone and no grant: the thread is ended, the reply waits for the next agent, nothing is retried", async () => {
    const w = world();
    w.t3!.setState("gone");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.gone(CLAUDE_T3)).toBe(true);
    expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    expect(w.t3!.sends()).toHaveLength(1);
  });

  test("another failure releases the claim and is tried again on the backoff", async () => {
    const w = world();
    w.t3!.setState("fail");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.sendClaims()).toEqual([]);
    expect(w.store.handover.holder(w.store.message(reply.id)!)).toBeNull();
    await wake.sweep();
    expect(w.t3!.sends()).toHaveLength(1);
    w.t3!.setState("up");
    w.clock.now += 31_000;
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(w.t3!.sends()).toHaveLength(2);
  });

  test("no T3 on this machine: the sign-in wait, exactly as before", async () => {
    const w = world({ t3Home: false });
    const wake = w.startT3();
    expect(await wake.wakes("t3", CLAUDE_T3)).toBe(false);
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.store.message(reply.id)?.t3_wait).toBe("sign_in");
  });
});
