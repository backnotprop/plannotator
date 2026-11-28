/**
 * The launch engine with "Start new agents in" T3 Code, against the T3 stand-in (fake-t3.ts), for the server tests of
 * starting an agent in T3 Code (inbox-launch-t3*.test.ts). A scratch home and data folder; no Inbox server, no T3 and
 * no agent run. The agents' own hosts are stand-ins (`background`) that record what they were asked to start, so a
 * fallback to the background is seen without a real Claude Code or Codex.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLaunchAgent, InboxLaunchRecord, InboxMessage } from "../../packages/core/inbox-types";
import { inboxLaunchedWakeOf } from "../../packages/core/inbox-run-line";
import type { InboxReplyCommand } from "../../packages/shared/inbox/connection";
import { InboxStore } from "../../packages/shared/inbox/store";
import { inboxBodyForAgent } from "../../packages/shared/inbox/uploads";
import { createAgentEnvironmentFor } from "../../packages/server/inbox-agents";
import { codexQueueMessage } from "../../packages/server/inbox-codex-wake";
import { createInboxDebugLog } from "../../packages/server/inbox-debug-log";
import { createInboxLaunch } from "../../packages/server/inbox-launch";
import type { LaunchHost, LaunchHostContext } from "../../packages/server/inbox-launch-host";
import type { InboxRexOpened } from "../../packages/server/inbox-rex";
import { createT3Local } from "../../packages/server/inbox-t3-local";
import { createInboxT3Wake } from "../../packages/server/inbox-t3-wake";
import { makeFakeT3Home, startFakeT3, type FakeT3, type FakeT3UsedThread } from "./fake-t3";
import { stubBridge } from "./stub-bridge";

export async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

/**
 * The bridge command the wake words a message from, built by the same rules inbox.ts's `replyCommand` uses for an
 * owner's message, the launched lines by `inboxLaunchedWakeOf` itself.
 */
export const commandOf = (item: InboxMessage): InboxReplyCommand => {
  const launched = inboxLaunchedWakeOf(item);
  return {
    type: item.to && !item.reply_to ? "message" : "reply",
    id: item.id,
    thread_id: item.thread_id,
    reply_to: item.reply_to ?? null,
    subject: null,
    body: inboxBodyForAgent(item),
    url: "http://127.0.0.1/#thread",
    ...(item.started_by_person && item.thread_id === item.id ? { new_thread: true } : {}),
    ...(launched ? { launched } : {}),
  };
};

/** T3's `orchestrator_capabilities` answer (its `OrchestratorMcpCapabilitiesResult`): Claude Code and Codex, first model first. */
export const CAPABILITIES = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    { providerInstanceId: "claudeAgent", driverKind: "claudeAgent", displayName: null, models: [{ id: "opus" }, { id: "sonnet" }], canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [] },
    { providerInstanceId: "codex", driverKind: "codex", displayName: null, models: [{ id: "gpt-5.5" }, { id: "gpt-5.5-mini" }], canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [] },
  ],
  features: {},
};

/**
 * An agent's own host, standing in: records each start and starts it in the background (`bg-1`, …). `trusted`: the
 * folders it trusts (absent: every one); its Trust folder offer warns on a folder that brings hooks, as Claude Code's
 * does, and trusts the folder once accepted.
 */
function backgroundHost(agent: InboxLaunchAgent, name: string, started: { agent: string; launch: InboxLaunchRecord }[], trusted?: Set<string>): LaunchHost {
  const nothing = { exitCode: 0, text: "" };
  return {
    agent,
    name,
    shellNames: [],
    available: async () => ({ ok: true, version: "1.0.0" }),
    // What New message offers it: a model and an effort the person may pick ("retired": one T3 no longer has).
    choices: async () => ({ models: agent === "codex" ? ["gpt-5.5", "gpt-5.5-mini"] : ["opus", "sonnet", "haiku", "retired"], efforts: ["low", "medium", "high", "max"], effort_word: "Effort" }),
    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: (folder) => !trusted || trusted.has(folder),
    ...(trusted
      ? {
          trustOffer: (target: { folder: string }) => ({
            folder: target.folder,
            read: () => (existsSync(join(target.folder, ".claude", "settings.json")) ? { warning: "This folder has 1 hook that will run once you trust it.", facts: ["Runs 1 hook"], warns: true } : { warning: null, facts: [], warns: false }),
            accept: async () => void trusted.add(target.folder),
          }),
        }
      : {}),
    start: async (launch) => {
      if (trusted && !trusted.has(launch.folder)) return { ok: false, code: "untrusted", text: `${launch.folder} isn't a trusted folder yet.` };
      started.push({ agent, launch });
      const session = `bg-${started.length}`;
      return { ok: true, session, ref: session };
    },
    sessions: async () => null,
    live: () => ({ busy: null, busySince: null, polls: 0 }),
    resume: async () => ({ ...nothing, failure: null }),
    stop: async () => nothing,
    remove: async () => nothing,
    purge: async () => nothing,
    attach: () => null,
    terminal: () => "",
    permissions: () => ({ sweep() {}, withdrawAll() {} }),
  };
}

