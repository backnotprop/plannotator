/**
 * Mistral Vibe as a `LaunchHost` (inbox-launch-host.ts): "New Vibe session" in compose's To.
 *
 * Codex's pattern (inbox-launch-codex.ts): the Inbox owns the process. One `vibe-acp` per launched session, in its
 * folder, speaking the Agent Client Protocol (JSON-RPC 2.0, one message per line) over stdio. It runs with the
 * person's own Vibe: their login env through the launch filter, so their `VIBE_HOME`, `config.toml`, API keys, agents,
 * tools and approval mode. **A launched Vibe session runs only while the Inbox runs**: Stop, Delete and an Inbox exit
 * end the process (Vibe saves the session as it goes), and a reply starts a new `vibe-acp` that `session/load`s it
 * before the reply goes in.
 *
 * - Start: `initialize`, `session/new { cwd, mcpServers }`. No first turn: the engine moves the root to the session,
 *   and the Vibe wake (inbox-vibe-wake.ts) hands it over.
 * - Identity: Vibe names no session to the MCP servers it starts, and gives them a near-empty env. So every
 *   `session/new` and `session/load` passes Plannotator's own Inbox MCP server (named as the person's
 *   `plannotator-inbox` entry, which it replaces for this session) with `PLANNOTATOR_VIBE_SESSION` in its env: the
 *   Inbox's id for the session (`session`, a UUID), while Vibe's own id is the launch's `session_ref`.
 * - Model: the pick goes in as `VIBE_ACTIVE_MODEL` on the process. `session/set_config_option` would write the
 *   person's `config.toml`, so it is never called.
 * - Turns: the wake's text goes in as `session/prompt`, which answers when the turn ends. Vibe takes one prompt at a
 *   time, so a delivery during a turn waits for it to end before it counts as delivered: a Stop, a hand-off or an
 *   exit meanwhile leaves the item waiting in the Inbox, never recorded as delivered and dropped.
 * - Stop: `session/cancel` while a turn runs (its open approvals answered cancelled, 5 s at most), `session/close`,
 *   then stdin closes (SIGTERM after 5 s).
 * - Approvals come to the thread's permission card (inbox-launch-vibe-permission.ts). Vibe's other requests (file
 *   and terminal access, which this client never offers) are refused.
 * - A turn that fails (an error answer to `session/prompt`, a refusal or a token limit) answers nothing through the
 *   Inbox, so the host posts Vibe's own words as one note in the thread.
 * - Trust: an untrusted folder only means Vibe skips the project's own `.vibe` config. The Inbox never writes Vibe's
 *   `trusted_folders.toml`.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { INBOX_VIBE_HOST, INBOX_VIBE_LAUNCH_MIN_VERSION, INBOX_VIBE_NAME, INBOX_VIBE_SESSION_ENV, parseVibeModels, parseVibeVersion, vibeModelEnv, type InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { agentVersionRun, createAgentEnvironmentFor, INBOX_MCP_SERVER_NAME } from "./inbox-agents";
import { launchChoiceCache, type LaunchChoiceLists } from "./inbox-launch-choice";
import { shellQuote, versionAtLeast } from "./inbox-launch-claude";
import { launchSpawnEnv, type LaunchEnv } from "./inbox-launch-env";
import { launchTurnErrorNote, writeLaunchNote, type LaunchAvailability, type LaunchDelivery, type LaunchHost, type LaunchHostContext, type LaunchHostResult, type LaunchLive, type LaunchPermissionContext } from "./inbox-launch-host";
import { createVibePermissions, VIBE_PERMISSION_REQUEST, type VibeToolCall } from "./inbox-launch-vibe-permission";

/** The run line's cause when Vibe has no API key for its provider (`session/new` answers -32000). */
export const VIBE_SIGNED_OUT = "Vibe isn't signed in. Run vibe --setup in Terminal, then try again.";
/** The run line's cause when another Vibe holds the session (Vibe's one-process-per-session lock). */
export const VIBE_HELD_ELSEWHERE = "This Vibe session is open in another Vibe. Quit it there, then try again.";
/** The stopped line's words (`stoppedNote`) when this Inbox never ran the session's process (it was restarted). */
export const VIBE_STOPPED_NOTE = "The Inbox restarted, which ended it. Your reply continues it.";

