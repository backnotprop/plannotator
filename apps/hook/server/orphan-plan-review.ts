/**
 * A classic hook plan review (the default mode: a hook event piped on stdin,
 * the decision printed to stdout for the agent that ran the hook) whose agent
 * died. Nothing can read its decision any more, yet it kept its server and
 * port open forever (#3350, finding b). It now exits once its parent is gone.
 *
 * Only that mode. Everything else keeps running as before:
 * - `review`, `annotate`, the Inbox and `claude-mod-plan` never call this.
 * - A host launch with a result file (PLANNOTATOR_HOST_RESULT_FILE) is read
 *   from that file, not from stdout.
 * - stdout that is not a pipe or socket (a file, nohup's nohup.out, a
 *   terminal) still holds the decision for someone to read later.
 * - A process started under PID 1 or with no parent pid has no parent to lose.
 */
import { fstatSync } from "node:fs";

/** How often the parent is checked: slow, it only frees a port nobody uses. */
export const PARENT_CHECK_MS = 10_000;

export interface ParentWatchMode {
  /** PLANNOTATOR_HOST_RESULT_FILE was given (the decision also goes to a file). */
  hostResultFile: boolean;
  /** stdout is a pipe or socket: the decision only reaches the process reading it. */
  stdoutPiped: boolean;
  /** process.ppid when the review started. */
  startPpid: number;
}

/** Whether this review's decision has no reader but its parent, so losing the parent ends it. */
export function watchesParent(mode: ParentWatchMode): boolean {
  if (mode.hostResultFile || !mode.stdoutPiped) return false;
  return Number.isInteger(mode.startPpid) && mode.startPpid > 1;
}

/** True when the review's only reader is gone: the parent that started it changed (reparented to init or a subreaper). */
export function classicPlanReviewOrphaned(check: ParentWatchMode & { currentPpid: number }): boolean {
  return watchesParent(check) && check.currentPpid !== check.startPpid;
}

function stdoutIsPipe(): boolean {
  try {
    const stat = fstatSync(1);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

/**
 * Exit (code 0) when this classic plan review's parent is gone. The timer is
 * unref'd, so it never keeps the process alive. Not on Windows: a process
 * there is not reparented, so its parent pid never changes.
 */
export function exitWhenParentGone(hostResultFile: boolean): void {
  if (process.platform === "win32") return;
  const mode: ParentWatchMode = { hostResultFile, stdoutPiped: stdoutIsPipe(), startPpid: process.ppid };
  if (!watchesParent(mode)) return;
  const timer = setInterval(() => {
    if (classicPlanReviewOrphaned({ ...mode, currentPpid: process.ppid })) process.exit(0);
  }, PARENT_CHECK_MS);
  timer.unref?.();
}
