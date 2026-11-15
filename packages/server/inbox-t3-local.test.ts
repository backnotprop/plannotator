/**
 * T3 Code on this machine: a reply to a T3 thread goes in through T3's own
 * `t3 thread send`, with no sign-in, for a Claude thread (the T3 wake) and a
 * Codex thread (the Codex wake, which never uses `codex queue` for a thread T3
 * runs: T3 runs a turn Codex starts by itself out of sight).
 *
 * Always wakes, never twice. One claim per reply across the ways it can go (the
 * Claude Code mod, `t3 thread send`, a saved grant), made before the send and
 * kept until T3 says it went or the thread, read back, shows whether it did. A
 * closed T3 is looked for every few seconds, and the reply goes in once it runs.
 *
 * The wakes against a fake `codex`, a fake T3 home and a scripted T3 MCP
 * (tests/helpers/fake-t3.ts), with a store in a temp folder. No Inbox server,
 * no Codex and no T3 run.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxAuthor, InboxMessage } from "@plannotator/core/inbox-types";
import { inboxModClaimDir } from "@plannotator/shared/inbox/claims";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { T3Credentials } from "@plannotator/t3-code/auth";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { type FakeT3, makeFakeT3Home, startFakeT3 } from "../../tests/helpers/fake-t3";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { codexQueueMessage, createInboxCodexWake, type InboxCodexWake } from "./inbox-codex-wake";
import { createT3Claims, createT3Local, t3ReadBackOf, t3ThreadOfCodexThread, type T3Local, type T3Route } from "./inbox-t3-local";
import { createInboxT3Wake, createT3ModOwner, type InboxT3Wake } from "./inbox-t3-wake";

const IN_T3 = "019a7c00-0000-7000-8000-0000000000a1";
const PLAIN = "019a7c00-0000-7000-8000-0000000000b2";
/** As T3 0.1.9 names a thread its app made, and one `t3 thread start` made (REAL-T3-PROOF). */
const T3_THREAD = "thread:project:5b1d2c3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e:7c6d5e4f-3a2b-4c1d-9e0f-1a2b3c4d5e6f";
const CLAUDE_T3 = "mcp:9843db4f-69c2-4891-9a2b-de6f0afaed58";
const SEND = ["thread", "send"];

// A send that hangs waits out the command's time limit (`sendTimeoutMs` below), once or twice in a test.
setDefaultTimeout(20_000);

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

function world(options: { t3Home?: boolean; schema?: "0.1.9" | "unknown"; codexThreads?: Record<string, string>; platform?: NodeJS.Platform; env?: Record<string, string> } = {}) {
  const agents = createFakeAgents("plannotator-t3-local-");
  cleanup.push(() => agents.remove());
  agents.install("codex");
  writeRollout(agents, IN_T3, "T3 Code");
  writeRollout(agents, PLAIN, "codex_vscode");
  const t3 = options.t3Home === false ? null : makeFakeT3Home(agents.home, options.codexThreads ?? { [IN_T3]: T3_THREAD }, { t3Threads: [CLAUDE_T3, T3_THREAD], ...(options.schema ? { schema: options.schema } : {}) });
  const dataDir = join(agents.root, "data");
  const store = InboxStore.open(join(dataDir, "inbox"));
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const environment = createAgentEnvironmentFor({ platform: options.platform ?? process.platform, homeDir: agents.home, env: { ...agents.env, ...options.env } });
  const clock = { now: Date.now() };
  /** What each wake told the debug log (`t3_route`). */
  const routes: T3Route[] = [];
  const route = (one: T3Route) => void routes.push(one);
  const stops: { stop(): void }[] = [];
  cleanup.push(() => {
    for (const one of stops) one.stop();
  });
  const local = (): T3Local => {
    // Long enough for a loaded machine to start the fake command; the hanging states wait it out.
    const made = createT3Local({ environment, now: () => clock.now, sendTimeoutMs: 3_000, probeMs: 25 });
    stops.push(made);
    return made;
  };
  const startCodex = (): InboxCodexWake => {
    const wake = createInboxCodexWake({ store, environment, commandOf, t3: local(), extraClis: [], now: () => clock.now, log: () => {}, route });
    stops.push(wake);
    return wake;
  };
  const startT3 = (o: { skip?: (item: InboxMessage, session: string) => boolean; local?: T3Local } = {}): InboxT3Wake => {
    const wake = createInboxT3Wake({ store, dataDir, commandOf, local: o.local ?? local(), now: () => clock.now, log: () => {}, route, ...(o.skip ? { skip: o.skip } : {}) });
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
  const sends = () => t3?.sends() ?? [];
  /** The replies T3 holds as turns, by reply id, in order. */
  const turnsOf = (thread: string) => (t3?.turns() ?? []).filter(([at]) => at === thread).map(([, text]) => /\((msg_[^)]+)\)$/.exec(text.split("\n", 1)[0]!)?.[1] ?? text);
  const claimsIn = (folder: string) => (existsSync(join(store.dir, folder)) ? readdirSync(join(store.dir, folder)) : []);
  return { agents, t3, store, dataDir, environment, clock, routes, local, startCodex, startT3, grant, ask, reply, queues, textOf, sends, turnsOf, claimsIn };
}

