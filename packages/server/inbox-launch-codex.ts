/**
 * Codex as a `LaunchHost` (inbox-launch-host.ts): "New Codex session" in compose's To.
 *
 * Pi's pattern (inbox-launch-pi.ts): the Inbox owns the process. One `codex app-server` per launched thread, in its
 * folder, speaking JSON-RPC over stdio, as Ask AI, voice and T3 Code do. It runs with the person's own Codex: their
 * login env through the launch filter, so their `CODEX_HOME`, `config.toml`, login, model, sandbox and approval
 * policy (nothing of theirs goes on argv or on the thread: `thread/start` gets the folder only). **A launched Codex
 * thread runs only while the Inbox runs**: Stop, Delete and an Inbox exit end the process (Codex writes its rollout
 * as it goes), and a reply starts a new app-server that `thread/resume`s the thread before the reply goes in.
 *
 * - Start: `initialize`, `account/read` (no login: the start fails with how to sign in), `thread/start { cwd }`,
 *   `thread/name/set`. No first turn: the engine moves the root to the thread, and the Codex wake hands it over.
 * - Turns: the Codex wake asks the engine's `deliver` before `codex queue` (inbox-codex-wake.ts); this host puts the
 *   wake text in as `turn/start`. Codex runs a turn started during another one after it; when it refuses one, the
 *   text goes into the running turn with `turn/steer`.
 * - Stop: `turn/interrupt` only while a turn runs (5 s at most), then stdin closes (SIGTERM after 5 s).
 * - The Inbox tools: the person's own `plannotator-inbox` MCP entry in Codex's config (the way any Codex session
 *   gets them), pointed at this Inbox's data dir when it is not the default. Codex starts MCP servers with a clean
 *   env, so that goes in as a `config` override on the thread, not only in the process env.
 * - Approvals (command, one-file patch, more access) come to the thread's permission card
 *   (inbox-launch-codex-permission.ts). Codex's other questions (`item/tool/requestUserInput`, an MCP form) are
 *   answered Cancel with one note in the thread, as Pi's dialogs are.
 * - A turn that fails (`turn/completed` with `status: "failed"`, a refused model or an expired login) answers
 *   nothing through the Inbox, so the host posts Codex's own error as one note in the thread.
 * - Trust: Codex writes `trust_level = "trusted"` into the person's `config.toml` when `thread/start` runs in a
 *   folder with no trust entry and their sandbox can write it. The Inbox never lets a launch change that file: such
 *   a folder's trust is passed in memory (`config.projects`), as Codex would have written it (PR #2407's finding).
 *
 * How a launched Codex learns it was launched (the launched-agent start note, in progress): its first turn is the
 * shared wake text (`inboxWakeText` through the wake's `commandOf`), so a note added there reaches Codex too; this
 * host sends that text as it is and adds nothing of its own.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { INBOX_CODEX_HOST, INBOX_CODEX_NAME, INBOX_CODEX_QUEUE_MIN_VERSION, parseCodexCliVersion, type InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { getDefaultPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { agentVersionRun, codexHome, createAgentEnvironmentFor, INBOX_MCP_SERVER_NAME, readCodexEntry } from "./inbox-agents";
import { shellQuote, versionAtLeast } from "./inbox-launch-claude";
import { createCodexPermissions, CODEX_APPROVALS } from "./inbox-launch-codex-permission";
import { launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import { launchNoteText, writeLaunchNote, type LaunchAvailability, type LaunchDelivery, type LaunchHost, type LaunchHostContext, type LaunchHostResult, type LaunchLive, type LaunchPermissionContext } from "./inbox-launch-host";

/** The first Codex CLI a launch starts: the Codex wake's floor (`codex queue`), so every Codex reply path is there. */
export const CODEX_LAUNCH_MIN_VERSION = INBOX_CODEX_QUEUE_MIN_VERSION;
/** The run line's cause when Codex has no login (Codex's own `account/read`, or `codex login status`). */
export const CODEX_SIGNED_OUT = "Codex isn't signed in. Run codex login in Terminal, then try again.";
/** The run line's cause when another Codex holds the thread (Codex's "active writer" refusal). */
export const CODEX_HELD_ELSEWHERE = "This Codex thread is open in another Codex. Quit it there, then try again.";
/** The stopped line's words (`stoppedNote`) when this Inbox never ran the thread's app-server (it was restarted). */
export const CODEX_STOPPED_NOTE = "The Inbox restarted, which ended it. Your reply continues it.";

