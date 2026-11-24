/**
 * Steering: a reply for a Codex thread that is in a turn goes into that turn, not after it (the owner, 2026-11-24:
 * "I think what we typically want is a way to like inject it as like steering"). The Codex wake
 * (inbox-codex-wake.ts) asks this module before `codex queue`, and `codex queue` stays the fallback for everything
 * this cannot do, so a reply never goes worse than it did before.
 *
 * One route for a thread the Inbox did not launch (a launched thread steers on its own app-server,
 * inbox-launch-codex.ts): the hook (the Codex app, and any Codex that runs hooks). While the thread's rollout says a turn runs
 *     (`codexRolloutTurn`), Plannotator's `PostToolUse` hook is in the person's Codex `hooks.json` and this Codex has
 *     run it since hooks.json last changed (Codex skips a hook the person has not reviewed; its gate notes each run,
 *     `codex-hook-ran`), and the reply fits the hook's context whole (`codexHookFits`), the reply is held in the hook
 *     mailbox (packages/shared/inbox/codex-hook-mailbox.ts) instead of being queued. The hook takes it after the
 *     turn's next tool call and Codex adds it to the turn before its next model request. When the turn ends first (no
 *     tool call came) the hold ends and `codex queue` gives it as the next turn, as before. One claim (the wake's
 *     mkdir) decides who sends it, so it never goes twice.
 *
 * A steer is only handed on: the wake says Delivered once the thread's rollout shows the text, and sends it as the
 * next turn when the turn ended without it (inbox-codex-sight.ts).
 *
 * EXPERIMENTAL, OFF by default (the owner, 2026-11-24: "Q's working fine for the most part"): `codexSteerOn()`
 * reads the `codex-steer` experimental switch (PLANNOTATOR_EXPERIMENTAL, else config.json `experimental.codexSteer`)
 * once, when the wake and the launch host are made (an Inbox restart applies a change). Off, delivery is exactly as
 * before this module: no file of it is read or written, a launched thread's host takes the text as it did, and the
 * installer writes no PostToolUse hook.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isCodexHookCommand } from "@plannotator/shared/codex-hook-command";
import { loadConfig, resolveExperimental } from "@plannotator/shared/config";
import { codexHookRanAt } from "@plannotator/shared/inbox/codex-hook-mailbox";

/**
 * Whether a reply to a Codex thread that is in a turn may go into that turn (the `codex-steer` experimental switch;
 * off: it waits for the turn to end and goes as the next turn, `codex queue`, as always). Read once by each caller at
 * its creation, quietly (an invalid config.json says nothing here; it is off).
 *
 * Option b (wait, with Send now to steer on demand, as Claude Code) needs the Codex connection to report `busy` and
 * `send_now` and the wake to act on `deliver_now_at`; option c needs a control to queue one reply. Neither exists yet.
 */
export function codexSteerOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveExperimental(loadConfig({ quiet: true }), "codex-steer", env);
}

/** A held reply gives up on the hook after this long, even while the rollout still says the turn runs (a Codex that quit mid-turn). */
export const CODEX_HOOK_HOLD_MAX_MS = 30 * 60_000;
/** How often the wake looks at what it holds or handed on (the hook took it, the turn ended, the rollout shows it). */
export const CODEX_HOOK_LOOK_MS = 2_000;
/**
 * A claim the hook made and has not marked (`hooked.json`) after this long: its process died between the two, before
 * it wrote anything to Codex (the mark comes first), and Codex has given up on it (its time limit is 10 s). It goes as
 * the next turn.
 */
export const CODEX_HOOK_CLAIM_GRACE_MS = 30_000;
/** A rollout last written longer ago than this is not believed to be in a turn. */
const ROLLOUT_STALE_MS = 20 * 60_000;
/** How much of a rollout's end is read for its last turn event. */
const ROLLOUT_TAIL_BYTES = 512 * 1024;
/** How long the hooks file's answer is kept. */
const HOOKS_TTL_MS = 30_000;

// ── The rollout: is a turn running? ──

const TURN_STARTS = new Set(["task_started", "turn_started"]);
const TURN_ENDS = new Set(["task_complete", "turn_complete", "turn_completed", "turn_aborted"]);

/**
 * What the end of a thread's rollout says of its turn: `running` when the last turn event opens one, `idle` when it
 * ends one, null when the tail names none. Codex writes `event_msg` lines with `payload.type` `task_started` and
 * `task_complete` / `turn_aborted` (the same markers apps/hook/server/codex-session.ts reads for the Stop hook).
 */
export function codexRolloutTurnOf(tail: string): "running" | "idle" | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"event_msg"')) continue;
    let entry: { type?: unknown; payload?: { type?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "event_msg" || typeof entry.payload?.type !== "string") continue;
    if (TURN_STARTS.has(entry.payload.type)) return "running";
    if (TURN_ENDS.has(entry.payload.type)) return "idle";
  }
  return null;
}

