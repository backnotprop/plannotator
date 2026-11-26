/**
 * Whether the agent that asked for a local code review is still there to
 * receive its decision (packages/shared/review-agent-gone.ts).
 *
 * Each watch answers two questions:
 * - `presence()`, asked on every Send: can the decision be received right
 *   now? Evaluated live, never latched where the agent can come back.
 * - `ended()`, asked by the 10 s timer: is the agent surely gone, so the
 *   page is told and, once no tab has it open, a local review may end? Any
 *   doubt answers false: ending a review under a live agent is the outcome
 *   that must never happen. The stdout reader's answer stays true once true
 *   (a pipe nobody reads cannot be read again); a mod launch's follows its
 *   lease, so a resume brings the agent back.
 *
 * The CLI can watch two kinds of reader:
 * - The process reading its stdout (an agent's shell command, the OpenCode
 *   CLI bridge). A changed parent (reparented; on Windows, a parent pid that
 *   no longer exists) is only a suspicion: an agent may have started the
 *   review in the background (`&`, nohup, setsid, `start /b`) and still read
 *   the pipe. The reader is gone only when a write to stdout fails with
 *   EPIPE (`probeStdoutReader`: a zero-length write on macOS, one newline
 *   elsewhere), only while the suspicion holds, at most every
 *   `PROBE_EVERY_MS` doubling up to `PROBE_MAX_GAP_MS`.
 * - A Claude Code mod launch (a host result file under `claude-code-mod/`).
 *   Its lease (`watcher.json` beside the result file) is renewed every 5 s by
 *   the Claude Code process watching the launch, which records its pid there
 *   (apps/hook/hooks/mod/controller.ts, `leaseText`). Ended when the lease's
 *   stamp has not changed for `MOD_AGENT_GONE_AFTER_MS` of THIS process's own
 *   awake time (no clock is compared across processes) AND the pid it names
 *   no longer runs. Send asks less: gone once the pid no longer runs and
 *   nobody holds the lease (released, or not renewed for `MOD_LEASE_STALE_MS`),
 *   so a quit session's review never says "sent". A lease without a pid (an
 *   older mod, Git Bash on Windows) is never judged gone.
 *
 * Anything else (a terminal, a file, another host's result file, a launch with
 * no lease file yet) has no watch, and the review runs exactly as before.
 */
import { readFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import type { AgentPresence } from "@plannotator/shared/review-agent-gone";
import { AGENT_GONE_CLI_LINE } from "@plannotator/shared/review-agent-gone-words";
import { takeHostResultPath } from "./host-result";
import { PARENT_CHECK_MS, stdoutIsPipe, watchesParent } from "./orphan-plan-review";

/**
 * The CLI's exit code when the review ended because its agent is gone. Not 0:
 * a mod launch that exits 0 with no result record is read as an old CLI's
 * printed decision. The mod has its own line for it
 * (apps/hook/hooks/mod/controller.ts `REVIEW_AGENT_GONE_EXIT_CODE`).
 */
export const AGENT_GONE_EXIT_CODE = 3;

/**
 * How long a mod launch's lease stamp must stay unchanged (this process's
 * clock) before its agent may count as gone: the lease is renewed every 5 s,
 * the mod re-arms a stalled timer within seconds of its next hook or 30 s
 * self-heal look, and a quick `claude --continue` takes it again at once.
 */
export const MOD_AGENT_GONE_AFTER_MS = 2 * 60_000;

/**
 * A held lease whose stamp has not moved for this long (this process's clock)
 * has no holder: the mod's own `LEASE_STALE_MS` (apps/hook/hooks/mod/controller.ts,
 * a separate bundle; review-agent-gone.test.ts keeps the two equal).
 */
export const MOD_LEASE_STALE_MS = 20_000;

/** A gap this long between two looks means the machine slept or the process was stopped: start counting again. */
export const SLEEP_GAP_MS = 3 * PARENT_CHECK_MS;

/** The first stdout probe after a suspicion, and the longest gap the probe backs off to while the reader answers. */
export const PROBE_EVERY_MS = PARENT_CHECK_MS;
export const PROBE_MAX_GAP_MS = 60_000;

export interface AgentWatch {
  readonly kind: "parent" | "mod";
  /** For Send: can a decision be received now. */
  presence(): AgentPresence;
  /** For the page and for ending a local review: the agent is surely gone (see the top of this file). */
  ended(): boolean;
}

/** Whether stdout still has a reader: "closed" only on EPIPE. */
export type ReaderProbe = () => "open" | "closed";

/** Only EPIPE (no process holds the read end) counts as closed; any other outcome is open. */
function writeProbe(text: string): "open" | "closed" {
  try {
    writeSync(1, text);
    return "open";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPIPE" ? "closed" : "open";
  }
}

/**
 * Whether stdout still has a reader. First a zero-length write, which adds
 * nothing to the output: macOS answers it with EPIPE once the reader is gone
 * (checked on Bun, review-agent-watch.test.ts), so there it is the whole probe.
 * Linux answers a zero-length write to a pipe with success whatever the
 * reader does, so elsewhere a single newline is written; the reader sees a
 * blank line (see "When the agent that asked for a review is gone" in
 * docs/agent-guides/code-review.md for the `| head` case).
 */
export function probeStdoutReader(platform: NodeJS.Platform = process.platform): "open" | "closed" {
  if (writeProbe("") === "closed") return "closed";
  if (platform === "darwin") return "open";
  return writeProbe("\n");
}

/** The process reading stdout. */
export function parentAgentWatch(options: {
  startPpid: number;
  platform: NodeJS.Platform;
  currentPpid: () => number;
  parentExists: (pid: number) => boolean;
  probeReader: ReaderProbe;
  now?: () => number;
}): AgentWatch {
  const now = options.now ?? Date.now;
  let closed = false;
  let nextProbeAt = 0;
  let gap = PROBE_EVERY_MS;
  const suspicious = () =>
    options.platform === "win32" ? !options.parentExists(options.startPpid) : options.currentPpid() !== options.startPpid;
  const check = (force: boolean): boolean => {
    if (closed) return true;
    if (!suspicious()) return false;
    const t = now();
    if (!force && t < nextProbeAt) return false;
    if (options.probeReader() === "closed") {
      closed = true;
      return true;
    }
    nextProbeAt = t + gap;
    gap = Math.min(gap * 2, PROBE_MAX_GAP_MS);
    return false;
  };
  return {
    kind: "parent",
    presence: () => (check(true) ? "gone" : "here"),
    ended: () => check(false),
  };
}

interface WatcherLease {
  owner: string | null;
  at: number;
  pid: number | null;
}

/** `watcher.json` as the mod writes it (`{ owner, at, touchedAt, pid? }`), else null. */
export function parseWatcherLease(text: string | null): WatcherLease | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text) as { owner?: unknown; at?: unknown; pid?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.at !== "number") return null;
    return {
      owner: typeof body.owner === "string" && body.owner ? body.owner : null,
      at: body.at,
      pid: typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 1 ? body.pid : null,
    };
  } catch {
    return null;
  }
}

/** A Claude Code mod launch's lease. */
export function modLeaseAgentWatch(options: {
  readLease: () => string | null;
  now: () => number;
  pidAlive: (pid: number) => boolean;
}): AgentWatch {
  let lastLookAt: number | null = null;
  let lastStamp: number | null = null;
  let renewedAt = options.now();
  /** The lease and how long (this process's clock) its stamp has not moved, or null with no lease. */
  const look = (): { lease: WatcherLease; stillFor: number } | null => {
    const t = options.now();
    // Asleep since the last look: the mod could not renew either.
    if (lastLookAt !== null && t - lastLookAt > SLEEP_GAP_MS) renewedAt = t;
    lastLookAt = t;
    const lease = parseWatcherLease(options.readLease());
    // No lease (not written yet, unreadable): nothing to judge by.
    if (!lease) {
      renewedAt = t;
      return null;
    }
    // Renewed: the stamp moved under a holder (whatever clock wrote it).
    if (lease.owner && lease.at !== lastStamp) renewedAt = t;
    lastStamp = lease.at;
    return { lease, stillFor: t - renewedAt };
  };
  // The process that held it is gone (a lease without a pid is never judged).
  const holderGone = (lease: WatcherLease) => lease.pid !== null && !options.pidAlive(lease.pid);
  return {
    kind: "mod",
    // Send: the holder's process is gone and nobody holds the lease (released
    // at session end, or not renewed for `MOD_LEASE_STALE_MS`): nobody can take
    // a decision now. A resume that takes the lease again answers "here".
    presence: () => {
      const seen = look();
      if (!seen || !holderGone(seen.lease)) return "here";
      return !seen.lease.owner || seen.stillFor >= MOD_LEASE_STALE_MS ? "gone" : "here";
    },
    // The page and the end: not renewed for the whole grace, and the holder is
    // gone. Not latched: a resume takes the lease again, and the agent is back.
    ended: () => {
      const seen = look();
      return !!seen && seen.stillFor >= MOD_AGENT_GONE_AFTER_MS && holderGone(seen.lease);
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
  probeReader?: ReaderProbe;
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
      pidAlive: processExists,
    });
  }
  if (!watchesParent({ hostResultFile: false, stdoutPiped: input.stdoutPiped, startPpid: input.startPpid })) return null;
  return parentAgentWatch({
    startPpid: input.startPpid,
    platform: input.platform,
    currentPpid: () => process.ppid,
    parentExists: processExists,
    probeReader: input.probeReader ?? probeStdoutReader,
    now: input.now,
  });
}

