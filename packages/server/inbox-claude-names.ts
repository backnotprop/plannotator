/**
 * Plannotator Inbox: Claude Code's own name for each live session, from `claude agents --json` (option A for list
 * rows, 2026-11-10; brief "session-names"). Claude Code lists every live session with a `name`: the one the person
 * gave (`/rename`, `--name`, a phone), else its own default such as "plannotator-3f". The plugin sends the person's
 * name only from 0.28.50 on, so a machine with an older plugin had no name at all; this asks Claude Code itself.
 *
 * Display only, as a label is: the list rows read it after the plugin's name and generated title (`session_titles`
 * in `GET /api/inbox/threads`, this computer's owner only). Nothing routes on it and nothing stores it. Bun only (the
 * Inbox). It runs only while a Claude Code session is live and a window watches (`wanted`), at most every
 * CLAUDE_NAMES_EVERY_MS; with no `claude` found it looks again after CLAUDE_NAMES_MISSING_RETRY_MS. A name a session
 * had stays after the session leaves the listing, as a label does, until the Inbox restarts.
 */

import type { AgentEnvironment } from "./inbox-agents";
import { cleanInboxSessionLabel } from "./inbox-sessions";

export const CLAUDE_NAMES_EVERY_MS = 15_000;
export const CLAUDE_NAMES_MISSING_RETRY_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 5_000;
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
}): InboxClaudeNames {
  const now = options.now ?? Date.now;
  const every = options.everyMs ?? CLAUDE_NAMES_EVERY_MS;
  const names = new Map<string, string>();
  let next = 0;
  let running: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    const environment = options.environment();
    const claude = environment.which("claude");
    if (!claude) {
      next = now() + CLAUDE_NAMES_MISSING_RETRY_MS;
      return;
    }
    next = now() + every;
    const result = await environment.run([claude, "agents", "--json"], { timeoutMs: RUN_TIMEOUT_MS, killGroup: false }).catch(() => null);
    const listed = result && result.exitCode === 0 ? claudeAgentNames(result.stdout) : null;
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