const meta = (thread: string) => ({ threadId: thread, "x-codex-turn-metadata": { thread_id: thread, turn_trigger: "user", turn_started_at_unix_ms: Date.now() } });

describe("the read-back", () => {
  test("a reply is present only as a user message whose first line names its id; a full page is not known", () => {
    const at = (texts: string[], role = "user") => JSON.stringify({ messages: texts.map((text) => ({ role, text })) });
    expect(t3ReadBackOf(at(["Plannotator Inbox: a reply (msg_1)\nwords"]), "msg_1")).toBe("present");
    expect(t3ReadBackOf(at(["Plannotator Inbox: a reply (msg_1)"], "assistant"), "msg_1")).toBe("absent");
    expect(t3ReadBackOf(at(["Plannotator Inbox: a reply (msg_12)"]), "msg_1")).toBe("absent");
    expect(t3ReadBackOf(at(["about (msg_1) later\nPlannotator Inbox: x (msg_1)"]), "msg_1")).toBe("absent");
    expect(t3ReadBackOf(at(["Plannotator Inbox: x (msg_1)  \nmore"]), "msg_1")).toBe("present");
    expect(t3ReadBackOf(at(Array.from({ length: 50 }, () => "other")), "msg_1")).toBe("unknown");
    expect(t3ReadBackOf("{not json", "msg_1")).toBe("unknown");
  });
});

