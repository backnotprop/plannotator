/**
 * Steering: a reply for a Codex thread that is in a turn goes into that turn, not after it (the owner, 2026-11-24:
 * "I think what we typically want is a way to like inject it as like steering"). The Codex wake
 * (inbox-codex-wake.ts) asks this module before `codex queue`, and `codex queue` stays the fallback for everything
 * this cannot do, so a reply never goes worse than it did before.
 *
 * Two routes, for a thread the Inbox did not launch (a launched thread steers on its own app-server,
 * inbox-launch-codex.ts):
 *
 *  1. The control socket (a terminal Codex on the shared background server, 0.157+): `turn/steer` into the running
 *     turn, found with `thread/read` (inbox-codex-control.ts). Tried first, since it lands at once; anything it cannot
 *     reach or Codex refuses falls to the hook or to `codex queue`.
 *  2. The hook (the Codex app, and any Codex that runs hooks). While the thread's rollout says a turn runs
 *     (`codexRolloutTurn`) and Plannotator's `PostToolUse` hook is in the person's Codex `hooks.json`, the reply is
 *     held in the hook mailbox (packages/shared/inbox/codex-hook-mailbox.ts) instead of being queued. The hook takes it
 *     after the turn's next tool call and Codex adds it to the turn before its next model request. When the turn ends
 *     first (no tool call came) the hold ends and `codex queue` gives it as the next turn, as before. One claim (the
 *     wake's mkdir) decides who sends it, so it never goes twice.
 *
 * `INBOX_CODEX_BUSY_REPLY` is the one switch for what a reply to a busy Codex does.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isCodexHookCommand } from "@plannotator/shared/codex-hook-command";
import { CodexControlError, codexControlSocketPath, openCodexControl, type CodexControl } from "./inbox-codex-control";

/**
 * What a reply to a Codex thread that is in a turn does (the owner's pick, 2026-11-24, option a):
 *
 *  - `"steer"`: it goes into the running turn (the hook after the next tool call, or `turn/steer`), else as the next turn.
 *  - `"next_turn"`: it waits for the turn to end and goes as the next turn (`codex queue`), as before 2026-11-24.
 *
 * Option b (wait, with Send now to steer on demand, as Claude Code) needs the Codex connection to report `busy` and
 * `send_now` and the wake to act on `deliver_now_at`; option c needs a control to queue one reply. Neither exists yet.
 */
export const INBOX_CODEX_BUSY_REPLY: "steer" | "next_turn" = "steer";

/** A held reply gives up on the hook after this long, even while the rollout still says the turn runs (a Codex that quit mid-turn). */
export const CODEX_HOOK_HOLD_MAX_MS = 30 * 60_000;
/** How often the wake looks at what it holds (the hook took it, the turn ended). */
export const CODEX_HOOK_LOOK_MS = 2_000;
/** A claim the hook made and has not yet marked (`hooked.json`) after this long is uncertain: its process died between the two. */
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


// ── The socket: steer the running turn ──

export type CodexSocketSteer =
  /** `turn/steer` took it: it is in the running turn. */
  | { kind: "steered"; turnId: string }
  /** Sent and no answer: it may be in the turn. Never sent again. */
  | { kind: "uncertain"; why: string }
  /** Not taken (no socket, the thread not on that server, no running turn, Codex refused it): another route sends it. */
  | { kind: "no"; why: string; idle: boolean };

/**
 * A thread's `status` from `thread/read` (`ThreadStatus`, app-server-protocol v2 thread.rs: `{ "type": "active",
 * "activeFlags": [...] }`, `"idle"`, `"notLoaded"`, `"systemError"`): `active`, `idle`, or null for anything else.
 */
export function codexThreadStatusOf(result: unknown): "active" | "idle" | null {
  const status = (result as { thread?: { status?: unknown } } | null)?.thread?.status;
  const type = typeof status === "string" ? status : (status as { type?: unknown } | null | undefined)?.type;
  return type === "active" ? "active" : type === "idle" ? "idle" : null;
}

/** The running turn's id in a list of turns (`Turn.status` `inProgress`), the newest first; null when none runs. */
export function codexRunningTurnOf(turns: unknown): string | null {
  if (!Array.isArray(turns)) return null;
  const running = turns.find((turn: { id?: unknown; status?: unknown } | null) => turn?.status === "inProgress" && typeof turn.id === "string" && turn.id);
  return running ? (running.id as string) : null;
}

/**
 * Codex refused a steer because the turn it named is not the running one (it ended, or another began): "no active
 * turn to steer", "expected active turn id `X` but found `Y`" (codex-rs/app-server turn_processor.rs).
 */
export const CODEX_TURN_MOVED = /no active turn|expected active turn id/i;
const TURN_MOVED = CODEX_TURN_MOVED;

/**
 * One reply into the running turn of `thread` on Codex's shared background server. Reads the thread (never loading
 * it: a thread that server does not hold is left alone), steers the running turn, and when that turn ended between
 * the read and the steer, reads once more and steers the next one. Anything else is "no" (or "uncertain" once a steer
 * was written and no answer came).
 */
