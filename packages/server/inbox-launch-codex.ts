/**
 * The Codex host for launch (PLAN "Codex", HOST.md "Codex on the same
 * interface"): `createCodexLaunchHost`, the `LaunchHost` the engine holds as
 * `codex`. Its approval requests are inbox-launch-codex-permission.ts.
 *
 * Codex's own shared app-server daemon keeps the thread (`codex app-server
 * daemon start`: idempotent, one JSON object on stdout). The Inbox talks
 * JSON-RPC to it over a WebSocket on its control socket
 * (`$CODEX_HOME/app-server-control/app-server-control.sock`, `ws+unix`), one
 * connection per Inbox, opened when a launch needs it. `codex exec` does not
 * fit: it dies with its process and refuses every approval.
 *
 * What the real 0.165 CLI and its daemon (the managed 0.160 package) showed
 * (`.ops/work/launch-codex/smoke/`):
 *  - `thread/start {cwd}` subscribes this connection and answers the thread
 *    (its id is both the session and the ref); no first turn.
 *  - It writes `trust_level = "trusted"` for the folder into the person's
 *    `config.toml` when the folder has no trust yet. The Inbox never lets it:
 *    such a folder's trust is passed in memory (`config.projects`), as Codex
 *    would have written it, so the file stays byte for byte as it was.
 *  - The first turn and every reply go in as `turn/start` (the Codex wake
 *    asks `deliver`); a session busy with a turn gets it through `codex
 *    queue`, its next turn. After `turn/interrupt` (Stop) Codex keeps a queued
 *    message from running (its queue waits on an interrupted thread), so a
 *    reply after Stop must be a `turn/start`.
 *  - `turn/interrupt` with no turn running never answers: Stop interrupts
 *    only a running turn, and waits 5 s at most.
 *  - A dropped connection leaves the thread loaded; `thread/resume` rejoins it
 *    (and re-sends a pending approval). `thread/unsubscribe` keeps it loaded
 *    (it unloads after 30 min with no subscriber); `thread/delete` removes it.
 *
 * Every CLI call runs through `AgentEnvironment` with `killGroup: false`: the
 * call may start the person's shared daemon. Tests put a fake `codex` and a
 * fake daemon socket first on PATH (tests/helpers/fake-codex/).
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { INBOX_CODEX_HOST, INBOX_CODEX_NAME, parseCodexCliVersion, type InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { codexHome, createAgentEnvironmentFor, INBOX_MCP_SERVER_NAME, readCodexEntry } from "./inbox-agents";
import { createCodexPermissions } from "./inbox-launch-codex-permission";
import { launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import type { LaunchAvailability, LaunchDelivery, LaunchHost, LaunchHostContext, LaunchHostResult, LaunchPermissionContext } from "./inbox-launch-host";
import type { InboxRunHostState } from "@plannotator/core/inbox-run-line";

/** The first Codex CLI tested for launch (the daemon commands, `thread/*`, `codex queue`). Below it the To row is not offered. */
export const CODEX_LAUNCH_MIN_VERSION = "0.165.0";

const DAEMON_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** `turn/interrupt` answers only while a turn runs: Stop waits this long at most. */
const INTERRUPT_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

export const codexSocketOf = (home: string) => join(home, "app-server-control", "app-server-control.sock");

/** POSIX single-quoted. */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function codexAttachCommand(folder: string, threadId: string): string {
  return `cd ${shellQuote(folder)} && codex resume ${threadId}`;
}

/** `codex app-server daemon start`'s one JSON object: the socket, and the app-server's own version (the managed package's, not the CLI's). */
export function parseDaemonStart(stdout: string): { socketPath: string | null; appServerVersion: string | null } | null {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    return { socketPath: text(parsed.socketPath), appServerVersion: text(parsed.appServerVersion) ?? text(parsed.managedCodexVersion) };
  } catch {
    return null;
  }
}

