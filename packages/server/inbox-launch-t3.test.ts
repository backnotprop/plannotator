/**
 * Start an agent in T3 Code (issue #3590): Settings → Agents' "Start new agents in" T3 Code, as Rex is. New message
 * starts the person's Claude Code (or Codex) as a new T3 thread on that agent, with the message as its first turn, on
 * the model T3 last ran that agent on in the project, else T3's own first model for it (read once under a read-only
 * token T3 issues for a minute, then revoked). When T3 Code isn't open or says no, the agent starts in the background
 * and the line says why. Replies go in through the T3 wake.
 *
 * The launch engine and the real T3 runner against the T3 stand-in (tests/helpers/fake-t3.ts: a `t3` launcher that
 * answers `thread start`, `list`, `show`, `send`, `project add` and `auth session issue`/`revoke` as T3's CLI does,
 * and its MCP server for `orchestrator_capabilities`), in a scratch home and data folder, with the agents' own hosts
 * standing in (tests/helpers/t3-launch.ts). No Inbox server, no T3 and no agent run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t3ListedModelOf, t3NewestModelOf } from "@plannotator/core/inbox-launch-choice";
import { INBOX_RUN_IN_T3_AGAIN, INBOX_RUN_IN_T3_OPEN, INBOX_RUN_IN_T3_STOP } from "@plannotator/core/inbox-run-line";
import { INBOX_LAUNCHED_LINE } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { makeFakeT3Home } from "../../tests/helpers/fake-t3";
import { CAPABILITIES, commandOf, t3LaunchSetup, until } from "../../tests/helpers/t3-launch";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { codexQueueMessage } from "./inbox-codex-wake";
import type { LaunchHostContext } from "./inbox-launch-host";
import { createT3LaunchHost, T3_LAUNCH_INTERRUPTED, t3AdoptableOf, t3IssuedSessionOf, t3LocalOrigin, t3StartedThreadOf, t3TurnEndedOf, type T3StartAttempt } from "./inbox-launch-t3";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

const setup = (options: Parameters<typeof t3LaunchSetup>[1] = {}) => t3LaunchSetup(cleanup, options);

/** Threads T3 already has in the project, newest first: Claude Code last ran on sonnet, Codex on gpt-5.5. */
const USED = [
  { threadId: "thread:project:p:3", title: "Totals", providerInstanceId: "claudeAgent", model: "sonnet" },
  { threadId: "thread:project:p:2", title: "Copy", providerInstanceId: "codex", model: "gpt-5.5" },
  { threadId: "thread:project:p:1", title: "Older", providerInstanceId: "claudeAgent", model: "opus" },
];

/** Every file under `dir`, with its text. */
function filesUnder(dir: string): [string, string][] {
  return (readdirSync(dir, { recursive: true }) as string[]).flatMap((name) => {
    const at = join(dir, name);
    return statSync(at).isFile() ? [[at, readFileSync(at, "utf8")] as [string, string]] : [];
  });
}

