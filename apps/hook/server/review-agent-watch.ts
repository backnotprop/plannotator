/**
 * Whether the agent that asked for a local code review is still there to
 * receive its decision (packages/shared/review-agent-gone.ts).
 *
 * The CLI can watch two kinds of reader:
 * - The process that started it and reads its stdout (an agent's shell
 *   command: Claude Code's skill, Codex, the OpenCode CLI bridge, ...). Same
 *   rule as a classic plan review (orphan-plan-review.ts): stdout is a pipe,
 *   no host result file, a real parent. Off Windows the agent is gone once
 *   the CLI was reparented; on Windows, where a process is never reparented,
 *   once that parent pid no longer exists.
 * - A Claude Code mod launch (a host result file under `claude-code-mod/`).
 *   The Claude Code process that watches the launch renews `watcher.json` in
 *   the launch directory every 5 s and releases it at session end
 *   (apps/hook/hooks/mod/controller.ts, `holdLease`). The agent is gone once
 *   no process has held it for `MOD_AGENT_GONE_AFTER_MS` of this server's own
 *   awake time. A decision written before that is delivered on resume, as
 *   before; after it the review ends and its draft waits for the next review
 *   of the same changes.
 *
 * Anything else (a terminal, a file, another host's result file, a launch with
 * no lease file yet) has no watch, and the review runs exactly as before.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import type { AgentPresence } from "@plannotator/shared/review-agent-gone";
import { takeHostResultPath } from "./host-result";
import { PARENT_CHECK_MS, stdoutIsPipe, watchesParent } from "./orphan-plan-review";

/**
 * The CLI's exit code when the review ended because its agent is gone. Not 0:
 * a mod launch that exits 0 with no result record is read as an old CLI's
 * printed decision. The mod reports any other code as "stopped without a
 * decision. Your draft is saved."
 */
export const AGENT_GONE_EXIT_CODE = 3;

/**
 * How long no Claude Code process may hold a mod launch's lease before its
 * agent counts as gone. The lease is renewed every 5 s and stale after 20 s;
 * the mod re-arms a stopped timer within 30 to 60 s; a quick
 * `claude --continue` takes it again in seconds. Two minutes covers all of
 * those and still frees the port soon after a quit.
 */
export const MOD_AGENT_GONE_AFTER_MS = 2 * 60_000;

/** The mod's own lease staleness (`LEASE_STALE_MS` in apps/hook/hooks/mod/controller.ts). */
export const MOD_LEASE_STALE_MS = 20_000;

/** A gap this long between two looks means the machine slept or the process was stopped: start counting again. */
export const SLEEP_GAP_MS = 3 * PARENT_CHECK_MS;

/** How long the open tab gets to hear that the review ended (and save its last edits) before the server stops. */
export const AGENT_GONE_ANNOUNCE_MS = 1_000;

export interface AgentWatch {
  readonly kind: "parent" | "mod";
  /** Once "gone", always "gone". */
  presence(): AgentPresence;
}

/** The parent that reads stdout. */
export function parentAgentWatch(options: {
  startPpid: number;
  platform: NodeJS.Platform;
  currentPpid: () => number;
  parentExists: (pid: number) => boolean;
}): AgentWatch {
  let gone = false;
  return {
    kind: "parent",
    presence() {
      if (!gone) {
        gone = options.platform === "win32"
          ? !options.parentExists(options.startPpid)
          : options.currentPpid() !== options.startPpid;
      }
      return gone ? "gone" : "here";
    },
  };
}

interface WatcherLease {
  owner: string | null;
  at: number;
}

/** `watcher.json` as the mod writes it (`{ owner, at, touchedAt }`), else null. */
export function parseWatcherLease(text: string | null): WatcherLease | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text) as { owner?: unknown; at?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.at !== "number") return null;
    return { owner: typeof body.owner === "string" && body.owner ? body.owner : null, at: body.at };
  } catch {
    return null;
  }
}