/**
 * The trust a thread for `folder` needs in memory so Codex writes none into `config.toml`: nothing when the
 * person's file already has a trust level for the folder (as given or its real path) or for its repository's
 * root (Codex then reads theirs and writes nothing); else that folder trusted, for this thread only. Codex keys
 * a folder's entry before its repository's, so a trust set here never hides one the person set.
 */
export function codexTrustOverride(configText: string | null, folder: string, realFolder: string, repoRoot: string | null): Record<string, unknown> {
  let projects: Record<string, unknown> = {};
  try {
    const parsed = configText ? (Bun.TOML.parse(configText) as Record<string, unknown>) : {};
    if (parsed.projects && typeof parsed.projects === "object") projects = parsed.projects as Record<string, unknown>;
  } catch {
    // Unreadable: Codex itself would fail on it; trust in memory changes nothing on disk either way.
  }
  const hasTrust = (key: string | null) => {
    const entry = key ? projects[key] : undefined;
    return !!entry && typeof entry === "object" && typeof (entry as { trust_level?: unknown }).trust_level === "string";
  };
  if ([folder, realFolder, repoRoot].some(hasTrust)) return {};
  return { projects: Object.fromEntries([...new Set([realFolder, folder])].map((key) => [key, { trust_level: "trusted" }])) };
}

/** The git repository holding `folder` (a `.git` in it or above it), as Codex looks for it, or null. */
function repositoryOf(folder: string): string | null {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** A thread's status as the app-server says it (`thread/status/changed`, `thread/read`). */
export type CodexThreadStatus = { type: "notLoaded" } | { type: "idle" } | { type: "systemError" } | { type: "active"; activeFlags: string[] };

/** The run line's host vocabulary for a Codex thread (`InboxRunHostState`, shaped like `claude agents`). */
export function codexHostState(status: CodexThreadStatus | null): InboxRunHostState {
  if (!status || status.type === "notLoaded") return "absent";
  if (status.type === "active") {
    const flags = status.activeFlags ?? [];
    if (flags.includes("waitingOnApproval")) return { status: "waiting", state: "working", waitingFor: "approval" };
    if (flags.includes("waitingOnUserInput")) return { status: "waiting", state: "working", waitingFor: "input" };
    return { status: "busy", state: "working", waitingFor: null };
  }
  return { status: "idle", state: status.type === "systemError" ? "error" : "idle", waitingFor: null };
}

// ── The JSON-RPC client ──

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

export interface CodexConnection {
  readonly open: boolean;
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  respond(id: number | string, result: unknown): void;
  close(): void;
}

/**
 * Open the WebSocket on the control socket and say `initialize` / `initialized`. Server requests and
 * notifications go to `on`; `closed` once the socket goes.
 */
export async function connectCodex(
  socketPath: string,
  on: { notification(method: string, params: any): void; request(id: number | string, method: string, params: any): void; closed(): void },
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<CodexConnection> {
  const ws = new WebSocket(`ws+unix://${socketPath}:/`);
  let next = 1;
  let open = false;
  const waiting = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => {
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(error);
    }
    waiting.clear();
  };
  ws.onmessage = (event) => {
    let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) return on.request(message.id, message.method, message.params);
    if (message.method) return on.notification(message.method, message.params);
    const w = typeof message.id === "number" ? waiting.get(message.id) : undefined;
    if (!w) return;
    waiting.delete(message.id as number);
    clearTimeout(w.timer);
    if (message.error) w.reject(new CodexRpcError(w.method, message.error.code ?? null, message.error.message ?? "error"));
    else w.resolve(message.result);
  };
  ws.onclose = () => {
    const was = open;
    open = false;
    fail(new Error("the Codex app-server connection closed"));
    if (was) on.closed();
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("the Codex app-server socket did not answer"));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`the Codex app-server socket could not be opened (${socketPath})`));
    };
  });
  open = true;
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  const connection: CodexConnection = {
    get open() {
      return open;
    },
    request(method, params, ms = REQUEST_TIMEOUT_MS) {
      if (!open) return Promise.reject(new Error("the Codex app-server connection is closed"));
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new CodexRpcError(method, null, "no answer"));
        }, ms);
        waiting.set(id, { method, resolve, reject, timer });
        send({ id, method, params });
      });
    },
    respond(id, result) {
      if (open) send({ id, result });
    },
    close() {
      open = false;
      ws.close();
    },
  };
  try {
    await connection.request("initialize", { clientInfo: { name: "plannotator_inbox", title: "Plannotator Inbox", version: "1" }, capabilities: null }, timeoutMs);
  } catch (error) {
    connection.close();
    throw error;
  }
  send({ method: "initialized" });
  return connection;
}

