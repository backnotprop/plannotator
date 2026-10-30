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

/** The person wrote last and the session has not written since, for at least this long. */
export const INBOX_TIDY_PERSON_LAST_MS = 10 * 60_000;
/** An open question or action item counts once it is this old. */
export const INBOX_TIDY_OPEN_ITEM_MS = 2 * 60 * 60_000;
/** A Board card in Backlog, Designing or Building counts once it has not moved for this long. */
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

/** The paragraph under the instruction: what tidying can mean, and how to write back. */
export const INBOX_TIDY_HOW =
  "That can mean sending what you finished but held back, answering what the person wrote, withdrawing a question that no longer applies (its id in `supersedes`, with one line why), marking an action item you saw done (`done`), or moving a Board card whose work moved on. Check your own context too for anything you said you would send. Write in each thread with reply_to set to the id given. Send no summary.";

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
}
