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

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
 * Whether Codex itself would write a folder's trust for this thread (thread_processor.rs: only when the effective
 * permissions can write the folder): the person's `sandbox_mode` (their selected `profile`'s first) being
 * `workspace-write` or `danger-full-access`. Unset is `read-only` (Codex's default for a folder with no trust
 * decision), which writes nothing. A named `default_permissions` profile is not read here: no trust is passed,
 * and Codex decides as it would in its own TUI.
 */
export function codexWritesTrust(configText: string | null): boolean {
  let parsed: Record<string, any> = {};
  try {
    parsed = configText ? (Bun.TOML.parse(configText) as Record<string, any>) : {};
  } catch {
    return false;
  }
  const profile = typeof parsed.profile === "string" ? parsed.profiles?.[parsed.profile] : undefined;
  if ((profile && profile.default_permissions !== undefined) || parsed.default_permissions !== undefined) return false;
  const mode = profile?.sandbox_mode ?? parsed.sandbox_mode;
  return mode === "workspace-write" || mode === "danger-full-access";
}

/**
 * The trust a thread for `folder` needs in memory so Codex writes none into `config.toml`, found as Codex finds the
 * folder's project (config_toml.rs `get_active_project`): the first of the folder's real path, the folder as given,
 * then its trust root (`codexTrustRoot`: a linked worktree's main checkout) that has an entry. That entry with a trust
 * level (trusted or untrusted): nothing, Codex reads it and writes nothing. No entry, or one with no trust level:
 * the folder trusted for this thread only, and only when Codex itself would have written it (`writes`).
 */
export function codexTrustOverride(configText: string | null, folder: string, realFolder: string, trustRoot: string | null, writes: boolean): Record<string, unknown> {
  let projects: Record<string, unknown> = {};
  try {
    const parsed = configText ? (Bun.TOML.parse(configText) as Record<string, unknown>) : {};
    if (parsed.projects && typeof parsed.projects === "object") projects = parsed.projects as Record<string, unknown>;
  } catch {
    // Unreadable: Codex itself would fail on it; nothing is passed.
    return {};
  }
  const keys = [realFolder, folder, ...(trustRoot ? [realPathOr(trustRoot), trustRoot] : [])];
  const found = keys.map((key) => projects[key]).find((entry) => entry !== undefined);
  if (found && typeof found === "object" && typeof (found as { trust_level?: unknown }).trust_level === "string") return {};
  if (!writes) return {};
  return { projects: Object.fromEntries([...new Set([realFolder, folder])].map((key) => [key, { trust_level: "trusted" }])) };
}

