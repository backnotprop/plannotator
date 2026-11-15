/**
 * T3 Code on this machine: a reply goes into a T3 thread as a new turn
 * through T3's own `t3` command, with no sign-in. Both T3 wakes send this way
 * first: a Claude thread's (inbox-t3-wake.ts, the thread id is T3's) and a
 * Codex thread's (inbox-codex-wake.ts, found through T3's state).
 *
 * T3 runs Codex as its own `codex app-server` and starts every turn itself. A
 * turn Codex starts on its own (a `codex queue` item) is one T3 never shows:
 * its adapter parks it as an unknown subagent's turn and drops its events (T3
 * v0.1.9, CodexAdapterV2.ts `rememberSubagentTurnStarted`), so the agent
 * answers from a turn the person cannot see. So the Codex wake never queues
 * for such a thread (its rollout's originator says T3), and sends here:
 *
 *  - T3's home is `$T3CODE_HOME`, else `~/.t3`, as T3 resolves it
 *    (`--base-dir` aside, which only a command line passes);
 *  - T3 runs when `<home>/userdata/server-runtime.json` names a live process:
 *    the file `t3 thread` reads to find the server. Reading it costs nothing,
 *    so a reply that waits on a closed T3 looks every few seconds
 *    (`onceRunning`) and goes in as soon as T3 is back;
 *  - the Codex thread's T3 thread is found in T3's own state, read only
 *    (`<home>/userdata/statev2.sqlite`, the provider thread whose native id
 *    is the Codex thread's): neither Codex nor `t3 thread show --json` names
 *    it. A database of another shape is not read (none is found);
 *  - the text goes in with `<home>/bin/t3 thread send <thread> <text> --json`,
 *    the launcher T3's desktop app writes at its first start (T3's way for
 *    scripts on its host). It signs in as the machine's owner for that one
 *    call, and T3 queues the message behind a running turn;
 *  - the command sends no request id, so each item is sent once (the wake's
 *    claim); a call that ran out of time is never sent again.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";

/** One `t3 thread` call may take this long. */
export const INBOX_T3_SEND_TIMEOUT_MS = 30_000;
/** How often a reply that waits on a closed T3 looks for it again. */
export const INBOX_T3_PROBE_MS = 2_000;
/** A Codex thread T3 has no thread for is not looked up again for this long. */
const LOOKUP_MISS_TTL_MS = 60_000;
/** A thread `t3 thread show` found, believed this long before asking again. */
const SHOWN_TTL_MS = 5 * 60_000;

/** What T3's command says when its server is not running, or cannot be reached (cli/thread.ts). */
const T3_DOWN = /No running T3 Code server uses|Could not reach the T3 Code server|T3 Code has moved or been removed/i;
/** What T3 says for a thread it does not have, or has archived (mcp/threadAccess.ts, cli/thread.ts). */
const T3_THREAD_GONE = /thread was not found|was not found\.|is no longer available|\bthread_not_found\b|archived/i;

export type T3LocalSend =
  /** T3 took it: a new turn now, or queued behind the running one. */
  | { sent: true }
  /** T3 is not running or not installed here: nothing was sent. */
  | { closed: string }
  /** T3 here has no such thread: nothing was sent. */
  | { gone: string }
  /** It may or may not have gone (the call ran out of time, or was cut short). */
  | { uncertain: string }
  /** T3 answered with another failure: nothing was sent. */
  | { failed: string };

export interface T3Local {
  /** Whether T3's `t3` command is on this machine (a test run's: only in a scratch home). */
  installed(): boolean;
  /** Whether a T3 server runs for this home now. */
  running(): boolean;
  /** Calls `fn` once, as soon as `running()` says yes (looked at every INBOX_T3_PROBE_MS). */
  onceRunning(fn: () => void): void;
  /** Whether T3 here has the thread (`t3 thread show`); false when it cannot say. */
  has(t3Thread: string): Promise<boolean>;
  send(t3Thread: string, text: string, signal?: AbortSignal): Promise<T3LocalSend>;
  /** The T3 thread that runs this Codex thread; null when T3's state names none or cannot be read. */
  threadOfCodexThread(codexThread: string): Promise<string | null>;
  stop(): void;
}

/** `$T3CODE_HOME` (as T3 reads it, `~` expanded), else `~/.t3`. */
export function t3HomeOf(environment: AgentEnvironment): string {
  const value = environment.env.T3CODE_HOME?.trim();
  if (value) {
    const expanded = value === "~" ? environment.homeDir : value.startsWith("~/") ? join(environment.homeDir, value.slice(2)) : value;
    if (isAbsolute(expanded)) return resolve(expanded);
  }
  return join(environment.homeDir, ".t3");
}

/** The `t3` launcher T3's desktop app writes in its home (`DesktopCliShim.launcherPath`). */
export function t3LauncherOf(environment: AgentEnvironment): string {
  return join(t3HomeOf(environment), "bin", environment.platform === "win32" ? "t3.cmd" : "t3");
}

