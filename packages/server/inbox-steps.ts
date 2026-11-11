import { INBOX_TIDY_OPEN_ITEM_MS, type InboxStepsPresence, type InboxSteps, type InboxStepsWire } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_STEPS_WORKING_MS = 10 * 60_000;
export const INBOX_STEPS_IDLE_MS = INBOX_TIDY_OPEN_ITEM_MS;

export interface InboxStepsLive {
  deliveryConnectionOf: (session: string) => { busy: boolean | null } | null;
  lastHeardOf: (session: string) => number | null;
  endedOf: (session: string) => boolean;
}

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

/** A step is `waiting`, the person has not answered since the list was last written, and the session has not ended (an ended session never updates its list). */
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
  stepsOn: () => boolean;
  json: (data: unknown, status?: number) => Response;
  now?: () => number;
}) {
  const { store, json } = options;
  const now = options.now ?? Date.now;

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