export interface T3LaunchOptions {
  /** "Start new agents in" (default "t3"). */
  startIn?: "t3" | "rex" | "inbox";
  /** No T3 Code on this computer. */
  t3?: false;
  /** T3 doesn't know the project's folder yet. */
  known?: false;
  /** The threads T3 already has in the project, newest first. */
  used?: FakeT3UsedThread[];
  startTimeoutMs?: number;
  /** T3's MCP server answers `orchestrator_capabilities` with this (none: T3 lists nothing). */
  capabilities?: unknown;
  /** The token T3 issues (default: one the MCP stand-in takes). */
  authToken?: string;
  /** The origin T3's runtime file names (default: the MCP stand-in's loopback address). */
  origin?: string;
  /** Rex, standing in (only with `startIn` "rex", or to see that it is never asked). */
  rex?: boolean;
  /** T3's projects (default: the Inbox project's folder, unless `known` is false); `parent` names the folder holding it. */
  t3Projects?: (at: { shop: string; parent: string }) => string[];
  /** Linked git checkouts T3 sees (see fake-t3.ts `checkouts`), by the same names. */
  checkouts?: (at: { shop: string; parent: string }) => Record<string, string>;
  /** Claude Code trusts only the project's folder until its Trust folder offer is accepted (default: every folder). */
  trust?: true;
  /** More of the person's login env (a clone's git sees it: a URL rewrite to a repository on disk). */
  login?: Record<string, string>;
}

