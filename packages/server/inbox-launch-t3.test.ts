/**
 * T3 Code as a launch host (issue #3590): New message → To → T3 Code and a project starts a new T3 thread there, in
 * a new git worktree, with the message as its first turn, on the agent and model picked (Default: the project's
 * own), and the person's replies go in through the T3 wake.
 *
 * The launch engine and the real T3 host against a fake T3 home (tests/helpers/fake-t3.ts: a `t3` launcher that
 * answers `thread start`, `list`, `show` and `send` as T3's cli/thread.ts does, and a scripted T3 MCP server for a
 * signed-in T3), in a scratch home and data folder. No Inbox server and no T3 run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseT3Capabilities, t3LaunchChoiceArgs, t3ThreadRunsOf, t3UsedModels } from "@plannotator/core/inbox-launch-choice";
import { INBOX_LAUNCHED_LINE, type InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { T3Credentials } from "@plannotator/t3-code/auth";
import { makeFakeT3Home, startFakeT3, type FakeT3UsedThread } from "../../tests/helpers/fake-t3";
import { stubBridge } from "../../tests/helpers/stub-bridge";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { codexQueueMessage } from "./inbox-codex-wake";
import { createInboxLaunch } from "./inbox-launch";
import { readLastLaunchChoice } from "./inbox-launch-choice";
import { coversHome, createT3LaunchHost, gitRepoOf, T3_LAUNCH_INTERRUPTED, T3_LAUNCH_NOT_OPEN, t3BaseOf, t3StartCause, t3StartedThreadOf, t3StartFailure } from "./inbox-launch-t3";
import type { LaunchHostContext } from "./inbox-launch-host";
import { createT3Local } from "./inbox-t3-local";
import { createInboxT3Wake } from "./inbox-t3-wake";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

/** The bridge command the wake words a message from, as inbox.ts's `replyCommand` gives it (the launched lines included). */
const commandOf = (item: InboxMessage): InboxReplyCommand => ({
  type: "reply",
  id: item.id,
  thread_id: item.thread_id,
  reply_to: item.reply_to ?? null,
  subject: null,
  body: item.body,
  url: "http://127.0.0.1/#thread",
  ...(item.launch ? { launched: { agent: item.launch.agent, project: true } } : {}),
});

/** A git repository as git leaves it on disk: `.git/HEAD` naming the branch it has checked out. No git is run. */
function repo(folder: string, head = "ref: refs/heads/main") {
  mkdirSync(join(folder, ".git"), { recursive: true });
  writeFileSync(join(folder, ".git", "HEAD"), `${head}\n`);
}

/** T3's `orchestrator_capabilities` answer, as a signed-in T3 with Claude Code (3 models, effort) and Codex (2) gives it. */
const CAPABILITIES = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: "claudeAgent",
      driverKind: "claudeAgent",
      displayName: null,
      models: [
        { id: "opus", options: [{ id: "effort", values: ["low", "medium", "high", "max"], default: "high" }, { id: "fastMode", values: [true, false] }] },
        { id: "sonnet", options: [{ id: "effort", values: ["low", "medium", "high"] }] },
        { id: "haiku" },
      ],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: null,
      models: [{ id: "gpt-5.5", options: [{ id: "effort", values: ["low", "medium", "high", "xhigh"] }] }, { id: "gpt-5.5-mini", label: "GPT-5.5 mini" }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
    // One the person added, named in T3: its own name. One the table doesn't know, unnamed: its instance id.
    { providerInstanceId: "claude-work", driverKind: "claudeAgent", displayName: "Claude (work)", models: [{ id: "opus" }], canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [] },
    { providerInstanceId: "zed-agent", driverKind: "acp", displayName: null, models: [{ id: "zeta-1" }], canRunChildTask: false, canRunCrossProviderChildTask: false, constraints: [] },
  ],
  features: {},
};