/** Vibe's error code for a missing API key (`session/new`, `session/load`). */
const VIBE_AUTH_REQUIRED = -32000;
/** How long a new `vibe-acp` may take to answer `initialize`, and each start step after it. */
const READY_MS = 30_000;
/** One request's answer (a turn's own work comes as notifications). */
const REQUEST_MS = 30_000;
/** After `session/cancel`, how long Stop waits for the turn to end. */
const INTERRUPT_MS = 5_000;
/** How long Stop waits for the process to end after its stdin closed, before it signals it. */
const STOP_MS = 5_000;
/** How long the throwaway `vibe-acp` that reads the model list may run (it starts the person's MCP servers too). */
const CHOICES_RUN_MS = 15_000;
/** The longest line `vibe-acp` may write: past it, the process is ended. */
const LINE_MAX = 64 * 1024 * 1024;
/** Tool calls kept per process for the approval that may follow. */
const TOOL_CALLS_KEPT = 50;

const CLIENT_INFO = { name: "plannotator", title: "Plannotator", version: "1.0.0" };
const INITIALIZE = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO };

// ── Pure helpers (unit-tested) ──

/** A cause as the line shows it after "Vibe didn't start.": one line, ending in a period. */
export function vibeCause(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return !line ? "" : /[.!?]$/.test(line) ? line : `${line}.`;
}

/** The process env: the login env through the launch filter, and the picked model. */
export function vibeSpawnEnv(login: Readonly<LaunchEnv>, model: string | undefined): LaunchEnv {
  return { ...launchSpawnEnv(login), ...vibeModelEnv(model) };
}

/**
 * The Inbox MCP server a launched session runs (ACP `McpServerStdio`), named for `session`. The data dir always goes
 * with it: Vibe passes a stdio server no `XDG_DATA_HOME` or `PLANNOTATOR_DATA_DIR`, so the shim could not find an
 * Inbox outside `~/.plannotator` alone.
 */
export function vibeInboxMcpServer(selfCommand: readonly string[], session: string, dataDir: string) {
  const [command = "plannotator", ...args] = selfCommand;
  return {
    name: INBOX_MCP_SERVER_NAME,
    command,
    args: [...args, "inbox", "mcp"],
    env: [
      { name: INBOX_VIBE_SESSION_ENV, value: session },
      { name: "PLANNOTATOR_DATA_DIR", value: dataDir },
    ],
  };
}

/** What Copy attach command copies: the session, opened in Vibe's own terminal UI in its folder. */
export function vibeAttachCommand(folder: string, ref: string): string {
  return `cd ${shellQuote(folder)} && vibe --resume ${shellQuote(ref)}`;
}

/** Open in Terminal while the Inbox's `vibe-acp` `pid` runs: it waits for that process to end, so one Vibe holds the session. */
export function vibeHandoffCommand(folder: string, ref: string, pid: number): string {
  return `/bin/sh -c ${shellQuote(`cd ${shellQuote(folder)} || exit 1; while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; vibe --resume ${shellQuote(ref)}`)}`;
}

/** The thread note for a turn that failed: Vibe's own words, one line. */
export const vibeTurnErrorNote = (error: string): string => launchTurnErrorNote(INBOX_VIBE_NAME, error);

/** A turn's stop reason the person should hear about (a cancel or a normal end says nothing). */
export function vibeStopNote(stopReason: unknown): string | null {
  if (stopReason === "refusal") return vibeTurnErrorNote("the model refused to answer");
  if (stopReason === "max_tokens") return vibeTurnErrorNote("it reached its token limit");
  if (stopReason === "max_turn_requests") return vibeTurnErrorNote("it reached its turn limit");
  return null;
}

// ── The process ──