/** The newest rollout file of a thread under `$CODEX_HOME/sessions` (by name: `rollout-<time>-<thread>.jsonl`), or null. */
export async function codexRolloutPath(codexHomeDir: string, thread: string, likelyFolders: readonly string[]): Promise<string | null> {
  const sessions = join(codexHomeDir, "sessions");
  const suffix = `-${thread.toLowerCase()}.jsonl`;
  const list = async (dir: string) => {
    try {
      return (await readdir(dir)).sort().reverse();
    } catch {
      return [];
    }
  };
  const inFolder = async (folder: string) => {
    const file = (await list(join(sessions, folder))).find((name) => name.startsWith("rollout-") && name.toLowerCase().endsWith(suffix));
    return file ? join(sessions, folder, file) : null;
  };
  for (const folder of likelyFolders) {
    const found = await inFolder(folder);
    if (found) return found;
  }
  for (const year of await list(sessions)) {
    for (const month of await list(join(sessions, year))) {
      for (const day of await list(join(sessions, year, month))) {
        const folder = join(year, month, day);
        if (likelyFolders.includes(folder)) continue;
        const found = await inFolder(folder);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Whether the rollout at `path` says a turn runs now (null: cannot say). Read only; a stale file never says running. */
export async function codexRolloutTurn(path: string, now: number): Promise<"running" | "idle" | null> {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const file = await open(path, "r");
    try {
      const length = Math.min(stat.size, ROLLOUT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, stat.size - length);
      const said = codexRolloutTurnOf(buffer.toString("utf8"));
      return said === "running" && now - stat.mtimeMs > ROLLOUT_STALE_MS ? null : said;
    } finally {
      await file.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

// ── The hook: is it installed? ──

/** Whether a Codex `hooks.json` text has Plannotator's `PostToolUse` hook (`codexHookCommand`, any path). */
export function codexHooksHavePostToolUse(text: string | null): boolean {
  if (!text) return false;
  try {
    const hooks = (JSON.parse(text) as { hooks?: { PostToolUse?: unknown } }).hooks?.PostToolUse;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook: { type?: unknown; command?: unknown }) => hook?.type === "command" && typeof hook.command === "string" && isCodexHookCommand(hook.command)));
  } catch {
    return false;
  }
}


/**
 * Codex refused a steer because the turn it named is not the running one (it ended, or another began): "no active
 * turn to steer", "expected active turn id `X` but found `Y`" (codex-rs/app-server turn_processor.rs).
 */
export const CODEX_TURN_MOVED = /no active turn|expected active turn id/i;
// ── What the wake asks ──

export interface CodexSteerRoute {
  /** Whether a reply for `thread` should wait for the hook now: a turn runs, and the hook is installed and has run. */
  holdsForHook(thread: string): Promise<boolean>;
  /**
   * The hook is in hooks.json and this Codex has not run it since hooks.json last changed: it waits for the person's
   * review in Codex (Codex skips it until then), so a reply goes as the next turn.
   */
  hookAwaitsReview(): boolean;
  /**
   * The thread's rollout file, or null when it is not found (or reading is not allowed). `fresh`: looked for even when
   * it was not found a moment ago (before a steer: a thread's first turn writes its rollout).
   */
  rollout(thread: string, fresh?: boolean): Promise<string | null>;
  /** The experimental switch, read once when the route was made: off, the wake delivers exactly as before. */
  readonly steering: boolean;
}

/**
 * The route for a Codex home. `allowed` is the test sandbox's guard (`agentHomeAllowed`): when false, nothing is read,
 * so every reply goes the way it went before. `inboxDir`: where the hook's gate notes its runs (`codex-hook-ran`).
 */
export function createCodexSteerRoute(options: {
  codexHomeDir: () => string;
  inboxDir: () => string;
  allowed: () => boolean;
  likelyFolders: (thread: string) => string[];
  now?: () => number;
  /** The switch; default `codexSteerOn()`, read once here. */
  steering?: boolean;
}): CodexSteerRoute {
  const now = options.now ?? Date.now;
  const steering = options.steering ?? codexSteerOn();
  const rolloutPaths = new Map<string, string>();
  const rolloutMisses = new Map<string, number>();
  let hooks: { at: number; installed: boolean; changedAt: number } | null = null;
  const hooksFile = () => {
    if (hooks && now() - hooks.at < HOOKS_TTL_MS) return hooks;
    let text: string | null = null;
    let changedAt = 0;
    try {
      const file = join(options.codexHomeDir(), "hooks.json");
      changedAt = statSync(file).mtimeMs;
      text = readFileSync(file, "utf8");
    } catch {
      text = null;
    }
    hooks = { at: now(), installed: codexHooksHavePostToolUse(text), changedAt };
    return hooks;
  };
  /** Codex ran the hook since hooks.json last changed (the gate's note; read each time: it is one stat). */
  const hookRan = () => {
    const ran = codexHookRanAt(options.inboxDir());
    return ran !== null && ran >= hooksFile().changedAt;
  };
  const rollout = async (thread: string, fresh = false): Promise<string | null> => {
    if (!steering || !options.allowed()) return null;
    const known = rolloutPaths.get(thread);
    if (known && existsSync(known)) return known;
    // A thread whose rollout was not found is not looked for again for a minute (the walk reads every day folder).
    const missed = rolloutMisses.get(thread);
    if (!fresh && missed !== undefined && now() - missed < 60_000) return null;
    const path = await codexRolloutPath(options.codexHomeDir(), thread, options.likelyFolders(thread));
    if (!path) {
      rolloutMisses.set(thread, now());
      return null;
    }
    rolloutMisses.delete(thread);
    rolloutPaths.set(thread, path);
    return path;
  };
  return {
    async holdsForHook(thread) {
      if (!steering || !options.allowed() || !hooksFile().installed || !hookRan()) return false;
      const path = await rollout(thread);
      return path !== null && (await codexRolloutTurn(path, now())) === "running";
    },
    hookAwaitsReview: () => steering && options.allowed() && hooksFile().installed && !hookRan(),
    rollout,
    steering,
  };
}