const realPathOr = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A small git metadata file's text (a regular file, not a link, at most 64 KiB), or null. */
function metadataFile(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A `.git` file's `gitdir:` target, resolved from its folder, or null. */
function gitdirOf(dotGit: string): string | null {
  const text = metadataFile(dotGit)?.trim();
  if (!text?.startsWith("gitdir:")) return null;
  const target = text.slice("gitdir:".length).trim();
  return target ? resolve(dirname(dotGit), target) : null;
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folder Codex keys a folder's trust by after the folder itself (codex git-utils trust.rs
 * `resolve_root_git_project_for_trust`): the nearest folder with a `.git` (a folder holding `HEAD`, or a file);
 * for a linked worktree, its main checkout, once the worktree's and the main checkout's git metadata agree. Null
 * when there is none, or for a `.git` file that is not a linked worktree (a submodule).
 */
export function codexTrustRoot(folder: string): string | null {
  let base = isDir(folder) ? folder : dirname(folder);
  let root: string | null = null;
  for (;;) {
    let dir = base;
    let candidate: string | null = null;
    for (;;) {
      if (existsSync(join(dir, ".git"))) {
        candidate = dir;
        break;
      }
      if (dirname(dir) === dir) return null;
      dir = dirname(dir);
    }
    const dotGit = join(candidate, ".git");
    if (!isDir(dotGit) || existsSync(join(dotGit, "HEAD"))) {
      root = candidate;
      break;
    }
    if (dirname(candidate) === candidate) return null;
    base = dirname(candidate);
  }
  const dotGit = join(root, ".git");
  if (isDir(dotGit)) return root;
  const gitDir = gitdirOf(dotGit);
  if (!gitDir) return null;
  try {
    const stat = lstatSync(gitDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const canonical = realpathSync(gitDir);
    if (basename(dirname(canonical)) !== "worktrees") return null;
    const commonDir = dirname(dirname(canonical));
    const registered = metadataFile(join(canonical, "gitdir"))?.trim();
    const common = metadataFile(join(canonical, "commondir"))?.trim();
    if (!registered || !common) return null;
    const worktreeDotGit = resolve(canonical, registered);
    if (basename(worktreeDotGit) !== ".git") return null;
    if (realpathSync(dirname(worktreeDotGit)) !== realpathSync(root) || realpathSync(resolve(canonical, common)) !== commonDir) return null;
    // The main checkout, spelled from the worktree's own pointer (Codex keeps that spelling), owning that common dir.
    const mainRoot = dirname(dirname(dirname(gitDir)));
    const mainDotGit = join(mainRoot, ".git");
    const mainGitDir = isDir(mainDotGit) ? mainDotGit : gitdirOf(mainDotGit);
    if (!mainGitDir || realpathSync(mainGitDir) !== commonDir) return null;
    return mainRoot;
  } catch {
    return null;
  }
}

/**
 * The thread note for a turn that failed (`turn/completed` with `status: "failed"`): Codex's own `turn.error.message`
 * as one line, every control or invisible character dropped, Markdown's marks escaped, 300 characters at most.
 */
export function codexTurnErrorNote(message: string): string {
  const flat = message
    // The zero-width joiner stays (it holds an emoji together).
    .replace(/(?:(?!‍)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const short = [...flat].length > 300 ? `${[...flat].slice(0, 299).join("").trimEnd()}…` : flat;
  // Only marks the Inbox's inline Markdown both formats and unescapes.
  const shown = short.replace(/[\\`*_[\]~#>|$!&{}]/g, (mark) => `\\${mark}`);
  return shown ? `Codex's turn ended with an error: ${shown}` : "Codex's turn ended with an error.";
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

/** The request never went (the connection was closed before it): nothing reached Codex. */
export class CodexNotSentError extends Error {}

/** Codex's streamed text, which the Inbox never reads: not sent to this connection (`initialize`'s opt-out). */
export const CODEX_OPT_OUT_NOTIFICATIONS = [
  "command/exec/outputDelta",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "process/outputDelta",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
];

/** A request whose outcome is unknown: it went, and no answer came (timed out, or the connection closed after it). */
export const codexAnswerUnknown = (error: unknown): boolean => !(error instanceof CodexNotSentError) && !(error instanceof CodexRpcError && error.code !== null);

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
  /** False when the connection is closed (nothing went). */
  respond(id: number | string, result: unknown): boolean;
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
      if (!open) return Promise.reject(new CodexNotSentError("the Codex app-server connection is closed"));
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
      if (!open) return false;
      send({ id, result });
      return true;
    },
    close() {
      open = false;
      ws.close();
    },
  };
  try {
    await connection.request("initialize", { clientInfo: { name: "plannotator_inbox", title: "Plannotator Inbox", version: "1" }, capabilities: { optOutNotificationMethods: CODEX_OPT_OUT_NOTIFICATIONS } }, timeoutMs);
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
        if (params.turn?.status === "failed") turnFailed(threadId, params.turn);
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

  /**
   * A launched thread's turn failed (the provider refused the model or the login): Codex answers nothing in the
   * Inbox, so one note from the session says it, with Codex's own words (and the logs). Once per turn.
   */
  const turnFailed = (threadId: string, turn: { id?: unknown; error?: { message?: unknown } | null }) => {
    const root = myRoots().find((r) => r.launch!.session_ref === threadId);
    if (!root || !permissionContext) return;
    const text = typeof turn.error?.message === "string" ? turn.error.message : "";
    const launchId = root.launch!.id;
    if (existsSync(permissionContext.launchDir(launchId))) ctx.startLog(launchId, `turn ${String(turn.id)} failed: ${text.slice(0, 2000)}`);
    ctx.log(`Inbox launch ${launchId}: a Codex turn failed: ${text.slice(0, 200)}`);
    try {
      const { store } = permissionContext;
      const latest = store.threadMessageIds(root.thread_id).at(-1) ?? root.id;
      store.sendMessage({
        project_id: root.project_id,
        author: { kind: "agent", host: INBOX_CODEX_HOST, session: threadId, name: INBOX_CODEX_NAME },
        body: codexTurnErrorNote(text),
        reply_to: latest,
        idempotency_key: `codex-error-${threadId}-${String(turn.id)}`,
      });
      permissionContext.onChange();
    } catch (error) {
      ctx.log(`Inbox launch ${launchId}: the turn's error note was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The daemon (started when `start` and not running) and the one connection. Null when it is not running and `start` is false. */
  /** `env`: the env the daemon starts with, read only when it must start (a login-shell read is never made for nothing). */
  const connect = async (options: { start: false } | { start: true; env: () => Promise<LaunchEnv>; launchId?: string }): Promise<CodexConnection | null> => {
    if (connection?.open) return connection;
    if (connecting) {
      // One attempt at a time; one that would not start the daemon (and found none) is followed by this one's start.
      const got = await connecting;
      if (got || !options.start) return got;
      return connect(options);
    }
    // No daemon and no start: nothing to wait for (never a slot for it).
    if (!options.start && !existsSync(socket())) return null;
    const attempt = (async (): Promise<CodexConnection | null> => {
      const tryConnect = () =>
        connectCodex(socket(), {
          notification: onNotification,
          request: (id, method, params) => permissions?.asked(id, method, params),
          closed: () => {
            // A late close of an earlier connection: the newer one stays.
            if (connection?.open) return;
            connection = null;
            for (const view of threads.values()) view.subscribed = false;
            permissions?.connectionLost();
            if (!closing) ctx.log("Inbox launch: the Codex app-server connection closed");
          },
        });
      let made: CodexConnection;
      try {
        made = await tryConnect();
      } catch (error) {
        if (!options.start) return null;
        // Not running (or a stale socket): start the shared daemon, then connect to the socket it names.
        const e = await ctx.environment();
        const codex = e.which("codex");
        if (!codex) throw new Error("codex is not on the Inbox's PATH");
        const daemonEnv = createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env: launchSpawnEnv(await options.env()) });
        const result = await daemonEnv.run([codex, "app-server", "daemon", "start"], { timeoutMs: DAEMON_TIMEOUT_MS, killGroup: false });
        if (options.launchId) ctx.startLog(options.launchId, `codex app-server daemon start: exit ${result.exitCode}\n${result.stdout}${result.stderr}`);
        if (result.exitCode !== 0) throw new Error(`codex app-server daemon start exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
        const parsed = parseDaemonStart(result.stdout);
        if (parsed?.socketPath) socketPath = parsed.socketPath;
        made = await tryConnect().catch((again: unknown) => {
          throw new Error(`${again instanceof Error ? again.message : String(again)} (before the start: ${error instanceof Error ? error.message : String(error)})`);
        });
      }
      // The Inbox stopped meanwhile: this host holds nothing any more.
      if (closing) {
        made.close();
        return null;
      }
      connection = made;
      connectedAt = now();
      // A new connection is on no thread: rejoin the launched threads that run a turn (their approvals come again).
      queueMicrotask(() => void rejoinThreads(made).catch(() => undefined));
      return made;
    })();
    connecting = attempt;
    // Settled: the slot is free, and only this attempt's (cleared after it was stored, never before).
    void attempt.then(
      () => {
        if (connecting === attempt) connecting = null;
      },
      () => {
        if (connecting === attempt) connecting = null;
      },
    );
    return attempt;
  };
  /** `connect` with the daemon started when needed: a connection, or an error saying why not. */
  const connectStarted = async (env: () => Promise<LaunchEnv>, launchId?: string): Promise<CodexConnection> => {
    const conn = await connect({ start: true, env, ...(launchId ? { launchId } : {}) });
    if (!conn) throw new Error("the Codex app-server did not start");
    return conn;
  };

  /** A reply's restart (`resume`, `deliver`) may start the daemon: with a fresh login-shell read, as `start` has, made only then. */
  const loginEnv = () => ctx.loginEnv();

  /**
   * `thread/start` and `thread/resume`'s settings for a launch: the folder's trust in memory and the Inbox's data dir
   * for its MCP entry. Never an approval policy or a sandbox: Codex runs with the person's own Codex settings.
   */
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
      ...codexTrustOverride(configText, launch.folder, real, codexTrustRoot(real), codexWritesTrust(configText)),
      // A test or second Inbox: the launched thread's Inbox MCP talks to this one.
      ...(isDefaultDataDir ? {} : { [`mcp_servers.${INBOX_MCP_SERVER_NAME}.env.PLANNOTATOR_DATA_DIR`]: ctx.dataDir }),
    };
    return {
      cwd: launch.folder,
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
    if (!myRoots().some((root) => root.launch!.session_ref && !root.launch!.error)) return;
    // A new connection rejoins its threads by itself (`connect`).
    await connect({ start: false }).catch(() => null);
  };
  /**
   * On every new connection (an Inbox restart, a daemon restart, a dropped socket): each launched thread that is
   * loaded and runs a turn, and that this connection is not on, is rejoined, so Codex sends its pending approval
   * again and the card's answer can go.
   */
  const rejoinThreads = async (conn: CodexConnection) => {
    const launches = myRoots().filter((root) => root.launch!.session_ref && !root.launch!.error);
    if (launches.length === 0 || !conn.open) return;
    const loaded = await loadedThreads(conn);
    for (const root of launches) {
      const ref = root.launch!.session_ref!;
      if (!loaded.has(ref)) {
        setStatus(ref, { type: "notLoaded" }, false);
        continue;
      }
      const read = await conn.request("thread/read", { threadId: ref }).catch(() => null);
      const status = read?.thread?.status as CodexThreadStatus | undefined;
      if (status) setStatus(ref, status, threads.get(ref)?.subscribed === true);
      if (status?.type === "active" && !threads.get(ref)?.subscribed) await resumeThread(conn, root.launch!).catch(() => undefined);
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

    /** Always the person's own Codex settings (`own_mode`): Settings → Agents' full-permissions switch is Claude Code's. */
    startOf: () => ({ full: false, ownMode: true, bypass: false }),

    /** Codex's trust only picks a default approval policy, and the Inbox passes a new folder's trust in memory: every folder starts. */
    trusts: () => true,

    /** The daemon, then `thread/start` in the folder (subscribed, no turn): the Codex wake delivers the root after the engine settles it. */
    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      const e = await ctx.environment();
      if (!e.which("codex")) return { ok: false as const, code: "missing" as const, text: "codex is not on the Inbox's PATH." };
      try {
        const conn = await connectStarted(async () => input.login, launch.id);
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
        const conn = await connectStarted(loginEnv);
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
      // What this Inbox last saw may be old (a turn started from Terminal): the thread as it is now, 5 s at most.
      const read = await conn.request("thread/read", { threadId: ref }, INTERRUPT_TIMEOUT_MS).catch(() => null);
      const status = read?.thread?.status as CodexThreadStatus | undefined;
      if (status && JSON.stringify(status) !== JSON.stringify(view.status)) setStatus(ref, status, false);
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

    /**
     * Delete: `thread/delete` (Codex's own history of it goes too). Never starts the daemon: with none running the
     * thread is left in Codex's history, and the log says so.
     */
    async remove(ref: string) {
      try {
        const conn = await connect({ start: false }).catch(() => null);
        if (!conn) {
          ctx.log(`Inbox launch: the Codex app-server is not running; thread ${ref} was not deleted in Codex (\`codex resume\` still lists it)`);
          return ok("skipped: the Codex app-server is not running");
        }
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
        respond: (id, result) => connection?.respond(id, result) ?? false,
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
    async deliver(launch: InboxLaunchRecord, text: string, signal: AbortSignal): Promise<LaunchDelivery> {
      const threadId = launch.session_ref!;
      // A Stop or Delete pressed meanwhile: no turn after it (the engine asks again once it is done).
      const stopped = { failed: "a Stop or Delete came first" } as const;
      const conn = await connectStarted(loginEnv);
      if (signal.aborted) return stopped;
      let view = threads.get(threadId);
      if (!view?.subscribed) view = await resumeThread(conn, launch);
      if (signal.aborted) return stopped;
      if (view.status.type === "active") return "queue";
      try {
        await conn.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      } catch (error) {
        // It went and no answer came: the turn may have started. Never sent again (a second turn).
        if (codexAnswerUnknown(error)) return { uncertain: error instanceof Error ? error.message : String(error) };
        throw error;
      }
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
