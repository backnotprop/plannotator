/**
 * Plannotator Inbox: Tidy (owner-approved design, 2026-10-28). One action the
 * person starts from the list header asks every live agent that may owe them
 * something to tidy its own threads, in one turn each: send what it finished
 * but held back, answer what the person wrote, withdraw stale questions, mark
 * finished action items done, move stale Board cards. An agent with nothing
 * to change sends nothing. Never scheduled, never sent in the person's name.
 *
 * The record is the Inbox's own notes (`InboxMessage.tidy`, an Inbox note:
 * the row never moves for it): one per listed thread, the first of a
 * session's carrying its wake. Browser-safe and dependency-free; re-exported
 * by `inbox-types`.
 */

import { INBOX_T3_HOST, isPlainT3ThreadId, isT3ThreadId } from "./inbox-t3";

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
 * The first line of a Tidy note's body, under the wake's `Plannotator Inbox:
 * Tidy (<id>)` line: who asks, and the spirit of it. The body carries it so
 * an older connection, which words the note as a New message, still reads
 * what it is.
 */
export const INBOX_TIDY_INSTRUCTION =
  "The person asked you, from the Plannotator Inbox, to tidy your threads there. Below is what the Inbox can see in each. Do only what still makes sense; where a thread is in order, leave it and send nothing.";

/**
 * The first line of a Tidy the person ran on threads they picked (approval "inbox-multi-select"), in place of
 * INBOX_TIDY_INSTRUCTION: every picked thread the session owns is listed, flagged or not.
 */
export const INBOX_TIDY_PICKED_INSTRUCTION =
  "The person picked these threads of yours in the Plannotator Inbox and asked you to tidy them. Read each one (read_thread with the id given), then do only what still makes sense; where a thread is in order, leave it and send nothing.";

/** The most a Tidy's own instructions may hold: one line, cut to this many characters. */
export const INBOX_TIDY_WORDS_MAX = 500;

/** The person's own instructions for one Tidy, as one line: blank lines and runs of spaces folded, cut to INBOX_TIDY_WORDS_MAX. */
export function inboxTidyWords(value: unknown): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > INBOX_TIDY_WORDS_MAX ? flat.slice(0, INBOX_TIDY_WORDS_MAX).trimEnd() : flat;
}

/**
 * The person's words as they go between the note's own straight quotes: each `"` in them becomes a curly one (“ at the
 * start or after a space or an opening bracket, else ”), so nothing they typed closes the quotation and reads as the
 * note's own text. One character for one: the length and the one-line cap stand.
 */
