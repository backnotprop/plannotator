export const INBOX_TIDY_PERSON_LAST_MS = 10 * 60_000;
export const INBOX_TIDY_OPEN_ITEM_MS = 2 * 60 * 60_000;
export const INBOX_TIDY_CARD_IDLE_MS = 2 * 24 * 60 * 60_000;
export const INBOX_TIDY_COOLDOWN_MS = 30 * 60_000;
export const INBOX_TIDY_RUN_SHOWN_MS = 24 * 60 * 60_000;

export const INBOX_TIDY_INSTRUCTION =
  "The person asked you, from the Plannotator Inbox, to tidy your threads there. Below is what the Inbox can see in each. Do only what still makes sense; where a thread is in order, leave it and send nothing.";

export const INBOX_TIDY_HOW =
  "That can mean sending what you finished but held back, answering what the person wrote, withdrawing a question that no longer applies (its id in `supersedes`, with one line why), marking an action item you saw done (`done`), or moving a Board card whose work moved on. Check your own context too for anything you said you would send. Write in each thread with reply_to set to the id given. If you have a shell, do all of it in one script instead of one call at a time: `plannotator inbox call <action> '<json>'` runs any Inbox action (`card '{\"op\":\"list\"}'`, `send_message`, …) and prints its result as JSON, and `-` in place of the JSON reads it from stdin. Print only what you need back, and give each send_message and card create an idempotency_key, so a rerun cannot post twice. Send no summary.";

const INBOX_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INBOX_SESSION_HOST = /^[a-z][a-z0-9-]{0,31}$/;

export function isInboxSessionId(value: unknown): value is string {
  return typeof value === "string" && INBOX_SESSION_ID.test(value);
}

export function inboxSessionRef(host: string | null, session: string): string | null {
  if (!isInboxSessionId(session)) return null;
  return host !== null && INBOX_SESSION_HOST.test(host) ? `${host}:${session}` : session;
}

export function parseInboxSessionRef(value: string): { host: string | null; session: string } | null {
  const colon = value.indexOf(":");
  const host = colon === -1 ? null : value.slice(0, colon);
  const session = value.slice(colon + 1);
  if (!isInboxSessionId(session) || (host !== null && !INBOX_SESSION_HOST.test(host))) return null;
  return { host, session };
}

export function inboxTidySessionLine(ref: string): string {
  return `In that script, pass \`--session ${ref}\` to every \`plannotator inbox call\`, so it writes as you.`;
}

export function inboxTidyMcpLine(id: string): string {
  return `Plannotator Inbox: Tidy (${id}). Finish what this call was for first.`;
}

export function isInboxTidyNote(message: { author: { kind: string }; tidy?: unknown }): boolean {
  return message.author.kind === "person" && typeof message.tidy === "object" && message.tidy !== null;
}

export interface InboxTidyMark {
  id: string;
  wake: boolean;
}

export interface InboxTidyItem {
  thread_id: string | null;
  subject: string;
  project: { id: string; name: string };
  reasons: string[];
}

export type InboxTidyReach = "wakes" | "next_call";

export interface InboxTidyAgent {
  session: string;
  host: string | null;
  name: string;
  reach: InboxTidyReach;
  items: InboxTidyItem[];
}

export interface InboxTidyPlan {
  serverSession: string;
  count: number;
  agents: InboxTidyAgent[];
  run: InboxTidyRun | null;
  combine?: InboxTidyCombine[];
  combine_loading?: true;
}

export interface InboxTidyCombine {
  into: { id: string; name: string; root: string; display_name?: string };
  from: { id: string; name: string; root: string };
  why: string;
}

export type InboxTidyState = "waiting" | "delivered" | "tidied" | "nothing" | "ended";

export interface InboxTidyRunAgent {
  session: string;
  host: string | null;
  name: string;
  reach: InboxTidyReach;
  state: InboxTidyState;
  updated: number;
}

export interface InboxTidyRun {
  id: string;
  at: string;
  agents: InboxTidyRunAgent[];
  done: number;
  updated: number;
}
