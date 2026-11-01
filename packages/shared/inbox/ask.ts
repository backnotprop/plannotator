/**
 * Plannotator Inbox: Ask AI's conversations, the questions a person asked
 * about a thread and what the agent that owns the thread answered.
 *
 *   inbox/ask/<thread id>.json   one per thread, 0600 in a 0700 folder, written whole (temp, then rename)
 *
 * Files, not the store's JSONL, as reply drafts are (reply-drafts.ts): a
 * conversation must never enter the event log, which the window's stream,
 * wait_for_reply's cursor, the phone relay and search read. So agents, the
 * MCP, the list and search never see it, and End deletes it for good.
 *
 * A turn's id comes from the window, so a phone retrying a dropped POST finds
 * the turn it already wrote and cannot write a second one. `seen_at` only
 * moves forward: the dot on the round button means an `answered_at` later
 * than it.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId } from "@plannotator/core/inbox-types";
import { INBOX_DRAFT_BODY_MAX } from "./drafts";
import { InboxError } from "./schema";

export const INBOX_ASK_DIR = "ask";
/** The most a question, or the passage it is about, may hold: what a reply draft may. */
export const INBOX_ASK_TEXT_MAX = INBOX_DRAFT_BODY_MAX;
/** A turn id: what a window's id generator makes, and nothing a path could misread. */
const TURN_ID = /^[A-Za-z0-9_-]{8,80}$/;

export interface InboxAskTurn {
  /** Made by the window: the POST's idempotency key. */
  id: string;
  at: string;
  /** The agent session that owned the thread when the person asked. */
  session: string;
  host: string | null;
  question: string;
  /** The text the person selected, when the question is about a passage. */
  passage?: string;
  answer?: string;
  answered_at?: string;
  /** The person stopped the answer. */
  stopped?: boolean;
}

export interface InboxAskConversation {
  v: 1;
  thread_id: string;
  seen_at: string | null;
  turns: InboxAskTurn[];
}

function dirOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_ASK_DIR);
}

function fileOf(inboxDirPath: string, threadId: string): string {
  return join(dirOf(inboxDirPath), `${threadId}.json`);
}

function parse(text: string): InboxAskConversation | null {
  try {
    const value = JSON.parse(text) as InboxAskConversation;
    if (!value || value.v !== 1 || !isInboxId("msg", value.thread_id) || !Array.isArray(value.turns)) return null;
    if (value.seen_at !== null && typeof value.seen_at !== "string") return null;
    const whole = value.turns.every((turn) => typeof turn?.id === "string" && typeof turn.at === "string" && typeof turn.session === "string" && typeof turn.question === "string");
    return whole ? value : null;
  } catch {
    return null;
  }
}

/** One thread's conversation, or null when it has none (a file that does not parse reads as none). */
export function readInboxAsk(inboxDirPath: string, threadId: string): InboxAskConversation | null {
  if (!isInboxId("msg", threadId)) return null;
  try {
    const conversation = parse(readFileSync(fileOf(inboxDirPath, threadId), "utf8"));
    return conversation?.thread_id === threadId ? conversation : null;
  } catch {
    return null;
  }
}

/** Write one conversation whole (owner-only folder and file). */
export function writeInboxAsk(inboxDirPath: string, conversation: InboxAskConversation): void {
  mkdirSync(dirOf(inboxDirPath), { recursive: true, mode: 0o700 });
  const file = fileOf(inboxDirPath, conversation.thread_id);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(conversation)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); // `mode` applies only on create: a left-over temp file keeps its old mode.
  renameSync(temp, file);
}

/** Remove one conversation's file; true when there was one. */
export function removeInboxAsk(inboxDirPath: string, threadId: string): boolean {
  if (!isInboxId("msg", threadId)) return false;
  try {
    unlinkSync(fileOf(inboxDirPath, threadId));
    return true;
  } catch {
    return false;
  }
}

/** Remove every conversation whose thread is gone (after a deletion). */
export function pruneInboxAsks(inboxDirPath: string, threadExists: (threadId: string) => boolean): void {
  let names: string[];
  try {
    names = readdirSync(dirOf(inboxDirPath));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const threadId = name.slice(0, -".json".length);
    if (!threadExists(threadId)) removeInboxAsk(inboxDirPath, threadId);
  }
}

/** The checks on an ask's input, before anything is written. */
export function checkInboxAskInput(input: { turn_id?: unknown; question?: unknown; passage?: unknown }): { id: string; question: string; passage?: string } {
  const { turn_id: id, question, passage } = input;
  if (typeof id !== "string" || !TURN_ID.test(id)) {
    throw new InboxError("validation_error", "turn_id: 8 to 80 letters, digits, dashes or underscores, made by the window.", { field: "turn_id" });
  }
  if (typeof question !== "string" || question.trim() === "" || question.length > INBOX_ASK_TEXT_MAX) {
    throw new InboxError("validation_error", `question: words, at most ${INBOX_ASK_TEXT_MAX} characters.`, { field: "question" });
  }
  if (passage !== undefined && (typeof passage !== "string" || passage.length > INBOX_ASK_TEXT_MAX)) {
    throw new InboxError("validation_error", `passage: at most ${INBOX_ASK_TEXT_MAX} characters.`, { field: "passage" });
  }
  return { id, question, ...(passage ? { passage } : {}) };
}

/** Add a turn; a turn with that id already there is the one answered, and nothing is written. */
export function addInboxAskTurn(inboxDirPath: string, threadId: string, turn: InboxAskTurn): { conversation: InboxAskConversation; turn: InboxAskTurn; added: boolean } {
  const conversation = readInboxAsk(inboxDirPath, threadId) ?? { v: 1 as const, thread_id: threadId, seen_at: null, turns: [] };
  const known = conversation.turns.find((candidate) => candidate.id === turn.id);
  if (known) return { conversation, turn: known, added: false };
  conversation.turns.push(turn);
  writeInboxAsk(inboxDirPath, conversation);
  return { conversation, turn, added: true };
}

/** The person saw the answers up to `seenAt`. An earlier time changes nothing. */
export function markInboxAskSeen(inboxDirPath: string, threadId: string, seenAt: string): { conversation: InboxAskConversation | null; changed: boolean } {
  const conversation = readInboxAsk(inboxDirPath, threadId);
  if (!conversation) return { conversation: null, changed: false };
  if (conversation.seen_at !== null && Date.parse(conversation.seen_at) >= Date.parse(seenAt)) return { conversation, changed: false };
  conversation.seen_at = seenAt;
  writeInboxAsk(inboxDirPath, conversation);
  return { conversation, changed: true };
}