function setup(options: { t3?: boolean; known?: boolean; used?: FakeT3UsedThread[]; port?: number; machine?: string; startTimeoutMs?: number; home?: (home: string) => void } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-t3-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const shop = join(home, "code", "shop");
  const notes = join(home, "notes");
  for (const dir of [home, dataDir, shop, notes]) mkdirSync(dir, { recursive: true });
  repo(shop, "ref: refs/heads/release/2.4");
  options.home?.(home);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const t3 =
    options.t3 === false
      ? null
      : makeFakeT3Home(home, {}, { projects: options.known === false ? [] : [shop], ...(options.used ? { used: { [shop]: options.used } } : {}), ...(options.port ? { port: options.port } : {}) });
  const path = "/usr/bin:/bin";
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "shop", root: shop });
  const plain = store.ensureProject({ name: "notes", root: notes });
  const bridge = stubBridge(dataDir, store);
  cleanup.push(() => bridge.stop());
  const clock = { now: Date.now() };
  /** Sessions that called an Inbox tool (the Inbox's MCP presence), as `lastHeardOf` reads them. */
  const heard = new Map<string, number>();
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: (session) => bridge.runStateOf(session), lastHeardOf: (session) => heard.get(session) ?? null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    loginEnv: async () => ({ HOME: home, PATH: path, PLANNOTATOR_TEST_SANDBOX: "1" }),
    ownEnv: () => ({ HOME: home, PATH: path }),
    installDirs: [],
    displayFolder: (p) => p.replace(home, "~"),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
    now: () => clock.now,
    firstTurn: (message) => codexQueueMessage(commandOf(message)),
    ...(options.machine ? { machineName: () => options.machine! } : {}),
    ...(options.startTimeoutMs ? { hosts: (ctx: LaunchHostContext) => [createT3LaunchHost(ctx, { startTimeoutMs: options.startTimeoutMs })] } : {}),
  });
  cleanup.push(() => launch.stop());
  /** What compose sends: To's agent and project, and the pick (none for Default). */
  const prepare = async (body: string, at = project, pick: { model?: string; effort?: string } = {}, name = "Checkout copy") => {
    const target = launch.target({ launch: { agent: "t3", project_id: at.id, ...pick } })!;
    const prepared = await launch.prepare(target, { name, body, resolveProject: async () => at });
    return store.startPersonThread({ project_id: at.id, body, to: prepared.to, idempotency_key: `send-${body}`, thread_name: name, launch: prepared.launch }).message;
  };
  const send = async (body: string, at = project, pick: { model?: string; effort?: string } = {}, name = "Checkout copy") => {
    const message = await prepare(body, at, pick, name);
    launch.begin(message);
    return message;
  };
  const route = async (id: string, action: "retry" | "stop") => {
    const path = `/api/inbox/launch/${id}/${action}`;
    const request = new Request(`http://127.0.0.1:4000${path}`, { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv" }) });
    return launch.route(request, path, "local").then(
      async (response) => ({ ok: true as const, body: (await response!.json()) as Record<string, unknown> }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    );
  };
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: path, PLANNOTATOR_TEST_SANDBOX: "1" } });
  /** The T3 wake that exists already, reaching T3 through `t3 thread send`. */
  const wake = () => {
    const local = createT3Local({ environment, sendTimeoutMs: 5_000, probeMs: 25 });
    const made = createInboxT3Wake({ store, dataDir, commandOf, local, log: () => {} });
    cleanup.push(() => {
      made.stop();
      local.stop();
    });
    return made;
  };
  const starts = () => t3!.calls().filter((args) => args[0] === "thread" && args[1] === "start");
  return { root, home, dataDir, shop, notes, store, project, plain, t3, launch, prepare, send, route, wake, starts, clock, heard, environment };
}

/** The T3 host alone, on a setup's scratch home: its lists, as To's model button reads them. */
function hostOf(t: ReturnType<typeof setup>) {
  return createT3LaunchHost({
    dataDir: t.dataDir,
    homeDir: t.home,
    platform: process.platform,
    environment: async () => t.environment,
    launchDir: (id: string) => join(t.dataDir, "inbox", "launch", id),
    startLog: () => {},
    displayFolder: (p: string) => p,
    bridge: { runStateOf: () => null },
    log: () => {},
  } as unknown as LaunchHostContext);
}