/** This CLI process's watch (`review`, `opencode-review`). */
export function cliReviewAgentWatch(): AgentWatch | null {
  const watch = reviewAgentWatch({
    hostResultFile: takeHostResultPath(),
    stdoutPiped: stdoutIsPipe(),
    startPpid: process.ppid,
    platform: process.platform,
    dataDir: getPlannotatorDataDir(),
  });
  // The probe must see EPIPE as an error, not die of SIGPIPE.
  if (watch?.kind === "parent") process.on("SIGPIPE", () => {});
  return watch;
}

/**
 * How long a local review whose agent is gone waits with no tab open (no
 * event stream: the page was closed, not reloaded) before it ends. Counted in
 * looks of this process, not by the clock, so a machine that slept with the
 * tab open does not end it on waking before the tab reconnects.
 */
export const AGENT_GONE_NO_TAB_MS = 2 * 60_000;

/**
 * The grace a spec may set on the CLI, heard only in the test sandbox
 * (`PLANNOTATOR_TEST_SANDBOX`): `PLANNOTATOR_TEST_REVIEW_NO_TAB_MS`.
 */
export function noTabMsFromEnv(env: Record<string, string | undefined>): number | undefined {
  if (!env.PLANNOTATOR_TEST_SANDBOX) return undefined;
  const value = Number(env.PLANNOTATOR_TEST_REVIEW_NO_TAB_MS);
  return env.PLANNOTATOR_TEST_REVIEW_NO_TAB_MS && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Watches a local code review's agent. While the agent is gone the review
 * stays open for every tab that has it (the page says nobody can receive a
 * decision, keeps every comment and keeps saving its draft, and Send is
 * refused), and says it to tabs opened later too. When the agent comes back
 * (a mod launch whose lease is taken again), the page is told that too. Once
 * the agent is gone and no tab has had the review open for
 * `AGENT_GONE_NO_TAB_MS`, the review ends: the server stops and the process
 * exits with `AGENT_GONE_EXIT_CODE`. No decision, no archive, no result
 * record: the draft stays for the next review of the same changes. Looks every
 * `PARENT_CHECK_MS`; the timer is unref'd. Never touches a review that was
 * decided (`setAgentGone` answers false then), and the returned stop (called
 * as soon as a decision is taken) ends the watch.
 */
export function endReviewWhenAgentGone(
  watch: AgentWatch,
  server: { setAgentGone(gone: boolean): boolean; openTabs(): number; stop(): void },
  options: { everyMs?: number; noTabMs?: number; exit?: (code: number) => void } = {},
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const everyMs = options.everyMs ?? PARENT_CHECK_MS;
  const noTabLooks = Math.max(1, Math.ceil((options.noTabMs ?? AGENT_GONE_NO_TAB_MS) / everyMs));
  let stopped = false;
  let announced = false;
  let looksWithNoTab = 0;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    const gone = watch.ended();
    if (gone !== announced) {
      if (!server.setAgentGone(gone)) return stop();
      announced = gone;
    }
    if (!gone || server.openTabs() > 0) {
      looksWithNoTab = 0;
      return;
    }
    looksWithNoTab += 1;
    if (looksWithNoTab < noTabLooks) return;
    // Decided meanwhile: leave it to deliver that decision.
    if (!server.setAgentGone(true)) return stop();
    stop();
    console.error(AGENT_GONE_CLI_LINE);
    server.stop();
    exit(AGENT_GONE_EXIT_CODE);
  }, everyMs);
  timer.unref?.();
  return stop;
}