describe("a Codex thread T3 Code runs", () => {
  test("the reply goes into the T3 thread once, on stdin, never through codex queue", async () => {
    const w = world();
    const wake = w.startCodex();
    expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(true);
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();
    expect(w.queues()).toEqual([]);
    expect(w.sends()).toEqual([[...SEND, T3_THREAD, "-", "--json"]]);
    expect(w.t3!.turns()).toEqual([[T3_THREAD, w.textOf(reply.id)]]);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ state: "delivered", host: "codex", session: IN_T3 });
    wake.stop();
    await w.startCodex().sweep();
    expect(w.sends()).toHaveLength(1);
    expect(w.claimsIn("t3-send-codex")).toEqual([]);
  });

  test("a second reply is a second T3 turn and never sits on Handed", async () => {
    const w = world();
    const wake = w.startCodex();
    w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    const second = w.reply(w.ask(IN_T3, "Codex from T3"), "In T3, reply back saying done.", "k2");
    await wake.sweep();
    expect(w.sends()).toHaveLength(2);
    expect(w.store.message(second.id)?.delivery?.state).toBe("delivered");
    expect(w.store.handover.handedTo(IN_T3)).toEqual([]);
  });

  test("T3 closed: nothing is run, the reply says so, and it goes in within seconds of T3 starting", async () => {
    const w = world();
    w.t3!.setState("down");
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
    expect(w.store.handover.holder(w.store.message(reply.id)!)).toBeNull();
    expect(w.t3!.calls()).toEqual([]);
    // No clock moves: the runtime file T3 writes when it starts is what sends it.
    w.t3!.setState("up");
    expect(await until(() => w.store.message(reply.id)?.delivery?.state === "delivered")).toBe(true);
    expect("t3_wait" in w.store.message(reply.id)!).toBe(false);
    expect(w.sends()).toHaveLength(1);
  });

  test("the debug log gets one line when a reply starts to wait on T3 and one when it goes, by id, never its words", async () => {
    const w = world();
    w.t3!.setState("down");
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();
    w.t3!.setState("up");
    expect(await until(() => w.store.message(reply.id)?.delivery?.state === "delivered")).toBe(true);
    const ids = { agent: "codex", thread: reply.thread_id, reply: reply.id };
    expect(w.routes).toEqual([{ route: "waiting", ...ids, reason: "closed" }, { route: "t3_send", ...ids }]);
    expect(JSON.stringify(w.routes)).not.toContain("ship it");
  });

  test("T3 open but its thread not found yet: never 'Open T3'; saved, looked up again, and sent once the row is there", async () => {
    const w = world({ codexThreads: {} });
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    expect(w.sends()).toEqual([]);
    // T3 writes the row a moment later.
    const db = new Database(join(w.t3!.dir, "userdata", "statev2.sqlite"));
    const payload = { driver: "codex", nativeThreadRef: { driver: "codex", nativeId: IN_T3, strength: "strong" } };
    db.query(`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('p1', ?, NULL, 'codex', 'codex', 'codex', NULL, 'idle', 1, 1, 'now', ?)`).run(T3_THREAD, JSON.stringify(payload));
    db.close();
    w.clock.now += 6_000;
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(wake.uncertain(IN_T3, reply.id)).toBe(false);
  });

  test("no T3 here, or Windows: saved for the agent's next read, never 'Open T3', not promised, never queued", async () => {
    for (const w of [world({ t3Home: false }), world({ platform: "win32" })]) {
      const wake = w.startCodex();
      expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(false);
      const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
      await wake.sweep();
      expect(w.queues()).toEqual([]);
      expect(w.sends()).toEqual([]);
      expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
      expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    }
  });

  test("T3's state in a shape this build does not know names no thread: nothing is sent, the reply is saved", async () => {
    const w = world({ schema: "unknown" });
    expect(await t3ThreadOfCodexThread(w.t3!.dir, IN_T3)).toBeNull();
    const wake = w.startCodex();
    expect(await wake.wakes("codex", IN_T3, meta(IN_T3))).toBe(false);
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.sends()).toEqual([]);
    expect(w.store.message(reply.id)?.t3_wait ?? null).toBeNull();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
  });

  test("a send T3 took and then failed on (a connection cut): read back, delivered, never sent twice", async () => {
    const w = world();
    w.t3!.setState("taken-then-fail");
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    w.t3!.setState("up");
    w.clock.now += 6_000;
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(w.sends()).toHaveLength(1);
    expect(w.turnsOf(T3_THREAD)).toEqual([reply.id]);
  });

  test("a send that never answered and that T3 did not take: read back, then sent again, once: the agent wakes", async () => {
    const w = world();
    w.t3!.setState("hang");
    const wake = w.startCodex();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.uncertain(IN_T3, reply.id)).toBe(true);
    // Across a restart too: the claim on disk is what is read back.
    wake.stop();
    w.t3!.setState("up");
    w.clock.now += 6_000;
    const after = w.startCodex();
    await after.sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(w.turnsOf(T3_THREAD)).toEqual([reply.id]);
    expect(w.sends()).toHaveLength(2);
  });

  test("a reply codex queue already took before (the stuck Handed line) reads as saved, and is not sent twice", async () => {
    const w = world();
    const reply = w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
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

  test("T3 no longer has the thread: read back to be sure, then the session ends and nothing is retried", async () => {
    const w = world();
    w.t3!.setState("gone");
    const wake = w.startCodex();
    w.reply(w.ask(IN_T3, "Codex from T3"), "Yes, ship it.", "k1");
    await wake.sweep();
    w.clock.now += 6_000;
    await wake.sweep();
    expect(wake.status(IN_T3)).toBe("dead");
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    expect(w.sends()).toHaveLength(1);
  });

  test("an earlier reply that did not go holds the later ones back: they go in order", async () => {
    const w = world();
    w.t3!.setState("hang");
    const wake = w.startCodex();
    const first = w.reply(w.ask(IN_T3, "Codex from T3"), "First.", "k1");
    const second = w.reply(w.ask(IN_T3, "Codex from T3"), "Second.", "k2");
    await wake.sweep();
    expect(w.sends()).toHaveLength(1);
    w.t3!.setState("up");
    w.clock.now += 6_000;
    await wake.sweep();
    await wake.sweep();
    expect(w.turnsOf(T3_THREAD)).toEqual([first.id, second.id]);
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
    expect(w.sends()).toEqual([[...SEND, CLAUDE_T3, "-", "--json"]]);
    expect(w.turnsOf(CLAUDE_T3)).toEqual([reply.id]);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ state: "delivered", host: "t3", session: CLAUDE_T3 });
    expect(wake.status(CLAUDE_T3)).toBe("alive");
    wake.stop();
    await w.startT3().sweep();
    expect(w.sends()).toHaveLength(1);
    expect(w.claimsIn("t3-send")).toEqual([]);
  });

  test("the command runs with none of the Inbox's identity: no thread id, no Claude or Plannotator variables, no token", async () => {
    const w = world({ env: { T3CODE_THREAD_ID: "mcp:someone-else", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "t3-code", PLANNOTATOR_SESSION_TAG: "tag", GITHUB_TOKEN: "secret", LANG: "en_US.UTF-8" } });
    const wake = w.startT3();
    w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    const env = w.t3!.envs().at(-1)!;
    for (const key of Object.keys(env)) expect(key).not.toMatch(/^(T3CODE_THREAD_ID|CLAUDE|PLANNOTATOR_|GITHUB_TOKEN)/);
    expect(env.T3CODE_HOME).toBe(w.t3!.dir);
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  test("while the Claude Code mod polls as the thread, T3 is never sent to (one owner per reply)", async () => {
    const w = world();
    const wake = w.startT3({ skip: () => true });
    w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(w.sends()).toEqual([]);
  });

  test("the first send starts Claude, whose mod polls at once: it is handed none of the others, and each goes once", async () => {
    const w = world();
    const real = w.local();
    let modPolls = false;
    const modTook: string[] = [];
    let wake: InboxT3Wake;
    const replies: InboxMessage[] = [];
    // The mod's poll, the moment T3 starts Claude: the bridge hands it what the T3 wake does not hold.
    const local: T3Local = {
      ...real,
      send: async (thread, text, signal) => {
        const sent = await real.send(thread, text, signal);
        modPolls = true;
        for (const one of replies) {
          const fresh = w.store.message(one.id)!;
          if (!fresh.delivery && !wake.holds(CLAUDE_T3, fresh)) modTook.push(one.id);
        }
        return sent;
      },
    };
    wake = w.startT3({ local, skip: () => modPolls });
    for (const words of ["First.", "Second.", "Third."]) replies.push(w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), words, words));
    await wake.sweep();
    expect(modTook).toEqual([]);
    expect(w.turnsOf(CLAUDE_T3)).toEqual(replies.map((one) => one.id));
    for (const one of replies) expect(w.store.message(one.id)?.delivery?.state).toBe("delivered");
  });

  test("a reply the mod claimed after the sweep picked it is not sent", async () => {
    const w = world();
    const real = w.local();
    const replies: InboxMessage[] = [];
    const local: T3Local = {
      ...real,
      send: async (thread, text, signal) => {
        const sent = await real.send(thread, text, signal);
        // The mod took the second one (its claim folder) while the first send ran.
        mkdirSync(inboxModClaimDir(w.store.dir, replies[1]!.id, CLAUDE_T3)!, { recursive: true });
        return sent;
      },
    };
    const wake = w.startT3({ local });
    replies.push(w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "First.", "k1"), w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Second.", "k2"));
    await wake.sweep();
    expect(w.turnsOf(CLAUDE_T3)).toEqual([replies[0]!.id]);
  });

  test("after a restart, before any sweep, the bridge still hands the mod nothing a send may have put in", async () => {
    const w = world();
    w.t3!.setState("taken-then-hang");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    wake.stop();
    const after = createInboxT3Wake({ store: w.store, dataDir: w.dataDir, commandOf, local: w.local(), now: () => w.clock.now, log: () => {} });
    expect(after.holds(CLAUDE_T3, w.store.message(reply.id)!)).toBe(true);
    after.stop();
  });

  test("a send T3 took with no answer is read back and delivered: no grant, no restart sends it again", async () => {
    const w = world();
    const mcp = w.grant([CLAUDE_T3]);
    w.t3!.setState("taken-then-hang");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.uncertain(CLAUDE_T3, reply.id)).toBe(true);
    expect(w.store.handover.handedTo(CLAUDE_T3)).toEqual([reply.id]);
    wake.stop();
    w.t3!.setState("up");
    w.clock.now += 6_000;
    await w.startT3().sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(w.sends()).toHaveLength(1);
    expect(mcp.sendCalls).toBe(0);
  });

  test("a crash between the claim and the send: read back after the restart, absent, sent once", async () => {
    const w = world();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    createT3Claims(join(w.store.dir, "t3-send"), () => w.clock.now - 60_000).make(reply.id, CLAUDE_T3, CLAUDE_T3);
    await w.startT3().sweep();
    expect(w.turnsOf(CLAUDE_T3)).toEqual([reply.id]);
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
  });

  test("T3 here has no such thread (read back to be sure): the claim goes, and a saved grant sends it, once", async () => {
    const w = world();
    const mcp = w.grant([CLAUDE_T3]);
    w.t3!.setState("gone");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(mcp.sendCalls).toBe(0);
    w.clock.now += 6_000;
    await wake.sweep();
    expect(w.sends()).toHaveLength(1);
    expect(mcp.turns.map((turn) => turn.clientRequestId)).toEqual([`plannotator-inbox-${reply.id}`]);
    expect(w.store.message(reply.id)?.delivery).toMatchObject({ host: "t3", session: CLAUDE_T3 });
    expect(w.claimsIn("t3-send")).toEqual([]);
    expect(w.routes).toEqual([{ route: "grant", agent: "claude", thread: reply.thread_id, reply: reply.id }]);
  });

  test("a T3 still starting that says 'not found' does not end the thread: it goes in once T3 has settled", async () => {
    const w = world();
    w.t3!.setState("starting");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    w.clock.now += 6_000;
    await wake.sweep();
    expect(wake.gone(CLAUDE_T3)).toBe(false);
    w.t3!.setState("up");
    w.clock.now += 60_000;
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(w.turnsOf(CLAUDE_T3)).toEqual([reply.id]);
  });

  test("T3 closed, no sign-in: the reply waits on T3 (not on a sign-in), and goes in within seconds of T3 starting", async () => {
    const w = world();
    w.t3!.setState("down");
    const wake = w.startT3();
    expect(await wake.wakes("t3", CLAUDE_T3)).toBe(false);
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    await wake.sweep();
    expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
    expect(w.store.handover.holder(w.store.message(reply.id)!)).toBeNull();
    expect(w.t3!.calls()).toEqual([]);
    w.t3!.setState("up");
    expect(await until(() => w.store.message(reply.id)?.delivery?.state === "delivered")).toBe(true);
    expect(w.sends()).toHaveLength(1);
    // The debug log: one line when it starts to wait, one when it goes, by id only.
    const ids = { agent: "claude", thread: reply.thread_id, reply: reply.id };
    expect(w.routes).toEqual([{ route: "waiting", ...ids, reason: "closed" }, { route: "t3_send", ...ids }]);
  });

  describe("T3 quits, taking the thread's Claude (and its mod) with it", () => {
    /** The mod, as the bridge sees it: a poll held open now, or one that ended within the live window. */
    const modOf = (w: ReturnType<typeof world>, local: T3Local) => {
      const mod = { holding: false, lately: false, resweeps: [] as number[] };
      const skip = createT3ModOwner({ local, holdsPoll: () => mod.holding, polledLately: () => mod.lately, claimed: () => false, resweep: (ms) => void mod.resweeps.push(ms), liveMs: 30_000, probeMs: 2_000 });
      return { mod, skip };
    };

    test("a reply the mod had reads as waiting on T3 within seconds, and goes in once T3 runs again", async () => {
      const w = world();
      const local = w.local();
      const { mod, skip } = modOf(w, local);
      mod.holding = true;
      mod.lately = true;
      const wake = w.startT3({ local, skip });
      const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
      await wake.sweep();
      // The mod's to deliver while it polls: nothing sent, no wait line.
      expect(w.sends()).toEqual([]);
      expect(w.store.message(reply.id)?.t3_wait).toBeUndefined();
      // T3 quits: the mod's poll ends with it, its last poll still inside the live window. No clock moves.
      mod.holding = false;
      w.t3!.setState("down");
      expect(await until(() => w.store.message(reply.id)?.t3_wait === "closed")).toBe(true);
      expect(w.t3!.calls()).toEqual([]);
      // T3 back, inside the same window: its Claude starts only with a turn, so the reply goes in as one, once.
      w.t3!.setState("up");
      expect(await until(() => w.store.message(reply.id)?.delivery?.state === "delivered")).toBe(true);
      expect(w.turnsOf(CLAUDE_T3)).toEqual([reply.id]);
      expect("t3_wait" in w.store.message(reply.id)!).toBe(false);
    });

    test("a reply sent just after T3 quit waits on T3 at the first look, though the mod polled moments ago", async () => {
      const w = world();
      const local = w.local();
      const { mod, skip } = modOf(w, local);
      mod.lately = true;
      w.t3!.setState("down");
      const wake = w.startT3({ local, skip });
      const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
      await wake.sweep();
      expect(w.store.message(reply.id)?.t3_wait).toBe("closed");
      expect(w.t3!.calls()).toEqual([]);
    });

    test("a poll held open keeps the mod the owner though T3 here reads as closed, and is looked at again in seconds", async () => {
      const w = world();
      const local = w.local();
      const { mod, skip } = modOf(w, local);
      mod.holding = true;
      mod.lately = true;
      w.t3!.setState("down");
      const wake = w.startT3({ local, skip });
      const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
      await wake.sweep();
      expect(w.store.message(reply.id)?.t3_wait).toBeUndefined();
      expect(w.store.handover.holder(w.store.message(reply.id)!)).toBeNull();
      expect(mod.resweeps).toContain(2_000);
    });
  });

  test("T3 here gone and no grant: the thread is ended, the reply waits for the next agent, nothing is retried", async () => {
    const w = world();
    w.t3!.setState("gone");
    const wake = w.startT3();
    w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    w.clock.now += 6_000;
    await wake.sweep();
    expect(wake.gone(CLAUDE_T3)).toBe(true);
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    expect(w.sends()).toHaveLength(1);
  });

  test("another failure keeps the claim, is read back once T3 answers, and goes in once", async () => {
    const w = world();
    w.t3!.setState("fail");
    const wake = w.startT3();
    const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
    await wake.sweep();
    expect(wake.uncertain(CLAUDE_T3, reply.id)).toBe(true);
    w.clock.now += 6_000;
    await wake.sweep();
    expect(w.sends()).toHaveLength(1);
    w.t3!.setState("up");
    w.clock.now += 31_000;
    await wake.sweep();
    expect(w.store.message(reply.id)?.delivery?.state).toBe("delivered");
    expect(w.turnsOf(CLAUDE_T3)).toEqual([reply.id]);
  });

  test("no T3 on this machine, or Windows: the sign-in wait, exactly as before, and not promised", async () => {
    for (const w of [world({ t3Home: false }), world({ platform: "win32" })]) {
      const wake = w.startT3();
      expect(await wake.wakes("t3", CLAUDE_T3)).toBe(false);
      const reply = w.reply(w.ask(CLAUDE_T3, "Claude", "t3"), "Yes, ship it.", "k1");
      await wake.sweep();
      expect(w.store.message(reply.id)?.t3_wait).toBe("sign_in");
      expect(w.sends()).toEqual([]);
    }
  });

  test("two threads whose ids differ only past a long common start keep their own claims", () => {
    const w = world();
    const claims = createT3Claims(join(w.store.dir, "t3-send"));
    const long = `thread:mcp:ns:${"r".repeat(200)}`;
    expect(claims.make("msg_1", `${long}:0`, `${long}:0`)).toBe(true);
    expect(claims.make("msg_1", `${long}:1`, `${long}:1`)).toBe(true);
    expect(claims.has("msg_1", `${long}:1`)).toBe(true);
  });
});