/** How long a new app-server may take to answer `initialize`, and each start step after it. */
const READY_MS = 30_000;
/** One request's answer (a turn's own work comes as notifications). */
const REQUEST_MS = 30_000;
/** `turn/interrupt` answers once the turn has stopped: Stop waits this long at most. */
const INTERRUPT_MS = 5_000;
/** How long Stop waits for the process to end after its stdin closed, before it signals it. */
const STOP_MS = 5_000;
/** The longest error text a turn's error note quotes. */
const NOTE_ERROR_MAX = 300;
/** The longest question title a Cancel note quotes. */
const NOTE_TITLE_MAX = 80;
/** The longest line the app-server may write (a turn's whole command output can be one line): past it, the process is ended. */
const LINE_MAX = 64 * 1024 * 1024;

// ── Pure helpers (unit-tested) ──

/** A cause as the line shows it after "Codex didn't start.": one line, ending in a period. */
export function codexCause(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return !line ? "" : /[.!?]$/.test(line) ? line : `${line}.`;
}

/**
 * The app-server's env: the login env through the launch filter, without the markers of a Codex session the Inbox
 * itself may run in (its thread and sandbox), and this Inbox's data dir when not the default. Never a `CODEX_HOME`
 * of the Inbox's own: the person's (from their login shell) or none, so Codex finds its own.
 */
export function codexSpawnEnv(login: Readonly<LaunchEnv>, dataDir: string | null): LaunchEnv {
  const env = Object.fromEntries(Object.entries(launchSpawnEnv(login)).filter(([name]) => name !== "CODEX_THREAD_ID" && !name.startsWith("CODEX_SANDBOX")));
  return { ...env, ...(dataDir ? { PLANNOTATOR_DATA_DIR: dataDir } : {}) };
}

/** What Copy attach command copies: the thread, opened in Codex's own terminal UI in its folder. */
export function codexAttachCommand(folder: string, thread: string): string {
  return `cd ${shellQuote(folder)} && codex resume ${shellQuote(thread)}`;
}

/** Open in Terminal while the Inbox's app-server `pid` runs: it waits for that process to end, so one Codex writes the thread. */
export function codexHandoffCommand(folder: string, thread: string, pid: number): string {
  return `/bin/sh -c ${shellQuote(`cd ${shellQuote(folder)} || exit 1; while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; codex resume ${shellQuote(thread)}`)}`;
}

/** `account/read`'s answer: signed in, or Codex says it needs a login it does not have. Anything else is believed. */
export function codexSignedOut(result: unknown): boolean {
  const read = (result ?? {}) as { account?: unknown; requiresOpenaiAuth?: unknown };
  return (read.account === null || read.account === undefined) && read.requiresOpenaiAuth === true;
}

/** `codex login status`: signed out only when it says so plainly (exit 1 and "Not logged in"); anything else is believed. */
export function codexLoginStatusSignedOut(result: { exitCode: number; stdout: string; stderr: string }): boolean {
  return result.exitCode === 1 && /\bnot logged in\b/i.test(`${result.stderr}\n${result.stdout}`);
}

/** The thread note for a turn that failed: Codex's own words, one line. */
export function codexTurnErrorNote(error: string): string {
  const shown = launchNoteText(error, NOTE_ERROR_MAX);
  return shown ? `Codex's turn ended with an error: ${shown}` : "Codex's turn ended with an error.";
}

/** The thread note for a question the Inbox answered Cancel. */
export function codexQuestionNote(title: unknown): string {
  const shown = launchNoteText(title, NOTE_TITLE_MAX);
  return shown ? `Codex asked something the Inbox can't show yet (“${shown}”); answered Cancel.` : "Codex asked something the Inbox can't show yet; answered Cancel.";
}