type Rpc = Record<string, any>;
/** Why the Inbox ended a process (null on the process: it ended on its own). */
type VibeEnding = "stop" | "handoff" | "restart" | "close";

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

interface VibeProcess {
  launchId: string;
  /** The Inbox's id for the session (the MCP server's `PLANNOTATOR_VIBE_SESSION`). */
  session: string;
  /** Vibe's own session id; empty until `session/new` answered. */
  ref: string;
  cwd: string;
  proc: ReturnType<typeof Bun.spawn>;
  exited: boolean;
  exitCode: number | null;
  ending: VibeEnding | null;
  /** The session is loaded on this process (made or loaded): turns may go in. */
  ready: boolean;
  /** The turn running now (or held for the caller `takeTurn` just woke), since when (ms). */
  turn: { since: number } | null;
  /** Callers waiting for the turn to end, in order: each is told whether it holds the next turn. */
  waiting: ((ok: boolean) => void)[];
  waiters: Map<string, { resolve: (result: Rpc) => void; reject: (error: Error) => void }>;
  toolCalls: Map<string, VibeToolCall>;
  stderr: string;
  ended: Promise<number>;
}

/** A restart under way (`resume`): what cancelled it, and when it is over. */
interface VibeSpawning {
  cancel: "stop" | "handoff" | null;
  done: Promise<void>;
}