// ── The host ──

/** What the host knows about one launched thread, from its events and reads. */
interface ThreadView {
  status: CodexThreadStatus;
  turnId: string | null;
  busySince: number | null;
  /** Rises on every sign of life (a start, a resume, a turn, a status change): Stop waits for a higher count. */
  polls: number;
  subscribed: boolean;
}

export function createCodexLaunchHost(ctx: LaunchHostContext) {
  const now = () => Date.now();
  const threads = new Map<string, ThreadView>();
  let connection: CodexConnection | null = null;
  let connecting: Promise<CodexConnection | null> | null = null;
  /** The socket the last `daemon start` named (else the one under CODEX_HOME). */
  let socketPath: string | null = null;
  let connectedAt = 0;
  let closing = false;
  let permissions: ReturnType<typeof createCodexPermissions> | null = null;
  let permissionContext: LaunchPermissionContext | null = null;

  /** The person's CODEX_HOME: the last login shell's, else the Inbox's, else `~/.codex`. */
  const home = () => {
    const value = ctx.shell()?.CODEX_HOME ?? ctx.ownEnv().CODEX_HOME;
    return codexHome(createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env: value ? { CODEX_HOME: value } : {} }));
  };
  const socket = () => socketPath ?? codexSocketOf(home());

  const viewOf = (threadId: string): ThreadView => {
    let view = threads.get(threadId);
    if (!view) {
      view = { status: { type: "notLoaded" }, turnId: null, busySince: null, polls: 0, subscribed: false };
      threads.set(threadId, view);
    }
    return view;
  };
  /** A new status. `life`: it counts as new life (an event on a thread this connection is on, a start, a resume, a read that differs). */
  const setStatus = (threadId: string, status: CodexThreadStatus, life = true) => {
    const view = viewOf(threadId);
    const wasActive = view.status.type === "active";
    view.status = status;
    if (life) view.polls += 1;
    if (status.type === "active" && !wasActive) view.busySince ??= now();
    if (status.type !== "active") view.busySince = null;
    if (status.type === "notLoaded") view.subscribed = false;
  };

  const onNotification = (method: string, params: any) => {
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId) return;
    switch (method) {
      // After Stop (unsubscribed) a late event is not new life: the session counts as live again only once it is resumed.
      case "thread/status/changed":
        if (params.status?.type) setStatus(threadId, params.status as CodexThreadStatus, viewOf(threadId).subscribed);
        break;
      case "turn/started": {
        const view = viewOf(threadId);
        view.turnId = params.turn?.id ?? null;
        if (view.status.type !== "active") setStatus(threadId, { type: "active", activeFlags: [] }, view.subscribed);
        else if (view.subscribed) view.polls += 1;
        break;
      }
      case "turn/completed": {
        const view = viewOf(threadId);
        view.turnId = null;
        if (view.subscribed) view.polls += 1;
        permissions?.turnEnded(threadId);
        break;
      }
      case "thread/closed":
        setStatus(threadId, { type: "notLoaded" });
        permissions?.turnEnded(threadId);
        break;
      case "item/started":
        if (params.item?.type === "fileChange") permissions?.fileChange(params.item.id, params.item.changes);
        break;
      case "serverRequest/resolved":
        permissions?.resolved(params.requestId);
        break;
    }
  };

  /** The daemon (started when `start` and not running) and the one connection. Null when it is not running and `start` is false. */
  const connect = (options: { start: false } | { start: true; env: LaunchEnv; launchId?: string }): Promise<CodexConnection | null> => {
    if (connection?.open) return Promise.resolve(connection);
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        if (!options.start && !existsSync(socket())) return null;
        const tryConnect = () =>
          connectCodex(socket(), {
            notification: onNotification,
            request: (id, method, params) => permissions?.asked(id, method, params),
            closed: () => {
              connection = null;
              for (const view of threads.values()) view.subscribed = false;
              permissions?.connectionLost();
              if (!closing) ctx.log("Inbox launch: the Codex app-server connection closed");
            },
          });
        try {
          connection = await tryConnect();
        } catch (error) {
          if (!options.start) return null;
          // Not running (or a stale socket): start the shared daemon, then connect to the socket it names.
          const e = await ctx.environment();
          const codex = e.which("codex");
          if (!codex) throw new Error("codex is not on the Inbox's PATH");
          const daemonEnv = createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env: launchSpawnEnv(options.env) });
          const result = await daemonEnv.run([codex, "app-server", "daemon", "start"], { timeoutMs: DAEMON_TIMEOUT_MS, killGroup: false });
          if (options.launchId) ctx.startLog(options.launchId, `codex app-server daemon start: exit ${result.exitCode}\n${result.stdout}${result.stderr}`);
          if (result.exitCode !== 0) throw new Error(`codex app-server daemon start exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
          const parsed = parseDaemonStart(result.stdout);
          if (parsed?.socketPath) socketPath = parsed.socketPath;
          connection = await tryConnect().catch((again: unknown) => {
            throw new Error(`${again instanceof Error ? again.message : String(again)} (before the start: ${error instanceof Error ? error.message : String(error)})`);
          });
        }
        connectedAt = now();
        return connection;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  /** The plain env (every call but a start): the daemon may be started by a resume or a delete too. */
  const plainEnv = async (): Promise<LaunchEnv> => {
    const e = await ctx.environment();
    return Object.fromEntries(Object.entries(e.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  };

  /** `thread/start` and `thread/resume`'s settings for a launch: full permissions when the record says so, the folder's trust in memory, the Inbox's data dir for its MCP entry. */
  const threadSettings = (launch: InboxLaunchRecord) => {
    let configText: string | null = null;
    try {
      configText = readFileSync(join(home(), "config.toml"), "utf8");
    } catch {
      // No config.toml: nothing to keep, and no trust to find.
    }
    let real = launch.folder;
    try {
      real = realpathSync(launch.folder);
    } catch {
      // Gone: the start fails on it anyway.
    }
    const isDefaultDataDir = ctx.dataDir === getDefaultPlannotatorDataDir(ctx.homeDir);
    const config: Record<string, unknown> = {
      ...codexTrustOverride(configText, launch.folder, real, repositoryOf(real)),
      // A test or second Inbox: the launched thread's Inbox MCP talks to this one.
      ...(isDefaultDataDir ? {} : { [`mcp_servers.${INBOX_MCP_SERVER_NAME}.env.PLANNOTATOR_DATA_DIR`]: ctx.dataDir }),
    };
    return {
      cwd: launch.folder,
      ...(launch.full_permissions ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  };

  /** config.toml's identity, to say in the start log if anything wrote it during a start (it never should). */
  const configStamp = () => {
    try {
      const stat = statSync(join(home(), "config.toml"));
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      return "absent";
    }
  };

  /** Rejoin a thread: loads it when the daemon unloaded it, subscribes this connection, re-sends a pending approval. */
  const resumeThread = async (conn: CodexConnection, launch: InboxLaunchRecord) => {
    const threadId = launch.session_ref!;
    const result = await conn.request("thread/resume", { threadId, excludeTurns: true, ...threadSettings(launch) });
    const view = viewOf(threadId);
    view.subscribed = true;
    setStatus(threadId, (result?.thread?.status as CodexThreadStatus) ?? { type: "idle" });
    return view;
  };

  /** The roots the engine gave this host's transport (its own launches only). */
  const myRoots = () => permissionContext?.roots() ?? [];

  /**
   * After an Inbox restart (or a dropped connection), at most every 15 s while a launch of ours is loaded: connect
   * (never starting the daemon), and rejoin each launched thread that runs a turn, so its pending approval is sent
   * again and comes to the card.
   */
  let lastLook = 0;
  const rejoin = async () => {
    if (connection?.open || connecting || now() - lastLook < 15_000) return;
    lastLook = now();
    const launches = myRoots().filter((root) => root.launch!.session_ref && !root.launch!.error);
    if (launches.length === 0) return;
    const conn = await connect({ start: false }).catch(() => null);
    if (!conn) return;
    const loaded = await loadedThreads(conn);
    for (const root of launches) {
      const ref = root.launch!.session_ref!;
      if (!loaded.has(ref)) {
        setStatus(ref, { type: "notLoaded" }, false);
        continue;
      }
      const read = await conn.request("thread/read", { threadId: ref }).catch(() => null);
      const status = read?.thread?.status as CodexThreadStatus | undefined;
      if (status) setStatus(ref, status);
      if (status?.type === "active") await resumeThread(conn, root.launch!).catch(() => undefined);
    }
  };

  const loadedThreads = async (conn: CodexConnection): Promise<Set<string>> => {
    const out = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const result = (await conn.request("thread/loaded/list", cursor ? { cursor } : {})) as { data?: string[]; nextCursor?: string | null };
      for (const id of result.data ?? []) out.add(id);
      cursor = result.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  };

  /** The turn running in a thread now: the one its events named, else the last in progress in its history. */
  const runningTurn = async (conn: CodexConnection, threadId: string): Promise<string | null> => {
    const view = threads.get(threadId);
    if (view?.turnId) return view.turnId;
    const read = await conn.request("thread/read", { threadId, includeTurns: true }).catch(() => null);
    const turns = (read?.thread?.turns ?? []) as { id: string; status: string }[];
    return [...turns].reverse().find((turn) => turn.status === "inProgress")?.id ?? null;
  };

  const ok = (text: string): LaunchHostResult => ({ exitCode: 0, text });
  const failed = (error: unknown): LaunchHostResult => ({ exitCode: 1, text: error instanceof Error ? error.message : String(error) });

  return {
    agent: INBOX_CODEX_HOST as "codex",
    name: INBOX_CODEX_NAME,
    // Of a login-shell read: CODEX_HOME (where the person's config, threads and the daemon's socket are).
    shellNames: ["CODEX_HOME"],

    /** `codex` on the plain env's PATH, new enough, and the Inbox's MCP entry on in its config.toml (how the thread answers in the Inbox). */
    async available(): Promise<LaunchAvailability> {
      const e = await ctx.environment();
      const path = e.which("codex");
      if (!path) return { ok: false, missing: true, reason: "codex is not on the Inbox's PATH" };
      const run = await e.run([path, "--version"], { timeoutMs: 10_000, killGroup: false });
      const version = parseCodexCliVersion(run.stdout);
      const text = version ? version.join(".") : null;
      if (!version || !versionAtLeast(version, CODEX_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `Codex ${text ?? "?"} is older than ${CODEX_LAUNCH_MIN_VERSION}` };
      const config = join(home(), "config.toml");
      if (readCodexEntry(config).kind !== "ours" || codexEntryDisabled(config)) return { ok: false, missing: false, reason: "the Inbox's MCP server is not on in Codex's config.toml" };
      return { ok: true, version: text! };
    },

    /** Full permissions when Settings → Agents' switch is on; otherwise the person's own config.toml decides (`own_mode`). */
    startOf: () => {
      const full = ctx.config().fullPermissions === true;
      return { full, ownMode: !full, bypass: false };
    },

    /** Codex's trust only picks a default approval policy, and the Inbox passes a new folder's trust in memory: every folder starts. */
    trusts: () => true,

    /** The daemon, then `thread/start` in the folder (subscribed, no turn): the Codex wake delivers the root after the engine settles it. */
    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      const e = await ctx.environment();
      if (!e.which("codex")) return { ok: false as const, code: "missing" as const, text: "codex is not on the Inbox's PATH." };
      try {
        const conn = (await connect({ start: true, env: input.login, launchId: launch.id }))!;
        const before = configStamp();
        const settings = threadSettings(launch);
        const result = await conn.request("thread/start", settings);
        const threadId = result?.thread?.id as string | undefined;
        if (!threadId) throw new Error("thread/start answered no thread");
        if (configStamp() !== before) ctx.startLog(launch.id, "warning: Codex's config.toml changed during thread/start");
        const view = viewOf(threadId);
        view.subscribed = true;
        setStatus(threadId, (result.thread.status as CodexThreadStatus) ?? { type: "idle" });
        ctx.startLog(launch.id, `thread/start: ${threadId} (${result.approvalPolicy ?? "?"}, ${result.sandbox?.type ?? "?"}${settings.config && "projects" in settings.config ? ", trust in memory" : ""})`);
        await conn.request("thread/name/set", { threadId, name: input.name.slice(0, 200) }).catch(() => undefined);
        return { ok: true as const, session: threadId, ref: threadId };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        ctx.startLog(launch.id, `error: ${text}`);
        return { ok: false as const, code: "failed" as const, text: text.slice(0, 300) };
      }
    },

    /** `thread/loaded/list` and each launched thread's `thread/read`. Never starts the daemon: not running, every thread reads as stopped. */
    async sessions() {
      const conn = await connect({ start: false }).catch(() => null);
      if (!conn) return () => "absent" as const;
      const loaded = await loadedThreads(conn);
      for (const root of myRoots()) {
        const ref = root.launch!.session_ref;
        if (!ref) continue;
        if (!loaded.has(ref)) {
          if (threads.has(ref) && threads.get(ref)!.status.type !== "notLoaded") setStatus(ref, { type: "notLoaded" });
          continue;
        }
        const read = await conn.request("thread/read", { threadId: ref }).catch(() => null);
        const status = read?.thread?.status as CodexThreadStatus | undefined;
        const view = viewOf(ref);
        if (status && JSON.stringify(status) !== JSON.stringify(view.status)) setStatus(ref, status);
      }
      return (ref: string) => (loaded.has(ref) ? codexHostState(threads.get(ref)?.status ?? null) : ("absent" as const));
    },

    /** Loaded in the daemon and this Inbox connected to it: busy while a turn runs. */
    live(session: string) {
      const view = threads.get(session);
      if (!connection?.open || !view || view.status.type === "notLoaded") return null;
      return { busy: view.status.type === "active", busySince: view.busySince, polls: view.polls };
    },

    /** A reply to a thread that is not live: the daemon (started again after a reboot), then `thread/resume`. The Codex wake delivers the reply. */
    async resume(launch: InboxLaunchRecord) {
      try {
        const conn = (await connect({ start: true, env: await plainEnv() }))!;
        const view = await resumeThread(conn, launch);
        return { ...ok(`thread/resume: ${view.status.type}`), failure: null };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { ...failed(error), failure: { code: "failed" as const, text: text.slice(0, 300) } };
      }
    },

    /** `turn/interrupt` of a running turn (5 s at most: it never answers with no turn), then `thread/unsubscribe`. The thread stays loaded. */
    async stop(ref: string) {
      const conn = await connect({ start: false }).catch(() => null);
      if (!conn) return ok("not running");
      const view = viewOf(ref);
      const said: string[] = [];
      if (view.status.type === "active") {
        const turnId = await runningTurn(conn, ref);
        if (turnId) {
          const answer = await conn.request("turn/interrupt", { threadId: ref, turnId }, INTERRUPT_TIMEOUT_MS).then(
            () => "interrupted",
            (error: unknown) => `interrupt: ${error instanceof Error ? error.message : String(error)}`,
          );
          said.push(answer);
        }
      }
      const unsubscribed = await conn.request("thread/unsubscribe", { threadId: ref }).then(
        (result: { status?: string }) => `unsubscribe: ${result?.status ?? "?"}`,
        (error: unknown) => `unsubscribe: ${error instanceof Error ? error.message : String(error)}`,
      );
      said.push(unsubscribed);
      view.subscribed = false;
      permissions?.turnEnded(ref);
      return ok(said.join("; "));
    },

    /** Delete: `thread/delete` (Codex's own history of it goes too). */
    async remove(ref: string) {
      try {
        const conn = (await connect({ start: true, env: await plainEnv() }))!;
        await conn.request("thread/unsubscribe", { threadId: ref }).catch(() => undefined);
        await conn.request("thread/delete", { threadId: ref });
        threads.delete(ref);
        return ok("thread/delete");
      } catch (error) {
        return failed(error);
      }
    },

    /** Codex keeps a thread's files by thread, and Delete removed this one's: nothing is kept for the folder. */
    purge: async () => ({ exitCode: 0, text: "", skipped: "Codex keeps nothing per folder beyond its threads" }),

    attach: (launch: InboxLaunchRecord) => (launch.session_ref ? codexAttachCommand(launch.folder, launch.session_ref) : null),
    /** `codex resume <id>` rejoins the live thread and shows a pending approval; before a thread exists, plain `codex` there. */
    terminal: (launch: InboxLaunchRecord) => (launch.session_ref ? codexAttachCommand(launch.folder, launch.session_ref) : `cd ${shellQuote(launch.folder)} && codex`),

    permissions(context: LaunchPermissionContext) {
      permissionContext = context;
      permissions = createCodexPermissions({
        ...context,
        respond: (id, result) => connection?.respond(id, result),
        steer: (threadId, turnId, text) =>
          void connection?.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] }).catch(() => undefined),
        status: (threadId) => (connection?.open ? (threads.get(threadId)?.status ?? null) : null),
        connectedAt: () => (connection?.open ? connectedAt : null),
        rejoin: () => void rejoin().catch(() => undefined),
      });
      return permissions;
    },

    /**
     * The Codex wake's text for a launched thread: `turn/start` when no turn runs (after Stop too, where a
     * queued message would wait), rejoining the thread first when this connection is not on it; `queue` while a
     * turn runs (it is the next turn).
     */
    async deliver(launch: InboxLaunchRecord, text: string): Promise<LaunchDelivery> {
      const threadId = launch.session_ref!;
      const conn = (await connect({ start: true, env: await plainEnv() }))!;
      let view = threads.get(threadId);
      if (!view?.subscribed) view = await resumeThread(conn, launch);
      if (view.status.type === "active") return "queue";
      await conn.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      return "delivered";
    },

    /** The Inbox stops: the connection goes (the daemon and its threads stay). */
    close() {
      closing = true;
      connection?.close();
      connection = null;
    },
  } satisfies LaunchHost;
}

function versionAtLeast(version: readonly number[], min: string): boolean {
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((version[i] ?? 0) !== (b[i] ?? 0)) return (version[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The Inbox's entry is there but `enabled = false`. */
function codexEntryDisabled(path: string): boolean {
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { mcp_servers?: Record<string, { enabled?: unknown }> };
    return parsed.mcp_servers?.[INBOX_MCP_SERVER_NAME]?.enabled === false;
  } catch {
    return false;
  }
}