/**
 * Whether Codex itself would write a folder's trust for this thread (thread_processor.rs: only when the effective
 * permissions can write the folder): the person's `sandbox_mode` (their selected `profile`'s first) being
 * `workspace-write` or `danger-full-access`. Unset is `read-only`, which writes nothing. A named
 * `default_permissions` profile is not read here: no trust is passed, and Codex decides as in its own TUI.
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

const realPathOr = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The trust a thread for `folder` needs in memory so Codex writes none into `config.toml`, found as Codex finds the
 * folder's project: the first of the folder's real path, the folder as given, then its trust root (`codexTrustRoot`)
 * that has an entry. An entry with a trust level: nothing (Codex reads it and writes nothing). None: the folder
 * trusted for this thread only, and only when Codex itself would have written it (`writes`).
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

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A `.git` file's `gitdir:` target, resolved from its folder, or null. */
function gitdirOf(dotGit: string): string | null {
  const text = metadataFile(dotGit)?.trim();
  if (!text?.startsWith("gitdir:")) return null;
  const target = text.slice("gitdir:".length).trim();
  return target ? resolve(dirname(dotGit), target) : null;
}

/**
 * The folder Codex keys a folder's trust by after the folder itself (codex git-utils `resolve_root_git_project_for_trust`):
 * the nearest folder with a `.git`; for a linked worktree, its main checkout, once the worktree's and the main
 * checkout's git metadata agree. Null when there is none, or for a `.git` file that is not a linked worktree.
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
    const mainRoot = dirname(dirname(dirname(gitDir)));
    const mainDotGit = join(mainRoot, ".git");
    const mainGitDir = isDir(mainDotGit) ? mainDotGit : gitdirOf(mainDotGit);
    if (!mainGitDir || realpathSync(mainGitDir) !== commonDir) return null;
    return mainRoot;
  } catch {
    return null;
  }
}

// ── The process ──

/** Why the Inbox ended a process (null on the process: it ended on its own). */
type CodexEnding = "stop" | "handoff" | "restart" | "close";

type Rpc = Record<string, any>;

interface CodexProcess {
  launchId: string;
  thread: string;
  proc: ReturnType<typeof Bun.spawn>;
  exited: boolean;
  exitCode: number | null;
  ending: CodexEnding | null;
  /** The thread is loaded on this process (started or resumed): turns may go in. */
  ready: boolean;
  /** The turn running now, and since when (ms). */
  turn: { id: string; since: number } | null;
  waiters: Map<string, { resolve: (result: Rpc) => void; reject: (error: Error) => void }>;
  stderr: string;
  ended: Promise<number>;
  /** An `error` notification's text for the running turn, kept for its `turn/completed`. */
  turnError: string | null;
}

