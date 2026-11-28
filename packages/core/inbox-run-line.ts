/**
 * The run line of a launched thread (PLAN "Run line state"): one quiet line
 * under the latest message saying what the agent is doing. Pure: the server
 * gathers the evidence (the launch record, the mod's live poll, the host's
 * `agents --json`, what it remembers in memory) and this decides the state.
 *
 * - `launch.error` → failed (or missing, when the CLI was gone).
 * - Our own permission question is open and its hook still holds it (the
 *   lease) → waiting_answer, whatever the host says: `waitingFor` cannot
 *   tell "asked in the Inbox" from "nobody asked" (bg-perm-test).
 * - The host says it waits on a prompt (`status: waiting` + `waitingFor`) →
 *   waiting_terminal, unless the session is live and idle: a session blocked
 *   on a dialog may still poll busy, but an idle one is blocked on nothing
 *   (the person answered in Terminal and the turn ended).
 * - A reply's respawn that failed, or never connected within the grace →
 *   failed (missing when the CLI is gone), with Try again; it is never
 *   retried by itself.
 * - Live and idle after a turn that ended in an error the session wrote down
 *   (`turnErrorAt`), with nothing waiting for it → failed with `turn_error`.
 * - Live and busy → working; live and idle → no line, except while the turn
 *   the start was for has not visibly begun (not taken yet, or taken but not
 *   polled busy nor answered): still starting, so the line does not blink out.
 * - Not live: the CLI gone → missing while a message waits for it (else no
 *   line: nothing waits on it); under a minute since the (re)start →
 *   starting; the host lists it stopped, done or not at all → stopped; never
 *   seen live a minute after start → failed ("not connected"); else stopped.
 */

import type { InboxLaunchRecord, InboxRun } from "./inbox-types";

/**
 * A launched session's turn that ended in an error (approval "inbox-failed-turn-note"): after the agent's name, on its
 * run line ("Claude Code couldn't answer. Your message is kept.") and in the notification for it
 * ("<project>: Codex couldn't answer").
 */
export const INBOX_TURN_FAILED_WORDS = "couldn't answer";

/** A start in Rex whose session never connected: the failed line's cause (the agent's own tab says why; the line has its own frame). */
export const INBOX_RUN_REX_NOT_CONNECTED = "Look at its tab there.";
/** Try again on a Rex session the Inbox may not have heard from yet since it started (its connection retries every minute at most). */
export const INBOX_REX_MAY_RUN = "It may still be running in Rex. Try again in a minute.";
/** Try again, or a reply's restart, on a Rex session whose process still runs (its tab, or wherever it was resumed): nothing starts beside it. */
export const INBOX_REX_STILL_RUNS = "It's still running, so it can't start again yet.";
/** Stop of a session that runs in Rex when Rex said no to closing its pane. */
export const INBOX_RUN_IN_REX_STOP = "Rex didn't close its tab. Stop it in its tab there.";
/** Stop of a session that runs in Rex when Rex did not answer in time (it may still close it). */
export const INBOX_RUN_IN_REX_NO_ANSWER = "Rex didn't answer. Stop it in its tab there.";
/** Stop of a session that runs in Rex when the Inbox never learned its pane (Rex was not asked). */
export const INBOX_RUN_IN_REX_NO_TAB = "The Inbox doesn't know its tab in Rex. Stop it in its tab there.";
/** Stop of a session in a Rex pane the Inbox did not open, when its process could not be found: nothing was closed. */
export const INBOX_RUN_IN_REX_ELSEWHERE = "It runs in a tab the Inbox didn't open. Stop it there.";
/** Stop of an agent in Rex whose process could not be found or ended (`ps` unread, a wrapper only, the signal refused). */
export const INBOX_RUN_IN_REX_COULDNT = "Couldn't stop it. Stop it in its tab.";
/** A reply to a session that ran in Rex, while Rex is not on this computer: the failed line's cause. */
export const INBOX_REX_NOT_HERE_AGAIN = "Rex isn't open on this computer.";
/**
 * The same where Rex is a server with no app on that computer (Linux, FreeBSD) and it did not answer. The owner
 * approved these words and the shared ones below (2026-11-18); the Mac's lines above and in RunLine.tsx are untouched.
 * No computer is named: the person usually reads this from another one.
 */