/** Whether the T3 server of this home runs: its runtime file names a process that is alive (serverRuntimeState.ts). */
export function t3ServerRunning(t3Home: string): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8")) as { pid?: unknown }).pid;
  } catch {
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** The columns the lookup reads: T3's state of another shape is not read. */
const PROVIDER_THREAD_COLUMNS = ["thread_id", "payload_json"];

/**
 * The T3 thread whose Codex provider thread has this native id, from T3's
 * projection (`orchestration_v2_projection_provider_threads`, its row's
 * `thread_id` and `payload_json.nativeThreadRef`). Opened read only; any
 * failure (no file, another schema, a lock) is null.
 */
export async function t3ThreadOfCodexThread(t3Home: string, codexThread: string): Promise<string | null> {
  const path = join(t3Home, "userdata", "statev2.sqlite");
  if (!existsSync(path)) return null;
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    try {
      const columns = new Set((db.query("PRAGMA table_info(orchestration_v2_projection_provider_threads)").all() as { name: unknown }[]).map((column) => column.name));
      if (!PROVIDER_THREAD_COLUMNS.every((name) => columns.has(name))) return null;
      const rows = db
        .query(
          `SELECT DISTINCT thread_id FROM orchestration_v2_projection_provider_threads
           WHERE thread_id IS NOT NULL
             AND json_extract(payload_json, '$.driver') = 'codex'
             AND lower(json_extract(payload_json, '$.nativeThreadRef.nativeId')) = lower(?)
           LIMIT 2`,
        )
        .all(codexThread) as { thread_id: unknown }[];
      // Two T3 threads on one Codex thread: not knowing which, none is picked.
      return rows.length === 1 && typeof rows[0]!.thread_id === "string" ? rows[0]!.thread_id : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function createT3Local(options: {
  environment: AgentEnvironment;
  now?: () => number;
  sendTimeoutMs?: number;
  probeMs?: number;
}): T3Local {
  const { environment } = options;
  const now = options.now ?? Date.now;
  // A test run reads agent files only in a scratch home (never the person's real ~/.t3).
  const allowed = () => agentHomeAllowed(environment);
  const launcher = () => t3LauncherOf(environment);
  const installed = () => allowed() && existsSync(launcher());
  const running = () => installed() && t3ServerRunning(t3HomeOf(environment));

  const waiting = new Set<() => void>();
  let probe: ReturnType<typeof setInterval> | null = null;
  const look = () => {
    if (!running()) return;
    if (probe) clearInterval(probe);
    probe = null;
    const due = [...waiting];
    waiting.clear();
    for (const fn of due) fn();
  };

  const run = async (args: string[], signal?: AbortSignal) => {
    const result = await environment.run([launcher(), "thread", ...args], {
      timeoutMs: options.sendTimeoutMs ?? INBOX_T3_SEND_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const said = `${result.stderr}\n${result.stdout}`.trim();
    // T3 may log first (a fresh home's migrations): what it says of the call is its last line.
    const last = said.split("\n").map((line) => line.trim()).filter(Boolean).pop()?.slice(0, 300) ?? "";
    return { result, said, last };
  };

  const found = new Map<string, string>();
  const missed = new Map<string, number>();
  const shown = new Map<string, number>();
  return {
    installed,
    running,
    onceRunning: (fn) => {
      waiting.add(fn);
      if (probe) return;
      probe = setInterval(look, options.probeMs ?? INBOX_T3_PROBE_MS);
      (probe as { unref?: () => void }).unref?.();
    },
    has: async (t3Thread) => {
      const at = shown.get(t3Thread);
      if (at !== undefined && now() - at < SHOWN_TTL_MS) return true;
      if (!running()) return false;
      const { result } = await run(["show", t3Thread, "--messages", "0", "--json"]);
      if (result.timedOut || result.exitCode !== 0) return false;
      shown.set(t3Thread, now());
      return true;
    },
    send: async (t3Thread, text, signal) => {
      if (!installed()) return { closed: `no t3 command at ${launcher()}` };
      const { result, said, last } = await run(["send", t3Thread, text, "--json"], signal);
      if (result.timedOut || (signal?.aborted && result.exitCode !== 0)) return { uncertain: last || "no answer" };
      if (result.exitCode === 0) {
        shown.set(t3Thread, now());
        return { sent: true };
      }
      if (T3_DOWN.test(said)) return { closed: last };
      shown.delete(t3Thread);
      if (T3_THREAD_GONE.test(said)) return { gone: last };
      return { failed: last || `exit ${result.exitCode}` };
    },
    threadOfCodexThread: async (codexThread) => {
      const known = found.get(codexThread);
      if (known) return known;
      const miss = missed.get(codexThread);
      if (miss !== undefined && now() - miss < LOOKUP_MISS_TTL_MS) return null;
      if (!allowed()) return null;
      const thread = await t3ThreadOfCodexThread(t3HomeOf(environment), codexThread);
      if (thread) {
        found.set(codexThread, thread);
        missed.delete(codexThread);
      } else missed.set(codexThread, now());
      return thread;
    },
    stop: () => {
      if (probe) clearInterval(probe);
      probe = null;
      waiting.clear();
    },
  };
}