export function t3LaunchSetup(cleanup: (() => void | Promise<void>)[], options: T3LaunchOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-t3-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const shop = join(home, "code", "shop");
  for (const dir of [home, dataDir, shop]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, ...(options.startIn === "inbox" ? {} : { startIn: options.startIn ?? "t3" }) } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const mcp: FakeT3 = startFakeT3({ threads: [], ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}) });
  cleanup.push(() => mcp.stop());
  const t3 =
    options.t3 === false
      ? null
      : makeFakeT3Home(home, {}, {
          projects: options.t3Projects ? options.t3Projects({ shop, parent: join(home, "code") }) : options.known === false ? [] : [shop],
          ...(options.checkouts ? { checkouts: options.checkouts({ shop, parent: join(home, "code") }) } : {}),
          ...(options.used ? { used: { [shop]: options.used } } : {}),
          port: Number(mcp.endpoint.port),
          ...(options.authToken ? { authToken: options.authToken } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
        });
  const path = "/usr/bin:/bin";
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "shop", root: shop });
  const bridge = stubBridge(dataDir, store);
  cleanup.push(() => bridge.stop());
  const clock = { now: Date.now() };
  const heard = new Map<string, number>();
  const background: { agent: string; launch: InboxLaunchRecord }[] = [];
  const trusted = options.trust ? new Set([shop]) : undefined;
  const rexOpens: unknown[] = [];
  const rexOpened: InboxRexOpened = { opened: true, session: "session:x", window: "window:y", block: "block:z", line: "Rex · shop / Claude Code" };
  /** Every line the engine logs, as the Inbox's debug log (inbox-debug-log.ts) keeps it, in the data folder. */
  const debug = createInboxDebugLog(join(dataDir, "inbox"));
  const logged: string[] = [];
  const engine = () =>
    createInboxLaunch({
      store,
      live: { runStateOf: (session) => bridge.runStateOf(session), lastHeardOf: (session) => heard.get(session) ?? null },
      dataDir,
      serverSession: "srv",
      homeDir: home,
      platform: process.platform,
      loginEnv: async () => ({ HOME: home, PATH: path, PLANNOTATOR_TEST_SANDBOX: "1", ...options.login }),
      ownEnv: () => ({ HOME: home, PATH: path }),
      installDirs: [],
      displayFolder: (p) => p.replace(home, "~"),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      json: (body, status = 200) => Response.json(body, { status }),
      onChange: () => {},
      log: (line) => {
        logged.push(line);
        debug.note("launch", { line });
      },
      selfCommand: ["plannotator"],
      now: () => clock.now,
      firstTurn: (message) => codexQueueMessage(commandOf(message)),
      // Every agent T3 Code runs, standing in: no real Claude Code, Codex, OpenCode or Pi is ever asked anything.
      hosts: (_ctx: LaunchHostContext) => [backgroundHost("claude-code", "Claude Code", background, trusted), backgroundHost("codex", "Codex", background), backgroundHost("opencode", "OpenCode", background), backgroundHost("pi", "Pi", background)],
      ...(options.startTimeoutMs ? { t3StartTimeoutMs: options.startTimeoutMs } : {}),
      ...(options.rex
        ? {
            rex: {
              open: async (request) => (rexOpens.push(request), rexOpened),
              appAttachedNow: async () => true,
              paneGone: async () => false,
              closePane: async () => "closed" as const,
            },
          }
        : {}),
    });
  const launch = engine();
  cleanup.push(() => launch.stop());
  const restart = () => {
    launch.stop();
    const again = engine();
    cleanup.push(() => again.stop());
    return again;
  };
  /** What compose sends: the agent and project; `name` null: no thread name (T3's title is the subject). */
  const prepare = async (body: string, agent: InboxLaunchAgent = "claude-code", name: string | null = "Checkout copy", extra: { background?: true } = {}, pick: { model?: string; effort?: string } = {}) => {
    const target = launch.target({ launch: { agent, project_id: project.id, ...pick } })!;
    const prepared = await launch.prepare(target, { name, body, resolveProject: async () => project, ...extra });
    return store.startPersonThread({ project_id: project.id, body, to: prepared.to, idempotency_key: `send-${body}`, ...(name !== null ? { thread_name: name } : {}), launch: prepared.launch }).message;
  };
  const send = async (body: string, agent: InboxLaunchAgent = "claude-code", name: string | null = "Checkout copy", pick: { model?: string; effort?: string } = {}) => {
    const message = await prepare(body, agent, name, {}, pick);
    launch.begin(message);
    return message;
  };
  const route = async (id: string, action: "retry" | "stop" | "open") => {
    const at = `/api/inbox/launch/${id}/${action}`;
    const request = new Request(`http://127.0.0.1:4000${at}`, { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv" }) });
    return launch.route(request, at, "local").then(
      async (response) => ({ ok: true as const, body: (await response!.json()) as Record<string, unknown> }),
      (error: Error & { code?: string }) => ({ ok: false as const, message: error.message, code: error.code }),
    );
  };
  /** A Send that clones `url` into `folder` (`~/…`) and starts Claude Code there. */
  const sendClone = async (url: string, folder: string) => {
    const target = launch.target({ launch: { agent: "claude-code", folder, clone: { url } } })!;
    const prepared = await launch.prepare(target, { name: "Cent drift", body: "Find the cent drift.", resolveProject: async (p) => store.ensureProject({ name: p.split("/").pop()!, root: p }) });
    const message = store.startPersonThread({ project_id: prepared.project.id, body: "Find the cent drift.", to: prepared.to, idempotency_key: `clone-${url}`, thread_name: "Cent drift", launch: prepared.launch }).message;
    launch.begin(message);
    return message;
  };
  /** The run line's Trust folder, pressed in this computer's window on the warning it read. */
  const trust = async (id: string, warning: string | null) => {
    const at = `/api/inbox/launch/${id}/trust`;
    const request = new Request(`http://127.0.0.1:4000${at}`, { method: "POST", headers: { host: "127.0.0.1:4000", origin: "http://127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv", warning }) });
    return (await launch.route(request, at, "local"))!.json() as Promise<Record<string, unknown>>;
  };
  /** Settings → Agents' own read, as this computer's window asks it. */
  const settings = async () => {
    const response = await launch.route(new Request("http://127.0.0.1:4000/api/inbox/launch/settings", { headers: { host: "127.0.0.1:4000" } }), "/api/inbox/launch/settings", "local");
    return ((await response!.json()) as { launch: Record<string, unknown> }).launch;
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
  return { root, home, dataDir, shop, store, project, t3, mcp, launch, restart, prepare, send, sendClone, trust, trusted, route, settings, wake, starts, clock, heard, environment, background, rexOpens, debug, logged };
}
