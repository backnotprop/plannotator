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
 *  - T3's home is `$T3CODE_HOME`, else `~/.t3`, as T3 resolves it (a
 *    server started with `--base-dir` elsewhere is not found: its replies
 *    wait as for a closed T3). Its command is the launcher T3's desktop app
 *    writes there (`bin/t3`), else a `t3` on PATH, run for that home;
 *  - T3 runs when `<home>/userdata/server-runtime.json` names a live process:
 *    the file `t3 thread` reads to find the server, so a T3 another user runs
 *    reads as closed. Reading it costs nothing, so a reply that waits on a
 *    closed T3 looks every few seconds (`onceRunning`);
 *  - the Codex thread's T3 thread is found in T3's own state, read only
 *    (`<home>/userdata/statev2.sqlite`, the provider thread whose native id
 *    is the Codex thread's): neither Codex nor `t3 thread show --json` names
 *    it. A database of another shape is not read (none is found);
 *  - the text goes on stdin (`t3 thread send <thread> - --json`), so no
 *    shell ever reads it, and the command gets only HOME, the user, PATH, the
 *    temp folder, the locale and T3's home: never this process's identity
 *    variables (an Inbox started inside an agent's thread has its
 *    T3CODE_THREAD_ID). T3 queues the message behind a running turn;
 *  - the command sends no request id, and two sends are two turns. So each
 *    send is claimed on disk first (`createT3Claims`), and only "No running
 *    T3 Code server" (decided before any request) gives the claim up at once.
 *    Any other failure, a call that ran out of time, or an Inbox stopped mid-
 *    call keeps it, and the thread is read back (`read`): the reply's id on
 *    its words' first line means T3 took it; its absence, that it may go
 *    again.
 *
 * Not on Windows: there `t3.cmd` goes through cmd.exe, which this build does
 * not trust with the text; a reply waits for a grant or the agent's read.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";

/** One `t3 thread` call may take this long. */
export const INBOX_T3_SEND_TIMEOUT_MS = 30_000;
/** How often a reply that waits on a closed T3 looks for it again. */
export const INBOX_T3_PROBE_MS = 2_000;
/** A T3 server younger than this may not have loaded its threads: a "not found" then is not believed. */
export const INBOX_T3_SETTLE_MS = 30_000;
/** A send that did not say how it went is read back no sooner than this after it: T3 may still be writing it. */
export const INBOX_T3_READ_BACK_AFTER_MS = 5_000;
/** How many of the thread's latest messages a read-back looks at. */
const READ_BACK_MESSAGES = 50;
/** What a read-back keeps of T3's answer (one reply's words can be 100 kB). */
const READ_BACK_MAX_BYTES = 4 * 1024 * 1024;
/** A Codex thread T3 has no thread for is not looked up again for this long. */
const LOOKUP_MISS_TTL_MS = 5_000;
/** A thread `t3 thread show` found, believed this long before asking again. */
const SHOWN_TTL_MS = 5 * 60_000;

/** What T3's command says when no server runs for its home: decided from the runtime file, before any request (cli/thread.ts). */
const T3_NOT_RUNNING = /^No running T3 Code server uses /;
/** What T3's command says for a thread it does not have (cli/thread.ts, mcp/threadAccess.ts), on its last line. */
const T3_THREAD_GONE = /^Thread .+ (was not found|is no longer available)\.$/;

/** The variables the `t3` command gets from this process: nothing that names an agent, a session or a token. */
const T3_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES"];

export type T3LocalSend =
  /** T3 took it: a new turn now, or queued behind the running one. */
  | { sent: true }
  /** No T3 server runs for this home: nothing was sent. */
  | { notRunning: string }
  /** Anything else: it may have gone. */
  | { unknown: string };

/**
 * Which way a reply to a T3 thread went, or that it waits: `mod` (the Claude Code mod in the thread's Claude),
 * `t3_send` (`t3 thread send` here), `grant` (a saved grant over T3's MCP), `waiting` (with the `t3_wait` reason).
 * The Inbox's debug log writes one line for each (`t3_route`): ids and these words only, never the reply's text.
 */
export interface T3Route {
  route: "mod" | "t3_send" | "grant" | "waiting";
  agent: "claude" | "codex";
  /** The Inbox's thread and the reply's id. */
  thread: string;
  reply: string;
  reason?: string;
}

/** What the thread's latest messages say of a reply: `present` (T3 took it), `absent`, `gone` (no such thread), or `unknown`. */
export type T3ReadBack = "present" | "absent" | "gone" | "unknown";

export interface T3Local {
  /** Whether T3's `t3` command is on this machine and can be used (never on Windows; a test run's only in a scratch home). */
  installed(): boolean;
  /** Whether a T3 server runs for this home now. */
  running(): boolean;
  /** Whether that server has run long enough (INBOX_T3_SETTLE_MS) that a "not found" from it is believed. */
  settled(): boolean;
  /** Calls `fn` once, as soon as `running()` says yes (looked at every INBOX_T3_PROBE_MS). */
  onceRunning(fn: () => void): void;
  /** Calls `fn` once, as soon as `running()` says no (looked at every INBOX_T3_PROBE_MS). */
  onceStopped(fn: () => void): void;
  /** Whether T3 here has the thread (`t3 thread show`); false when it cannot say. */
  has(t3Thread: string): Promise<boolean>;
  send(t3Thread: string, text: string, signal?: AbortSignal): Promise<T3LocalSend>;
  /** Reads the thread's latest messages for a user message whose first line ends with `(<marker>)`. */
  read(t3Thread: string, marker: string): Promise<T3ReadBack>;
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

/** The T3 server of this home as its runtime file says (serverRuntimeState.ts): its start, when the process it names is alive. */
export function t3ServerOf(t3Home: string): { startedAt: number } | null {
  const path = join(t3Home, "userdata", "server-runtime.json");
  let state: { pid?: unknown; startedAt?: unknown };
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as typeof state;
  } catch {
    return null;
  }
  const { pid } = state;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EPERM") return null;
  }
  const said = typeof state.startedAt === "string" ? Date.parse(state.startedAt) : Number.NaN;
  let written = Number.NaN;
  try {
    written = statSync(path).mtimeMs;
  } catch {
    // Read a moment ago.
  }
  // The later of the two: a file rewritten for a new start with an old time is still a new start.
  const startedAt = Math.max(Number.isFinite(said) ? said : 0, Number.isFinite(written) ? written : 0);
  return { startedAt };
}

