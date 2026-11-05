/**
 * Plannotator Inbox: Ask AI's conversations, the questions a person asked
 * about a thread and what the agent that owns the thread answered.
 *
 *   inbox/ask/<thread id>.json   one per thread, 0600 in a 0700 folder, written whole (temp, then rename)
 *
 * Files, not the store's JSONL, as reply drafts are (reply-drafts.ts): a
 * conversation must never enter the event log, which the window's stream,
 * read_thread's cursor, the phone relay and search read. So agents, the
 * MCP, the list and search never see it, and End deletes it for good.
 *
 * This file is the only copy of the person's words, so only "no such file"
 * means "no conversation". A file that cannot be read now is left as it is and
 * refused. One that does not parse is set aside whole
 * (`<id>.json.<time>.bad`) by the next question, which is refused so the person
 * hears of it, and the question after that starts a new conversation. End and
 * thread delete remove everything of a conversation: the file, a file set
 * aside, and a temp file a crash left.
 *
 * A turn's id comes from the window, so a phone retrying a dropped POST finds
 * the turn it already wrote and cannot write a second one. `seen_at` only
 * moves forward and never past the newest answer: the dot on the round button
 * means an `answered_at` later than it.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId } from "@plannotator/core/inbox-types";
import { isShapeId } from "@plannotator/core/shape";
import type { InboxShowMeTarget } from "@plannotator/core/inbox-review";
import { INBOX_DRAFT_BODY_MAX } from "./drafts";
import { InboxError } from "./schema";

export const INBOX_ASK_DIR = "ask";
/** The most a question, or the passage it is about, may hold: what a reply draft may. */
export const INBOX_ASK_TEXT_MAX = INBOX_DRAFT_BODY_MAX;
/**
 * The most bytes a file may reach by adding a question: every write rewrites it
 * whole on the server's one thread. It has room for many of the largest turns.
 */
export const INBOX_ASK_FILE_MAX = 32 * 1024 * 1024;
/** Ends an answer cut to fit, in a turn or in the file. */
export const INBOX_ASK_CUT_NOTE = "\n\n… (the rest of the answer was cut)";
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
  /** Why `answer` is only part of one: the session went away, another message took the turn, or it failed. */
  failure?: "gone" | "taken_over" | "failed";
  /**
   * Show me (code review in the Inbox, while Code review is on): the question
   * asks the agent for a Shape (`question` is `inboxShowMeRequest`'s words), about
   * `show_me`'s review, file and lines. Absent: a plain Ask, words only.
   */
  kind?: "show_me";
  show_me?: InboxShowMeTarget;
  /** The board this Show me made. Never stored: the Inbox reads it from the boards when the window reads the conversation (`showMeShapes`). */
  shape?: string;
  /** Show me again: the board it asks to bring up to date (its request says so). A retry sends it again. */
  again_shape?: string;
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

/**
 * One thread's conversation, or null only when it has no file. A file that
 * cannot be read, or does not parse, throws: taking it for "none" would let the
 * next write replace it.
 */