describe("T3 Code through the launch engine, against a fake t3", () => {
  test("To offers T3 Code in the projects that are git repositories, always in a new worktree; with no t3, it is not on this computer", async () => {
    const t = setup();
    const block = (await t.launch.composeBlock())!;
    const entry = block.agents.find((a) => a.agent === "t3");
    expect(entry).toMatchObject({ name: "T3 Code", starts_in: [t.project.id], worktree: true });
    // The other agents start anywhere, as before.
    expect(block.agents.filter((a) => a.agent !== "t3").every((a) => a.starts_in === undefined && a.worktree === undefined)).toBe(true);

    const none = setup({ t3: false });
    const missing = (await none.launch.composeBlock())!;
    expect(missing.agents.map((a) => a.agent)).not.toContain("t3");
    expect(missing.not_ready).toContainEqual({ agent: "t3", name: "T3 Code", code: "missing" });
  });

  test("Default: one `t3 thread start` in the project with no agent or model flag, the checked-out branch as the base, the wake text on stdin; the root moves to the thread, delivered, and the line names what T3 runs", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    const [start] = t.t3!.starts();
    expect(start!.id).toBe(session);
    expect(start!.cwd).toBe(t.shop);
    expect(start!.base).toBe("release/2.4");
    expect(start!.title).toBe("Checkout copy");
    // Default passes nothing: T3 uses the project's own default model.
    expect(t.starts()).toEqual([["thread", "start", ".", "-", "--worktree=release/2.4", "--title=Checkout copy", "--json"]]);
    expect(start!).toMatchObject({ provider: null, model: null, options: [] });
    // The words the T3 wake would send the thread: the message, and the line that says the Inbox started it.
    const after = t.store.message(root.id)!;
    expect(start!.text).toBe(codexQueueMessage(commandOf(after)));
    expect(start!.text).toContain("Tighten the checkout copy.");
    expect(start!.text).toContain(INBOX_LAUNCHED_LINE);
    expect(after.to).toEqual({ host: "t3", session });
    expect(after.delivery).toMatchObject({ state: "delivered", host: "t3", session });
    // The message is never in the command line T3's process list shows.
    expect(t.t3!.calls().flat().join(" ")).not.toContain("Tighten");
    // After the start, T3 says what the thread runs: the meta line and the agent row name it.
    const inner = await until("what it runs", () => t.store.message(root.id)!.launch!.inner);
    expect(inner).toEqual({ provider: "claudeAgent", model: "opus", agent: "Claude Code" });
    expect(t.t3!.calls()).toContainEqual(["thread", "show", session, "--messages=0", "--json"]);
    expect(t.launch.agents().find((a) => a.session === session)?.inner).toEqual(inner);
  });

  test("a pick passes its agent and model, and its effort as T3's option; it is remembered for the next New message; an effort with Default is refused", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.", t.project, { model: "codex/gpt-5.5", effort: "high" });
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts()).toEqual([["thread", "start", ".", "-", "--worktree=release/2.4", "--title=Checkout copy", "--provider=codex", "--model=gpt-5.5", "--option=effort=high", "--json"]]);
    expect(t.t3!.starts()[0]).toMatchObject({ id: session, provider: "codex", model: "gpt-5.5", options: ["effort=high"] });
    expect(await until("what it runs", () => t.store.message(root.id)!.launch!.inner)).toEqual({ provider: "codex", model: "gpt-5.5", agent: "Codex" });
    expect(readLastLaunchChoice(t.dataDir, "t3")).toEqual({ model: "codex/gpt-5.5", effort: "high" });

    await expect(t.prepare("Again.", t.project, { effort: "high" })).rejects.toThrow("T3 Code takes an effort only with a model. Nothing was sent.");
  });

  test("a thread name that starts with a dash goes in as the title, never as a flag", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.", t.project, {}, "--wait");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts()[0]).toContain("--title=--wait");
    expect(t.t3!.starts()[0]!.title).toBe("--wait");
  });

  test("the T3 wake never takes the launch's placeholder: made before the Send, it runs no command of its own, and a failed start shows one line only", async () => {
    const t = setup();
    const wake = t.wake();
    await wake.sweep();
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    for (let i = 0; i < 3; i++) await wake.sweep();
    expect(t.starts()).toHaveLength(1);
    expect(t.t3!.sends()).toEqual([]);
    expect(t.t3!.calls().filter((args) => args.some((arg) => arg.startsWith("launch:")))).toEqual([]);
    expect(t.store.message(root.id)!.to!.session).toBe(session);

    const down = setup();
    down.t3!.setState("down");
    const downWake = down.wake();
    await downWake.sweep();
    const failed = await down.send("Tighten the checkout copy.");
    await until("the start failed", () => down.store.message(failed.id)!.launch!.error);
    for (let i = 0; i < 3; i++) await downWake.sweep();
    // No "waits for T3 Code" beside "T3 Code didn't start", and nothing sent to the placeholder.
    expect(down.store.message(failed.id)!.t3_wait).toBeUndefined();
    expect(down.t3!.sends()).toEqual([]);
  });

  test("the move to the new thread and the delivery are one write: no record ever has the root on the thread and undelivered", async () => {
    const t = setup();
    const seen: InboxMessage[] = [];
    const unsubscribe = t.store.subscribe((line) => {
      if (line.kind === "message") seen.push(line.record as InboxMessage);
    });
    cleanup.push(unsubscribe);
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    const onThread = seen.filter((m) => m.id === root.id && m.to?.session === session);
    expect(onThread.length).toBeGreaterThan(0);
    expect(onThread.every((m) => m.delivery?.state === "delivered")).toBe(true);
    // As the Inbox reads it again after a restart.
    expect(InboxStore.open(t.dataDir).message(root.id)).toMatchObject({ to: { session }, delivery: { state: "delivered" } });
  });

  test("a reply written while T3 starts the thread moves to the thread with the root, and goes in once", async () => {
    const t = setup();
    const root = await t.prepare("Tighten the checkout copy.");
    const early = t.store.sendReply(root.id, { words: "Keep the button label.", idempotency_key: "early" }).reply!;
    expect(early.to?.session).toStartWith("launch:");
    t.launch.begin(root);
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(early.id)!.to).toEqual({ host: "t3", session });
    const wake = t.wake();
    await until("the reply went in", async () => {
      await wake.sweep();
      return t.store.message(early.id)!.delivery;
    });
    expect(t.t3!.sends()).toEqual([["thread", "send", session, "-", "--json"]]);
  });

  test("a reply goes into the new thread once, through the T3 wake", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    const wake = t.wake();
    await wake.sweep();
    expect(t.t3!.sends()).toEqual([]);
    const reply = t.store.sendReply(root.id, { words: "Keep the button label.", idempotency_key: "r1" }).reply!;
    await until("the reply went in", async () => {
      await wake.sweep();
      return t.store.message(reply.id)!.delivery;
    });
    expect(t.t3!.sends()).toEqual([["thread", "send", session, "-", "--json"]]);
    expect(t.t3!.turns().filter(([at]) => at === session).map(([, text]) => text.includes("Keep the button label."))).toEqual([false, true]);
  });

  test("a start cut short (no answer in time) that made the thread: Try again takes that thread, never a second", async () => {
    const t = setup({ startTimeoutMs: 1_500 });
    t.t3!.setState("taken-then-hang");
    const root = await t.send("Tighten the checkout copy.");
    const error = await until("the start timed out", () => t.store.message(root.id)!.launch!.error, 15_000);
    expect(error.text).toBe("T3 Code didn't answer within 2 seconds. Try again: if it made the thread, the Inbox picks it up.");
    expect(t.t3!.starts()).toHaveLength(1);
    t.t3!.setState("up");
    expect((await t.route(root.launch!.id, "retry")).ok).toBe(true);
    const session = await until("taken", () => t.store.message(root.id)!.launch!.session_ref);
    expect(session).toBe(t.t3!.starts()[0]!.id);
    expect(t.starts()).toHaveLength(1);
    expect(t.store.message(root.id)!.delivery).toMatchObject({ state: "delivered", session });
  }, 30_000);

  test("an Inbox that closed mid-start: the line says so, and Try again starts it", async () => {
    const t = setup();
    // The thread was written, and the Inbox closed before the start ran (`begin` never came).
    const root = await t.prepare("Tighten the checkout copy.");
    expect(t.launch.runOfMessage(root.id)).toMatchObject({ state: "failed", cause: T3_LAUNCH_INTERRUPTED });
    expect((await t.route(root.launch!.id, "retry")).ok).toBe(true);
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.starts()).toHaveLength(1);
  });

  test("a thread whose agent never reaches the Inbox: after the wait, the line says it isn't connected; once it calls, the line goes", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    t.clock.now += 9 * 60_000;
    expect(t.launch.runOfMessage(root.id)).toBeNull();
    t.clock.now += 2 * 60_000;
    expect(t.launch.runOfMessage(root.id)).toMatchObject({ state: "failed", cause: "Started, but not connected to the Inbox. Is Plannotator's Inbox MCP server on in that folder?" });
    t.heard.set(session, t.clock.now);
    expect(t.launch.runOfMessage(root.id)).toBeNull();
  });

  test("Stop is refused for a T3 thread, in words an older window shows: T3 Code runs it", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.");
    await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    const said = await t.route(root.launch!.id, "stop");
    expect(said).toEqual({ ok: false, message: "T3 Code runs this thread in its own app. Stop it in T3 Code." });
    expect(t.launch.runOfMessage(root.id)?.state).not.toBe("stopped");
  });

  test("a project that is not a git repository, a scratch folder, another folder and a folder in a home-folder repository are refused before anything is made", async () => {
    const t = setup();
    await expect(t.send("Sort the notes.", t.plain)).rejects.toThrow("~/notes isn't a git repository. T3 Code starts its work in a new worktree of one. Nothing was sent.");
    const scratch = t.launch.target({ launch: { agent: "t3", scratch: true } })!;
    await expect(t.launch.prepare(scratch, { name: "Try", body: "x", resolveProject: async () => t.project })).rejects.toThrow("T3 Code starts only in a project's git repository, in a new worktree. Nothing was sent.");
    mkdirSync(join(t.home, "drafts"));
    const other = t.launch.target({ launch: { agent: "t3", folder: "~/drafts" } })!;
    await expect(t.launch.prepare(other, { name: "Try", body: "x", resolveProject: async () => t.project })).rejects.toThrow("isn't a git repository. T3 Code starts its work in a new worktree of one. Nothing was sent.");
    expect(t.t3!.calls()).toEqual([]);

    // A dotfiles repository at home holds every folder under it: notes is still no project's repository, shop still is.
    const dots = setup({ home: (home) => repo(home) });
    await expect(dots.send("Sort the notes.", dots.plain)).rejects.toThrow("isn't a git repository");
    expect((await dots.launch.composeBlock())!.agents.find((a) => a.agent === "t3")?.starts_in).toEqual([dots.project.id]);
  });

  test("when T3 refuses, the run line says why in plain words: T3 Code not open (named for linked machines), a folder T3 doesn't know; never a path", async () => {
    for (const state of ["down", "stale"] as const) {
      const down = setup();
      down.t3!.setState(state);
      const one = await down.send("Tighten the checkout copy.");
      const error = await until("the start failed", () => down.store.message(one.id)!.launch!.error);
      expect(error).toMatchObject({ code: "failed", text: T3_LAUNCH_NOT_OPEN });
      expect(error.text).not.toContain("/");
      expect(down.store.message(one.id)!.delivery).toBeUndefined();
    }

    // Read in every linked machine's window: it names the computer.
    const named = setup({ machine: "Mini" });
    named.t3!.setState("down");
    const there = await named.send("Tighten the checkout copy.");
    expect((await until("the start failed", () => named.store.message(there.id)!.launch!.error)).text).toBe("T3 Code isn't open on Mini. Open it there, then try again.");

    const unknown = setup({ known: false });
    const two = await unknown.send("Tighten the checkout copy.");
    const said = await until("the start failed", () => unknown.store.message(two.id)!.launch!.error);
    expect(said.text).toBe("shop isn't a project in T3 Code yet. Add its folder in T3 Code, then try again.");
  });
});