export function t3ServerRunning(t3Home: string): boolean {
  return t3ServerOf(t3Home) !== null;
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
      // T3 writes while it runs: a moment's lock is waited out.
      db.run("PRAGMA busy_timeout = 2000");
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

/** Whether T3's answer to `thread show --json` holds a user message whose first line names this reply. */
export function t3ReadBackOf(json: string, marker: string): "present" | "absent" | "unknown" {
  let messages: unknown;
  try {
    messages = (JSON.parse(json) as { messages?: unknown }).messages;
  } catch {
    return "unknown";
  }
  if (!Array.isArray(messages)) return "unknown";
  const named = `(${marker})`;
  for (const message of messages as { role?: unknown; text?: unknown }[]) {
    if (message?.role !== "user" || typeof message.text !== "string") continue;
    if (message.text.split("\n", 1)[0]!.trimEnd().endsWith(named)) return "present";
  }
  // A full page may have scrolled past it: not known to be absent.
  return messages.length >= READ_BACK_MESSAGES ? "unknown" : "absent";
}

export function createT3Local(options: {
  environment: AgentEnvironment;
  now?: () => number;
  sendTimeoutMs?: number;
  probeMs?: number;
  settleMs?: number;
}): T3Local {
  const { environment } = options;
  const now = options.now ?? Date.now;
  const home = () => t3HomeOf(environment);
  // A test run reads agent files only in a scratch home (never the person's real ~/.t3).
  const allowed = () => agentHomeAllowed(environment);
  const launcher = (): string | null => {
    const desktop = t3LauncherOf(environment);
    if (existsSync(desktop)) return desktop;
    return environment.which("t3");
  };
  const installed = () => environment.platform !== "win32" && allowed() && launcher() !== null;
  const server = () => (installed() ? t3ServerOf(home()) : null);
  const running = () => server() !== null;
  const settled = () => {
    const up = server();
    return up !== null && Date.now() - up.startedAt >= (options.settleMs ?? INBOX_T3_SETTLE_MS);
  };
  const childEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const key of T3_ENV_KEYS) {
      const value = environment.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.T3CODE_HOME = home();
    return env;
  };

  /** What waits for T3 to run, and for it to stop: one probe looks for both. */
  const waiting = new Set<() => void>();
  const leaving = new Set<() => void>();
  let probe: ReturnType<typeof setInterval> | null = null;
  const look = () => {
    const side = running() ? waiting : leaving;
    const due = [...side];
    side.clear();
    if (waiting.size === 0 && leaving.size === 0 && probe) {
      clearInterval(probe);
      probe = null;
    }
    for (const fn of due) fn();
  };
  const probeSoon = () => {
    if (probe) return;
    probe = setInterval(look, options.probeMs ?? INBOX_T3_PROBE_MS);
    (probe as { unref?: () => void }).unref?.();
  };

  const run = async (args: string[], extra: { signal?: AbortSignal; stdin?: string; outputCap?: number } = {}) => {
    const result = await environment.run([launcher() ?? t3LauncherOf(environment), "thread", ...args], {
      timeoutMs: options.sendTimeoutMs ?? INBOX_T3_SEND_TIMEOUT_MS,
      env: childEnv(),
      cleanEnv: true,
      ...extra,
    });
    // T3 may log first (a fresh home's migrations): what it says of the call is its last line.
    const said = `${result.stderr}\n${result.stdout}`;
    const last = said.split("\n").map((line) => line.trim()).filter(Boolean).pop()?.slice(0, 300) ?? "";
    return { result, last };
  };

  const found = new Map<string, string>();
  const missed = new Map<string, number>();
  const shown = new Map<string, number>();
  return {
    installed,
    running,
    settled,
    onceRunning: (fn) => {
      waiting.add(fn);
      probeSoon();
    },
    onceStopped: (fn) => {
      leaving.add(fn);
      probeSoon();
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
      if (!installed()) return { notRunning: "no t3 command here" };
      const { result, last } = await run(["send", t3Thread, "-", "--json"], { stdin: text, ...(signal ? { signal } : {}) });
      if (result.exitCode === 0 && !result.timedOut) {
        shown.set(t3Thread, now());
        return { sent: true };
      }
      if (!result.timedOut && T3_NOT_RUNNING.test(last)) return { notRunning: last };
      return { unknown: result.timedOut ? "no answer" : last || `exit ${result.exitCode}` };
    },
    read: async (t3Thread, marker) => {
      if (!running()) return "unknown";
      const { result, last } = await run(["show", t3Thread, "--messages", String(READ_BACK_MESSAGES), "--json"], { outputCap: READ_BACK_MAX_BYTES });
      if (result.timedOut) return "unknown";
      if (result.exitCode !== 0) {
        if (!T3_THREAD_GONE.test(last) || !settled()) return "unknown";
        shown.delete(t3Thread);
        return "gone";
      }
      return t3ReadBackOf(result.stdout, marker);
    },
    threadOfCodexThread: async (codexThread) => {
      const known = found.get(codexThread);
      if (known) return known;
      const miss = missed.get(codexThread);
      if (miss !== undefined && now() - miss < LOOKUP_MISS_TTL_MS) return null;
      if (!allowed()) return null;
      const thread = await t3ThreadOfCodexThread(home(), codexThread);
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
      leaving.clear();
    },
  };
}