export function readInboxAsk(inboxDirPath: string, threadId: string): InboxAskConversation | null {
  if (!isInboxId("msg", threadId)) return null;
  let text: string;
  try {
    text = readFileSync(fileOf(inboxDirPath, threadId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new InboxError("ask_unreadable", "This thread's conversation can't be read right now. Nothing was changed.");
  }
  const conversation = parse(text);
  if (conversation?.thread_id !== threadId) throw new InboxError("ask_damaged", "This thread's conversation is damaged and can't be shown. Nothing was changed.");
  return conversation;
}

/** The read before a question is added: a damaged file is set aside whole, and the person is told. */
function readForAsk(inboxDirPath: string, threadId: string): InboxAskConversation | null {
  try {
    return readInboxAsk(inboxDirPath, threadId);
  } catch (error) {
    if (!(error instanceof InboxError) || error.code !== "ask_damaged") throw error;
    const file = fileOf(inboxDirPath, threadId);
    const aside = `${file}.${Date.now()}.bad`;
    renameSync(file, aside);
    throw new InboxError("ask_damaged", `This thread's conversation was damaged, so it was set aside at ${aside}. Your question was not saved. Ask again to start a new conversation.`);
  }
}

function writeWhole(inboxDirPath: string, threadId: string, text: string): void {
  mkdirSync(dirOf(inboxDirPath), { recursive: true, mode: 0o700 });
  const file = fileOf(inboxDirPath, threadId);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600); // `mode` applies only on create: a left-over temp file keeps its old mode.
  renameSync(temp, file);
}

const serialize = (conversation: InboxAskConversation): string => `${JSON.stringify(conversation)}\n`;

/** Write one conversation whole (owner-only folder and file). */
export function writeInboxAsk(inboxDirPath: string, conversation: InboxAskConversation): void {
  writeWhole(inboxDirPath, conversation.thread_id, serialize(conversation));
}

/** The folder's file names, none when there is no folder. */
function namesIn(inboxDirPath: string): string[] {
  try {
    return readdirSync(dirOf(inboxDirPath));
  } catch {
    return [];
  }
}

/** The thread a file belongs to: `<id>.json`, a crash's `<id>.json.<pid>.tmp`, a set-aside `<id>.json.<time>.bad`. */
const threadOfFile = (name: string): string => name.split(".", 1)[0]!;

/** What the chat list needs of a conversation: the agent of its last turn, when anything last happened, a new answer. */
export interface InboxAskSummary {
  host: string | null;
  at: string;
  unread: boolean;
}

export function inboxAskSummary(conversation: InboxAskConversation | null): InboxAskSummary | null {
  const last = conversation?.turns.at(-1);
  if (!conversation || !last) return null;
  const times = (turn: InboxAskTurn): number[] => [Date.parse(turn.at), Date.parse(turn.answered_at ?? "")].filter(Number.isFinite);
  const newest = (values: number[]): number => values.reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
  const answered = newest(conversation.turns.map((turn) => Date.parse(turn.answered_at ?? "")).filter(Number.isFinite));
  const seen = Date.parse(conversation.seen_at ?? "");
  return {
    host: last.host,
    at: new Date(newest(conversation.turns.flatMap(times))).toISOString(),
    unread: Number.isFinite(answered) && (!Number.isFinite(seen) || answered > seen),
  };
}

/** Each thread's conversation file with what says it changed, without reading it. */
export function inboxAskFiles(inboxDirPath: string): { threadId: string; mtimeMs: number; size: number }[] {
  return namesIn(inboxDirPath).flatMap((name) => {
    const threadId = threadOfFile(name);
    if (name !== `${threadId}.json` || !isInboxId("msg", threadId)) return [];
    try {
      const { mtimeMs, size } = statSync(join(dirOf(inboxDirPath), name));
      return [{ threadId, mtimeMs, size }];
    } catch {
      return [];
    }
  });
}

function removeFiles(inboxDirPath: string, names: string[]): boolean {
  let removed = false;
  for (const name of names) {
    try {
      unlinkSync(join(dirOf(inboxDirPath), name));
      removed = true;
    } catch {
      // Already gone.
    }
  }
  return removed;
}

/** Remove everything of one conversation; true when there was anything. */
export function removeInboxAsk(inboxDirPath: string, threadId: string): boolean {
  if (!isInboxId("msg", threadId)) return false;
  return removeFiles(inboxDirPath, namesIn(inboxDirPath).filter((name) => threadOfFile(name) === threadId));
}

/** Remove everything of each conversation whose thread is gone (after a deletion). */
export function pruneInboxAsks(inboxDirPath: string, threadExists: (threadId: string) => boolean): void {
  removeFiles(
    inboxDirPath,
    namesIn(inboxDirPath).filter((name) => {
      const threadId = threadOfFile(name);
      return isInboxId("msg", threadId) && !threadExists(threadId);
    }),
  );
}

/** One stored version of a board, as `showMeShapes` reads it. */
export interface ShowMeBoardVersion {
  n: number;
  at: string;
  through: string | null;
}

/**
 * The board each Show me made, read from the boards themselves, so an agent
 * stores a board the one way it always does and nothing here can disagree with
 * the store. A turn looks at versions written between its asking and its end
 * (its answer, or the next Show me), so other work on the thread's boards is
 * never taken for it:
 *  - Show me again: only the board it asked to bring up to date.
 *  - A Show me: a new board through its review. Only when the turn has ended
 *    with none does it take another board moved through that review (the agent
 *    chose to update one), or a new one stored with no `--through`.
 *  - Stopped or failed with no end kept: nothing.
 * By turn id; a Show me with no board yet is absent.
 */
export function showMeShapes(turns: readonly InboxAskTurn[], boards: readonly { id: string; versions: readonly ShowMeBoardVersion[] }[]): Map<string, string> {
  const out = new Map<string, string>();
  const asked = turns.filter((turn) => turn.kind === "show_me");
  asked.forEach((turn, at) => {
    const from = Date.parse(turn.at);
    const ended = Date.parse(turn.answered_at ?? "");
    const hasEnd = Number.isFinite(ended);
    const cut = turn.stopped === true || turn.failure !== undefined;
    if (cut && !hasEnd) return;
    const next = asked[at + 1];
    const until = Math.min(hasEnd ? ended : Infinity, next ? Date.parse(next.at) : Infinity);
    const firstOf = (fits: (board: string, version: ShowMeBoardVersion) => boolean): string | undefined => {
      let first: { id: string; when: number } | null = null;
      for (const board of boards) {
        for (const version of board.versions) {
          const when = Date.parse(version.at);
          if (when >= from && when <= until && fits(board.id, version) && (!first || when < first.when)) first = { id: board.id, when };
        }
      }
      return first?.id;
    };
    const review = turn.show_me?.review;
    const made =
      turn.again_shape !== undefined
        ? firstOf((board) => board === turn.again_shape)
        : (firstOf((_, version) => version.n === 1 && version.through === review) ??
          (hasEnd && !cut ? firstOf((_, version) => version.through === review || (version.n === 1 && version.through === null)) : undefined));
    if (made) out.set(turn.id, made);
  });
  return out;
}

/** A Show me's input, as the window sends it: `{ kind: "show_me", show_me, again_shape? }`. */
export interface InboxShowMeInput {
  target: InboxShowMeTarget;
  againShape?: string;
}

const SHOW_ME_KEYS = ["review", "file", "lines", "round", "words"];

/**
 * The shape of a Show me's input (`kind`, `show_me`, `again_shape`); null
 * for a plain Ask. What it points at is checked by the route, which knows the
 * thread: here only that each field is the right kind of value.
 */
export function checkInboxShowMeInput(input: { kind?: unknown; show_me?: unknown; again_shape?: unknown }): InboxShowMeInput | null {
  if (input.kind === undefined && input.show_me === undefined && input.again_shape === undefined) return null;
  const bad = (message: string, field: string) => new InboxError("validation_error", message, { field });
  if (input.kind !== "show_me") throw bad('kind: "show_me", or none for a plain question.', "kind");
  const raw = input.show_me;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("show_me: { review, file, lines, round, words? }.", "show_me");
  const s = raw as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!SHOW_ME_KEYS.includes(key)) throw bad(`show_me.${key}: not a field (review, file, lines, round, words).`, "show_me");
  if (!isInboxId("msg", s.review)) throw bad("show_me.review: the review's message id.", "show_me");
  const file = s.file === null || s.file === undefined ? null : s.file;
  if (file !== null && (typeof file !== "string" || file.trim() === "" || file.length > 1000)) throw bad("show_me.file: a file of the review, or null for the Overview.", "show_me");
  const lines = s.lines === null || s.lines === undefined ? null : s.lines;
  const line = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
  if (lines !== null && (!Array.isArray(lines) || lines.length !== 2 || !line(lines[0]) || !line(lines[1]) || (lines[0] as number) > (lines[1] as number))) {
    throw bad("show_me.lines: [first, last], whole line numbers from 1, first ≤ last.", "show_me");
  }
  if ((file === null) !== (lines === null)) throw bad("show_me.file and show_me.lines go together (both null: the Overview).", "show_me");
  if (s.words !== undefined && (typeof s.words !== "string" || s.words.length > INBOX_ASK_TEXT_MAX)) throw bad(`show_me.words: at most ${INBOX_ASK_TEXT_MAX} characters.`, "show_me");
  const again = input.again_shape;
  if (again !== undefined && (typeof again !== "string" || !isShapeId(again))) throw bad("again_shape: the id of the board to bring up to date.", "again_shape");
  const words = typeof s.words === "string" && s.words.trim() ? s.words : undefined;
  return {
    target: { review: s.review as string, file: file as string | null, lines: lines as [number, number] | null, round: typeof s.round === "number" ? s.round : 1, ...(words ? { words } : {}) },
    ...(again !== undefined ? { againShape: again as string } : {}),
  };
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

/** The saved turn with this id, when there is one: what a retried POST answers. */
export function findInboxAskTurn(inboxDirPath: string, threadId: string, turnId: string): { conversation: InboxAskConversation; turn: InboxAskTurn } | null {
  const conversation = readForAsk(inboxDirPath, threadId);
  const turn = conversation?.turns.find((candidate) => candidate.id === turnId);
  return conversation && turn ? { conversation, turn } : null;
}

/** Add a turn; a turn with that id already there is the one answered, and nothing is written. */
export function addInboxAskTurn(inboxDirPath: string, threadId: string, turn: InboxAskTurn): { conversation: InboxAskConversation; turn: InboxAskTurn; added: boolean } {
  const conversation = readForAsk(inboxDirPath, threadId) ?? { v: 1 as const, thread_id: threadId, seen_at: null, turns: [] };
  const known = conversation.turns.find((candidate) => candidate.id === turn.id);
  if (known) return { conversation, turn: known, added: false };
  conversation.turns.push(turn);
  const text = serialize(conversation);
  if (Buffer.byteLength(text) > INBOX_ASK_FILE_MAX) throw new InboxError("ask_full", "This conversation is full. End it to ask again. Your question was not saved.");
  writeWhole(inboxDirPath, threadId, text);
  return { conversation, turn, added: true };
}

const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text));

