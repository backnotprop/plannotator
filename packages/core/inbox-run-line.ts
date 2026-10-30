/**
 * The run line of a launched thread (PLAN "Run line state"): one quiet line
 * under the latest message saying what the agent is doing. Pure: the server
 * gathers the evidence (the launch record, the mod's live poll, the host's
 * `agents --json`, what it remembers in memory) and this decides the state.
 *
 * - `launch.error` → failed (or missing, when the CLI was gone).
 * - The host says it waits on a prompt (`status: waiting` + `waitingFor`) →
 *   waiting_terminal, live or not: a session blocked on a dialog may still
 *   poll. (PR 2 adds `waiting_answer` from our own open question first.)
 * - Live and busy → working; live and idle → no line, except while the turn
 *   the start was for has not been taken yet (the session connected and is
 *   about to take it): still starting, so the line does not blink out.
 * - Not live: the CLI gone → missing; under a minute since the (re)start →
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
  /** A message to the agent waits to be taken as a turn: the first one, or the reply that respawned it. */
  turnWaiting: boolean;
  /** The session took a message at least once (it connected). */
  seenLive: boolean;
  /** The host's last word on it; null when not read. */
  host: InboxRunHostState | null;
  /** When the host was first seen waiting on a prompt. */
  waitingSince: number | null;
  /** When the person pressed Stop, while it still holds. */
  stoppedByPersonAt: number | null;
  /** `cd <folder> && claude attach <ref>`; null before the session exists. */
  attachCommand: string | null;
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
  const host = e.host === "absent" ? null : e.host;
  if (host?.status === "waiting" && host.waitingFor) return line("waiting_terminal", { since: iso(e.waitingSince) });
  const starting = () => line("starting", { since: iso(e.startedAt), again: e.again });
  const inGrace = e.now - e.startedAt < INBOX_RUN_START_GRACE_MS;
  if (e.live) return e.live.busy === true ? line("working", { since: iso(e.live.busySince) }) : e.turnWaiting && inGrace ? starting() : null;
  if (e.cliAvailable === false) return line("missing");
  if (inGrace) return starting();
  const hostStopped = e.host === "absent" || host?.state === "stopped" || host?.state === "done";
  if (!e.seenLive && !hostStopped) return line("failed", { cause: "Started, but not connected to the Inbox. Is Plannotator's plugin on in that folder?" });
  return line("stopped", { stopped_by_person: e.stoppedByPersonAt !== null, since: iso(e.stoppedByPersonAt) });
}