describe("starting an agent in T3 Code", () => {
  test("the person's Claude Code starts as one T3 thread on the model T3 last ran Claude Code on there, the wake text on stdin; the root moves to the thread, delivered, and no token is asked for", async () => {
    const t = setup({ used: USED, capabilities: CAPABILITIES });
    const root = await t.send("Tighten the checkout copy.");
    expect(root.launch).toMatchObject({ agent: "claude-code", t3: {} });
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts()).toEqual([["thread", "start", ".", "-", "--title=Checkout copy", "--provider=claudeAgent", "--model=sonnet", "--json"]]);
    const [start] = t.t3!.starts();
    expect(start).toMatchObject({ id: session, cwd: t.shop, base: null, title: "Checkout copy", provider: "claudeAgent", model: "sonnet" });
    const after = t.store.message(root.id)!;
    expect(start!.text).toBe(codexQueueMessage(commandOf(after)));
    expect(start!.text).toContain(INBOX_LAUNCHED_LINE);
    expect(after.to).toEqual({ host: "t3", session });
    expect(after.delivery).toMatchObject({ state: "delivered", host: "t3", session });
    expect(after.launch).toMatchObject({ agent: "claude-code", t3: {}, inner: { provider: "claudeAgent", model: "sonnet", agent: "Claude Code" } });
    // The message is never on a command line, and T3 knew a model: no token, no MCP call.
    expect(t.t3!.calls().flat().join(" ")).not.toContain("Tighten");
    expect(t.t3!.issued()).toEqual([]);
    expect(t.mcp.capabilityCalls).toBe(0);
    // Nothing here started it in the background, and the agent row has no Stop.
    expect(t.background).toEqual([]);
    expect(t.launch.agents().find((a) => a.session === session)).toMatchObject({ t3: true, inner: { model: "sonnet" } });
  });

  test("Codex takes the model T3 last ran Codex on, not Claude Code's", async () => {
    const t = setup({ used: USED });
    const root = await t.send("Tighten the checkout copy.", "codex");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.t3!.starts()[0]).toMatchObject({ provider: "codex", model: "gpt-5.5" });
    expect(t.store.message(root.id)!.launch!.inner).toEqual({ provider: "codex", model: "gpt-5.5", agent: "Codex" });
  });

  test("no thread on that agent yet: T3's own first model for it, read once under a read-only, one-minute token from T3's own `auth session issue`, revoked after; the token is in no file, log line or command line", async () => {
    const token = `t3-issued-${crypto.randomUUID()}`;
    const t = setup({ capabilities: CAPABILITIES, authToken: token });
    t.mcp.state.token = token;
    const root = await t.send("Tighten the checkout copy.", "codex");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.t3!.starts()[0]).toMatchObject({ id: session, provider: "codex", model: "gpt-5.5" });
    // One token, read-only (T3's own scope for a read-only MCP client), an MCP client's, for a minute, named.
    const issued = t.t3!.issued();
    expect(issued).toEqual([{ sessionId: issued[0]!.sessionId, scope: "orchestration:read", subject: "mcp-client", ttl: "1m", label: "Plannotator Inbox", json: true }]);
    expect(t.mcp.capabilityCalls).toBe(1);
    // Revoked at once, not left to its minute.
    expect(await until("revoked", () => (t.t3!.revoked().length > 0 ? t.t3!.revoked() : null))).toEqual([issued[0]!.sessionId]);
    // Never written down: not in any file the Inbox keeps (start.log, the debug log, the store), not in a log line, not
    // on any `t3` command line or in its environment.
    await t.debug.flush();
    const kept = filesUnder(t.dataDir);
    expect(kept.some(([at]) => at.endsWith("debug.log"))).toBe(true);
    expect(kept.some(([at]) => at.endsWith("start.log"))).toBe(true);
    expect(kept.filter(([, text]) => text.includes(token)).map(([at]) => at)).toEqual([]);
    expect(t.logged.join("\n")).not.toContain(token);
    expect(JSON.stringify(t.t3!.calls())).not.toContain(token);
    expect(JSON.stringify(t.t3!.envs())).not.toContain(token);
    // start.log says a token was asked for, and never what it was.
    const startLog = kept.find(([at]) => at.endsWith("start.log"))![1];
    expect(startLog).toContain("t3 auth session issue --scope=orchestration:read --subject=mcp-client --ttl=1m");
    expect(startLog).toContain("T3 Code lists codex · gpt-5.5 first for this agent");
  });

  test("a folder T3 doesn't know is added as a T3 project with T3's own `project add`, then the agent starts there", async () => {
    const t = setup({ known: false, capabilities: CAPABILITIES });
    const root = await t.send("Tighten the checkout copy.");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.t3!.added()).toEqual([t.shop]);
    expect(t.t3!.starts()[0]).toMatchObject({ cwd: t.shop, provider: "claudeAgent", model: "opus" });
  });

  test("the thread runs in exactly the Inbox's folder: not in a T3 project that holds it, nor in another checkout of its repository", async () => {
    // T3 has the folder above it as a project: without its own, T3 would run the thread there.
    const nested = setup({ used: USED, t3Projects: ({ parent }) => [parent] });
    const root = await nested.send("Tighten the checkout copy.");
    await until("the thread", () => nested.store.message(root.id)!.launch!.session_ref);
    expect(nested.t3!.added()).toEqual([nested.shop]);
    expect(nested.t3!.starts()[0]).toMatchObject({ cwd: nested.shop, project: nested.shop });
    // The folder is a git worktree of a repository T3 has: T3 would run it in that checkout.
    const linked = setup({ t3Projects: ({ parent }) => [join(parent, "shop-main")], checkouts: ({ shop, parent }) => ({ [shop]: join(parent, "shop-main") }), capabilities: CAPABILITIES });
    const second = await linked.send("Tighten the checkout copy.");
    await until("the thread", () => linked.store.message(second.id)!.launch!.session_ref);
    expect(linked.t3!.starts()[0]).toMatchObject({ project: linked.shop });
  });

  test("the person's model and effort from New message, as Rex starts it: passed to T3 as picked, with no token", async () => {
    const t = setup({ capabilities: CAPABILITIES });
    const root = await t.send("Tighten the checkout copy.", "claude-code", "Checkout copy", { model: "haiku", effort: "high" });
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts()).toEqual([["thread", "start", ".", "-", "--title=Checkout copy", "--provider=claudeAgent", "--model=haiku", "--option=effort=high", "--json"]]);
    expect(t.store.message(root.id)!.launch!.inner).toEqual({ provider: "claudeAgent", model: "haiku", agent: "Claude Code" });
    expect(t.t3!.issued()).toEqual([]);
  });

  test("an effort T3 refuses: once more on the person's model with T3's own effort, and the thread says the effort, not the model", async () => {
    const t = setup({ used: USED });
    const root = await t.send("Tighten the checkout copy.", "claude-code", "Checkout copy", { model: "haiku", effort: "max" });
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts().map((args) => args.filter((a) => a.startsWith("--model") || a.startsWith("--option")))).toEqual([["--model=haiku", "--option=effort=max"], ["--model=haiku"]]);
    expect(t.store.message(root.id)!.launch).toMatchObject({ t3: { declined_effort: "max" }, inner: { model: "haiku" } });
    expect(t.store.message(root.id)!.launch!.t3!.declined).toBeUndefined();
    expect(t.t3!.issued()).toEqual([]);
  });

  test("a model T3 refuses: once more on T3's own (the project's newest, else its list), and the thread says T3 didn't take the person's", async () => {
    // The person's pick refused: the newest thread's model, no token.
    const t = setup({ used: USED, capabilities: CAPABILITIES });
    const root = await t.send("Tighten the checkout copy.", "claude-code", "Checkout copy", { model: "retired", effort: "high" });
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.t3!.starts().map((s) => s.model)).toEqual(["sonnet"]);
    expect(t.starts().map((args) => args.filter((a) => a.startsWith("--model") || a.startsWith("--option")))).toEqual([["--model=retired", "--option=effort=high"], ["--model=sonnet"]]);
    expect(t.store.message(root.id)!.launch).toMatchObject({ t3: { declined: "retired" }, inner: { model: "sonnet" } });
    expect(t.t3!.issued()).toEqual([]);
    // The project's newest model refused: T3's listed one, through the token.
    const old = setup({ used: [{ threadId: "thread:project:p:9", title: "Old", providerInstanceId: "claudeAgent", model: "retired" }], capabilities: CAPABILITIES });
    const second = await old.send("Tighten the checkout copy.");
    await until("the thread", () => old.store.message(second.id)!.launch!.session_ref);
    expect(old.t3!.starts().map((s) => s.model)).toEqual(["opus"]);
    expect(old.t3!.issued()).toHaveLength(1);
    expect(old.store.message(second.id)!.launch!.t3).toEqual({});
    expect(old.background).toEqual([]);
  });

  test("a start in the background leaves a reply written meanwhile on its placeholder, as before; only a start that took the first turn (T3 Code) moves it", async () => {
    const t = setup({ startIn: "inbox" });
    const root = await t.prepare("Tighten the checkout copy.");
    const early = t.store.sendReply(root.id, { words: "Keep the button label.", idempotency_key: "early-bg" }).reply!;
    const placeholder = early.to!.session;
    t.launch.begin(root);
    await until("started", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(early.id)!.to!.session).toBe(placeholder);
  });

  test("a routine's run never starts in T3 Code: in the background, as with Rex", async () => {
    const t = setup({ used: USED });
    const message = await t.prepare("Nightly totals.", "claude-code", "Totals", { background: true });
    expect(message.launch!.t3).toBeUndefined();
    t.launch.begin(message);
    await until("started", () => t.store.message(message.id)!.launch!.session_ref);
    expect(t.background.map((b) => b.agent)).toEqual(["claude-code"]);
    expect(t.starts()).toEqual([]);
  });

  test("with the background chosen, nothing asks T3", async () => {
    const t = setup({ startIn: "inbox", used: USED });
    const root = await t.send("Tighten the checkout copy.");
    await until("started", () => t.store.message(root.id)!.launch!.session_ref);
    expect(root.launch!.t3).toBeUndefined();
    expect(t.t3!.calls()).toEqual([]);
  });
});

