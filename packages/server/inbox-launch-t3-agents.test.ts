/**
 * Codex, OpenCode and Pi started in T3 Code, and a start the Inbox closed during (issue #3590). T3 gives its thread's
 * id (`T3CODE_THREAD_ID`) only to the Claude it runs, so only Claude reaches the Inbox as the T3 thread; Codex,
 * OpenCode and Pi write under their own session ids, which nothing T3 says names. The launch counts their agent as
 * connected once it writes in the launch's own thread (`t3LaunchWriterOf`), and a start the Inbox closed during whose
 * agent wrote settles on its thread with no second start (`t3AdoptableOf`).
 *
 * The launch engine and the real T3 runner against the T3 stand-in (tests/helpers/fake-t3.ts), in a scratch home and
 * data folder (tests/helpers/t3-launch.ts): no Inbox server, no T3 and no agent run. An agent's words go in as its
 * Inbox client files them (the identity `inboxHostSessionFromEnv` reads from the environment T3 gives it), in reply
 * to the message the first turn named; nothing fakes "heard".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxLaunchAgent, InboxMessage } from "@plannotator/core/inbox-types";
import { inboxHostSessionFromEnv } from "../../apps/hook/server/inbox-mcp-shim";
import { CAPABILITIES, commandOf, t3LaunchSetup, until } from "../../tests/helpers/t3-launch";
import { codexQueueMessage } from "./inbox-codex-wake";
import { T3_LAUNCH_INTERRUPTED, t3AdoptableOf, t3LaunchWriterOf, type T3StartAttempt } from "./inbox-launch-t3";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

/** T3's threads in the project, newest first: one per agent, so each start takes its model from the list (no token). */
const USED = [
  { threadId: "thread:project:p:4", title: "Totals", providerInstanceId: "claudeAgent", model: "sonnet" },
  { threadId: "thread:project:p:3", title: "Copy", providerInstanceId: "codex", model: "gpt-5.5" },
  { threadId: "thread:project:p:2", title: "Docs", providerInstanceId: "opencode", model: "anthropic/claude-sonnet-4-5" },
  { threadId: "thread:project:p:1", title: "Tests", providerInstanceId: "pi", model: "claude-sonnet-4-5" },
];

type Setup = ReturnType<typeof t3LaunchSetup>;
type Who = { host: string; session: string; name: string };

/**
 * Who an agent's words come from inside a T3 thread, as its own Inbox client files them: Claude as the thread
 * (T3's `T3CODE_THREAD_ID`); Codex by `CODEX_THREAD_ID`, Pi by `PI_SESSION_ID` (the shim's own read); OpenCode's
 * plugin under its own session id. A new session each time, as a new T3 thread's agent is.
 */
function agentIn(agent: InboxLaunchAgent, t3Thread?: string): Who {
  const env: Record<string, string> =
    agent === "claude-code" ? { T3CODE_THREAD_ID: t3Thread!, CLAUDE_CODE_ENTRYPOINT: "t3-code" } : agent === "codex" ? { CODEX_THREAD_ID: randomUUID() } : agent === "pi" ? { PI_SESSION_ID: randomUUID() } : {};
  const filed = agent === "opencode" ? { host: "opencode", session: `ses_${randomUUID().replace(/-/g, "").slice(0, 26)}`, name: "OpenCode" } : inboxHostSessionFromEnv(env);
  if (!filed) throw new Error(`no identity for ${agent}`);
  return filed;
}

/** The agent's reply in the Inbox thread, to the message its first turn named (as its `reply` call writes it). */
const writes = (t: Setup, root: InboxMessage, who: Who, body: string) =>
  t.store.sendMessage({ project_id: t.project.id, reply_to: root.id, author: { kind: "agent", host: who.host, session: who.session, name: who.name }, body, wakes: true }).message;

/**
 * The Inbox closed while `t3 thread start` ran, and T3 made the thread anyway: what the start notes before it runs
 * T3 (`t3-start.json`: the title, the title's threads T3 listed, when, "running"), then T3's own `thread start` with the
 * wake text on stdin, as the start runs it. Nothing after that is written: the Inbox is gone.
 */
async function cutStart(t: Setup, root: InboxMessage, provider: string, model: string): Promise<string> {
  const dir = join(t.dataDir, "inbox", "launch", root.launch!.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "t3-start.json"), `${JSON.stringify({ title: "Checkout copy", before: [], listed: true, at: Date.now(), outcome: "running" })}\n`);
  const made = Bun.spawn([t.t3!.launcher, "thread", "start", ".", "-", "--title=Checkout copy", `--provider=${provider}`, `--model=${model}`, "--json"], { cwd: t.shop, stdin: new Blob([codexQueueMessage(commandOf(root))]), stdout: "pipe", stderr: "pipe" });
  await made.exited;
  return t.t3!.starts().at(-1)!.id;
}

