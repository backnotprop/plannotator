/**
 * Thread steps on the Inbox server (approval "inbox-thread-steps",
 * 2026-11-03): the window's read of a thread's steps, and each list's
 * freshness from its session's presence.
 *
 *   GET /api/inbox/threads/:id/steps → { serverSession, on, steps: InboxStepsWire[] }
 *
 * `on` is the person's switch (config.json `inboxSteps`, off by default).
 * Off: `steps` is empty, whatever the store keeps, so the window shows
 * nothing. The store keeps every list; turning the switch on again shows them
 * as they were.
 *
 * Presence, never the list's age, says how fresh a list is:
 *  - a session whose connection polls (the Claude Code mod, Pi, OpenCode 2)
 *    or that the Inbox wakes itself (Codex, Qwen Code, T3): `working` while a
 *    turn runs, `idle` between turns (a connection that does not say:
 *    `working` while heard within INBOX_STEPS_WORKING_MS, then `idle`);
 *  - `ended` only on evidence (`endedOf`): the session was seen polling in
 *    this run and no longer polls, or the Inbox knows its woken thread is gone;
 *  - any other session (an MCP-only client, OpenCode 1, the mod off, Pi or
 *    OpenCode 2 without the wake, whatever host it names; the rule of
 *    "Replying when the asking session has ended" in inbox-compose.md):
 *    `working` while heard within INBOX_STEPS_WORKING_MS, `idle` up to
 *    INBOX_STEPS_IDLE_MS, then `ended`, since such an agent may come back
 *    at any time and only time says it has not.
 */

import { INBOX_TIDY_OPEN_ITEM_MS, type InboxStepsPresence, type InboxSteps, type InboxStepsWire } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** How long a session that does not say whether a turn runs counts as working after it was last heard. */
export const INBOX_STEPS_WORKING_MS = 10 * 60_000;
/** How long a session with no evidence of an end counts as idle, not ended, after it was last heard: Tidy's idle bar. */
export const INBOX_STEPS_IDLE_MS = INBOX_TIDY_OPEN_ITEM_MS;

/** What the steps read needs from the live sessions (packages/server/inbox-sessions.ts). */
export interface InboxStepsLive {
  /** How the session is connected now (polling, or woken by the Inbox), or null when it is not. */
  deliveryConnectionOf: (session: string) => { busy: boolean | null } | null;
  /** When the session was last heard (a poll or an MCP call), or null. */
  lastHeardOf: (session: string) => number | null;
  /** Evidence that the session ended: seen polling in this run and no longer, or its woken thread known gone. */
  endedOf: (session: string) => boolean;
}

/** A list's presence now. */
export function inboxStepsPresenceOf(record: InboxSteps, live: InboxStepsLive, now: number): InboxStepsPresence {
  const session = record.agent.session ?? "";
  const heard = Math.max(live.lastHeardOf(session) ?? 0, Date.parse(record.updated_at) || 0);
  const connection = live.deliveryConnectionOf(session);
  if (connection) {
    if (connection.busy === true) return "working";
    if (connection.busy === false) return "idle";
    return now - heard <= INBOX_STEPS_WORKING_MS ? "working" : "idle";
  }
  if (live.endedOf(session)) return "ended";
  if (now - heard <= INBOX_STEPS_WORKING_MS) return "working";
  if (now - heard <= INBOX_STEPS_IDLE_MS) return "idle";
  return "ended";
}

/**
 * A list still waits on the person (the row's and the lane card's amber pause, approval
 * "inbox-checklist-spinners-2026-11-07": "only while the thread waits on the person"): a step is `waiting`, the person
 * has not answered in the thread since the list was last written (no message of theirs, no 👍 Looks good), and the
 * session has not ended (an ended session never updates its list, so its "waiting" would stay for good).
 */
export function inboxStepsWaitOnPerson(
  record: InboxSteps,
  live: InboxStepsLive,
  now: number,
  personAnsweredSince: (threadId: string, since: string) => boolean,
): boolean {
  if (!record.steps.some((step) => step.status === "waiting")) return false;
  if (personAnsweredSince(record.thread_id, record.updated_at)) return false;
  return inboxStepsPresenceOf(record, live, now) !== "ended";
}

/**
 * Tidy's rule for steps (approval "inbox-thread-steps", part 5; asked only while the switch is on): a list with a
 * step still `doing` while its session has been idle for INBOX_STEPS_IDLE_MS or more, or has ended. Idle since: the
 * session's last idle transition when its connection says (else when it was last heard), and never before the list's
 * own last write.
 */
export function inboxStepsStale(record: InboxSteps, live: InboxStepsLive & { lastIdleOf: (session: string) => number | null }, now: number): boolean {
  if (!record.steps.some((step) => step.status === "doing")) return false;
  const presence = inboxStepsPresenceOf(record, live, now);
  if (presence === "ended") return true;
  if (presence !== "idle") return false;
  const session = record.agent.session ?? "";
  const quiet = Math.max(Date.parse(record.updated_at) || 0, live.lastIdleOf(session) ?? live.lastHeardOf(session) ?? 0);
  return now - quiet >= INBOX_STEPS_IDLE_MS;
}

export function createInboxStepsRoute(options: {
  store: InboxStore;
  serverSession: string;
  live: InboxStepsLive;
  /** The person's switch, read on every request. */
  stepsOn: () => boolean;
  json: (data: unknown, status?: number) => Response;
  now?: () => number;
}) {
  const { store, json } = options;
  const now = options.now ?? Date.now;

  /** A thread's lists as the window reads them, with each session's presence now. */
  const threadSteps = (threadId: string): InboxStepsWire[] => {
    const t = now();
    return store.threadSteps(threadId).map((record) => ({ ...record, presence: inboxStepsPresenceOf(record, options.live, t) }));
  };

  const route = (req: Request, path: string): Response | null => {
    const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/steps$/.exec(path);
    if (!match) return null;
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    const message = store.message(match[1]!);
    if (!message) return json({ error: `No thread ${match[1]}.`, code: "thread_not_found" }, 404);
    // The switch read once: `on` and `steps` always agree.
    const on = options.stepsOn();
    return json({ serverSession: options.serverSession, on, steps: on ? threadSteps(message.thread_id) : [] });
  };

  return { route, threadSteps };
}