/** The start of `answer` whose JSON is at most `room` bytes, and the note. */
function cutToFit(answer: string, room: number): string {
  let fits = 0;
  let over = answer.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (jsonBytes(answer.slice(0, middle)) <= room) fits = middle;
    else over = middle;
  }
  return `${answer.slice(0, fits)}${INBOX_ASK_CUT_NOTE}`;
}

/**
 * Change a saved turn, only if it is still there: an answer that ends after
 * End or a thread delete writes nothing, so the file cannot come back. An
 * answer takes only the room the file has left, and says so when that cuts it.
 * A file that cannot be read throws, as every read here does.
 */
export function updateInboxAskTurn(inboxDirPath: string, threadId: string, turnId: string, patch: Partial<Omit<InboxAskTurn, "id" | "question" | "passage">>): { conversation: InboxAskConversation; turn: InboxAskTurn } | null {
  const conversation = readInboxAsk(inboxDirPath, threadId);
  const turn = conversation?.turns.find((candidate) => candidate.id === turnId);
  if (!conversation || !turn) return null;
  Object.assign(turn, patch);
  let text = serialize(conversation);
  const over = Buffer.byteLength(text) - INBOX_ASK_FILE_MAX;
  if (over > 0 && patch.answer) {
    turn.answer = cutToFit(patch.answer, jsonBytes(patch.answer) - over - jsonBytes(INBOX_ASK_CUT_NOTE));
    text = serialize(conversation);
  }
  writeWhole(inboxDirPath, threadId, text);
  return { conversation, turn };
}

/**
 * The person saw the answers up to `seenAt`. The mark only moves forward and
 * stops at the newest answer, so a wrong time cannot hide a later answer's dot.
 * With no answer there is nothing to see, and nothing changes.
 */
export function markInboxAskSeen(inboxDirPath: string, threadId: string, seenAt: string): { conversation: InboxAskConversation | null; changed: boolean } {
  const conversation = readInboxAsk(inboxDirPath, threadId);
  if (!conversation) return { conversation: null, changed: false };
  const newest = conversation.turns.reduce((latest, turn) => {
    const answeredAt = Date.parse(turn.answered_at ?? "");
    return Number.isFinite(answeredAt) && answeredAt > latest ? answeredAt : latest;
  }, Number.NEGATIVE_INFINITY);
  const mark = Math.min(Date.parse(seenAt), newest);
  if (!Number.isFinite(mark)) return { conversation, changed: false };
  if (conversation.seen_at !== null && Date.parse(conversation.seen_at) >= mark) return { conversation, changed: false };
  conversation.seen_at = new Date(mark).toISOString();
  writeInboxAsk(inboxDirPath, conversation);
  return { conversation, changed: true };
}