describe("the T3 model button's lists", () => {
  test("a signed-in T3 (the grant's endpoint is the T3 running here): each agent's models, labelled by agent, with each model's effort", async () => {
    const mcp = startFakeT3({ threads: [], capabilities: CAPABILITIES });
    cleanup.push(() => mcp.stop());
    const t = setup({ port: Number(mcp.endpoint.port) });
    new T3Credentials(t.dataDir, mcp.endpoint).save({ endpoint: mcp.endpoint.href, epoch: "e1", tokens: { access_token: mcp.state.token, token_type: "Bearer" } });
    const lists = (await hostOf(t).choices([t.shop]))!;
    expect(lists.models).toEqual(["claudeAgent/opus", "claudeAgent/sonnet", "claudeAgent/haiku", "codex/gpt-5.5", "codex/gpt-5.5-mini", "claude-work/opus", "zed-agent/zeta-1"]);
    expect(lists.model_labels).toEqual({
      "claudeAgent/opus": "Claude Code · opus",
      "claudeAgent/sonnet": "Claude Code · sonnet",
      "claudeAgent/haiku": "Claude Code · haiku",
      "codex/gpt-5.5": "Codex · gpt-5.5",
      "codex/gpt-5.5-mini": "Codex · GPT-5.5 mini",
      // T3's own name for an instance the person added; the raw id for an agent neither T3 nor the table names.
      "claude-work/opus": "Claude (work) · opus",
      "zed-agent/zeta-1": "zed-agent · zeta-1",
    });
    // Only the option T3 calls `effort` (a boolean option is not one); none with Default.
    expect(lists.model_efforts).toMatchObject({ "claudeAgent/opus": ["low", "medium", "high", "max"], "claudeAgent/haiku": [], "codex/gpt-5.5": ["low", "medium", "high", "xhigh"] });
    expect(lists.efforts).toEqual([]);
    // T3's list was read, not the threads'.
    expect(mcp.capabilityCalls).toBe(1);
    expect(t.t3!.calls().filter((args) => args[1] === "list")).toEqual([]);
  });

  test("no sign-in: the agents and models the project's T3 threads already used, newest first, no effort; an agent the table doesn't know reads as its id", async () => {
    const used = [
      { threadId: "thread:project:a:1", title: "Totals", providerInstanceId: "claudeAgent", model: "opus" },
      { threadId: "thread:project:a:2", title: "Copy", providerInstanceId: "codex", model: "gpt-5.5" },
      { threadId: "thread:project:a:3", title: "Again", providerInstanceId: "claudeAgent", model: "opus" },
      { threadId: "thread:project:a:4", title: "Mine", providerInstanceId: "my-agent", model: "m-1" },
    ];
    const t = setup({ used });
    const lists = (await hostOf(t).choices([t.shop]))!;
    expect(lists.models).toEqual(["claudeAgent/opus", "codex/gpt-5.5", "my-agent/m-1"]);
    expect(lists.model_labels).toEqual({ "claudeAgent/opus": "Claude Code · opus", "codex/gpt-5.5": "Codex · gpt-5.5", "my-agent/m-1": "my-agent · m-1" });
    expect(lists.efforts).toEqual([]);
    expect(lists.model_efforts).toEqual({});
    // And To offers them, once read (a slow read never holds the menu up).
    const offered = await until("the lists", async () => (await t.launch.composeBlock())!.agents.find((a) => a.agent === "t3")?.choices);
    expect(offered.models).toEqual(lists.models);
  });

  test("neither (no sign-in, no thread yet), or T3 not open: no lists, so no button; Default still starts", async () => {
    const t = setup({ used: [] });
    const host = hostOf(t);
    expect(await host.choices([t.shop])).toBeNull();
    t.t3!.setState("down");
    expect(await hostOf(t).choices([t.shop])).toBeNull();
  });
});

