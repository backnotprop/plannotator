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
 * - Live and busy → working; live and idle → no line, except while the turn
 *   the start was for has not visibly begun (not taken yet, or taken but not
 *   polled busy nor answered): still starting, so the line does not blink out.
 * - Not live: the CLI gone → missing while a message waits for it (else no
 *   line: nothing waits on it); under a minute since the (re)start →
 *   starting; the host lists it stopped, done or not at all → stopped; never
 *   seen live a minute after start → failed ("not connected"); else stopped.
 */

import type { InboxLaunchRecord, InboxRun } from "./inbox-types";

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
  /** That start was a reply's respawn or Try again. */
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
  /** When the person pressed Stop, while it still holds. */
  stoppedByPersonAt: number | null;
  /** `cd <folder> && claude attach <ref>`; null before the session exists. */
  attachCommand: string | null;
  /** When the oldest permission question of ours still open was asked (its hook holds it), or null. */
  permissionSince?: number | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function inboxRunOf(e: InboxRunEvidence): InboxRun | null {
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
    ...extra,
  });
  const error = e.launch.error;
  if (error) {
    if (error.code === "missing") return line("missing");
    return line("failed", { cause: error.text, untrusted: error.code === "untrusted", since: error.at });
  }
  if (e.permissionSince != null) return line("waiting_answer", { since: iso(e.permissionSince) });
  const host = e.host === "absent" ? null : e.host;
  const idle = e.live !== null && e.live.busy !== true;
  if (host?.status === "waiting" && host.waitingFor && !idle) return line("waiting_terminal", { since: iso(e.waitingSince) });
  // Only while the reply waits for it: re-addressed to another session, nothing here waits any more.
  if (!e.live && e.respawnFailed && e.turnWaiting) return e.cliAvailable === false ? line("missing") : line("failed", { cause: e.respawnFailed, again: true, untrusted: e.respawnUntrusted === true });
  const starting = () => line("starting", { since: iso(e.startedAt), again: e.again });
  const inGrace = e.now - e.startedAt < INBOX_RUN_START_GRACE_MS;
  if (e.live) return e.live.busy === true ? line("working", { since: iso(e.live.busySince) }) : e.turnWaiting && inGrace ? starting() : null;
  if (e.cliAvailable === false) return e.turnWaiting ? line("missing") : null;
  if (inGrace) return starting();
  const hostStopped = e.host === "absent" || host?.state === "stopped" || host?.state === "done";
  if (!e.seenLive && !hostStopped) return line("failed", { cause: "Started, but not connected to the Inbox. Is Plannotator's plugin on in that folder?" });
  return line("stopped", { stopped_by_person: e.stoppedByPersonAt !== null, since: iso(e.stoppedByPersonAt) });
}