export const INBOX_REX_SERVER_AWAY_AGAIN = "Rex's server isn't running.";
/** The run line's note for a start that went to the background for that reason. */
export const INBOX_REX_SERVER_AWAY = "Rex's server isn't running, so it started in the background.";
/** Settings → Agents, Rex chosen, for that reason. */
export const INBOX_REX_SERVER_AWAY_SETTINGS = "Rex's server isn't running now, so new agents start in the background until it is.";
/** The Rex server there is another account's (a shared server): the Inbox never starts an agent on it. */
export const INBOX_REX_SHARED = "Rex here runs as another account, so it started in the background.";
export const INBOX_REX_SHARED_AGAIN = "Rex here runs as another account.";
/** A reply to a session that ran in Rex, when Rex said no to its new tab (an error answer): the failed line's cause. */
export const INBOX_REX_REFUSED_AGAIN = "Rex didn't open a tab for it.";
/** Open in Terminal for a session that runs in Rex (its line offers none; an older window's press). */
export const INBOX_RUN_IN_REX_OPEN = "This agent runs in Rex. Open its tab there.";

/** A start that has not connected within this long is not "starting" any more. */
export const INBOX_RUN_START_GRACE_MS = 60_000;

/** The host's view of one session (`claude agents --json --all`), or `absent` when `--all` does not list it. */
export type InboxRunHostState = { status: string | null; state: string | null; waitingFor: string | null } | "absent";