describe("T3 launch pieces", () => {
  test("a test run never offers a t3 outside its temp folder (a t3 on the person's PATH), only one in its scratch home", async () => {
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

  test("the start's flags: none for Default; an agent and model together, and an effort only with them", () => {
    expect(t3LaunchChoiceArgs({})).toEqual([]);
    expect(t3LaunchChoiceArgs({ effort: "high" })).toEqual([]);
    expect(t3LaunchChoiceArgs({ model: "opus" })).toEqual([]);
    expect(t3LaunchChoiceArgs({ model: "claudeAgent/opus" })).toEqual(["--provider=claudeAgent", "--model=opus"]);
    expect(t3LaunchChoiceArgs({ model: "opencode/anthropic/claude-x", effort: "max" })).toEqual(["--provider=opencode", "--model=anthropic/claude-x", "--option=effort=max"]);
  });

  test("T3's answers: a thread's agent and model from `thread show`, the pairs from `thread list`, a capabilities answer with no model", () => {
    expect(t3ThreadRunsOf(`${JSON.stringify({ thread: { threadId: "t", providerInstanceId: "codex", model: "gpt-5.5" }, messages: [] })}\n`)).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(t3ThreadRunsOf(JSON.stringify({ thread: { threadId: "t" } }))).toBeNull();
    expect(t3ThreadRunsOf("not json")).toBeNull();
    expect(t3UsedModels(["not json", "[]"])).toBeNull();
    expect(parseT3Capabilities({ providers: [{ providerInstanceId: "codex", models: [] }] })).toBeNull();
    expect(parseT3Capabilities(null)).toBeNull();
  });

  test("the base is the branch the folder has checked out, HEAD when detached, and a linked worktree's own HEAD; none outside a repository", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-base-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const main = join(root, "app");
    repo(main, "ref: refs/heads/feature/login");
    mkdirSync(join(main, "src", "deep"), { recursive: true });
    expect(t3BaseOf(join(main, "src", "deep"))).toBe("feature/login");
    expect(gitRepoOf(join(main, "src"))!.top).toBe(main);

    const detached = join(root, "detached");
    repo(detached, "3f2a9c0d1e4b5a6c7d8e9f0a1b2c3d4e5f6a7b8c");
    expect(t3BaseOf(detached)).toBe("HEAD");

    // A linked worktree: `.git` is a file naming its git dir, which has its own HEAD.
    const linked = join(root, "linked");
    const gitDir = join(main, ".git", "worktrees", "linked");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(linked);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fix/totals\n");
    writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
    expect(t3BaseOf(linked)).toBe("fix/totals");

    const plain = join(root, "plain");
    mkdirSync(plain);
    // The temp folder itself is in no repository either.
    expect(gitRepoOf(plain)).toBeNull();
    expect(t3BaseOf(plain)).toBeNull();

    // A repository at home or above it is no project's own; one below home is.
    expect(coversHome("/Users/me", "/Users/me")).toBe(true);
    expect(coversHome("/", "/Users/me")).toBe(true);
    expect(coversHome("/Users/me/code/shop", "/Users/me")).toBe(false);
  });

  test("the thread is read from --json's last line", () => {
    const thread = "thread:project:5b1d2c3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e:7c6d5e4f-3a2b-4c1d-9e0f-1a2b3c4d5e6f";
    expect(t3StartedThreadOf(`warming up\n${JSON.stringify({ threadId: thread, projectId: "p", runId: "r" })}\n`)).toBe(thread);
    expect(t3StartedThreadOf(JSON.stringify({ projectId: "p" }))).toBeNull();
    expect(t3StartedThreadOf("not json")).toBeNull();
  });

  test("a failed start's cause: the host's own sentence for each case it recognises, never T3's path or server words", () => {
    const failed = (stderr: string, machine?: string) => t3StartFailure({ exitCode: 1, stdout: "", stderr }, "shop", machine);
    // T3 Code not open: no server for its home, or a runtime file whose server does not answer.
    expect(failed("No running T3 Code server uses /Users/me/.t3. Start T3 Code, then retry.")).toBe("T3 Code isn't open on this computer. Open it, then try again.");
    expect(failed("Could not reach the T3 Code server at http://127.0.0.1:3773. connect ECONNREFUSED")).toBe("T3 Code isn't open on this computer. Open it, then try again.");
    expect(failed("No running T3 Code server uses /Users/me/.t3. Start T3 Code, then retry.", "Studio")).toBe("T3 Code isn't open on Studio. Open it there, then try again.");
    // The folder is in no project T3 knows.
    expect(failed("No T3 Code project matches '.'. Pass a project id or a path inside a project.")).toBe("shop isn't a project in T3 Code yet. Add its folder in T3 Code, then try again.");
    // No answer in time; an answer with no thread in it: Try again picks up a thread it made.
    expect(t3StartFailure({ timedOut: true, exitCode: null, stdout: "", stderr: "" }, "shop")).toBe("T3 Code didn't answer within 30 seconds. Try again: if it made the thread, the Inbox picks it up.");
    expect(t3StartFailure({ exitCode: 0, stdout: "{}", stderr: "" }, "shop")).toBe("T3 Code started a thread but didn't say which. Try again: the Inbox picks it up.");
  });

  test("a failure it does not recognise: T3's last line, one line, 300 characters at most, each absolute path cut to its last name", () => {
    expect(t3StartCause('noise\nBase ref "nope" does not resolve to a commit in project "shop" (/Users/me/code/shop).\n', "shop")).toBe('Base ref "nope" does not resolve to a commit in project "shop" (shop).');
    expect(t3StartCause("Worktree folder /Users/me/.t3/worktrees/shop/t3-1a2b3c4d is in use.", "shop")).toBe("Worktree folder t3-1a2b3c4d is in use.");
    expect(t3StartCause("Cannot write ~/.t3/userdata/state.json, C:\\Users\\me\\.t3\\x.db or '/var/tmp/t3' now", "shop")).toBe("Cannot write state.json, x.db or 't3' now.");
    // A URL is not a path.
    expect(t3StartCause("Fetch https://example.com/a/b failed", "shop")).toBe("Fetch https://example.com/a/b failed.");
    expect(t3StartCause("", "shop")).toBe("T3 Code did not say why.");
    expect(t3StartCause(`${"x".repeat(400)}`, "shop").length).toBeLessThanOrEqual(301);
  });
});