describe("when T3 Code can't start it, the agent starts in the background and the line says why", () => {
  const fellBack = async (t: ReturnType<typeof setup>, why: "unavailable" | "refused") => {
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("started in the background", () => t.store.message(root.id)!.launch!.session_ref);
    const after = t.store.message(root.id)!;
    expect(session).toStartWith("bg-");
    expect(after.to).toEqual({ host: "claude-code", session });
    expect(after.launch!.t3).toMatchObject({ [why]: true });
    expect(after.launch!.inner).toBeUndefined();
    expect(t.background.map((b) => b.agent)).toEqual(["claude-code"]);
    // Not delivered by the start: the agent's own wake hands it the message, as for any background start.
    expect(after.delivery).toBeUndefined();
    // It runs in the background: its Stop is the agent's own again.
    expect(t.launch.agents().find((a) => a.session === session)).toMatchObject({ t3: false });
    return { root, session };
  };

  test("T3 Code not open (no server, or one that doesn't answer): unavailable, and no thread, token or project add is tried", async () => {
    for (const state of ["down", "stale"] as const) {
      const t = setup({ used: USED, capabilities: CAPABILITIES });
      t.t3!.setState(state);
      await fellBack(t, "unavailable");
      // At most the folder's `project add` and `thread list`, which say T3 isn't running.
      expect(t.t3!.calls().filter((args) => !(args[0] === "thread" && args[1] === "list") && !(args[0] === "project" && args[1] === "add"))).toEqual([]);
      expect(t.t3!.issued()).toEqual([]);
    }
  });

  test("no T3 Code on this computer at all: unavailable", async () => {
    const t = setup({ t3: false });
    await fellBack(t, "unavailable");
  });

  test("a T3 too old to issue a token, and no thread to take a model from: refused, nothing started there", async () => {
    const t = setup({ capabilities: CAPABILITIES });
    t.t3!.refuseAuth();
    await fellBack(t, "refused");
    expect(t.store.message(t.store.launchedRoots()[0]!.id)!.launch!.t3).toEqual({ refused: true, why: "no_model" });
    expect(t.t3!.starts()).toEqual([]);
    expect(t.mcp.capabilityCalls).toBe(0);
  });

  test("T3 lists no model for that agent: refused, and the token is revoked all the same", async () => {
    const t = setup({ capabilities: { ...CAPABILITIES, providers: CAPABILITIES.providers.filter((p) => p.driverKind !== "claudeAgent") } });
    await fellBack(t, "refused");
    expect(t.mcp.capabilityCalls).toBe(1);
    await until("revoked", () => t.t3!.revoked().length === 1);
    expect(t.t3!.revoked()).toEqual([t.t3!.issued()[0]!.sessionId]);
  });

  test("a T3 whose runtime file names an address off this computer: no token is ever asked for, and nothing is sent there", async () => {
    const t = setup({ capabilities: CAPABILITIES, origin: "http://t3.example.com:9" });
    await fellBack(t, "refused");
    expect(t.t3!.issued()).toEqual([]);
    expect(t.mcp.capabilityCalls).toBe(0);
  });

  test("T3 refuses the model and lists none to try instead, or won't add the folder: refused, and the record says which", async () => {
    const t = setup({ used: [{ threadId: "thread:project:p:9", title: "Old", providerInstanceId: "claudeAgent", model: "retired" }] });
    const { root } = await fellBack(t, "refused");
    expect(t.store.message(root.id)!.launch!.t3).toEqual({ refused: true, declined: "retired" });
    const unknown = setup({ known: false, capabilities: CAPABILITIES });
    unknown.t3!.refuseProjectAdd();
    const second = await fellBack(unknown, "refused");
    expect(unknown.store.message(second.root.id)!.launch!.t3).toEqual({ refused: true, why: "project" });
    expect(unknown.t3!.starts()).toEqual([]);
  });
});

