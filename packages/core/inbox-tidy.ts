/** The person wrote last and the session has not written since, for at least this long. */
export const INBOX_TIDY_PERSON_LAST_MS = 10 * 60_000;
/** An open question or action item counts once it is this old. */
export const INBOX_TIDY_OPEN_ITEM_MS = 2 * 60 * 60_000;
/** A Board card in Todo or In progress counts once it has not moved for this long. */
export const INBOX_TIDY_CARD_IDLE_MS = 2 * 24 * 60 * 60_000;
/** A session is not asked again this soon, unless the person wrote to it since. */
export const INBOX_TIDY_COOLDOWN_MS = 30 * 60_000;
/** How long the window shows the last Tidy's progress line (until the person closes it). */
export const INBOX_TIDY_RUN_SHOWN_MS = 24 * 60 * 60_000;

/**
 * The first line of a Tidy note's body, under the wake's `Plannotator Inbox: Tidy (<id>)` line: who
 * asks, and the spirit of it.
 */
export const INBOX_TIDY_INSTRUCTION =
  "The person asked you, from the Plannotator Inbox, to tidy your threads there. Below is what the Inbox can see in each. Do only what still makes sense; where a thread is in order, leave it and send nothing.";

/** The paragraph under the instruction: what tidying can mean, and how to write back. */
export const INBOX_TIDY_HOW =
  "That can mean sending what you finished but held back, answering what the person wrote, withdrawing a question that no longer applies (its id in `supersedes`, with one line why), marking an action item you saw done (`done`), or moving a Board card whose work moved on. Check your own context too for anything you said you would send. Write in each thread with reply_to set to the id given. If you have a shell, do all of it in one script instead of one call at a time: `plannotator inbox call <action> '<json>'` runs any Inbox action (`card '{\"op\":\"list\"}'`, `send_message`, …) and prints its result as JSON, and `-` in place of the JSON reads it from stdin. Print only what you need back, and give each send_message and card create an idempotency_key, so a rerun cannot post twice. Send no summary.";

const INBOX_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INBOX_SESSION_HOST = /^[a-z][a-z0-9-]{0,31}$/;

export function isInboxSessionId(value: unknown): value is string {
  return typeof value === "string" && INBOX_SESSION_ID.test(value);
}

/**
 * The value `plannotator inbox call --session` takes for a session: `<host>:<session>`, or the
 * session alone when it has no host.
 */
export function inboxSessionRef(host: string | null, session: string): string | null {
  if (!isInboxSessionId(session)) return null;
  return host !== null && INBOX_SESSION_HOST.test(host) ? `${host}:${session}` : session;
}

/** A `--session` value's parts, or null when it is not one. */
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

/** The line before the Tidy text at the end of an MCP-only agent's next Inbox tool result. */
export function inboxTidyMcpLine(id: string): string {
  return `Plannotator Inbox: Tidy (${id}). Finish what this call was for first.`;
}

/** Whether a message is one of the Inbox's Tidy notes. */
export function isInboxTidyNote(message: { author: { kind: string }; tidy?: unknown }): boolean {
  return message.author.kind === "person" && typeof message.tidy === "object" && message.tidy !== null;
}

/** On a Tidy note (`InboxMessage.tidy`): its run, and whether it carries the session's wake. */
export interface InboxTidyMark {
  id: string;
  wake: boolean;
}

/** One thread (or a card without one) Tidy would list for a session. */
export interface InboxTidyItem {
  thread_id: string | null;
  subject: string;
  project: { id: string; name: string };
  reasons: string[];
}

/** How Tidy reaches a session: its connection (or Codex's queue) wakes it, or at its next Inbox tool call (MCP only). */
export type InboxTidyReach = "wakes" | "next_call";

/** One session Tidy can ask. */
export interface InboxTidyAgent {
  session: string;
  host: string | null;
  name: string;
  reach: InboxTidyReach;
  items: InboxTidyItem[];
}

/** What GET /api/inbox/tidy answers: who Tidy would ask in the list's (or the Board's) scope, and the last run. */
export interface InboxTidyPlan {
  serverSession: string;
  count: number;
  agents: InboxTidyAgent[];
  run: InboxTidyRun | null;
  combine?: InboxTidyCombine[];
  combine_loading?: true;
}

/** One suggested combine: `from` goes into `into`. `why` is a few words ("same repository"). */
export interface InboxTidyCombine {
  into: { id: string; name: string; root: string; display_name?: string };
  from: { id: string; name: string; root: string };
  why: string;
}

/** "ended": the session ended before its wake was delivered, or after it without writing or going idle (it never will). */
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
