/**
 * A reply to an agent the Inbox started in Rex starts it again in a new Rex tab, as the same session
 * (inbox-launch.ts `resumeInRex`). Rex owns that process, so the Inbox cannot ask it whether the old one still runs:
 * after an Inbox restart, an update or a Mac waking from sleep, a Claude Code or Pi still running in its tab reads as
 * "not live" until its connection polls again. A second tab on the same session id would make two processes take the
 * replies and write one transcript. So a new tab only once both hold:
 *
 *  - this Inbox has run long enough for any connection from before it to have come back (the connection retries at
 *    most every `INBOX_RETRY_MS.max`, and counts as live for `INBOX_SESSION_LIVE_MS` after a poll);
 *  - no process on this computer runs that session id (`--session-id <id>` or `--resume <id>` on its command line:
 *    Claude Code's and Pi's Rex commands both name it). A listing that cannot be read counts as one that runs it.
 *
 * Otherwise the reply waits for the session (Try again says why). Rex tabs run on this computer, so `ps` sees them.
 */
import { INBOX_RETRY_MS } from "@plannotator/shared/inbox/agent-link";
import { INBOX_SESSION_LIVE_MS } from "@plannotator/shared/inbox/connection";
import { INBOX_REX_MAY_RUN, INBOX_REX_STILL_RUNS } from "@plannotator/core/inbox-run-line";

/** How long after this Inbox starts a Rex session it has not heard from may still be running. */
export const INBOX_REX_RESUME_AFTER_BOOT_MS = INBOX_RETRY_MS.max + INBOX_SESSION_LIVE_MS;

/** Every process's pid, parent and whole command line, or null when ps could not run. */
export function inboxProcessListing(): string | null {
  try {
    const ps = Bun.spawnSync(["/bin/ps", "-A", "-ww", "-o", "pid=,ppid=,command="], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "ignore", windowsHide: true });
    return ps.exitCode === 0 ? ps.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** Whether `listing` has a process whose command line names `session` as the one it starts or resumes. */
export function inboxListingRunsSession(listing: string, session: string): boolean {
  const id = session.replace(/[^0-9A-Za-z-]/g, "");
  if (!id) return false;
  // Quoted (the tab's `sh -c`) or not (the agent's own argv), and never a longer id that starts the same.
  const names = new RegExp(`(?:--session-id|--resume)\\s+'?${id}(?![0-9A-Za-z-])`, "i");
  return listing.split("\n").some((line) => names.test(line));
}

/**
 * Why a Rex session must not get a new tab now, or null when it may: the words for Try again. `listing` reads the
 * processes (`inboxProcessListing` unless a test stands in).
 */
export function inboxRexResumeHeld(input: { session: string | null | undefined; now: number; bootAt: number; listing?: () => string | null }): string | null {
  if (input.now - input.bootAt < INBOX_REX_RESUME_AFTER_BOOT_MS) return INBOX_REX_MAY_RUN;
  if (!input.session) return null;
  const listing = (input.listing ?? inboxProcessListing)();
  return listing === null || inboxListingRunsSession(listing, input.session) ? INBOX_REX_STILL_RUNS : null;
}