describe("Codex, OpenCode and Pi in T3 Code reach the Inbox under their own sessions", () => {
  for (const [agent, provider] of [
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["pi", "pi"],
  ] as const) {
    test(`${agent}: once it writes in the thread it is connected, after the wait too; the person's next reply goes to it once, not into the T3 thread as well`, async () => {
      const t = t3LaunchSetup(cleanup, { used: USED, capabilities: CAPABILITIES });
      const wake = t.wake();
      const root = await t.send("Tighten the checkout copy.", agent);
      const thread = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
      expect(t.t3!.starts()).toMatchObject([{ id: thread, provider }]);
      // The first turn names the message, so only this thread's agent can answer it.
      expect(t.t3!.starts()[0]!.text).toContain(root.id);
      // Its agent writes under its own session, never as the T3 thread.
      const who = agentIn(agent);
      expect(who.host).toBe(agent);
      expect(who.session).not.toBe(thread);
      // Past the ten-minute wait, with T3 saying the turn is over, and nothing from it yet: "hasn't connected".
      t.clock.now += 11 * 60_000;
      expect(await until("the line", () => t.launch.runOfMessage(root.id))).toMatchObject({ state: "failed", t3: { started: true } });
      // It writes in the thread: connected, and the line goes.
      const answer = writes(t, root, who, "Tightened: three labels shorter.");
      expect(t.launch.runOfMessage(root.id)).toBeNull();
      expect(t.launch.agents().find((a) => a.session === thread)).toMatchObject({ t3: true, run: null });
      // The person's reply to it goes to the agent's own session, and the T3 wake leaves it alone.
      const reply = t.store.sendReply(answer.id, { words: "Keep the button label.", idempotency_key: `next-${agent}` }).reply!;
      expect(t.store.recipientOf(reply)).toMatchObject({ session: who.session });
      await wake.sweep();
      await Bun.sleep(100);
      await wake.sweep();
      expect(t.t3!.sends()).toEqual([]);
      expect(t.background).toEqual([]);
    });
  }

  test("another session of the same agent in the same folder is not taken for it: one that wrote in another thread first, or one the person brought into this thread", async () => {
    const t = t3LaunchSetup(cleanup, { used: USED });
    const root = await t.send("Tighten the checkout copy.", "codex");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    // A Codex already at work in the project, elsewhere: it wrote in another thread first.
    const other = agentIn("codex");
    t.store.sendMessage({ project_id: t.project.id, author: { kind: "agent", host: other.host, session: other.session, name: other.name }, body: "Lint is clean.", subject: "Lint" });
    writes(t, root, other, "I can look at the copy too.");
    // A new Codex the person sent a reply in this thread to.
    const brought = agentIn("codex");
    t.store.sendReply(root.id, { words: "Second opinion, please.", idempotency_key: "brought", to: { host: brought.host, session: brought.session } });
    writes(t, root, brought, "Second opinion: fine.");
    t.clock.now += 11 * 60_000;
    expect(await until("the line", () => t.launch.runOfMessage(root.id))).toMatchObject({ state: "failed", t3: { started: true } });
  });

  test("the rule, piece by piece", () => {
    const thread = "thr_launch";
    const since = Date.parse("2026-11-27T10:00:00.000Z");
    const at = (ms: number) => new Date(since + ms).toISOString();
    const agent = (host: string, session: string, ms = 1_000) => ({ author: { kind: "agent" as const, host, session, name: null }, created_at: at(ms) });
    const first = new Map<string, string>([["codex-a", thread], ["codex-b", "thr_other"], ["t3-x", thread], ["pi-a", thread]]);
    const of = (messages: Parameters<typeof t3LaunchWriterOf>[0], own: string | null = null, elsewhere = (_: string) => false) => t3LaunchWriterOf(messages, { threadId: thread, agent: "codex", since, own }, (s) => first.get(s) ?? null, elsewhere);
    expect(of([agent("codex", "codex-a")])).toEqual({ host: "codex", session: "codex-a" });
    // Another agent's session, one that wrote elsewhere first, one from before the start, another launch's: none.
    expect(of([agent("pi", "pi-a")])).toBeNull();
    expect(of([agent("codex", "codex-b")])).toBeNull();
    expect(of([agent("codex", "codex-a", -60_000)])).toBeNull();
    expect(of([agent("codex", "codex-a")], null, (s) => s === "codex-a")).toBeNull();
    // The T3 thread itself (Claude Code in T3): any while the launch has none, then only its own.
    expect(of([agent("t3", "t3-x")])).toEqual({ host: "t3", session: "t3-x" });
    expect(of([agent("t3", "t3-x")], "t3-y")).toBeNull();
    // Brought in by the person before it wrote: not it. A reply to it afterwards changes nothing.
    const toIt = { author: { kind: "person" as const }, created_at: at(500), to: { host: "codex", session: "codex-a" } };
    expect(of([toIt, agent("codex", "codex-a")])).toBeNull();
    expect(of([{ author: { kind: "person" as const }, created_at: at(500), tags: [{ host: "codex", session: "codex-a" }] }, agent("codex", "codex-a")])).toBeNull();
    expect(of([agent("codex", "codex-a"), { ...toIt, created_at: at(2_000) }])).toEqual({ host: "codex", session: "codex-a" });
  });
});

