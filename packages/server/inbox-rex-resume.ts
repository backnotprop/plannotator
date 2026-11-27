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
 * When process `pid` started (ms, at most a second early: `ps` gives its elapsed time in whole seconds), or null
 * when `ps` could not tell (no such process, no `ps`).
 */
export async function inboxProcessStartedAt(pid: number, now: () => number = Date.now): Promise<number | null> {
  try {
    const ps = Bun.spawn(["/bin/ps", "-o", "etime=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    // `[[dd-]hh:]mm:ss`
    const m = code === 0 ? /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text) : null;
    if (!m) return null;
    const seconds = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
    return now() - seconds * 1000 - 1000;
  } catch {
    return null;
  }
}

/**
 * Whether `listing` has a process whose command line names `session` as the one it starts or resumes: Claude Code's
 * and Pi's `--session-id <id>` or `--resume <id>`, OpenCode's `--session <id>`.
 */
export function inboxListingRunsSession(listing: string, session: string): boolean {
  return listingNamesSession(listing, session);
}

/**
 * A command line up to the `--name` argument that follows its session. Every command the Inbox builds names its
 * session before the thread's name (`--session-id <id> --name <thread name> …`, `--resume <id>`), and `ps` gives one
 * flat line, so what follows that `--name` may be the person's own words: a thread named "--resume <another session's
 * id>" must never read as that session's process. A `--name` before any session (one the person typed,
 * `claude --name foo --resume <id>`) cuts nothing, so that process is still found.
 */
export function inboxCommandBeforeName(command: string): string {
  const session = /(?:^|\s)'?(?:--session-id|--session|--resume)'?\s+\S/.exec(command);
  if (!session) return command;
  const from = session.index + session[0].length;
  const at = command.slice(from).search(/\s'?--name'?(?:\s|$)/);
  return at < 0 ? command : command.slice(0, from + at);
}

/** The rows of `listing` (`pid ppid command`) whose command line names `session`, by pid: its parent and command. */
function sessionRows(listing: string, session: string): Map<number, { ppid: number; command: string }> {
  const found = new Map<number, { ppid: number; command: string }>();
  // Claude Code's and Pi's ids are UUIDs, OpenCode's `ses_<alnum>`: only those characters, never a pattern.
  const id = session.replace(/[^0-9A-Za-z_-]/g, "");
  if (!id) return found;
  // Quoted (the tab's `sh -c`) or not (the agent's own argv), and never a longer id that starts the same.
  const names = new RegExp(`(?:--session-id|--session|--resume)\\s+'?${id}(?![0-9A-Za-z_-])`, "i");
  for (const line of listing.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (row && names.test(inboxCommandBeforeName(row[3]!))) found.set(Number(row[1]), { ppid: Number(row[2]), command: row[3]! });
  }
  return found;
}

/** The agents' own programs, by the basename of a command's first word (or of a script `node` or `bun` runs). */
const AGENT_PROGRAMS = new Set(["claude", "pi", "opencode", "opencode2"]);

/** Whether `command` runs an agent itself, not a shell or wrapper (`sh -c`, `tmux`, `env`) with the agent's argv in it. */
export function inboxCommandIsAgent(command: string, programs: readonly string[] = []): boolean {
  const words = command.trim().split(/\s+/);
  const base = (word: string | undefined) => (word ?? "").split("/").pop()!.toLowerCase();
  const known = (name: string) => AGENT_PROGRAMS.has(name) || programs.includes(name);
  // Claude Code's installed binary is its version file (`…/claude/versions/2.1.327`).
  if (/\/claude\/versions\/[^/]+$/.test(words[0] ?? "")) return true;
  if (known(base(words[0]))) return true;
  return (base(words[0]) === "node" || base(words[0]) === "bun") && known(base(words[1]).replace(/\.(c|m)?js$/, ""));
}

/**
 * The agent processes in `listing` (`pid ppid command` rows) whose command line names `session`: the agent's own
 * program (`inboxCommandIsAgent`), never a shell or wrapper with its argv (a `sh -c '… claude --resume <id>'`, a
 * `tmux new 'claude …'` client), and none whose child is that agent too. `wrapped`: such a wrapper names it while no
 * agent program does (the agent runs where `ps` cannot tell, so Stop must not say it stopped). Stop ends `agents`
 * when the agent is not in the pane the Inbox had Rex make for it. `programs`: more names the agent's program goes by
 * (the engine passes its host's own name, as a test's fake agent is named).
 */
export function inboxListingSessionAgents(listing: string, session: string, programs: readonly string[] = []): { agents: number[]; wrapped: boolean } {
  const rows = sessionRows(listing, session);
  const agentRows = [...rows].filter(([, row]) => inboxCommandIsAgent(row.command, programs));
  const parents = new Set(agentRows.map(([, row]) => row.ppid));
  const agents = agentRows.map(([pid]) => pid).filter((pid) => !parents.has(pid));
  return { agents, wrapped: agents.length === 0 && rows.size > 0 };
}

/** Whether any process in `listing` names `session` (an agent, or a shell or wrapper about to run or running it). */
function listingNamesSession(listing: string, session: string): boolean {
  return sessionRows(listing, session).size > 0;
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