/** A restart under way (`resume`): what cancelled it, and when it is over. */
interface CodexSpawning {
  cancel: "stop" | "handoff" | null;
  done: Promise<void>;
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

/** Codex as a `LaunchHost`; `close` ends every process it owns. The options are for tests. */
export function createCodexLaunchHost(ctx: LaunchHostContext, options: { readyMs?: number; requestMs?: number } = {}) {
  const readyMs = options.readyMs ?? READY_MS;
  const requestMs = options.requestMs ?? REQUEST_MS;
  /** The person's Codex home: their login shell's `CODEX_HOME`, else the Inbox's, else `~/.codex` (as Codex finds it). */
  const homeEnv = () => ctx.shell()?.CODEX_HOME ?? ctx.ownEnv().CODEX_HOME;
  const codexHomeDir = () => codexHome(createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env: { HOME: ctx.homeDir, ...(homeEnv() ? { CODEX_HOME: homeEnv() } : {}) } }));
  const configText = (): string | null => {
    try {
      return readFileSync(join(codexHomeDir(), "config.toml"), "utf8");
    } catch {
      return null;
    }
  };
  /** This Inbox's data dir for an app-server it starts; null when it is the default (the MCP entry finds it alone). */
  const dataDirArg = () => (resolve(ctx.dataDir) === resolve(getDefaultPlannotatorDataDir(ctx.homeDir)) ? null : ctx.dataDir);

  /** The running (or last) process of each thread, by thread id. */
  const procs = new Map<string, CodexProcess>();
  /** Restarts under way, by thread id. */
  const spawning = new Map<string, CodexSpawning>();
  /** Every message a thread's app-servers wrote, counted across its processes (`live.polls` never goes back). */
  const polls = new Map<string, number>();
  /** The engine's permission context, for the thread notes (set once by `permissions`). */
  let threads: LaunchPermissionContext | null = null;
  let permissions: ReturnType<typeof createCodexPermissions> | null = null;
  let rpcIds = 0;
  let notes = 0;

  const running = (thread: string): CodexProcess | null => {
    const p = procs.get(thread);
    return p && !p.exited ? p : null;
  };

  const write = (p: CodexProcess, message: Rpc): boolean => {
    try {
      const stdin = p.proc.stdin as { write(text: string): void; flush?(): void };
      stdin.write(`${JSON.stringify(message)}\n`);
      stdin.flush?.();
      return true;
    } catch {
      // Gone: its exit is recorded by `ended`.
      return false;
    }
  };
  const request = (p: CodexProcess, method: string, params: Rpc, ms = requestMs): Promise<Rpc> =>
    new Promise((resolveRpc, rejectRpc) => {
      if (p.exited) return rejectRpc(new RpcError("Codex is not running"));
      const id = `inbox-${++rpcIds}`;
      const timer = setTimeout(() => {
        p.waiters.delete(id);
        rejectRpc(new RpcError(`Codex did not answer ${method} within ${Math.round(ms / 1000)} s`, true));
      }, ms);
      p.waiters.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveRpc(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRpc(error);
        },
      });
      if (!write(p, { id, method, params })) {
        clearTimeout(timer);
        p.waiters.delete(id);
        rejectRpc(new RpcError("Codex is not running"));
      }
    });

  /** One note from the thread in the launch's thread (a failed turn, a question answered Cancel). */
  const note = (launchId: string, thread: string, body: string, key: string) => {
    const root = threads?.rootOf(launchId);
    if (!threads || !root) return;
    writeLaunchNote(threads, root, { author: { host: INBOX_CODEX_HOST, session: thread, name: INBOX_CODEX_NAME }, body, key }, ctx.log);
  };

  /** A server request no card can show: Cancel at once, and one note in the thread saying so. */
  const cannotAsk = (p: CodexProcess, id: string | number, method: string, params: Rpc) => {
    if (method === "mcpServer/elicitation/request") write(p, { id, result: { action: "cancel", content: null } });
    else write(p, { id, error: { code: -32601, message: "The Plannotator Inbox cannot answer this request." } });
    const title = params?.message ?? params?.questions?.[0]?.question ?? params?.questions?.[0]?.header ?? "";
    ctx.startLog(p.launchId, `codex ${method} answered cancelled: ${String(title).slice(0, 200)}`);
    ctx.log(`Inbox launch ${p.launchId}: a Codex ${method} answered Cancel`);
    note(p.launchId, p.thread, codexQuestionNote(title), `codex-ask-${p.launchId}-${String(id)}-${++notes}`);
  };

  const onMessage = (p: CodexProcess, message: Rpc) => {
    polls.set(p.thread, (polls.get(p.thread) ?? 0) + 1);
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method !== "string") {
      const waiter = p.waiters.get(String(message.id));
      if (!waiter) return;
      p.waiters.delete(String(message.id));
      if (message.error) waiter.reject(new RpcError(String(message.error?.message ?? "Codex refused it")));
      else waiter.resolve((message.result ?? {}) as Rpc);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = (message.params ?? {}) as Rpc;
    if (hasId) {
      if (CODEX_APPROVALS.has(message.method) && permissions && params.threadId === p.thread) permissions.asked(p, message.id, message.method, params);
      else cannotAsk(p, message.id, message.method, params);
      return;
    }
    // Notifications of another thread (a subagent's) only count as life.
    if (params.threadId !== undefined && params.threadId !== p.thread) return;
    switch (message.method) {
      case "turn/started": {
        const id = params.turn?.id;
        if (typeof id === "string") p.turn = { id, since: p.turn?.id === id ? p.turn.since : Date.now() };
        p.turnError = null;
        threads?.onChange();
        return;
      }
      case "turn/completed": {
        const turn = params.turn ?? {};
        if (!p.turn || p.turn.id === turn.id) p.turn = null;
        permissions?.turnEnded(p.thread);
        if (turn.status === "failed") {
          const text = typeof turn.error?.message === "string" ? turn.error.message : (p.turnError ?? "");
          if (existsSync(ctx.launchDir(p.launchId))) ctx.startLog(p.launchId, `codex ${p.thread}: the turn ended with an error: ${text.slice(0, 2000)}`);
          ctx.log(`Inbox launch ${p.launchId}: a Codex turn ended with an error: ${text.slice(0, 200)}`);
          note(p.launchId, p.thread, codexTurnErrorNote(text), `codex-error-${p.launchId}-${String(turn.id ?? "")}-${++notes}`);
        }
        p.turnError = null;
        threads?.onChange();
        return;
      }
      case "error": {
        // A retry follows: its own end decides. Otherwise kept for the turn's `turn/completed`.
        if (params.willRetry !== true && typeof params.error?.message === "string") p.turnError = params.error.message;
        return;
      }
      case "item/started": {
        if (params.item?.type === "fileChange") permissions?.fileChange(params.item.id, params.item.changes);
        return;
      }
      default:
        return;
    }
  };

  /** The thread's settings: the folder, its trust in memory (so `config.toml` stays as it is), and this Inbox's data dir for the MCP entry. */
  const threadConfig = (launch: InboxLaunchRecord): Rpc | null => {
    const text = configText();
    const real = realPathOr(launch.folder);
    const data = dataDirArg();
    const config: Rpc = {
      ...codexTrustOverride(text, launch.folder, real, codexTrustRoot(real), codexWritesTrust(text)),
      ...(data ? { [`mcp_servers.${INBOX_MCP_SERVER_NAME}.env.PLANNOTATOR_DATA_DIR`]: data } : {}),
    };
    return Object.keys(config).length > 0 ? config : null;
  };

  type SpawnResult = { ok: true; thread: string } | { ok: false; cancelled: boolean; missing: boolean; text: string; output: string };
  /**
   * One app-server for a launch's thread (`thread`: resume it; null: start a new one), in the launch's folder;
   * resolves once the thread is loaded on it (or it could not be). Nothing is spawned once `cancelled()`.
   */
  const spawnCodex = async (launch: InboxLaunchRecord, thread: string | null, name: string, login: Readonly<LaunchEnv>, cancelled: () => boolean): Promise<SpawnResult> => {
    const env = codexSpawnEnv(login.PATH ? login : ((await ctx.environment()).env as LaunchEnv), dataDirArg());
    const path = createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env }).which("codex") ?? (await ctx.environment()).which("codex");
    if (!path) return { ok: false, cancelled: false, missing: true, text: "codex is not on the login PATH.", output: "codex not found" };
    if (cancelled()) return { ok: false, cancelled: true, missing: false, text: "", output: "" };
    const argv = [path, "app-server"];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { cwd: launch.folder, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, cancelled: false, missing: false, text: codexCause(text), output: text };
    }
    const key = thread ?? `pending-${launch.id}`;
    const p: CodexProcess = { launchId: launch.id, thread: key, proc, exited: false, exitCode: null, ending: null, ready: false, turn: null, waiters: new Map(), stderr: "", ended: null as never, turnError: null };
    p.ended = proc.exited.then((code) => {
      p.exited = true;
      p.exitCode = code;
      p.turn = null;
      p.ready = false;
      for (const waiter of p.waiters.values()) waiter.reject(new RpcError("Codex is not running"));
      p.waiters.clear();
      permissions?.processEnded(p);
      if (existsSync(ctx.launchDir(launch.id))) {
        ctx.startLog(launch.id, `codex app-server ${p.thread}: exited ${code}${p.ending ? ` (${p.ending})` : ""}${p.stderr.trim() ? `\n[stderr]\n${p.stderr.trim().slice(-2000)}` : ""}`);
      }
      threads?.onChange();
      return code;
    });
    if (thread) procs.set(thread, p);
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at).replace(/\r$/, "");
            buffer = buffer.slice(at + 1);
            if (!line.trim()) continue;
            try {
              onMessage(p, JSON.parse(line) as Rpc);
            } catch {
              // Not JSON, or a handler's own failure: never the end of the reader.
            }
          }
          if (buffer.length > LINE_MAX) {
            buffer = "";
            proc.kill("SIGTERM");
          }
        }
      } catch {
        // The pipe closed with the process.
      }
    })();
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) p.stderr = `${p.stderr}${decoder.decode(chunk, { stream: true })}`.slice(-8000);
      } catch {
        // Closed.
      }
    })();

    const fail = async (why: string): Promise<SpawnResult> => {
      const endedItself = p.exited;
      if (!p.exited) {
        try {
          (p.proc.stdin as { end(): void }).end();
        } catch {}
        p.proc.kill("SIGTERM");
      }
      await Promise.race([p.ended, Bun.sleep(2_000)]);
      if (thread && procs.get(thread) === p) procs.delete(thread);
      const said = endedItself ? p.stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) : undefined;
      return { ok: false, cancelled: false, missing: false, text: codexCause(said && !why ? said : why || said || "It exited before it answered"), output: `codex app-server\n${p.stderr.trim().slice(-2000)}` };
    };
    try {
      await request(p, "initialize", { clientInfo: { name: "plannotator", title: "Plannotator", version: "1.0.0" } }, readyMs);
      write(p, { method: "initialized" });
      // No login: say how to sign in now, before a thread exists (Codex itself would only fail the first turn).
      const account = await request(p, "account/read", {}, readyMs).catch((): null => null);
      if (account && codexSignedOut(account)) return await fail(CODEX_SIGNED_OUT);
      const config = threadConfig(launch);
      let id: string;
      if (thread) {
        await request(p, "thread/resume", { threadId: thread, ...(config ? { config } : {}) }, readyMs);
        id = thread;
      } else {
        const started = await request(p, "thread/start", { cwd: launch.folder, ...(config ? { config } : {}) }, readyMs);
        const made = started.thread?.id;
        if (typeof made !== "string" || !made) return await fail("Codex answered thread/start without a thread");
        id = made;
        p.thread = id;
        procs.set(id, p);
        polls.set(id, (polls.get(id) ?? 0) + (polls.get(key) ?? 0));
        polls.delete(key);
        // The thread's name in Codex's own lists; a refusal is not a failed start.
        await request(p, "thread/name/set", { threadId: id, name: name.trim() || "Inbox" }, readyMs).catch((error: unknown) => {
          ctx.startLog(launch.id, `thread/name/set: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      p.ready = true;
      ctx.startLog(launch.id, `codex app-server in ${launch.folder}\nready: thread ${id}${thread ? " (resumed)" : ""}`);
      return { ok: true, thread: id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/active writer/i.test(message)) return await fail(CODEX_HELD_ELSEWHERE);
      return await fail(p.exited ? "" : message);
    }
  };

  /** End a process: interrupt its turn (only while one runs), close its stdin, and signal it only if it lingers. */
  const end = async (p: CodexProcess, why: CodexEnding): Promise<number | null> => {
    if (p.exited) return p.exitCode;
    p.ending ??= why;
    if (p.turn) {
      await request(p, "turn/interrupt", { threadId: p.thread, turnId: p.turn.id }, INTERRUPT_MS).catch((error: unknown) => {
        ctx.startLog(p.launchId, `turn/interrupt: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    try {
      (p.proc.stdin as { end(): void }).end();
    } catch {}
    const code = await Promise.race([p.ended, Bun.sleep(STOP_MS).then(() => null)]);
    if (code !== null) return code;
    p.proc.kill("SIGTERM");
    return Promise.race([
      p.ended,
      Bun.sleep(2_000).then(() => {
        p.proc.kill("SIGKILL");
        return null;
      }),
    ]);
  };

  const nameOf = (launch: InboxLaunchRecord) => {
    const root = threads?.rootOf(launch.id);
    return root?.thread_name ?? root?.subject ?? "Inbox";
  };

  type ResumeResult = LaunchHostResult & { failure: { code: "untrusted" | "failed"; text: string } | null };
  const nothing = (text: string): ResumeResult => ({ exitCode: 0, text, failure: null });

  return {
    agent: INBOX_CODEX_HOST,
    name: INBOX_CODEX_NAME,
    connector: "Inbox MCP server",
    // Of a login-shell read: where Codex keeps its config, login and threads.
    shellNames: ["CODEX_HOME"],

    /**
     * `codex` on the plain env's PATH and new enough, the person's Codex has Plannotator's Inbox MCP entry (it is
     * how a Codex session answers in the Inbox), and Codex has a login (`codex login status`, local only).
     */
    async available(): Promise<LaunchAvailability> {
      const e = await ctx.environment();
      const path = e.which("codex");
      if (!path) return { ok: false, missing: true, reason: "codex is not on the Inbox's PATH", code: "missing" };
      const entry = readCodexEntry(join(codexHomeDir(), "config.toml"));
      if (entry.kind !== "ours" && entry.kind !== "other") return { ok: false, missing: false, reason: "Plannotator's Inbox is not connected to Codex (Settings → Agents)", code: "tool_off" };
      const version = parseCodexCliVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
      const shown = version?.join(".") ?? null;
      if (!shown || !versionAtLeast(shown, CODEX_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `Codex ${shown ?? "?"} is older than ${CODEX_LAUNCH_MIN_VERSION}`, code: "too_old" };
      const home = homeEnv();
      const status = await e.run([path, "login", "status"], { timeoutMs: 10_000, ...(home ? { env: { CODEX_HOME: home } } : {}) });
      if (codexLoginStatusSignedOut(status)) return { ok: false, missing: false, reason: "Codex isn't signed in", code: "signed_out" };
      return { ok: true, version: shown };
    },

    /** Codex's modes are the person's own config: nothing to fix on the record. */
    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    /** An app-server never refuses a folder: its trust only decides Codex's own defaults there. */
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      const result = await spawnCodex(launch, null, input.name, input.login, () => false);
      if (!result.ok) {
        ctx.startLog(launch.id, result.output);
        return { ok: false as const, code: result.missing ? ("missing" as const) : ("failed" as const), text: result.text };
      }
      return { ok: true as const, session: result.thread, ref: result.thread };
    },

    /** What this Inbox's processes say: running (busy or idle), stopped once one ended, absent when none ran here. */
    async sessions() {
      return (ref: string) => {
        const p = procs.get(ref);
        if (!p) return "absent" as const;
        return p.exited ? { status: null, state: "stopped", waitingFor: null } : { status: p.turn ? "busy" : "idle", state: "running", waitingFor: null };
      };
    },

    /** The thread's app-server, once the thread is loaded on it: busy while a turn runs; every message it writes counts. */
    live(session: string): LaunchLive | null {
      const p = running(session);
      if (!p || !p.ready) return null;
      return { busy: p.turn !== null, busySince: p.turn?.since ?? null, polls: polls.get(session) ?? 0 };
    },

    /** A new app-server on the thread (`thread/resume`): the waiting reply then goes in as a turn (`deliver`). */
    async resume(launch: InboxLaunchRecord): Promise<ResumeResult> {
      const thread = launch.session_ref!;
      if (spawning.has(thread)) return nothing("starting already");
      const old = running(thread);
      if (old?.ready) return nothing("already running here");
      // Marked before the first await: a Stop, Delete or Open in Terminal from now on cancels this restart.
      let finish!: () => void;
      const mark: CodexSpawning = { cancel: null, done: new Promise<void>((done) => (finish = done)) };
      spawning.set(thread, mark);
      try {
        if (old) await end(old, "restart");
        const login = await ctx.loginEnv().catch((): LaunchEnv => ({}));
        if (mark.cancel) return nothing(`${mark.cancel === "stop" ? "stopped" : "opened in Terminal"} during the restart: nothing started`);
        const result = await spawnCodex(launch, thread, nameOf(launch), login, () => mark.cancel !== null);
        if (mark.cancel) {
          const p = running(thread);
          if (p) await end(p, mark.cancel);
          return nothing(`${mark.cancel === "stop" ? "stopped" : "opened in Terminal"} during the restart: ${p ? "ended as it came up" : "nothing started"}`);
        }
        if (!result.ok) return { exitCode: 1, text: result.output, failure: { code: "failed", text: result.text } };
        return nothing(`codex app-server, thread/resume ${thread}: ready`);
      } finally {
        spawning.delete(thread);
        finish();
      }
    },

    /**
     * The wake's text as a turn: `turn/start` (Codex runs it after a turn that is running), or, when Codex refuses a
     * second turn, `turn/steer` into the running one. A restart under way is waited for. No answer in time: it may
     * have gone, and is never sent again (`uncertain`).
     */
    async deliver(launch: InboxLaunchRecord, text: string, signal: AbortSignal): Promise<LaunchDelivery> {
      const thread = launch.session_ref;
      if (!thread) return { failed: "the thread has not started" };
      const under = spawning.get(thread);
      if (under) await under.done;
      const p = running(thread);
      if (!p?.ready) return { failed: "Codex is not running" };
      if (signal.aborted) return { failed: "stopped" };
      const input = [{ type: "text", text, text_elements: [] }];
      try {
        const started = await request(p, "turn/start", { threadId: thread, input });
        const id = started.turn?.id;
        if (typeof id === "string" && !p.turn && started.turn?.status === "inProgress" && started.turn?.startedAt !== null) p.turn = { id, since: Date.now() };
        threads?.onChange();
        return "delivered";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RpcError && error.timedOut) return { uncertain: message };
        if (p.turn && !p.exited && !signal.aborted) {
          try {
            await request(p, "turn/steer", { threadId: thread, expectedTurnId: p.turn.id, input });
            return "delivered";
          } catch (steer) {
            if (steer instanceof RpcError && steer.timedOut) return { uncertain: steer.message };
            return { failed: `${message}; turn/steer: ${steer instanceof Error ? steer.message : String(steer)}` };
          }
        }
        return { failed: message };
      }
    },

    /** The turn is interrupted (while one runs) and the process ends; a restart under way is cancelled and waited for. */
    async stop(ref: string): Promise<LaunchHostResult> {
      const mark = spawning.get(ref);
      if (mark) mark.cancel = "stop";
      const p = running(ref);
      const code = p ? await end(p, "stop") : null;
      if (mark) {
        await mark.done;
        return { exitCode: 0, text: "stopped during a restart: nothing left running" };
      }
      if (!p) return { exitCode: 0, text: "not running in this Inbox" };
      return { exitCode: code ?? 1, text: code === null ? "did not end; killed" : `ended ${code}` };
    },
    /** Codex keeps its threads (its own history and `codex resume`): nothing to remove. */
    remove: async (): Promise<LaunchHostResult> => ({ exitCode: 0, text: "Codex keeps its own threads" }),
    /** Codex keeps its sessions by date, not by folder: nothing of a scratch folder's to purge. */
    purge: async (): Promise<LaunchHostResult & { skipped?: string }> => ({ exitCode: 0, text: "", skipped: "Codex keeps its sessions by date, not by folder" }),

    /** Only while no app-server of this Inbox runs the thread (one Codex writes it at a time). */
    attach(launch: InboxLaunchRecord): string | null {
      const thread = launch.session_ref;
      if (!thread || running(thread) || spawning.has(thread)) return null;
      return codexAttachCommand(launch.folder, thread);
    },
    /**
     * Open in Terminal: `codex resume` on the thread. With the Inbox's app-server running, it ends first (its turn
     * interrupted) and the command waits for it; a restart under way is cancelled.
     */
    terminal(launch: InboxLaunchRecord): string {
      const thread = launch.session_ref;
      if (!thread) return `cd ${shellQuote(launch.folder)} && codex`;
      const mark = spawning.get(thread);
      if (mark && mark.cancel === null) mark.cancel = "handoff";
      const p = running(thread);
      if (!p) return codexAttachCommand(launch.folder, thread);
      void end(p, "handoff");
      return codexHandoffCommand(launch.folder, thread, p.proc.pid);
    },

    /** No app-server of this Inbox runs the thread (it ended, or never ran here), and no restart is under way. */
    processEnded(ref: string): boolean {
      return !running(ref) && !spawning.has(ref);
    },

    /** Codex's approvals on the permission card, answered on the app-server that asked. */
    permissions(context: LaunchPermissionContext) {
      threads = context;
      permissions = createCodexPermissions({
        ...context,
        log: context.log ?? ctx.log,
        respond: (target, id, result) => !target.exited && write(target as CodexProcess, { id, result }),
        steer: (target, turnId, text) => {
          const p = target as CodexProcess;
          if (!p.exited) void request(p, "turn/steer", { threadId: p.thread, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] }).catch(() => undefined);
        },
        running: (thread) => running(thread) !== null,
      });
      return permissions;
    },

    /** The words after "Codex stopped." when the person did not press Stop: why this thread is not running. */
    stoppedNote(launch: InboxLaunchRecord): string | null {
      const thread = launch.session_ref;
      if (!thread) return null;
      const p = procs.get(thread);
      if (p?.exited && p.ending === null) return `Codex ended on its own (exit ${p.exitCode ?? "unknown"}). Your reply continues it.`;
      if (p?.exited && p.ending === "handoff") return "It was opened in Terminal. Your reply continues it here once Codex there has quit.";
      return CODEX_STOPPED_NOTE;
    },

    /** The Inbox stops: every process's stdin closes (Codex ends its turn and exits); a restart under way starts nothing. */
    close() {
      for (const mark of spawning.values()) mark.cancel = "stop";
      for (const p of procs.values()) {
        if (p.exited) continue;
        p.ending ??= "close";
        try {
          (p.proc.stdin as { end(): void }).end();
        } catch {}
        const timer = setTimeout(() => {
          if (!p.exited) p.proc.kill("SIGTERM");
        }, 2_000);
        (timer as { unref?: () => void }).unref?.();
      }
    },
  } satisfies LaunchHost;
}
