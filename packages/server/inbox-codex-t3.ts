/**
 * A Codex thread that T3 Code runs: the person's reply goes into the T3
 * thread as a new turn, through T3's own `t3` command, with no sign-in.
 *
 * T3 runs Codex as its own `codex app-server` and starts every turn itself. A turn Codex starts on its own (a `codex queue` item) is one
 * T3 never shows: its adapter parks it as an unknown subagent's turn and
 * drops its events (T3 v0.1.9, CodexAdapterV2.ts `rememberSubagentTurnStarted`),
 * so the agent answers from a turn the person cannot see. So the Codex wake
 * never queues for such a thread (its rollout's originator says T3), and
 * sends here instead:
 *
 *  - the T3 thread is found in T3's own state, read only
 *    (`<T3 home>/userdata/statev2.sqlite`, the provider thread whose native id
 *    is the Codex thread's). Nothing inside Codex names it: T3 puts
 *    T3CODE_THREAD_ID in the thread's shells only, never in its MCP servers;
 *  - the text goes in with `<T3 home>/bin/t3 thread send --json <thread>
 *    <text>`, the launcher T3's desktop app writes at its first start. It
 *    signs in as the machine's owner for that one call, so the person signs
 *    in to nothing, and T3 queues the message behind a running turn;
 *  - the command sends no request id, so each item is sent once (the Codex
 *    wake's claim); a call that ran out of time is never sent again.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";

/** One `t3 thread send` may take this long. */
export const INBOX_CODEX_T3_SEND_TIMEOUT_MS = 30_000;
/** A Codex thread T3 has no thread for is not looked up again for this long. */
const LOOKUP_MISS_TTL_MS = 60_000;

/** What T3's command says when its server is not running, or cannot be reached (cli/thread.ts). */
const T3_DOWN = /No running T3 Code server uses|Could not reach the T3 Code server/i;
/** What T3 says for a thread it does not have, or has archived (mcp/threadAccess.ts). */
const T3_THREAD_GONE = /thread was not found|\bthread_not_found\b|archived/i;

export type CodexT3Send =
  /** T3 took it: a new turn now, or queued behind the running one. */
  | { sent: true }
  /** T3 is not running or not installed here: nothing was sent. */
  | { closed: string }
  /** T3 no longer has the thread. */
  | { gone: string }
  /** It may or may not have gone (the call ran out of time, or was cut short). */
  | { uncertain: string }
  /** T3 answered with another failure: nothing was sent. */
  | { failed: string };

export interface CodexT3Route {
  /** The T3 thread that runs this Codex thread; null when T3's state names none or cannot be read. */
  threadOf(codexThread: string): Promise<string | null>;
  /** Whether a reply to this Codex thread can go into T3: its launcher is here and T3 has the thread. */
  reaches(codexThread: string): Promise<boolean>;
  send(t3Thread: string, text: string, signal?: AbortSignal): Promise<CodexT3Send>;
}

/** `$T3CODE_HOME` (as T3 reads it), else `~/.t3`. */
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

export function createCodexT3Route(options: {
  environment: AgentEnvironment;
  now?: () => number;
  sendTimeoutMs?: number;
}): CodexT3Route {
  const { environment } = options;
  const now = options.now ?? Date.now;
  const found = new Map<string, string>();
  const missed = new Map<string, number>();
  const threadOf = async (codexThread: string): Promise<string | null> => {
    const known = found.get(codexThread);
    if (known) return known;
    const miss = missed.get(codexThread);
    if (miss !== undefined && now() - miss < LOOKUP_MISS_TTL_MS) return null;
    // A test run reads agent files only in a scratch home (never the person's real ~/.t3).
    if (!agentHomeAllowed(environment)) return null;
    const thread = await t3ThreadOfCodexThread(t3HomeOf(environment), codexThread);
    if (thread) {
      found.set(codexThread, thread);
      missed.delete(codexThread);
    } else missed.set(codexThread, now());
    return thread;
  };
  return {
    threadOf,
    reaches: async (codexThread) => agentHomeAllowed(environment) && existsSync(t3LauncherOf(environment)) && (await threadOf(codexThread)) !== null,
    send: async (t3Thread, text, signal) => {
      const launcher = t3LauncherOf(environment);
      if (!agentHomeAllowed(environment) || !existsSync(launcher)) return { closed: `no t3 command at ${launcher}` };
      const run = await environment.run([launcher, "thread", "send", "--json", t3Thread, text], {
        timeoutMs: options.sendTimeoutMs ?? INBOX_CODEX_T3_SEND_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      const said = `${run.stderr}\n${run.stdout}`.trim();
      const first = said.split("\n")[0]?.slice(0, 300) ?? "";
      if (run.timedOut || (signal?.aborted && run.exitCode !== 0)) return { uncertain: first || "no answer" };
      if (run.exitCode === 0) return { sent: true };
      if (T3_DOWN.test(said)) return { closed: first };
      if (T3_THREAD_GONE.test(said)) return { gone: first };
      return { failed: first || `exit ${run.exitCode}` };
    },
  };
}