describe("an agent that runs in T3 Code", () => {
  test("Stop and Open in Terminal are refused in Rex's words with T3 Code's name; the thread is never read as stopped", async () => {
    const t = setup({ used: USED });
    const root = await t.send("Tighten the checkout copy.");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(await t.route(root.launch!.id, "stop")).toEqual({ ok: false, message: INBOX_RUN_IN_T3_STOP, code: "launch_in_t3" });
    expect(await t.route(root.launch!.id, "open")).toEqual({ ok: false, message: INBOX_RUN_IN_T3_OPEN, code: "launch_in_t3" });
    expect(t.starts()).toHaveLength(1);
    expect(t.launch.runOfMessage(root.id)?.state ?? null).not.toBe("stopped");
  });

  test("the T3 wake never takes the launch's placeholder, and a reply written while T3 starts the thread goes in once, after it", async () => {
    const t = setup({ used: USED });
    const wake = t.wake();
    await wake.sweep();
    const root = await t.prepare("Tighten the checkout copy.");
    const early = t.store.sendReply(root.id, { words: "Keep the button label.", idempotency_key: "early" }).reply!;
    expect(early.to?.session).toStartWith("launch:");
    await wake.sweep();
    expect(t.t3!.sends()).toEqual([]);
    t.launch.begin(root);
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(early.id)!.to).toEqual({ host: "t3", session });
    await until("the reply went in", async () => {
      await wake.sweep();
      return t.store.message(early.id)!.delivery;
    });
    expect(t.t3!.sends()).toEqual([["thread", "send", session, "-", "--json"]]);
    expect(t.t3!.turns().filter(([at]) => at === session).map(([, text]) => text.includes("Keep the button label."))).toEqual([false, true]);
  });

  test("the move to the thread and the delivery are one write: no record ever has the root on the thread and undelivered", async () => {
    const t = setup({ used: USED });
    const seen: { id: string; session?: string; delivered: boolean }[] = [];
    cleanup.push(
      t.store.subscribe((line) => {
        if (line.kind !== "message") return;
        const m = line.record as { id: string; to?: { session?: string }; delivery?: { state?: string } };
        seen.push({ id: m.id, ...(m.to?.session ? { session: m.to.session } : {}), delivered: m.delivery?.state === "delivered" });
      }),
    );
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    const onThread = seen.filter((m) => m.id === root.id && m.session === session);
    expect(onThread.length).toBeGreaterThan(0);
    expect(onThread.every((m) => m.delivered)).toBe(true);
    expect(InboxStore.open(t.dataDir).message(root.id)).toMatchObject({ to: { session }, delivery: { state: "delivered" } });
  });

  test("a start cut short (no answer in time) that made the thread: Try again takes that thread, never a second", async () => {
    const t = setup({ used: USED, startTimeoutMs: 1_500 });
    t.t3!.setState("taken-then-hang");
    const root = await t.send("Tighten the checkout copy.");
    const error = await until("the start timed out", () => t.store.message(root.id)!.launch!.error, 15_000);
    expect(error.text).toBe("T3 Code didn't answer within 2 seconds. Try again: if it made the thread, the Inbox picks it up.");
    // Uncertain, not refused: nothing started in the background beside a thread T3 may have made.
    expect(t.background).toEqual([]);
    t.t3!.setState("up");
    expect((await t.route(root.launch!.id, "retry")).ok).toBe(true);
    const session = await until("taken", () => t.store.message(root.id)!.launch!.session_ref);
    expect(session).toBe(t.t3!.starts()[0]!.id);
    expect(t.starts()).toHaveLength(1);
    expect(t.store.message(root.id)!.delivery).toMatchObject({ state: "delivered", session });
  }, 30_000);

  test("an Inbox that closed mid-start: the line says so, and Try again starts it in T3 Code", async () => {
    const t = setup({ used: USED });
    const root = await t.prepare("Tighten the checkout copy.");
    expect(t.launch.runOfMessage(root.id)).toMatchObject({ state: "failed", cause: T3_LAUNCH_INTERRUPTED });
    expect((await t.route(root.launch!.id, "retry")).ok).toBe(true);
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts()).toHaveLength(1);
  });

  test("a thread whose agent never reaches the Inbox: once T3 says its turn is over, after the wait, the line says it opened in T3 Code and isn't connected, with no Try again (refused in words, nothing started again); once it calls, the line goes", async () => {
    const t = setup({ used: USED });
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    t.clock.now += 9 * 60_000;
    expect(t.launch.runOfMessage(root.id)).toBeNull();
    t.clock.now += 2 * 60_000;
    const line = await until("the line", () => t.launch.runOfMessage(root.id));
    expect(line).toMatchObject({ state: "failed", cause: "Look at its thread there.", no_retry: true, t3: { started: true } });
    // An older window still offers Try again: refused in Rex's words, and nothing starts, here or in the background.
    expect(await t.route(root.launch!.id, "retry")).toEqual({ ok: false, message: INBOX_RUN_IN_T3_AGAIN, code: "launch_in_t3" });
    expect(t.starts()).toHaveLength(1);
    expect(t.background).toEqual([]);
    t.heard.set(session, t.clock.now);
    expect(t.launch.runOfMessage(root.id)).toBeNull();
  });

  test("a long first turn: while T3 says the run is active, nothing says not connected, however long it takes", async () => {
    const t = setup({ used: USED });
    t.t3!.setRunStatus("running");
    const root = await t.send("Tighten the checkout copy.");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    t.clock.now += 30 * 60_000;
    t.launch.runOfMessage(root.id);
    await until("T3 asked", () => t.t3!.calls().some((args) => args[1] === "show"));
    await Bun.sleep(100);
    expect(t.launch.runOfMessage(root.id)).toBeNull();
    t.t3!.setRunStatus("completed");
    t.clock.now += 61_000;
    expect(await until("the line", () => t.launch.runOfMessage(root.id))).toMatchObject({ state: "failed", t3: { started: true } });
  });
});

