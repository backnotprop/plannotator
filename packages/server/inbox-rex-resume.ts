/**
 * A reply to an agent the Inbox started in Rex starts it again in a new Rex tab, as the same session
 * (inbox-launch.ts `resumeInRex`). Rex owns that process, so the Inbox cannot ask it whether the old one still runs:
 * after an Inbox restart, an update or a Mac waking from sleep, a Claude Code or Pi still running in its tab reads as
 * "not live" until its connection polls again. A second tab on the same session id would make two processes take the
 * replies and write one transcript. So a new tab only once both hold:
 *
 *  - this Inbox has run long enough for any connection from before it to have come back (the connection retries at
 *    most every `INBOX_RETRY_MS.max`, and counts as live for `INBOX_SESSION_LIVE_MS` after a poll);
 *  - no process on this computer runs that session id: Claude Code keeps its argv (`--session-id <id>` or
 *    `--resume <id>`, as the tab's shell line does), and so does OpenCode (`--session <id>`); Pi sets `process.title = "pi"`, so its own check is asked too
 *    (`LaunchHost.runsSession`: the claim its extension wrote, against the same listing). A listing that cannot be
 *    read counts as one that runs it.
 *
 * Otherwise the reply waits for the session (its line says so; Try again says why). Rex tabs run on this computer,
 * so `ps` sees them. The listing is read without blocking the server.
 */
import { INBOX_RETRY_MS } from "@plannotator/shared/inbox/agent-link";
import { INBOX_SESSION_LIVE_MS } from "@plannotator/shared/inbox/connection";

/** How long after this Inbox starts a Rex session it has not heard from may still be running. */
export const INBOX_REX_RESUME_AFTER_BOOT_MS = INBOX_RETRY_MS.max + INBOX_SESSION_LIVE_MS;

/** Why a Rex session gets no new tab now: it may still run (this Inbox just started), or a process still runs it. */
export type InboxRexHeld = "may_run" | "still_runs";

/** Every process's pid, parent and whole command line, or null when ps could not run. */
export async function inboxProcessListing(): Promise<string | null> {
  try {
    const ps = Bun.spawn(["/bin/ps", "-A", "-ww", "-o", "pid=,ppid=,command="], { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    return code === 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Whether `listing` has a process whose command line names `session` as the one it starts or resumes: Claude Code's
 * and Pi's `--session-id <id>` or `--resume <id>`, OpenCode's `--session <id>`.
 */
export function inboxListingRunsSession(listing: string, session: string): boolean {
  return inboxListingSessionPids(listing, session).length > 0;
}

/**
 * The processes in `listing` (`pid ppid command` rows) whose command line names `session`, without one whose child
 * names it too: the agent itself, never a shell or wrapper it runs under (a `sh -c '… claude --resume <id>'` keeps
 * its pane's shell). Stop ends these when the agent is not in the pane the Inbox had Rex make for it.
 */
export function inboxListingSessionPids(listing: string, session: string): number[] {
  const id = session.replace(/[^0-9A-Za-z-]/g, "");
  if (!id) return [];
  // Quoted (the tab's `sh -c`) or not (the agent's own argv), and never a longer id that starts the same.
  const names = new RegExp(`(?:--session-id|--session|--resume)\\s+'?${id}(?![0-9A-Za-z-])`, "i");
  const found = new Map<number, number>();
  for (const line of listing.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (row && names.test(row[3]!)) found.set(Number(row[1]), Number(row[2]));
  }
  const parents = new Set(found.values());
  return [...found.keys()].filter((pid) => !parents.has(pid));
}

/**
 * Why a Rex session must not get a new tab now, or null when it may. `listing` reads the processes
 * (`inboxProcessListing` unless a test stands in); `runs` is the agent's own check against it (Pi's claims).
 */
export async function inboxRexResumeHeld(input: {
  session: string | null | undefined;
  now: number;
  bootAt: number;
  listing?: () => Promise<string | null>;
  runs?: (listing: string, session: string) => boolean;
}): Promise<InboxRexHeld | null> {
  if (input.now - input.bootAt < INBOX_REX_RESUME_AFTER_BOOT_MS) return "may_run";
  if (!input.session) return null;
  const listing = await (input.listing ?? inboxProcessListing)();
  if (listing === null) return "still_runs";
  return inboxListingRunsSession(listing, input.session) || input.runs?.(listing, input.session) === true ? "still_runs" : null;
}