// ── The claim on each send, and the way through T3 both wakes share ──

/** One claim per reply and session (`<root>/<reply>.<session hash>/claim.json`; each wake has its own root): made before a send, kept while it may have gone. */
export interface T3Claims {
  has(itemId: string, session: string): boolean;
  /** When the claim was made, null when there is none. */
  madeAt(itemId: string, session: string): number | null;
  make(itemId: string, session: string, t3Thread: string): boolean;
  drop(itemId: string, session: string): void;
  /** Every claim on disk, as `<item>.<session>` keys. */
  keys(): string[];
}

export function createT3Claims(root: string, now: () => number = Date.now): T3Claims {
  // A session id is opaque and may be long: two T3 threads must never share a folder.
  const dirOf = (itemId: string, session: string) => join(root, `${itemId}.${createHash("sha256").update(session).digest("hex").slice(0, 32)}`);
  return {
    has: (itemId, session) => existsSync(dirOf(itemId, session)),
    madeAt: (itemId, session) => {
      const dir = dirOf(itemId, session);
      try {
        const at = Date.parse((JSON.parse(readFileSync(join(dir, "claim.json"), "utf8")) as { at?: string }).at ?? "");
        if (Number.isFinite(at)) return at;
      } catch {
        // Made by a call that stopped before it wrote its claim.
      }
      try {
        return statSync(dir).mtimeMs;
      } catch {
        return null;
      }
    },
    make: (itemId, session, t3Thread) => {
      const dir = dirOf(itemId, session);
      try {
        mkdirSync(root, { recursive: true });
        mkdirSync(dir);
      } catch {
        return false;
      }
      try {
        writeFileSync(join(dir, "claim.json"), `${JSON.stringify({ item: itemId, session, thread: t3Thread, at: new Date(now()).toISOString() })}\n`);
      } catch {
        // The folder alone holds the claim.
      }
      return true;
    },
    drop: (itemId, session) => {
      try {
        rmSync(dirOf(itemId, session), { recursive: true, force: true });
      } catch {
        // Left behind: a later sweep tries again.
      }
    },
    keys: () => {
      let names: string[] = [];
      try {
        names = readdirSync(root);
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const name of names) {
        try {
          const claim = JSON.parse(readFileSync(join(root, name, "claim.json"), "utf8")) as { item?: unknown; session?: unknown };
          if (typeof claim.item === "string" && typeof claim.session === "string") out.push(`${claim.item}.${claim.session}`);
        } catch {
          // Names no item: left for the sweep that made it.
        }
      }
      return out;
    },
  };
}