/** A Claude Code mod launch's lease. */
export function modLeaseAgentWatch(options: { readLease: () => string | null; now: () => number }): AgentWatch {
  let gone = false;
  let lastLookAt: number | null = null;
  let lastHeldAt = options.now();
  return {
    kind: "mod",
    presence() {
      if (gone) return "gone";
      const now = options.now();
      // Asleep since the last look: the mod could not renew either.
      if (lastLookAt !== null && now - lastLookAt > SLEEP_GAP_MS) lastHeldAt = now;
      lastLookAt = now;
      const lease = parseWatcherLease(options.readLease());
      // No lease (not written yet, an older mod, unreadable): nothing to judge by.
      if (!lease) {
        lastHeldAt = now;
        return "here";
      }
      if (lease.owner && now - lease.at < MOD_LEASE_STALE_MS) lastHeldAt = now;
      gone = now - lastHeldAt >= MOD_AGENT_GONE_AFTER_MS;
      return gone ? "gone" : "here";
    },
  };
}

/** Whether the result file is a Claude Code mod launch's (`<data dir>/claude-code-mod/<session>/<launch>/result.json`). */
export function isClaudeCodeModLaunch(resultFile: string, dataDir: string): boolean {
  return isAbsolute(resultFile) && resolve(resultFile).startsWith(resolve(dataDir, "claude-code-mod") + sep);
}

/** Whether a process with this pid exists. A refusal (EPERM) means it does. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/** The watch for this review's reader, or null when there is none to watch. */
export function reviewAgentWatch(input: {
  /** The host result file the CLI was given (`takeHostResultPath()`). */
  hostResultFile: string | undefined;
  stdoutPiped: boolean;
  startPpid: number;
  platform: NodeJS.Platform;
  dataDir: string;
  now?: () => number;
}): AgentWatch | null {
  if (input.hostResultFile) {
    if (!isClaudeCodeModLaunch(input.hostResultFile, input.dataDir)) return null;
    const leasePath = join(dirname(input.hostResultFile), "watcher.json");
    return modLeaseAgentWatch({
      readLease: () => {
        try {
          return readFileSync(leasePath, "utf8");
        } catch {
          return null;
        }
      },
      now: input.now ?? Date.now,
    });
  }
  if (!watchesParent({ hostResultFile: false, stdoutPiped: input.stdoutPiped, startPpid: input.startPpid })) return null;
  return parentAgentWatch({
    startPpid: input.startPpid,
    platform: input.platform,
    currentPpid: () => process.ppid,
    parentExists: processExists,
  });
}

/** This CLI process's watch (`review`, `opencode-review`). */
export function cliReviewAgentWatch(): AgentWatch | null {
  return reviewAgentWatch({
    hostResultFile: takeHostResultPath(),
    stdoutPiped: stdoutIsPipe(),
    startPpid: process.ppid,
    platform: process.platform,
    dataDir: getPlannotatorDataDir(),
  });
}

/**
 * Ends a local code review once its agent is gone: tells the open tab, gives
 * it a moment, stops the server and exits with `AGENT_GONE_EXIT_CODE`. No
 * decision, no archive, no result record: the draft stays. Looks every
 * `PARENT_CHECK_MS`; the timer is unref'd. Returns a stop.
 */
export function endReviewWhenAgentGone(
  watch: AgentWatch,
  server: { announceAgentGone(): void; stop(): void },
  options: { everyMs?: number; exit?: (code: number) => void } = {},
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let ended = false;
  const timer = setInterval(() => {
    if (ended || watch.presence() !== "gone") return;
    ended = true;
    clearInterval(timer);
    console.error("Plannotator: the agent that asked for this review is gone, so the review ends. Its draft is kept.");
    server.announceAgentGone();
    setTimeout(() => {
      server.stop();
      exit(AGENT_GONE_EXIT_CODE);
    }, AGENT_GONE_ANNOUNCE_MS);
  }, options.everyMs ?? PARENT_CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