export interface InboxRunEvidence {
  launch: InboxLaunchRecord;
  project: string;
  now: number;
  /** The latest start or respawn (ms); the launch's `started_at` after an Inbox restart. */
  startedAt: number;
  /** That start was a reply's respawn (a Try again of a start that never ran is a first start). */
  again: boolean;
  /** The CLI is gone from the login PATH (false), there (true), or not checked (null). */
  cliAvailable: boolean | null;
  /** The mod's poll: null when not live. */
  live: { busy: boolean | null; busySince: number | null } | null;
  /** A message to the agent waits for its turn to begin (not taken, or taken but not yet busy nor answered): the first one, or the reply that respawned it. */
  turnWaiting: boolean;
  /** The session took a message at least once (it connected). */
  seenLive: boolean;
  /** The host's last word on it; null when not read. */
  host: InboxRunHostState | null;
  /** When the host was first seen waiting on a prompt. */
  waitingSince: number | null;
  /** The reply's respawn did not take: its cause (it exited non-zero, or never connected). Null otherwise. */
  respawnFailed: string | null;
  /** That respawn was refused because Claude Code does not trust the folder: the line offers Open in Terminal. */
  respawnUntrusted?: boolean;
  /** The session's last turn ended in an error it wrote down (Claude Code's transcript): when (ms); null otherwise. */
  turnErrorAt?: number | null;
  /** When the person pressed Stop, while it still holds. */
  stoppedByPersonAt: number | null;
  /** The host's words for a stop that was not the person's (`LaunchHost.stoppedNote`): the stopped line's `cause`. */
  stoppedNote?: string | null;
  /** What of Plannotator's connects the session ("plugin" when not given; Pi's "extension"). */
  connector?: string;
  /** `cd <folder> && claude attach <ref>`; null before the session exists. */
  attachCommand: string | null;
  /** The launch's folder as the person knows it (`~/…`), for the failed line of a folder the Send made. */
  shownFolder?: string;
  /** A clone under way: its percent, once shown (null before, or in its first seconds). */
  clonePct?: number | null;
  /** The clone the record says runs is running in this Inbox now (false after a restart cut it off). */
  cloneRunning?: boolean;
  /** When the oldest permission question of ours still open was asked (its hook holds it), or null. */
  permissionSince?: number | null;
  /** A start in Rex (`InboxRun.rex`): on every line it gives. */
  rex?: InboxRun["rex"];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * The session a launched message (a root, or a reply sent to a new session) started: its record's, else its `to` while
 * that is still the placeholder or, on an older launch that started, the session. Null when it was moved before any
 * session started, and on a message no launch made.
 */
export function inboxLaunchedSession(root: { to?: { session: string } | null; launch?: Pick<InboxLaunchRecord, "session" | "session_ref"> | null }): string | null {
  if (!root.launch) return null;
  if (root.launch.session) return root.launch.session;
  const to = root.to?.session ?? null;
  return to && (to.startsWith("launch:") || root.launch.session_ref) ? to : null;
}

/**
 * A bridge command's `launched` (approval "inbox-launched-agent-note"): set only on the message a launch was made for
 * (a launched thread's root, or a reply sent to a new session), while it is addressed to the session its launch
 * started (never once the person moved it to another session, never on a deleted launch), so only that session's
 * first wake carries the launched lines. `project`: started in a project folder, not a scratch folder, one the Send
 * made, or a clone. Null for every other message.
 */
export function inboxLaunchedWakeOf(message: {
  to?: { session: string } | null;
  launch?: Pick<InboxLaunchRecord, "agent" | "session" | "session_ref" | "scratch" | "made_folder" | "clone" | "deleted_at"> | null;
}): { agent: InboxLaunchRecord["agent"]; project: boolean } | null {
  const launch = message.launch;
  if (!launch || launch.deleted_at || !message.to) return null;
  if (inboxLaunchedSession(message) !== message.to.session) return null;
  return { agent: launch.agent, project: !launch.scratch && !launch.made_folder && !launch.clone };
}

export function inboxRunOf(e: InboxRunEvidence): InboxRun | null {
  // Clone from a git URL: the clone comes before the agent (E1-E7, E11).
  const clone = e.launch.clone;
  const cloneOf = (extra: Partial<NonNullable<InboxRun["clone"]>> = {}): NonNullable<InboxRun["clone"]> => ({
    url: clone!.url,
    host: clone!.host,
    slug: clone!.slug,
    branch: clone!.branch ?? null,
    pct: null,
    error: null,
    error_text: null,
    renamed_from: clone!.renamed_from ?? null,
    brings: clone!.brings ?? null,
    folder_shown: e.shownFolder ?? null,
    ...extra,
  });
  const line = (state: InboxRun["state"], extra: Partial<InboxRun> = {}): InboxRun => ({
    state,
    launch_id: e.launch.id,
    agent: e.launch.agent,
    project: e.project,
    folder: e.launch.folder,
    since: null,
    again: false,
    stopped_by_person: false,
    cause: null,
    untrusted: false,
    attach_command: e.attachCommand,
    ...(e.rex ? { rex: e.rex } : {}),
    // A clone that is done: the line after it still names it (E11's "Cloned into …", E10's trust words).
    ...(clone && clone.state === "done" ? { clone: cloneOf() } : {}),
    ...extra,
  });
  if (clone && clone.state === "cloning") {
    // A clone the Inbox no longer runs (it was restarted meanwhile): failed, with Try again.
    if (e.cloneRunning === false) return line("clone_failed", { since: e.launch.started_at, clone: cloneOf({ error: "failed", error_text: "The clone stopped when the Inbox closed." }) });
    return line("cloning", { since: iso(e.startedAt), clone: cloneOf({ pct: e.clonePct ?? null }) });
  }
  if (clone && clone.state === "failed") return line("clone_failed", { clone: cloneOf({ error: clone.error ?? "failed", error_text: clone.error_text ?? null }) });
  if (clone && clone.state === "cancelled") return line("clone_cancelled", { clone: cloneOf() });
  const error = e.launch.error;
  if (error) {
    if (error.code === "missing") return line("missing");
    return line("failed", { cause: error.text, untrusted: error.code === "untrusted", since: error.at, ...(e.launch.made_folder && !clone ? { made_folder: e.shownFolder ?? e.launch.folder } : {}) });
  }
  if (e.permissionSince != null) return line("waiting_answer", { since: iso(e.permissionSince) });
  const host = e.host === "absent" ? null : e.host;
  const idle = e.live !== null && e.live.busy !== true;
  if (host?.status === "waiting" && host.waitingFor && !idle) return line("waiting_terminal", { since: iso(e.waitingSince) });
  // Only while the reply waits for it: re-addressed to another session, nothing here waits any more.
  if (!e.live && e.respawnFailed && e.turnWaiting) return e.cliAvailable === false ? line("missing") : line("failed", { cause: e.respawnFailed, again: true, untrusted: e.respawnUntrusted === true });
  const starting = () => line("starting", { since: iso(e.startedAt), again: e.again });
  const inGrace = e.now - e.startedAt < INBOX_RUN_START_GRACE_MS;
  if (e.live) {
    if (e.live.busy === true) return line("working", { since: iso(e.live.busySince) });
    // Its last turn ended in an error (its note is in the thread): it couldn't answer, with Try again.
    if (e.turnErrorAt != null && !e.turnWaiting) return line("failed", { turn_error: true, since: iso(e.turnErrorAt) });
    return e.turnWaiting && inGrace ? starting() : null;
  }
  if (e.cliAvailable === false) return e.turnWaiting ? line("missing") : null;
  if (inGrace) return starting();
  const hostStopped = e.host === "absent" || host?.state === "stopped" || host?.state === "done";
  // The person's Stop says stopped, even before the agent took its first message (a Rex tab closed by Stop).
  if (!e.seenLive && !hostStopped && e.stoppedByPersonAt === null) return line("failed", { cause: e.rex?.line !== undefined && !e.rex.unavailable && !e.rex.refused ? INBOX_RUN_REX_NOT_CONNECTED : `Started, but not connected to the Inbox. Is Plannotator's ${e.connector ?? "plugin"} on in that folder?` });
  const byPerson = e.stoppedByPersonAt !== null;
  // Not the person's Stop: the host's own words, when it has some.
  return line("stopped", { stopped_by_person: byPerson, since: iso(e.stoppedByPersonAt), ...(!byPerson && e.stoppedNote ? { cause: e.stoppedNote } : {}) });
}
