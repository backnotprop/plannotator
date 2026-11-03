/**
 * Thread steps on the Inbox server (approval "inbox-thread-steps",
 * 2026-11-03): the window's read of a thread's steps, and each list's
 * freshness from its session's presence.
 *
 *   GET /api/inbox/threads/:id/steps → { serverSession, on, steps: InboxStepsWire[] }
 *
 * `on` is the person's switch (Settings → Capabilities, config.json
 * `inboxSteps`, off by default). Off: `steps` is empty, whatever the store
 * keeps, so the window shows nothing. The store keeps every list; turning the
 * switch on again shows them as they were.
 *
 * Presence, never the list's age, says how fresh a list is:
 *  - a session whose connection polls (the Claude Code mod, Pi, OpenCode 2)
 *    or that the Inbox wakes itself (Codex, Qwen Code, T3): `working` while a
 *    turn runs, `idle` between turns, `ended` once it stops polling;
 *  - one whose connection does not say whether a turn runs, and an MCP-only
 *    client: `working` while it was heard within INBOX_STEPS_WORKING_MS,
 *    then `idle`; an MCP-only client reads `ended` once it has not been heard
 *    for INBOX_STEPS_IDLE_MS (it has no connection that could say so).
 */

import type { InboxStepsPresence, InboxSteps, InboxStepsWire } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** How long a session that does not say whether a turn runs counts as working after it was last heard. */
export const INBOX_STEPS_WORKING_MS = 10 * 60_000;
/** How long an MCP-only session counts as idle, not ended, after it was last heard; Tidy's idle bar too. */
export const INBOX_STEPS_IDLE_MS = 2 * 60 * 60_000;

/** What the steps read needs from the live sessions (packages/server/inbox-sessions.ts). */
export interface InboxStepsLive {
  /** How the session is connected now (polling, or woken by the Inbox), or null when it is not. */
  deliveryConnectionOf: (session: string) => { busy: boolean | null } | null;
  /** When the session was last heard (a poll or an MCP call), or null. */
  lastHeardOf: (session: string) => number | null;
  /** When the session last went idle, live or not, or null. */
  lastIdleOf: (session: string) => number | null;
}

/**
 * A list's presence now, and since when it has been so where that is known
 * (`since`: the session's last idle start, or when it was last heard once
 * ended; null otherwise). `bridged`: the session's host has a connection that
 * polls (a session of such a host that does not poll now has ended).
 */
export function inboxStepsPresenceOf(
  record: InboxSteps,
  live: InboxStepsLive,
  bridged: (host: string | null) => boolean,
  now: number,
): { presence: InboxStepsPresence; since: number | null } {
  const session = record.agent.session ?? "";
  const heard = Math.max(live.lastHeardOf(session) ?? 0, Date.parse(record.updated_at) || 0);
  const connection = live.deliveryConnectionOf(session);
  if (connection) {
    if (connection.busy === true) return { presence: "working", since: null };
    if (connection.busy === false) return { presence: "idle", since: live.lastIdleOf(session) ?? heard };
    return now - heard <= INBOX_STEPS_WORKING_MS ? { presence: "working", since: null } : { presence: "idle", since: heard };
  }
  if (bridged(record.agent.host)) return { presence: "ended", since: heard || null };
  if (now - heard <= INBOX_STEPS_WORKING_MS) return { presence: "working", since: null };
  if (now - heard <= INBOX_STEPS_IDLE_MS) return { presence: "idle", since: heard };
  return { presence: "ended", since: heard || null };
}

export function createInboxStepsRoute(options: {
  store: InboxStore;
  serverSession: string;
  live: InboxStepsLive;
  /** The person's switch, read on every request. */
  stepsOn: () => boolean;
  bridged: (host: string | null) => boolean;
  json: (data: unknown, status?: number) => Response;
  now?: () => number;
}) {
  const { store, json } = options;
  const now = options.now ?? Date.now;

  /** A thread's lists as the window reads them, with each session's presence now; empty while the switch is off. */
  const threadSteps = (threadId: string): InboxStepsWire[] => {
    if (!options.stepsOn()) return [];
    const t = now();
    return store.threadSteps(threadId).map((record) => ({ ...record, presence: inboxStepsPresenceOf(record, options.live, options.bridged, t).presence }));
  };

  const route = (req: Request, path: string): Response | null => {
    const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/steps$/.exec(path);
    if (!match) return null;
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    const message = store.message(match[1]!);
    if (!message) return json({ error: `No thread ${match[1]}.`, code: "thread_not_found" }, 404);
    return json({ serverSession: options.serverSession, on: options.stepsOn(), steps: threadSteps(message.thread_id) });
  };

  return { route, threadSteps };
}