export async function steerOverCodexSocket(options: {
  socketPath: string;
  thread: string;
  text: string;
  /** One request's answer (ms). */
  requestMs?: number;
  connect?: (path: string, ms: number) => Promise<CodexControl | null>;
}): Promise<CodexSocketSteer> {
  const ms = options.requestMs ?? 10_000;
  const control = await (options.connect ?? openCodexControl)(options.socketPath, ms).catch(() => null);
  if (!control) return { kind: "no", why: "Codex's control socket is not there", idle: false };
  const input = [{ type: "text", text: options.text, text_elements: [] }];
  const thread = options.thread.toLowerCase();
  /** The running turn's id; "idle"; null when Codex does not say. Reads only: never loads the thread. */
  const activeTurn = async (): Promise<string | "idle" | null> => {
    const status = codexThreadStatusOf(await control.request("thread/read", { threadId: options.thread }, ms));
    if (status !== "active") return status;
    // The newest turn first (`thread/turns/list`); when that does not show it, the whole thread once.
    const listed = await control.request("thread/turns/list", { threadId: options.thread, limit: 1 }, ms).catch(() => null);
    const fromList = codexRunningTurnOf(listed?.data);
    if (fromList) return fromList;
    const whole = await control.request("thread/read", { threadId: options.thread, includeTurns: true }, ms);
    return codexRunningTurnOf([...((whole.thread?.turns as unknown[] | undefined) ?? [])].reverse());
  };
  try {
    await control.request("initialize", { clientInfo: { name: "plannotator", title: "Plannotator", version: "1.0.0" } }, ms);
    control.notify("initialized");
    // Only a thread this server holds (the TUI's): never one of the Codex app's, whose server is its own.
    let loaded = false;
    let cursor: string | null = null;
    for (let page = 0; page < 10 && !loaded; page++) {
      const list = await control.request("thread/loaded/list", cursor ? { cursor } : {}, ms);
      const ids: unknown[] = Array.isArray(list.data) ? list.data : [];
      loaded = ids.some((id) => typeof id === "string" && id.toLowerCase() === thread);
      cursor = typeof list.nextCursor === "string" && list.nextCursor ? list.nextCursor : null;
      if (!cursor) break;
    }
    if (!loaded) return { kind: "no", why: "the thread is not on Codex's background server", idle: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      const active = await activeTurn();
      if (active === null) return { kind: "no", why: "Codex did not say which turn runs", idle: false };
      if (active === "idle") return { kind: "no", why: "no turn runs", idle: true };
      try {
        const steered = await control.request("turn/steer", { threadId: options.thread, expectedTurnId: active, input }, ms);
        return { kind: "steered", turnId: typeof steered.turnId === "string" ? steered.turnId : active };
      } catch (error) {
        if (error instanceof CodexControlError && error.maybeSent) return { kind: "uncertain", why: error.message };
        if (!(error instanceof CodexControlError) || !TURN_MOVED.test(error.message)) return { kind: "no", why: error instanceof Error ? error.message : String(error), idle: false };
      }
    }
    return { kind: "no", why: "the turn kept changing", idle: false };
  } catch (error) {
    // Only reads failed: nothing of the reply was sent.
    return { kind: "no", why: error instanceof Error ? error.message : String(error), idle: false };
  } finally {
    control.close();
  }
}

// ── What the wake asks ──

export interface CodexSteerRoute {
  /** Route 1: into the running turn over the control socket, when this Codex has one and the thread is on it. */
  socket(thread: string, text: string): Promise<CodexSocketSteer>;
  /** Whether a reply for `thread` should wait for the hook now: a turn runs, and the hook is installed. */
  holdsForHook(thread: string): Promise<boolean>;
}

/**
 * The routes for a Codex home. `allowed` is the test sandbox's guard (`agentHomeAllowed`): when false, nothing is read
 * and no socket is touched, so every reply goes the way it went before.
 */
export function createCodexSteerRoute(options: {
  codexHomeDir: () => string;
  allowed: () => boolean;
  likelyFolders: (thread: string) => string[];
  now?: () => number;
  policy?: "steer" | "next_turn";
  requestMs?: number;
}): CodexSteerRoute {
  const now = options.now ?? Date.now;
  const policy = options.policy ?? INBOX_CODEX_BUSY_REPLY;
  const rolloutPaths = new Map<string, string>();
  let hooks: { at: number; installed: boolean } | null = null;
  const hookInstalled = () => {
    if (hooks && now() - hooks.at < HOOKS_TTL_MS) return hooks.installed;
    let text: string | null = null;
    try {
      text = readFileSync(join(options.codexHomeDir(), "hooks.json"), "utf8");
    } catch {
      text = null;
    }
    hooks = { at: now(), installed: codexHooksHavePostToolUse(text) };
    return hooks.installed;
  };
  return {
    async socket(thread, text) {
      if (policy !== "steer" || !options.allowed()) return { kind: "no", why: "off", idle: false };
      const socketPath = codexControlSocketPath(options.codexHomeDir());
      if (!existsSync(socketPath)) return { kind: "no", why: "Codex's control socket is not there", idle: false };
      return steerOverCodexSocket({ socketPath, thread, text, ...(options.requestMs ? { requestMs: options.requestMs } : {}) });
    },
    async holdsForHook(thread) {
      if (policy !== "steer" || !options.allowed() || !hookInstalled()) return false;
      let path = rolloutPaths.get(thread) ?? null;
      if (!path || !existsSync(path)) {
        path = await codexRolloutPath(options.codexHomeDir(), thread, options.likelyFolders(thread));
        if (!path) return false;
        rolloutPaths.set(thread, path);
      }
      return (await codexRolloutTurn(path, now())) === "running";
    },
  };
}