describe("a clone that brings hooks, with T3 Code chosen", () => {
  test("decision 4a, as Rex's start: it waits for Claude Code's own Trust folder; Trust folder starts the T3 thread in the clone", async () => {
    // A repository on disk, reached as https://github.com/acme/hooked through git's own URL rewrite: nothing leaves.
    const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-clone-")));
    cleanup.push(() => rmSync(fixtures, { recursive: true, force: true }));
    const gitEnv = { HOME: fixtures, PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (cwd: string, ...args: string[]) => {
      const ran = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
      if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
    };
    const work = join(fixtures, "work");
    mkdirSync(join(work, ".claude"), { recursive: true });
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] } }));
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first");
    mkdirSync(join(fixtures, "acme"));
    git(fixtures, "clone", "-q", "--bare", work, join(fixtures, "acme", "hooked.git"));

    const t = setup({ capabilities: CAPABILITIES, trust: true, login: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${fixtures}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/" } });
    const root = await t.sendClone("https://github.com/acme/hooked", "~/code/hooked");
    const folder = join(t.home, "code", "hooked");
    await until("the clone, then the wait for trust", () => t.store.message(root.id)!.launch!.error?.code === "untrusted");
    expect(t.store.message(root.id)!.launch!.clone).toMatchObject({ state: "done", brings: ["hooks"] });
    // Nothing started anywhere: not in T3, not in the background.
    expect(t.starts()).toEqual([]);
    expect(t.background).toEqual([]);
    const line = await t.launch.runOf(root.id, true);
    expect(line).toMatchObject({ state: "failed", untrusted: true, trust: { warning: "This folder has 1 hook that will run once you trust it." } });

    // Trust folder: Claude Code's own trust is saved, and the start goes on in T3, in the clone.
    await t.trust(root.launch!.id, "This folder has 1 hook that will run once you trust it.");
    expect(t.trusted!.has(folder)).toBe(true);
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.t3!.starts()).toHaveLength(1);
    expect(t.t3!.starts()[0]).toMatchObject({ cwd: folder, project: folder });
    expect(t.store.message(root.id)!.to!.host).toBe("t3");
    expect(t.background).toEqual([]);
  });
});