export async function listVibeModels(vibeAcp: string, env: Readonly<Record<string, string>>, cwd: string, ms: number): Promise<LaunchChoiceLists | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([vibeAcp], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  } catch {
    return null;
  }
  const stdin = proc.stdin as { write(text: string): void; flush?(): void; end(): void };
  const send = (message: Rpc) => {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    stdin.flush?.();
  };
  const timer = setTimeout(() => proc.kill("SIGKILL"), ms);
  try {
    send({ id: 1, method: "initialize", params: INITIALIZE });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: Rpc;
        try {
          message = JSON.parse(line) as Rpc;
        } catch {
          continue;
        }
        if (typeof message.method === "string") continue;
        if (message.id === 1) {
          if (message.error) return null;
          // Nothing is saved for a session until its first prompt: this one leaves no trace.
          send({ id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
        } else if (message.id === 2) {
          const lists = message.error ? null : parseVibeModels(message.result?.configOptions);
          if (typeof message.result?.sessionId === "string") send({ id: 3, method: "session/close", params: { sessionId: message.result.sessionId } });
          return lists;
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try {
      stdin.end();
    } catch {}
    setTimeout(() => proc.kill("SIGKILL"), 2_000).unref?.();
  }
}

/** Mistral Vibe as a `LaunchHost`; `close` ends every process it owns. The options are for tests. */
export function createVibeLaunchHost(ctx: LaunchHostContext, options: { readyMs?: number; requestMs?: number; interruptMs?: number } = {}) {
  const readyMs = options.readyMs ?? READY_MS;
  const requestMs = options.requestMs ?? REQUEST_MS;
  const interruptMs = options.interruptMs ?? INTERRUPT_MS;

  /** The running (or last) process of each session, by Vibe's session id. */
  const procs = new Map<string, VibeProcess>();
  /** Restarts under way, by Vibe's session id. */
  const spawning = new Map<string, VibeSpawning>();
  /** Every message a session's processes wrote, counted across them by the Inbox's id (`live.polls` never goes back). */
  const polls = new Map<string, number>();
  let threads: LaunchPermissionContext | null = null;
  let permissions: ReturnType<typeof createVibePermissions> | null = null;
  let rpcIds = 0;

  const running = (ref: string): VibeProcess | null => {
    const p = procs.get(ref);
    return p && !p.exited ? p : null;
  };
  const bySession = (session: string): VibeProcess | null => {
    for (const p of procs.values()) if (p.session === session && !p.exited) return p;
    return null;
  };

  const write = (p: VibeProcess, message: Rpc): boolean => {
    try {
      const stdin = p.proc.stdin as { write(text: string): void; flush?(): void };
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      stdin.flush?.();
      return true;
    } catch {
      // Gone: its exit is recorded by `ended`.
      return false;
    }
  };
  /** A request; `ms` null waits as long as it takes (a turn). */
  const request = (p: VibeProcess, method: string, params: Rpc, ms: number | null = requestMs): Promise<Rpc> =>
    new Promise((resolveRpc, rejectRpc) => {
      if (p.exited) return rejectRpc(new RpcError("Vibe is not running"));
      const id = `inbox-${++rpcIds}`;
      const timer = ms === null ? null : setTimeout(() => {
        p.waiters.delete(id);
        rejectRpc(new RpcError(`Vibe did not answer ${method} within ${Math.round(ms / 1000)} s`, null, true));
      }, ms);
      const clear = () => {
        if (timer) clearTimeout(timer);
      };
      p.waiters.set(id, {
        resolve: (result) => {
          clear();
          resolveRpc(result);
        },
        reject: (error) => {
          clear();
          rejectRpc(error);
        },
      });
      if (!write(p, { id, method, params })) {
        clear();
        p.waiters.delete(id);
        rejectRpc(new RpcError("Vibe is not running"));
      }
    });

  /** One note from the session in the launch's thread (a failed turn). */
  const note = (p: VibeProcess, body: string, key: string, turnError = false) => {
    const root = threads?.rootOf(p.launchId);
    if (!threads || !root) return;
    writeLaunchNote(threads, root, { author: { host: INBOX_VIBE_HOST, session: p.session, name: INBOX_VIBE_NAME }, body, key, turnError }, ctx.log);
  };

  /** Every caller waiting for a turn is told it will not get one (the process ends). */
  const releaseWaiting = (p: VibeProcess) => {
    for (const waiter of p.waiting.splice(0)) waiter(false);
  };
  /**
   * True once the caller holds the next turn (no turn runs, none waits before it), and must start it at once with
   * `prompt`; false when the process ends or is ending, or `signal` aborts first.
   */
  const takeTurn = (p: VibeProcess, signal?: AbortSignal): Promise<boolean> => {
    if (p.exited || p.ending !== null || signal?.aborted) return Promise.resolve(false);
    if (!p.turn && p.waiting.length === 0) {
      // Held at once: another caller in the same tick must wait for it.
      p.turn = { since: Date.now() };
      return Promise.resolve(true);
    }
    return new Promise((resolveTurn) => {
      const waiter = (ok: boolean) => {
        signal?.removeEventListener("abort", onAbort);
        resolveTurn(ok);
      };
      const onAbort = () => {
        const at = p.waiting.indexOf(waiter);
        if (at >= 0) p.waiting.splice(at, 1);
        waiter(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      p.waiting.push(waiter);
    });
  };

  /** The turn is over: the next caller waiting gets it (held for it at once), or none does when the process is ending. */
  const handOn = (p: VibeProcess) => {
    p.turn = null;
    const next = p.waiting.shift();
    if (!next) return;
    const ok = !p.exited && p.ending === null;
    if (ok) p.turn = { since: Date.now() };
    next(ok);
    if (!ok) releaseWaiting(p);
  };

  /** One turn: the text as `session/prompt`; when it ends, the next caller waiting gets the turn. */
  const prompt = (p: VibeProcess, text: string) => {
    p.turn = { since: Date.now() };
    threads?.onChange();
    // Unique across Inbox runs: a note's idempotency key never meets an earlier run's.
    const turnKey = `${p.ref}-${randomUUID()}`;
    void request(p, "session/prompt", { sessionId: p.ref, prompt: [{ type: "text", text }] }, null)
      .then((result) => {
        const said = vibeStopNote(result.stopReason);
        if (said) note(p, said, `vibe-stop-${p.launchId}-${turnKey}`, true);
      })
      .catch((error: unknown) => {
        if (p.exited) return;
        const text = error instanceof Error ? error.message : String(error);
        if (existsSync(ctx.launchDir(p.launchId))) ctx.startLog(p.launchId, `vibe-acp ${p.ref}: the turn ended with an error: ${text.slice(0, 2000)}`);
        ctx.log(`Inbox launch ${p.launchId}: a Vibe turn ended with an error: ${text.slice(0, 200)}`);
        note(p, vibeTurnErrorNote(text), `vibe-error-${p.launchId}-${turnKey}`, true);
      })
      .finally(() => {
        permissions?.turnEnded(p.ref);
        handOn(p);
        threads?.onChange();
      });
  };

  /** Wait for the turn, then start it with `text`; false (and nothing sent) when the process ended, is ending, or `signal` aborted meanwhile. */
  const nextTurn = async (p: VibeProcess, text: string, signal?: AbortSignal): Promise<boolean> => {
    if (!(await takeTurn(p, signal))) return false;
    if (p.exited || p.ending !== null || signal?.aborted) {
      // The turn held for this caller goes on, so neither Stop nor the next caller waits on a turn that never starts.
      handOn(p);
      return false;
    }
    prompt(p, text);
    return true;
  };

  const onMessage = (p: VibeProcess, message: Rpc) => {
    polls.set(p.session, (polls.get(p.session) ?? 0) + 1);
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method !== "string") {
      const waiter = p.waiters.get(String(message.id));
      if (!waiter) return;
      p.waiters.delete(String(message.id));
      if (message.error) waiter.reject(new RpcError(String(message.error?.message ?? "Vibe refused it"), typeof message.error?.code === "number" ? message.error.code : null));
      else waiter.resolve((message.result ?? {}) as Rpc);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = (message.params ?? {}) as Rpc;
    if (hasId) {
      if (message.method === VIBE_PERMISSION_REQUEST && permissions && p.ref && params.sessionId === p.ref) {
        permissions.asked(p, message.id, params, p.toolCalls.get(String(params.toolCall?.toolCallId)), p.cwd);
      } else {
        write(p, { id: message.id, error: { code: -32601, message: "The Plannotator Inbox cannot answer this request." } });
      }
      return;
    }
    if (message.method !== "session/update" || params.sessionId !== p.ref) return;
    const update = (params.update ?? {}) as Rpc;
    if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && typeof update.toolCallId === "string") {
      const merged = { ...(p.toolCalls.get(update.toolCallId) ?? {}), ...update } as VibeToolCall;
      p.toolCalls.delete(update.toolCallId);
      p.toolCalls.set(update.toolCallId, merged);
      if (p.toolCalls.size > TOOL_CALLS_KEPT) p.toolCalls.delete(p.toolCalls.keys().next().value!);
    }
  };

  /** The Inbox MCP server for `session/new` and `session/load`. */
  const mcpServers = (session: string) => [vibeInboxMcpServer(ctx.selfCommand, session, ctx.dataDir)];

  type SpawnResult = { ok: true; ref: string } | { ok: false; cancelled: boolean; missing: boolean; text: string; output: string };
  /**
   * One `vibe-acp` for a launch's session (`ref`: load it; null: make a new one), in the launch's folder; resolves
   * once the session is loaded on it (or it could not be). Nothing is spawned once `cancelled()`.
   */
  const spawnVibe = async (launch: InboxLaunchRecord, session: string, ref: string | null, login: Readonly<LaunchEnv>, cancelled: () => boolean): Promise<SpawnResult> => {
    const env = vibeSpawnEnv(login.PATH ? login : ((await ctx.environment()).env as LaunchEnv), launch.model);
    const path = createAgentEnvironmentFor({ platform: ctx.platform, homeDir: ctx.homeDir, env }).which("vibe-acp") ?? (await ctx.environment()).which("vibe-acp");
    if (!path) return { ok: false, cancelled: false, missing: true, text: "vibe-acp is not on the login PATH.", output: "vibe-acp not found" };
    if (cancelled()) return { ok: false, cancelled: true, missing: false, text: "", output: "" };
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([path], { cwd: launch.folder, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, cancelled: false, missing: false, text: vibeCause(text), output: text };
    }
    const p: VibeProcess = { launchId: launch.id, session, ref: ref ?? "", cwd: launch.folder, proc, exited: false, exitCode: null, ending: null, ready: false, turn: null, waiting: [], waiters: new Map(), toolCalls: new Map(), stderr: "", ended: null as never };
    p.ended = proc.exited.then((code) => {
      p.exited = true;
      p.exitCode = code;
      p.turn = null;
      p.ready = false;
      releaseWaiting(p);
      for (const waiter of p.waiters.values()) waiter.reject(new RpcError("Vibe is not running"));
      p.waiters.clear();
      permissions?.processEnded(p);
      if (existsSync(ctx.launchDir(launch.id))) {
        ctx.startLog(launch.id, `vibe-acp ${p.ref || "(no session)"}: exited ${code}${p.ending ? ` (${p.ending})` : ""}${p.stderr.trim() ? `\n[stderr]\n${p.stderr.trim().slice(-2000)}` : ""}`);
      }
      threads?.onChange();
      return code;
    });
    if (ref) procs.set(ref, p);
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
      if (ref && procs.get(ref) === p) procs.delete(ref);
      const said = endedItself ? p.stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) : undefined;
      return { ok: false, cancelled: false, missing: false, text: vibeCause(said && !why ? said : why || said || "It exited before it answered"), output: `vibe-acp\n${p.stderr.trim().slice(-2000)}` };
    };
    try {
      await request(p, "initialize", INITIALIZE, readyMs);
      let id: string;
      if (ref) {
        // Vibe replays the history as updates before it answers: none of it is a turn.
        await request(p, "session/load", { sessionId: ref, cwd: launch.folder, mcpServers: mcpServers(session) }, readyMs);
        id = ref;
      } else {
        const made = await request(p, "session/new", { cwd: launch.folder, mcpServers: mcpServers(session) }, readyMs);
        if (typeof made.sessionId !== "string" || !made.sessionId) return await fail("Vibe answered session/new without a session");
        id = made.sessionId;
        p.ref = id;
        procs.set(id, p);
      }
      p.ready = true;
      ctx.startLog(launch.id, `vibe-acp in ${launch.folder}\nready: session ${id}${ref ? " (loaded)" : ""}${launch.model ? `, model ${launch.model}` : ""}`);
      return { ok: true, ref: id };
    } catch (error) {
      if (error instanceof RpcError && error.code === VIBE_AUTH_REQUIRED) return await fail(VIBE_SIGNED_OUT);
      const message = error instanceof Error ? error.message : String(error);
      if (/already open|another vibe process/i.test(message)) return await fail(VIBE_HELD_ELSEWHERE);
      return await fail(p.exited ? "" : message);
    }
  };

  /** End a process: cancel its turn (only while one runs), close the session, close stdin, and signal it only if it lingers. */
  const end = async (p: VibeProcess, why: VibeEnding): Promise<number | null> => {
    if (p.exited) return p.exitCode;
    p.ending ??= why;
    releaseWaiting(p);
    if (p.turn && p.ref) {
      write(p, { method: "session/cancel", params: { sessionId: p.ref } });
      // A turn waiting on an approval ends only once that is answered.
      permissions?.turnEnded(p.ref);
      const turnOver = (async () => {
        while (p.turn && !p.exited) await Bun.sleep(50);
      })();
      await Promise.race([turnOver, Bun.sleep(interruptMs)]);
    }
    // Vibe's lock on the session goes with it, so a Terminal can open the session at once.
    if (p.ready && p.ref) await request(p, "session/close", { sessionId: p.ref }, interruptMs).catch(() => undefined);
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

  let choiceKey: string | null = null;
  const choiceLists = launchChoiceCache(async () => {
    const e = await ctx.environment();
    const path = e.which("vibe-acp");
    if (!path) return null;
    return listVibeModels(path, vibeSpawnEnv(e.env as LaunchEnv, undefined), ctx.homeDir, CHOICES_RUN_MS);
  });

  type ResumeResult = LaunchHostResult & { failure: { code: "untrusted" | "failed"; text: string } | null };
  const nothing = (text: string): ResumeResult => ({ exitCode: 0, text, failure: null });

  return {
    agent: INBOX_VIBE_HOST,
    name: INBOX_VIBE_NAME,
    connector: "Inbox MCP server",
    // Of a login-shell read: where Vibe keeps its config, keys and sessions.
    shellNames: ["VIBE_HOME"],

    /** `vibe-acp` on the plain env's PATH, new enough. Its own MCP entry needs no setup: each session gets the Inbox's. */
    async available(): Promise<LaunchAvailability> {
      const e = await ctx.environment();
      const path = e.which("vibe-acp");
      if (!path) return { ok: false, missing: true, reason: "vibe-acp is not on the Inbox's PATH", code: "missing" };
      const version = parseVibeVersion((await agentVersionRun(e, path, { timeoutMs: 10_000 })).stdout);
      if (!version || !versionAtLeast(version, INBOX_VIBE_LAUNCH_MIN_VERSION)) return { ok: false, missing: false, reason: `Vibe ${version ?? "?"} is older than ${INBOX_VIBE_LAUNCH_MIN_VERSION}`, code: "too_old" };
      choiceKey = `${path}@${version}`;
      return { ok: true, version };
    },

    choices: () => choiceLists(choiceKey),

    /** Vibe's approval mode is the person's own config: nothing to fix on the record. */
    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    /** `vibe-acp` never refuses a folder: its trust only decides whether the project's `.vibe` config loads. */
    trusts: () => true,

    async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }) {
      const session = randomUUID();
      const result = await spawnVibe(launch, session, null, input.login, () => false);
      if (!result.ok) {
        ctx.startLog(launch.id, result.output);
        return { ok: false as const, code: result.missing ? ("missing" as const) : ("failed" as const), text: result.text };
      }
      return { ok: true as const, session, ref: result.ref };
    },

    /** What this Inbox's processes say: running (busy or idle), stopped once one ended, absent when none ran here. */
    async sessions() {
      return (ref: string) => {
        const p = procs.get(ref);
        if (!p) return "absent" as const;
        return p.exited ? { status: null, state: "stopped", waitingFor: null } : { status: p.turn ? "busy" : "idle", state: "running", waitingFor: null };
      };
    },

    /** The session's `vibe-acp`, once the session is loaded on it: busy while a turn runs; every message it writes counts. */
    live(session: string): LaunchLive | null {
      const p = bySession(session);
      if (!p || !p.ready) return null;
      return { busy: p.turn !== null, busySince: p.turn?.since ?? null, polls: polls.get(session) ?? 0 };
    },

    /** A new `vibe-acp` on the session (`session/load`): the waiting reply then goes in as a turn (`deliver`). */
    async resume(launch: InboxLaunchRecord): Promise<ResumeResult> {
      const ref = launch.session_ref!;
      const session = launch.session ?? threads?.rootOf(launch.id)?.to?.session;
      if (!session) return { exitCode: 1, text: "no Inbox session id on the launch", failure: { code: "failed", text: "This session can't be continued from the Inbox." } };
      if (spawning.has(ref)) return nothing("starting already");
      const old = running(ref);
      if (old?.ready) return nothing("already running here");
      let finish!: () => void;
      const mark: VibeSpawning = { cancel: null, done: new Promise<void>((done) => (finish = done)) };
      spawning.set(ref, mark);
      try {
        if (old) await end(old, "restart");
        const login = await ctx.loginEnv().catch((): LaunchEnv => ({}));
        if (mark.cancel) return nothing(`${mark.cancel === "stop" ? "stopped" : "opened in Terminal"} during the restart: nothing started`);
        const result = await spawnVibe(launch, session, ref, login, () => mark.cancel !== null);
        if (mark.cancel) {
          const p = running(ref);
          if (p) await end(p, mark.cancel);
          return nothing(`${mark.cancel === "stop" ? "stopped" : "opened in Terminal"} during the restart: ${p ? "ended as it came up" : "nothing started"}`);
        }
        if (!result.ok) return { exitCode: 1, text: result.output, failure: { code: "failed", text: result.text } };
        return nothing(`vibe-acp, session/load ${ref}: ready`);
      } finally {
        spawning.delete(ref);
        finish();
      }
    },

    /**
     * The wake's text as a turn: at once, or once the running turn ends (a restart under way is waited for too). A
     * Stop, Delete, hand-off or exit meanwhile answers `hold`, as the engine does for a stopped session: the item
     * waits in the Inbox for the session's next start, never recorded as delivered.
     */
    async deliver(launch: InboxLaunchRecord, text: string, signal: AbortSignal): Promise<LaunchDelivery> {
      const ref = launch.session_ref;
      if (!ref) return { failed: "the session has not started" };
      const under = spawning.get(ref);
      if (under) await under.done;
      const p = running(ref);
      if (!p?.ready) return { failed: "Vibe is not running" };
      return (await nextTurn(p, text, signal)) ? "delivered" : "hold";
    },

    /** The turn is cancelled (while one runs) and the process ends; a restart under way is cancelled and waited for. */
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
    /** Vibe keeps its sessions (its own history and `vibe --resume`): nothing to remove. */
    remove: async (): Promise<LaunchHostResult> => ({ exitCode: 0, text: "Vibe keeps its own sessions" }),
    /** Vibe keeps its sessions by id, not by folder: nothing of a scratch folder's to purge. */
    purge: async (): Promise<LaunchHostResult & { skipped?: string }> => ({ exitCode: 0, text: "", skipped: "Vibe keeps its sessions by id, not by folder" }),

    /** Only while no `vibe-acp` of this Inbox holds the session (one Vibe opens it at a time). */
    attach(launch: InboxLaunchRecord): string | null {
      const ref = launch.session_ref;
      if (!ref || running(ref) || spawning.has(ref)) return null;
      return vibeAttachCommand(launch.folder, ref);
    },
    /**
     * Open in Terminal: `vibe --resume` on the session. With the Inbox's `vibe-acp` running, it ends first (its turn
     * cancelled) and the command waits for it; a restart under way is cancelled.
     */
    terminal(launch: InboxLaunchRecord): string {
      const ref = launch.session_ref;
      if (!ref) return `cd ${shellQuote(launch.folder)} && vibe`;
      const mark = spawning.get(ref);
      if (mark && mark.cancel === null) mark.cancel = "handoff";
      const p = running(ref);
      if (!p) return vibeAttachCommand(launch.folder, ref);
      void end(p, "handoff");
      return vibeHandoffCommand(launch.folder, ref, p.proc.pid);
    },

    /** No `vibe-acp` of this Inbox runs the session (it ended, or never ran here), and no restart is under way. */
    processEnded(ref: string): boolean {
      return !running(ref) && !spawning.has(ref);
    },

    /** Vibe's approvals on the permission card, answered on the process that asked. */
    permissions(context: LaunchPermissionContext) {
      threads = context;
      permissions = createVibePermissions({
        ...context,
        log: context.log ?? ctx.log,
        respond: (target, id, result) => !target.exited && write(target as VibeProcess, { id, result }),
        followUp: (target, text) => {
          const p = target as VibeProcess;
          void nextTurn(p, text);
        },
      });
      return permissions;
    },

    /** The words after "Vibe stopped." when the person did not press Stop: why this session is not running. */
    stoppedNote(launch: InboxLaunchRecord): string | null {
      const ref = launch.session_ref;
      if (!ref) return null;
      const p = procs.get(ref);
      if (p?.exited && p.ending === null) return `Vibe ended on its own (exit ${p.exitCode ?? "unknown"}). Your reply continues it.`;
      if (p?.exited && p.ending === "handoff") return "It was opened in Terminal. Your reply continues it here once Vibe there has quit.";
      return VIBE_STOPPED_NOTE;
    },

    /** The Inbox stops: every process's stdin closes (Vibe saves and exits); a restart under way starts nothing. */
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