/**
 * What one try through `t3 thread send` came to:
 *  - `delivered`: T3 took it (it said so, or the thread shows it);
 *  - `closed`: no T3 server runs here, nothing was sent (no claim is kept);
 *  - `retry`: T3 did not take it (the thread read back without it): the claim is gone, try again later;
 *  - `gone`: T3 here has no such thread (the claim is gone);
 *  - `checking`: it may have gone: the claim is kept, and the thread is read back on a later try.
 */
export type T3Try = "delivered" | "closed" | "retry" | "gone" | "checking";

export async function tryThroughT3(input: {
  local: T3Local;
  claims: T3Claims;
  itemId: string;
  session: string;
  t3Thread: string;
  /** The reply's id as the first line of `text` names it. */
  marker: string;
  text: string;
  now: () => number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<T3Try> {
  const { local, claims, itemId, session, t3Thread, marker, now } = input;
  if (claims.has(itemId, session)) {
    // Sent before with no answer, or cut short (an Inbox stopped mid-call): what the thread shows decides.
    if (!local.running()) return "checking";
    const made = claims.madeAt(itemId, session);
    if (made !== null && now() - made < INBOX_T3_READ_BACK_AFTER_MS) return "checking";
    const said = await local.read(t3Thread, marker);
    if (said === "present") return "delivered";
    if (said === "unknown") return "checking";
    claims.drop(itemId, session);
    if (said === "gone") return "gone";
    input.log?.(`T3 did not take ${itemId} for thread ${t3Thread} (its thread does not show it); it goes again.`);
  }
  if (!local.running()) return "closed";
  if (!claims.make(itemId, session, t3Thread)) return "checking";
  const sent = await local.send(t3Thread, input.text, input.signal);
  if ("sent" in sent) return "delivered";
  if ("notRunning" in sent) {
    claims.drop(itemId, session);
    return "closed";
  }
  input.log?.(`t3 thread send for ${itemId} (thread ${t3Thread}) did not say it went (${sent.unknown}); the thread is read back before it goes again.`);
  return "checking";
}