describe("a T3 run that failed at once", () => {
  test("T3 says the thread's run failed (its agent not signed in there): the not-connected line at once, not after the ten-minute wait", async () => {
    const t = setup({ used: USED });
    t.t3!.setRunStatus("failed");
    const root = await t.send("Tighten the checkout copy.");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    // Past the start's own grace, well inside the ten-minute wait.
    t.clock.now += 2 * 60_000;
    const line = await until("the line", () => {
      const run = t.launch.runOfMessage(root.id);
      return run?.state === "failed" ? run : null;
    });
    expect(line).toMatchObject({ cause: "Look at its thread there.", t3: { started: true } });
  });
});

describe("Settings → Agents: Start new agents in T3 Code", () => {
  test("offered while T3 Code is on this computer, with the agents that can start there; whether it is open now; saved as the choice", async () => {
    const t = setup({ startIn: "inbox" });
    expect(await t.settings()).toMatchObject({ start_in: "inbox", t3_here: true, t3_open: true, t3_agents: ["claude-code", "pi", "codex", "opencode"] });
    t.t3!.setState("down");
    expect(await t.settings()).toMatchObject({ t3_here: true, t3_open: false });
    const at = "/api/inbox/launch/settings";
    const saved = await t.launch.route(new Request(`http://127.0.0.1:4000${at}`, { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv", start_in: "t3" }) }), at, "local");
    expect(((await saved!.json()) as { launch: { start_in: string } }).launch.start_in).toBe("t3");
    expect(JSON.parse(readFileSync(join(t.dataDir, "config.json"), "utf8")).inboxLaunch.startIn).toBe("t3");

    const none = setup({ t3: false, startIn: "inbox" });
    expect(await none.settings()).toMatchObject({ t3_here: false, t3_open: false });
  });

  test("offered in this Inbox's tailnet window too, as Rex is (a Send from there starts in T3 Code here); never asked for the device door", async () => {
    const t = setup({ startIn: "inbox" });
    const at = "/api/inbox/launch/settings";
    const read = async (via: string, door?: { platform: string; window: boolean }) =>
      ((await (await t.launch.route(new Request(`http://127.0.0.1:4000${at}`, { headers: { host: "127.0.0.1:4000" } }), at, via, door ?? null))!.json()) as { launch: Record<string, unknown> }).launch;
    expect(await read("tailnet")).toMatchObject({ t3_here: true, t3_open: true });
    const doorRead = await read("local", { platform: "darwin", window: true });
    expect(doorRead.t3_here).toBeUndefined();
    expect(doorRead.t3_open).toBeUndefined();
  });
});

describe("T3 start pieces", () => {
  test("a test run never takes a t3 outside its temp folder (a t3 on the person's PATH), only one in its scratch home", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-path-")));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const hostWith = (which: string | null) =>
      createT3LaunchHost({
        platform: "darwin",
        environment: async () => ({ ...createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: { PLANNOTATOR_TEST_SANDBOX: "1" } }), which: () => which }),
      } as unknown as LaunchHostContext);
    expect(await hostWith("/opt/homebrew/bin/t3").available()).toMatchObject({ ok: false, code: "missing" });
    expect(await hostWith(join(home, "bin", "t3")).available()).toMatchObject({ ok: true });
    makeFakeT3Home(home, {});
    expect(await hostWith(null).available()).toMatchObject({ ok: true });
  });

  test("the model: the newest thread on that agent's own instance; else T3's first listed model for its driver, one that can run now first", () => {
    expect(t3NewestModelOf(JSON.stringify(USED), "claudeAgent")).toEqual({ provider: "claudeAgent", model: "sonnet" });
    expect(t3NewestModelOf(JSON.stringify(USED), "opencode")).toBeNull();
    expect(t3NewestModelOf(`log line\n${JSON.stringify(USED)}`, "codex")).toEqual({ provider: "codex", model: "gpt-5.5" });
    // A model that could be read as a flag or a path is never taken.
    expect(t3NewestModelOf(JSON.stringify([{ providerInstanceId: "codex", model: "--json" }]), "codex")).toBeNull();
    expect(t3ListedModelOf(CAPABILITIES, "claudeAgent")).toEqual({ provider: "claudeAgent", model: "opus" });
    const blocked = { providers: [{ providerInstanceId: "claude-work", driverKind: "claudeAgent", models: [{ id: "haiku" }], constraints: [{ kind: "signed-out" }] }, CAPABILITIES.providers[0]] };
    expect(t3ListedModelOf(blocked, "claudeAgent")).toEqual({ provider: "claudeAgent", model: "opus" });
    // Only providers that can run now: one T3 says is signed out would fail its first turn there.
    expect(t3ListedModelOf({ providers: [blocked.providers[0]] }, "claudeAgent")).toBeNull();
    expect(t3ListedModelOf({ providers: [] }, "claudeAgent")).toBeNull();
    expect(t3ListedModelOf(null, "claudeAgent")).toBeNull();
  });

  test("the token: read from T3's pretty JSON; sent only to a loopback origin T3's runtime file names", () => {
    const issued = JSON.stringify({ sessionId: "session-1", token: "secret", method: "bearer-session-token", scopes: ["orchestration:read"], subject: "mcp-client", client: {}, expiresAt: "2026-11-19T00:01:00.000Z" }, null, 2);
    expect(t3IssuedSessionOf(issued)).toEqual({ sessionId: "session-1", token: "secret" });
    expect(t3IssuedSessionOf("Issued session session-1.")).toBeNull();
    expect(t3IssuedSessionOf(JSON.stringify({ sessionId: "a b", token: "x" }))).toBeNull();

    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-origin-")));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const t3 = makeFakeT3Home(home, {}, { db: false, port: 4123 });
    const runtime = join(t3.dir, "userdata", "server-runtime.json");
    expect(t3LocalOrigin(t3.dir)?.href).toBe("http://127.0.0.1:4123/");
    for (const origin of ["http://t3.example.com:4123", "https://127.0.0.1:4123", "http://10.0.0.2:4123"]) {
      writeFileSync(runtime, JSON.stringify({ version: 1, pid: process.pid, port: 4123, origin, startedAt: "2026-11-14T00:00:00.000Z" }));
      expect(t3LocalOrigin(t3.dir)).toBeNull();
    }
    t3.setState("down");
    expect(t3LocalOrigin(t3.dir)).toBeNull();
  });

  test("a thread's turn as `thread show` says it: over when idle or its run ended; not while a run is active or it waits on the person; unknown when T3 didn't say", () => {
    const show = (thread: Record<string, unknown>) => `${JSON.stringify({ thread: { threadId: "t", ...thread }, messages: [] })}\n`;
    expect(t3TurnEndedOf(show({ status: "idle", activeRunId: null, pendingRequestCount: 0 }))).toBe(true);
    for (const status of ["completed", "cancelled", "interrupted", "rolled_back"]) expect(t3TurnEndedOf(show({ status, activeRunId: null }))).toBe(true);
    expect(t3TurnEndedOf(show({ status: "failed", activeRunId: null }))).toBe("failed");
    expect(t3TurnEndedOf(show({ status: "running", activeRunId: "run:1" }))).toBe(false);
    expect(t3TurnEndedOf(show({ status: "idle", activeRunId: null, pendingRequestCount: 1 }))).toBe(false);
    expect(t3TurnEndedOf(show({}))).toBeNull();
    expect(t3TurnEndedOf("not json")).toBeNull();
  });

  test("which thread a later start takes: only after an uncertain end, only a new one of the title made since, never one that is elsewhere in this Inbox", () => {
    const at = Date.parse("2026-11-17T10:00:00.000Z");
    const listed = [
      { threadId: "thread:project:p:new-known", title: "Fix login", createdAt: at + 5_000 },
      { threadId: "thread:project:p:new", title: "Fix login", createdAt: at + 2_000 },
      { threadId: "thread:project:p:older", title: "Fix login", createdAt: at - 60_000 },
      { threadId: "thread:project:p:before", title: "Fix login", createdAt: at - 120_000 },
    ];
    const known = (thread: string) => thread.endsWith("new-known");
    const attempt = (outcome: T3StartAttempt["outcome"]): T3StartAttempt => ({ title: "Fix login", before: ["thread:project:p:before"], listed: true, at, outcome });
    expect(t3AdoptableOf(attempt("uncertain"), "Fix login", listed, known)).toBe("thread:project:p:new");
    expect(t3AdoptableOf(attempt("running"), "Fix login", listed, known)).toBe("thread:project:p:new");
    for (const outcome of ["refused", "started"] as const) expect(t3AdoptableOf(attempt(outcome), "Fix login", listed, known)).toBeNull();
    expect(t3AdoptableOf(attempt("uncertain"), "Fix logout", listed, known)).toBeNull();
    expect(t3AdoptableOf(null, "Fix login", listed, known)).toBeNull();
  });

  test("the thread is read from --json's last line", () => {
    const thread = "thread:project:5b1d2c3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e:7c6d5e4f-3a2b-4c1d-9e0f-1a2b3c4d5e6f";
    expect(t3StartedThreadOf(`warming up\n${JSON.stringify({ threadId: thread, projectId: "p", runId: "r" })}\n`)).toBe(thread);
    expect(t3StartedThreadOf(JSON.stringify({ projectId: "p" }))).toBeNull();
    expect(t3StartedThreadOf("not json")).toBeNull();
  });
});