export function inboxQuotedWords(words: string): string {
  return words.replace(/"/g, (_, at: number) => (at === 0 || /[\s([{]/.test(words[at - 1]!) ? "“" : "”"));
}

/** The paragraph a Tidy's body gains right after its first, only when the person typed instructions. */
export function inboxTidyWordsLine(words: string): string {
  return `The person added, for this Tidy: "${inboxQuotedWords(words)}". Where it differs from the rest of this note, their words win.`;
}

/** A Combine's run id (`cmb_` + ULID): its wake is a Tidy note, so it travels as one, but it is no Tidy run. */
export function isInboxCombineRun(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("cmb_");
}

/** The paragraph under the instruction: what tidying can mean, and how to write back. */
export const INBOX_TIDY_HOW =
  "That can mean sending what you finished but held back, answering what the person wrote, withdrawing a question that no longer applies (its id in `supersedes`, with one line why), marking an action item you saw done (`done`), or moving a Board card whose work moved on. Check your own context too for anything you said you would send. Write in each thread with reply_to set to the id given. If you have a shell, do all of it in one script instead of one call at a time: `plannotator inbox call <action> '<json>'` runs any Inbox action (`card '{\"op\":\"list\"}'`, `send_message`, …) and prints its result as JSON, and `-` in place of the JSON reads it from stdin. Print only what you need back, and give each send_message and card create an idempotency_key, so a rerun cannot post twice. Send no summary.";

/** A session id a command line can carry: what Claude Code, Pi, OpenCode and the shim's `ses_` ids use, and nothing a shell would read. */
const INBOX_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INBOX_SESSION_HOST = /^[a-z][a-z0-9-]{0,31}$/;

export function isInboxSessionId(value: unknown): value is string {
  return typeof value === "string" && INBOX_SESSION_ID.test(value);
}

/**
 * The value `plannotator inbox call --session` takes for a session:
 * `<host>:<session>`, or the session alone when it has no host. Null for a
 * session id no command line should carry (an agent chose it, and the wake
 * text puts it in a command).
 */
export function inboxSessionRef(host: string | null, session: string): string | null {
  if (!isInboxSessionId(session) && !(host === INBOX_T3_HOST && isPlainT3ThreadId(session))) return null;
  return host !== null && INBOX_SESSION_HOST.test(host) ? `${host}:${session}` : session;
}

/** A `--session` value's parts, or null when it is not one. */
export function parseInboxSessionRef(value: string): { host: string | null; session: string } | null {
  const colon = value.indexOf(":");
  const host = colon === -1 ? null : value.slice(0, colon);
  const session = value.slice(colon + 1);
  if (host !== null && !INBOX_SESSION_HOST.test(host)) return null;
  // A T3 thread's own id has `:` in it (inbox-t3.ts): it counts only under its host. Quoted, a script can pass any.
  if (!isInboxSessionId(session) && !(host === INBOX_T3_HOST && isT3ThreadId(session))) return null;
  return { host, session };
}

/**
 * The line under INBOX_TIDY_HOW in one session's Tidy: the exact value that
 * makes its script that session, the one way that works on every host
 * (OpenCode and an MCP-only agent have no session in their shell).
 */
export function inboxTidySessionLine(ref: string): string {
  return `In that script, pass \`--session ${ref}\` to every \`plannotator inbox call\`, so it writes as you.`;
}

/** The line before the Tidy text at the end of an MCP-only agent's next Inbox tool result. */
export function inboxTidyMcpLine(id: string, label = "Tidy"): string {
  return `Plannotator Inbox: ${label} (${id}). Finish what this call was for first.`;
}

/** Whether a message is one of the Inbox's Tidy notes. */
export function isInboxTidyNote(message: { author: { kind: string }; tidy?: unknown }): boolean {
  return message.author.kind === "person" && typeof message.tidy === "object" && message.tidy !== null;
}

/** On a Tidy note (`InboxMessage.tidy`): its run, and whether it carries the session's wake. */
export interface InboxTidyMark {
  /** The run (`tdy_` + ULID): one press of Tidy, across sessions. */
  id: string;
  /** The one note of the session that is delivered to it (the wake); the others only show in their threads. */
  wake: boolean;
}

/** One thread (or a card without one) Tidy would list for a session. */
export interface InboxTidyItem {
  /** The thread, or null for a Board card that links no open thread in scope. */
  thread_id: string | null;
  subject: string;
  project: { id: string; name: string };
  /** Why it is listed ("you wrote last", "2 questions, 6 h", "card idle 2 d"); the window does not show them. */
  reasons: string[];
}

/** How Tidy reaches a session: its connection (or Codex's queue) wakes it, or at its next Inbox tool call (MCP only). */
export type InboxTidyReach = "wakes" | "next_call";

/** One session Tidy can ask. */
export interface InboxTidyAgent {
  session: string;
  host: string | null;
  /** How the person sees it ("Claude Code"). */
  name: string;
  reach: InboxTidyReach;
  items: InboxTidyItem[];
}

/** What GET /api/inbox/tidy answers: who Tidy would ask in the list's (or the Board's) scope, and the last run. */
export interface InboxTidyPlan {
  serverSession: string;
  /** Items across `agents` (threads, and cards without a thread). */
  count: number;
  agents: InboxTidyAgent[];
  /** The last run (within INBOX_TIDY_RUN_SHOWN_MS), or null. */
  run: InboxTidyRun | null;
  /** Projects that are one, each a suggestion the person ticks. Counted in `count`. Absent when there are none. */
  combine?: InboxTidyCombine[];
  /** Repositories are still being read, so `combine` may be short of a pair. Absent once they are read. */
  combine_loading?: true;
  /** The instructions the person gave the last Tidies, newest first, at most three. Absent from an older Inbox. */
  recent?: string[];
  /**
   * A plan for picked threads (`threads=`): the picked threads no agent is asked about, by why. `ended`: no session
   * that can be reached owns it; `asked`: its agent was asked a moment ago (the cool-down). Absent for the whole list.
   */
  unreached?: { ended: number; asked: number };
}

/** One suggested combine: `from` goes into `into`. `why` is a few words ("same repository"). */
export interface InboxTidyCombine {
  into: { id: string; name: string; root: string; display_name?: string };
  from: { id: string; name: string; root: string };
  why: string;
}

/**
 * Where one asked session stands: `waiting` (not delivered yet), `delivered`
 * (no write since, not seen idle after it), `tidied` (it wrote since
 * delivery), `nothing` (it went idle after delivery without writing:
 * "Nothing to change"). An agent whose connection reports no idle (Codex,
 * MCP only) stays `delivered` until it writes.
 */
/** "ended": the session ended before its wake was delivered, or after it without writing or going idle (it never will). */
export type InboxTidyState = "waiting" | "delivered" | "tidied" | "nothing" | "ended";

export interface InboxTidyRunAgent {
  session: string;
  host: string | null;
  name: string;
  reach: InboxTidyReach;
  state: InboxTidyState;
  /** Threads it wrote in since delivery. */
  updated: number;
}

export interface InboxTidyRun {
  id: string;
  at: string;
  agents: InboxTidyRunAgent[];
  /** Agents that finished (tidied or nothing to change). */
  done: number;
  /** Threads written in since delivery, across agents. */
  updated: number;
  /** The person's own instructions for this run, when they gave any. */
  words?: string;
}
