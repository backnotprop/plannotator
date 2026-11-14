/**
 * A Codex thread T3 Code runs (its rollout's originator is T3's): the
 * person's reply goes into the T3 thread through T3's own `t3` command, never
 * `codex queue` (T3 runs a turn Codex starts by itself out of sight, so the
 * agent would answer from a turn the person never sees, and a second item
 * sat on "Handed to …" for good). The Codex wake against a fake `codex` and
 * a fake T3 home (tests/helpers/fake-t3.ts), with a store in a temp folder.
 * No Inbox server, no Codex and no T3 run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxAuthor, InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { makeFakeT3Home } from "../../tests/helpers/fake-t3";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createCodexT3Route } from "./inbox-codex-t3";
import { codexQueueMessage, createInboxCodexWake, type InboxCodexWake } from "./inbox-codex-wake";

const IN_T3 = "019a7c00-0000-7000-8000-0000000000a1";
const PLAIN = "019a7c00-0000-7000-8000-0000000000b2";
const T3_THREAD = "thread:project:5b1d2c3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e:7c6d5e4f-3a2b-4c1d-9e0f-1a2b3c4d5e6f";

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

function world(options: { t3Home?: boolean } = {}) {
  const agents = createFakeAgents("plannotator-codex-t3-");
  cleanup.push(() => agents.remove());
  agents.install("codex");
  writeRollout(agents, IN_T3, "T3 Code");
  writeRollout(agents, PLAIN, "codex_vscode");
  const t3 = options.t3Home === false ? null : makeFakeT3Home(agents.home, { [IN_T3]: T3_THREAD });
  const dataDir = join(agents.root, "data");
  const store = InboxStore.open(join(dataDir, "inbox"));
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: agents.home, env: agents.env });
  const clock = { now: Date.now() };
  const wakes: InboxCodexWake[] = [];
  cleanup.push(() => {
    for (const wake of wakes) wake.stop();
  });
  const start = () => {
    const wake = createInboxCodexWake({ store, environment, commandOf, t3: createCodexT3Route({ environment, now: () => clock.now, sendTimeoutMs: 1_500 }), extraClis: [], now: () => clock.now, log: () => {} });
    wakes.push(wake);
    return wake;
  };
  const author = (session: string, name: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host: "codex", session, name });
  const ask = (session: string, name: string) => store.sendMessage({ project_id: project.id, author: author(session, name), body: "Ship the worker today?", wakes: true }).message;
  const reply = (asked: InboxMessage, words: string, key: string) => store.sendReply(asked.id, { words, idempotency_key: key }).reply!;
  const queues = () => agents.calls().filter((call) => call.name === "codex" && call.args[0] === "queue");
  return { agents, t3, store, clock, start, ask, reply, queues };
}

const meta = (thread: string) => ({ threadId: thread, "x-codex-turn-metadata": { thread_id: thread, turn_trigger: "user", turn_started_at_unix_ms: Date.now() } });

describe("a Codex thread T3 Code runs", () => {
  test("the reply goes into the T3 thread once, never through codex queue (no answer from a turn T3 hides)", async () => {
    const w = world();
    const wake = w.start();
    expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(true);
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();

    expect(w.queues()).toEqual([]);
    const text = codexQueueMessage(commandOf(w.store.message(reply.id)!));
    expect(w.t3!.calls()).toEqual([["thread", "send", T3_THREAD, text, "--json"]]);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ state: "delivered", host: "codex", session: IN_T3 });

    // Once, across a restart too.
    wake.stop();
    await w.start().sweep();
    expect(w.t3!.calls()).toHaveLength(1);
    expect(w.queues()).toEqual([]);
  });

  test("a second reply is a second T3 turn and never sits on Handed", async () => {
    const w = world();
    const wake = w.start();
    const asked = w.ask(IN_T3, "Codex from T3");
    w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    const again = w.ask(IN_T3, "Codex from T3");
    const second = w.reply(again, "In T3, reply back saying done.", "k2");
    await wake.sweep();
    expect(w.t3!.calls()).toHaveLength(2);
    expect(w.store.message(second.id)?.delivery?.state).toBe("delivered");
    expect(w.store.handover.handedTo(IN_T3)).toEqual([]);
    expect(w.queues()).toEqual([]);
  });

  test("T3 not running: nothing is sent, the reply says why (not Handed), and it goes in once T3 is up", async () => {
    const w = world();
    w.t3!.setState("down");
    const wake = w.start();
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery ?? null).toBeNull();
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
    expect(w.store.handover.handedTo(IN_T3)).toEqual([]);
    expect(w.store.handover.holder(w.store.message(reply.id)!)).toBeNull();
    expect(w.queues()).toEqual([]);

    w.t3!.setState("up");
    w.clock.now += 61_000;
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ host: "codex", session: IN_T3 });
    expect("t3_wait" in w.store.message(reply.id)!).toBe(false);
    expect(w.t3!.calls().filter((call) => call[1] === "send")).toHaveLength(2);
  });

  test("no T3 here (no launcher, no state): not promised a wake, and never queued", async () => {
    const w = world({ t3Home: false });
    const wake = w.start();
    expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(false);
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.queues()).toEqual([]);
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
  });

  test("a send that does not answer is never sent again: saved for the agent's next read", async () => {
    const w = world();
    w.t3!.setState("hang");
    const wake = w.start();
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    w.t3!.setState("up");
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    wake.stop();
    const after = w.start();
    await after.sweep();
    expect(after.uncertain(IN_T3, reply.id)).toBe(true);
    expect(w.t3!.calls()).toHaveLength(1);
  });

  test("a reply codex queue already took before (the stuck Handed line) reads as saved, and is not sent twice", async () => {
    const w = world();
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    // As an earlier Inbox left it: queued with `codex queue`, waiting for a turn T3 never shows.
    const claim = join(w.store.dir, "codex-queue", `${reply.id}.${IN_T3}`);
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "queued.json"), `${JSON.stringify({ at: Date.now() - 60_000 })}\n`);
    const wake = w.start();
    await wake.sweep();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    expect(JSON.parse(readFileSync(join(claim, "queued.json"), "utf8")).uncertain).toBe(true);
    expect(w.t3!.calls()).toEqual([]);
    expect(w.queues()).toEqual([]);
  });

  test("T3 no longer has the thread: the session ends, the reply waits for the next agent, nothing is retried", async () => {
    const w = world();
    w.t3!.setState("gone");
    const wake = w.start();
    const asked = w.ask(IN_T3, "Codex from T3");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.status(IN_T3)).toBe("dead");
    expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    expect(w.t3!.calls()).toHaveLength(1);
    expect(w.queues()).toEqual([]);
  });
});

describe("a Codex thread T3 does not run", () => {
  test("is woken through codex queue exactly as before, and T3 is never asked", async () => {
    const w = world();
    const wake = w.start();
    expect(await wake.wakes("codex", PLAIN, meta(PLAIN))).toBe(true);
    const asked = w.ask(PLAIN, "Codex");
    const reply = w.reply(asked, "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();
    const text = codexQueueMessage(commandOf(w.store.message(reply.id)!));
    expect(w.queues().map((call) => call.args)).toEqual([["queue", `--thread=${PLAIN}`, `--message=${text}`]]);
    expect(w.t3!.calls()).toEqual([]);
    expect(w.store.message(reply.id)?.delivery ?? null).toBeNull();
    expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
    // Queued, not delivered: delivered at the thread's next turn, as before.
    wake.noteToolCall(PLAIN, w.clock.now + 1_000);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ host: "codex", session: PLAIN });
  });
});