describe("a start the Inbox closed during", () => {
  test("Claude Code wrote in the thread before Try again: the launch settles on its thread by itself, with no second thread and the message once", async () => {
    const t = t3LaunchSetup(cleanup, { used: USED });
    const root = await t.prepare("Tighten the checkout copy.");
    const made = await cutStart(t, root, "claudeAgent", "sonnet");
    const launch = t.restart();
    expect(launch.runOfMessage(root.id)).toMatchObject({ state: "failed", cause: T3_LAUNCH_INTERRUPTED });
    // Its Claude writes as the thread, as it does inside T3.
    writes(t, root, agentIn("claude-code", made), "Tightened.");
    launch.runOfMessage(root.id);
    expect(await until("settled", () => t.store.message(root.id)!.launch!.session_ref)).toBe(made);
    expect(t.store.message(root.id)).toMatchObject({ to: { host: "t3", session: made }, delivery: { state: "delivered", session: made } });
    expect(launch.runOfMessage(root.id)?.state === "failed").toBe(false);
    expect(t.starts()).toHaveLength(1);
    expect(t.t3!.turns().filter(([at]) => at === made)).toHaveLength(1);
    expect(t.background).toEqual([]);
  });

  test("Codex wrote under its own session: Try again takes the thread that start made (T3 lists it), never a second", async () => {
    const t = t3LaunchSetup(cleanup, { used: USED });
    const root = await t.prepare("Tighten the checkout copy.", "codex");
    const made = await cutStart(t, root, "codex", "gpt-5.5");
    const launch = t.restart();
    writes(t, root, agentIn("codex"), "Tightened.");
    // T3 can't answer while the Inbox looks: the line stays, and its Try again starts nothing beside the thread.
    t.t3!.refuseList();
    expect(launch.runOfMessage(root.id)).toMatchObject({ state: "failed", cause: T3_LAUNCH_INTERRUPTED });
    await until("asked T3", () => t.t3!.calls().some((args) => args[1] === "list"));
    await Bun.sleep(150);
    const route = async () => {
      const at = `/api/inbox/launch/${root.launch!.id}/retry`;
      return launch.route(new Request(`http://127.0.0.1:4000${at}`, { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv" }) }), at, "local");
    };
    await route();
    expect(await until("the line again", () => t.store.message(root.id)!.launch!.error)).toMatchObject({ text: T3_LAUNCH_INTERRUPTED });
    expect(t.starts()).toHaveLength(1);
    t.t3!.refuseList(false);
    await route();
    expect(await until("taken", () => t.store.message(root.id)!.launch!.session_ref)).toBe(made);
    expect(t.starts()).toHaveLength(1);
    expect(t.t3!.turns().filter(([at]) => at === made)).toHaveLength(1);
    expect(t.background).toEqual([]);
  });

  test("its agent has not written: Try again takes the thread that start made", async () => {
    const t = t3LaunchSetup(cleanup, { used: USED });
    const root = await t.prepare("Tighten the checkout copy.");
    const made = await cutStart(t, root, "claudeAgent", "sonnet");
    const launch = t.restart();
    const at = `/api/inbox/launch/${root.launch!.id}/retry`;
    await launch.route(new Request(`http://127.0.0.1:4000${at}`, { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv" }) }), at, "local");
    expect(await until("taken", () => t.store.message(root.id)!.launch!.session_ref)).toBe(made);
    expect(t.starts()).toHaveLength(1);
  });

  test("a thread of the same title another launch in the project has is never taken: a new thread starts", async () => {
    const t = t3LaunchSetup(cleanup, { used: USED });
    const root = await t.prepare("Tighten the checkout copy.");
    // The note this launch's start wrote, then another launch of the same title starts its own thread there.
    const dir = join(t.dataDir, "inbox", "launch", root.launch!.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "t3-start.json"), `${JSON.stringify({ title: "Checkout copy", before: [], listed: true, at: Date.now() - 1_000, outcome: "running" })}\n`);
    // No thread name of its own (two open threads can't share one): T3's title is its subject, the same words.
    const other = await t.send("Checkout copy", "claude-code", null);
    const theirs = await until("theirs", () => t.store.message(other.id)!.launch!.session_ref);
    expect(t.t3!.starts()).toMatchObject([{ id: theirs, title: "Checkout copy" }]);
    const at = `/api/inbox/launch/${root.launch!.id}/retry`;
    await t.launch.route(new Request(`http://127.0.0.1:4000${at}`, { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv" }) }), at, "local");
    const mine = await until("mine", () => t.store.message(root.id)!.launch!.session_ref);
    expect(mine).not.toBe(theirs);
    expect(t.starts()).toHaveLength(2);
  });

  test("T3 didn't list the threads before a start that then timed out: Try again lists again and takes the thread by its title and time, never a second", async () => {
    // With no list, the model is T3's first listed one.
    const t = t3LaunchSetup(cleanup, { used: USED, capabilities: CAPABILITIES, startTimeoutMs: 1_500 });
    t.t3!.refuseList();
    t.t3!.setState("taken-then-hang");
    const root = await t.send("Tighten the checkout copy.");
    await until("the start timed out", () => t.store.message(root.id)!.launch!.error, 15_000);
    t.t3!.setState("up");
    t.t3!.refuseList(false);
    expect((await t.route(root.launch!.id, "retry")).ok).toBe(true);
    expect(await until("taken", () => t.store.message(root.id)!.launch!.session_ref)).toBe(t.t3!.starts()[0]!.id);
    expect(t.starts()).toHaveLength(1);
  }, 30_000);

  test("which thread a later start takes: one made since that start, exactly one, never one that is elsewhere; with no list before it, only by T3's time", () => {
    const at = Date.parse("2026-11-17T10:00:00.000Z");
    const listed = [
      { threadId: "new-elsewhere", title: "Fix login", createdAt: at + 5_000 },
      { threadId: "new", title: "Fix login", createdAt: at + 2_000 },
      { threadId: "older", title: "Fix login", createdAt: at - 60_000 },
      { threadId: "before", title: "Fix login", createdAt: null },
    ];
    const elsewhere = (thread: string) => thread === "new-elsewhere";
    const attempt = (listedBefore: boolean): T3StartAttempt => ({ title: "Fix login", before: listedBefore ? ["before"] : [], listed: listedBefore, at, outcome: "uncertain" });
    expect(t3AdoptableOf(attempt(true), "Fix login", listed, elsewhere)).toBe("new");
    expect(t3AdoptableOf(attempt(false), "Fix login", listed, elsewhere)).toBe("new");
    // Two that could be it: none.
    expect(t3AdoptableOf(attempt(false), "Fix login", listed, () => false)).toBeNull();
    // No list before it, and T3 gives no time: none.
    expect(t3AdoptableOf(attempt(false), "Fix login", [{ threadId: "x", title: "Fix login", createdAt: null }], () => false)).toBeNull();
    expect(t3AdoptableOf(attempt(true), "Fix login", [{ threadId: "x", title: "Fix login", createdAt: null }], () => false)).toBe("x");
  });
});

describe("a T3 whose CLI has no --option", () => {
  test("the person's effort is refused as an unknown flag: once more on their model without it, and the record says the effort, not the model", async () => {
    const t = t3LaunchSetup(cleanup, { used: USED });
    t.t3!.withoutOptionFlag();
    const root = await t.send("Tighten the checkout copy.", "claude-code", "Checkout copy", { model: "haiku", effort: "high" });
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts().map((args) => args.filter((a) => a.startsWith("--model") || a.startsWith("--option")))).toEqual([["--model=haiku", "--option=effort=high"], ["--model=haiku"]]);
    expect(t.store.message(root.id)!.launch).toMatchObject({ t3: { declined_effort: "high" }, inner: { model: "haiku" } });
    expect(t.store.message(root.id)!.launch!.t3!.declined).toBeUndefined();
    expect(t.background).toEqual([]);
  });
});
