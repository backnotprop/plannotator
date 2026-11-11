/**
 * Plannotator Inbox: Claude Code's own name for each live session, from `claude agents --json` (option A for list
 * rows, 2026-11-10; brief "session-names"). Claude Code lists every live session with a `name`: the one the person
 * gave (`/rename`, `--name`, a phone), else its own default such as "plannotator-3f". The plugin sends the person's
 * name only from 0.28.50 on, so a machine with an older plugin had no name at all; this asks Claude Code itself.
 *
 * Display only, as a label is: the list rows read it after the plugin's name and generated title (`session_titles`
 * in `GET /api/inbox/threads`, this computer's owner only). Nothing routes on it and nothing stores it. Bun only (the
 * Inbox). A name a session had stays after the session leaves the listing, as a label does, until the Inbox restarts.
 *
 * An outside CLI must never hold the Inbox (#3082's lesson: a forge CLI that never answered hung it):
 *  - Nothing waits on it. The list route reads `all()`, a map in memory; a run only ever updates that map.
 *  - Each run has a hard deadline (CLAUDE_NAMES_RUN_TIMEOUT_MS) through `AgentEnvironment.run`
 *    (packages/server/inbox-agents.ts `spawnRun`): its own process group, SIGKILL to the whole group at the deadline
 *    (so a CLI that ignores SIGTERM, and anything it started, ends too), and the answer comes at the deadline
 *    whatever the processes do. Killing the group is safe here: `claude agents --json` (no `--all`) was seen to start
 *    no supervisor, and nothing it starts on purpose should outlive a run that never answered. Once #3082's runner
 *    merges, the two should share one hardened runner.
 *  - Never two at once: a refresh while one runs returns that run.
 *  - It backs off: a run that failed doubles the wait, from CLAUDE_NAMES_EVERY_MS up to CLAUDE_NAMES_BACKOFF_MAX_MS;
 *    one that worked starts it over. With no `claude` found it looks again after CLAUDE_NAMES_MISSING_RETRY_MS.
 *  - It runs only when wanted: a window is open and a live Claude Code session has neither a name nor a title from its
 *    plugin (a current plugin with a named or titled session costs nothing). Otherwise the timer only asks `wanted`.
 */

import type { AgentEnvironment } from "./inbox-agents";
import { cleanInboxSessionLabel } from "./inbox-sessions";

export const CLAUDE_NAMES_EVERY_MS = 15_000;
export const CLAUDE_NAMES_MISSING_RETRY_MS = 5 * 60_000;
/** The longest wait after runs that failed in a row (timed out, failed, or said nothing readable): it doubles up to this. */
export const CLAUDE_NAMES_BACKOFF_MAX_MS = 5 * 60_000;
/** A run's hard deadline. One real run took 0.27-0.47 s and about 0.25 s of CPU on a Mac mini (2026-11-10). */
export const CLAUDE_NAMES_RUN_TIMEOUT_MS = 5_000;
/** The most names kept: one per session this Inbox saw since it started. */
const NAMES_MAX = 500;

/** `claude agents --json`'s `sessionId` → `name`, each name cleaned as a poll's label is. Null when it does not parse. */
export function claudeAgentNames(stdout: string): Map<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = new Map<string, string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { sessionId, name } = entry as Record<string, unknown>;
    const clean = cleanInboxSessionLabel(name);
    if (typeof sessionId === "string" && sessionId && clean) out.set(sessionId, clean);
  }
  return out;
}

export interface InboxClaudeNames {
  /** Every name known, by session id (no prototype). */
  all(): Record<string, string>;
  /** Ask Claude Code now, if wanted and due. Resolves when done; never rejects. */
  refresh(): Promise<void>;
  stop(): void;
}

export function createInboxClaudeNames(options: {
  environment: () => AgentEnvironment;
  /** A Claude Code session is live and a window watches. */
  wanted: () => boolean;
  /** The names changed: the windows read the rows again. */
  onChange: () => void;
  now?: () => number;
  everyMs?: number;
  /** Tests: a shorter deadline. */
  runTimeoutMs?: number;
}): InboxClaudeNames {
  const now = options.now ?? Date.now;
  const every = options.everyMs ?? CLAUDE_NAMES_EVERY_MS;
  const names = new Map<string, string>();
  let next = 0;
  let failures = 0;
  let running: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    const environment = options.environment();
    const claude = environment.which("claude");
    if (!claude) {
      next = now() + CLAUDE_NAMES_MISSING_RETRY_MS;
      return;
    }
    const result = await environment.run([claude, "agents", "--json"], { timeoutMs: options.runTimeoutMs ?? CLAUDE_NAMES_RUN_TIMEOUT_MS }).catch(() => null);
    const listed = result && result.exitCode === 0 && !result.timedOut ? claudeAgentNames(result.stdout) : null;
    // Counted from the run's end, so a slow run never makes the next one start sooner.
    failures = listed ? 0 : failures + 1;
    next = now() + Math.min(CLAUDE_NAMES_BACKOFF_MAX_MS, every * 2 ** Math.min(20, failures));
    if (!listed) return;
    let changed = false;
    for (const [session, name] of listed) {
      if (names.get(session) === name) continue;
      names.delete(session);
      names.set(session, name);
      changed = true;
    }
    while (names.size > NAMES_MAX) names.delete(names.keys().next().value!);
    if (changed) options.onChange();
  };

  const refresh = (): Promise<void> => {
    if (running || now() < next || !options.wanted()) return running ?? Promise.resolve();
    running = run().finally(() => {
      running = null;
    });
    return running;
  };

  const timer = setInterval(() => void refresh(), Math.min(every, 5_000));
  (timer as { unref?: () => void }).unref?.();

  return {
    all: () => {
      const out = Object.create(null) as Record<string, string>;
      for (const [session, name] of names) out[session] = name;
      return out;
    },
    refresh,
    stop: () => clearInterval(timer),
  };
}
