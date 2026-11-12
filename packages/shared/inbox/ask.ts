import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId } from "@plannotator/core/inbox-types";
import { isShapeId, SHAPE_LIMITS } from "@plannotator/core/shape";
import type { InboxShowMeTarget } from "@plannotator/core/inbox-review";
import { INBOX_DRAFT_BODY_MAX } from "./drafts";
import { InboxError } from "./schema";

export const INBOX_ASK_DIR = "ask";
export const INBOX_ASK_TEXT_MAX = INBOX_DRAFT_BODY_MAX;
export const INBOX_ASK_FILE_MAX = 32 * 1024 * 1024;
export const INBOX_ASK_CUT_NOTE = "\n\n… (the rest of the answer was cut)";
const TURN_ID = /^[A-Za-z0-9_-]{8,80}$/;

export interface InboxAskTurn {
  id: string;
  at: string;
  session: string;
  host: string | null;
  question: string;
  passage?: string;
  source?: string;
  answer?: string;
  answered_at?: string;
  stopped?: boolean;
  failure?: "gone" | "taken_over" | "failed";
  kind?: "show_me";
  show_me?: InboxShowMeTarget;
  shape?: string;
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
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

const serialize = (conversation: InboxAskConversation): string => `${JSON.stringify(conversation)}\n`;

export function writeInboxAsk(inboxDirPath: string, conversation: InboxAskConversation): void {
  writeWhole(inboxDirPath, conversation.thread_id, serialize(conversation));
}

function namesIn(inboxDirPath: string): string[] {
  try {
    return readdirSync(dirOf(inboxDirPath));
  } catch {
    return [];
  }
}

const threadOfFile = (name: string): string => name.split(".", 1)[0]!;

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
    }
  }
  return removed;
}

export function removeInboxAsk(inboxDirPath: string, threadId: string): boolean {
  if (!isInboxId("msg", threadId)) return false;
  return removeFiles(inboxDirPath, namesIn(inboxDirPath).filter((name) => threadOfFile(name) === threadId));
}

export function pruneInboxAsks(inboxDirPath: string, threadExists: (threadId: string) => boolean): void {
  removeFiles(
    inboxDirPath,
    namesIn(inboxDirPath).filter((name) => {
      const threadId = threadOfFile(name);
      return isInboxId("msg", threadId) && !threadExists(threadId);
    }),
  );
}

export interface ShowMeBoardVersion {
  n: number;
  at: string;
  through: string | null;
}

export function showMeShapes(turns: readonly InboxAskTurn[], boards: readonly { id: string; versions: readonly ShowMeBoardVersion[] }[], running: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const asked = turns.filter((turn) => turn.kind === "show_me");
  asked.forEach((turn, at) => {
    const from = Date.parse(turn.at);
    const ended = Date.parse(turn.answered_at ?? "");
    const hasEnd = Number.isFinite(ended);
    const cut = turn.stopped === true || turn.failure !== undefined;
    if (!hasEnd && (cut || turn.id !== running)) return;
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
    const review = turn.show_me?.review ?? null;
    const made =
      turn.again_shape !== undefined
        ? firstOf((board) => board === turn.again_shape)
        : review === null
          ?
            (firstOf((_, version) => version.n === 1) ?? (hasEnd && !cut ? firstOf((_, version) => version.through === null) : undefined))
          : (firstOf((_, version) => version.n === 1 && version.through === review) ??
            (hasEnd && !cut ? firstOf((_, version) => version.through === review || (version.n === 1 && version.through === null)) : undefined));
    if (made) out.set(turn.id, made);
  });
  return out;
}

export interface InboxShowMeInput {
  target: InboxShowMeTarget;
  againShape?: string;
}

const SHOW_ME_KEYS = ["review", "file", "lines", "round", "words", "part"];
const SHOW_ME_PICTURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export function checkInboxShowMeInput(input: { kind?: unknown; show_me?: unknown; again_shape?: unknown }): InboxShowMeInput | null {
  if (input.kind === undefined && input.show_me === undefined && input.again_shape === undefined) return null;
  const bad = (message: string, field: string) => new InboxError("validation_error", message, { field });
  if (input.kind !== "show_me") throw bad('kind: "show_me", or none for a plain question.', "kind");
  const raw = input.show_me;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("show_me: { review, file, lines, round, words? }.", "show_me");
  const s = raw as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!SHOW_ME_KEYS.includes(key)) throw bad(`show_me.${key}: not a field (review, file, lines, round, words, part).`, "show_me");
  const fromBoard = s.part !== undefined;
  if (!isInboxId("msg", s.review) && !(fromBoard && (s.review === null || s.review === undefined))) throw bad("show_me.review: the review's message id.", "show_me");
  const file = s.file === null || s.file === undefined ? null : s.file;
  if (file !== null && (typeof file !== "string" || file.trim() === "" || file.length > 1000)) throw bad("show_me.file: a file of the review, or null for the Overview.", "show_me");
  const lines = s.lines === null || s.lines === undefined ? null : s.lines;
  const line = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
  if (lines !== null && (!Array.isArray(lines) || lines.length !== 2 || !line(lines[0]) || !line(lines[1]) || (lines[0] as number) > (lines[1] as number))) {
    throw bad("show_me.lines: [first, last], whole line numbers from 1, first ≤ last.", "show_me");
  }
  if ((file === null) !== (lines === null)) throw bad("show_me.file and show_me.lines go together (both null: the Overview).", "show_me");
  if (s.words !== undefined && (typeof s.words !== "string" || s.words.length > INBOX_ASK_TEXT_MAX)) throw bad(`show_me.words: at most ${INBOX_ASK_TEXT_MAX} characters.`, "show_me");
  const rawPart = s.part as Record<string, unknown> | undefined;
  if (rawPart !== undefined) {
    const text = (value: unknown, max: number) => typeof value === "string" && value.trim() !== "" && Array.from(value).length <= max;
    if (!rawPart || typeof rawPart !== "object" || !isShapeId(rawPart.board) || !text(rawPart.name, 600) || (rawPart.code !== undefined && !text(rawPart.code, 1100)) || file !== null) {
      throw bad("show_me.part: { board, name, code? }, with file and lines null.", "show_me");
    }
    if (rawPart.parts !== undefined && (!Array.isArray(rawPart.parts) || rawPart.parts.length < 2 || rawPart.parts.length > 40 || !rawPart.parts.every((name) => text(name, 600)))) {
      throw bad("show_me.part.parts: the names of the 2 to 40 parts a box covered.", "show_me");
    }
    if (rawPart.picture !== undefined && (typeof rawPart.picture !== "string" || rawPart.picture.length > SHAPE_LIMITS.notePicture || !SHOW_ME_PICTURE_RE.test(rawPart.picture))) {
      throw bad("show_me.part.picture: the box's picture, a PNG data: URL within the limit.", "show_me");
    }
  }
  const again = input.again_shape;
  if (again !== undefined && (typeof again !== "string" || !isShapeId(again))) throw bad("again_shape: the id of the board to bring up to date.", "again_shape");
  const words = typeof s.words === "string" && s.words.trim() ? s.words : undefined;
  return {
    target: {
      review: isInboxId("msg", s.review) ? s.review : null,
      file: file as string | null,
      lines: lines as [number, number] | null,
      round: typeof s.round === "number" ? s.round : 1,
      ...(words ? { words } : {}),
      ...(rawPart
        ? {
            part: {
              board: rawPart.board as string,
              name: rawPart.name as string,
              ...(rawPart.code !== undefined ? { code: rawPart.code as string } : {}),
              ...(rawPart.parts !== undefined ? { parts: rawPart.parts as string[] } : {}),
              ...(rawPart.picture !== undefined ? { picture: rawPart.picture as string } : {}),
            },
          }
        : {}),
    },
    ...(again !== undefined ? { againShape: again as string } : {}),
  };
}

export function checkInboxAskInput(input: { turn_id?: unknown; question?: unknown; passage?: unknown; source?: unknown }): { id: string; question: string; passage?: string; source?: string } {
  const { turn_id: id, question, passage, source } = input;
  if (typeof id !== "string" || !TURN_ID.test(id)) {
    throw new InboxError("validation_error", "turn_id: 8 to 80 letters, digits, dashes or underscores, made by the window.", { field: "turn_id" });
  }
  if (typeof question !== "string" || question.trim() === "" || question.length > INBOX_ASK_TEXT_MAX) {
    throw new InboxError("validation_error", `question: words, at most ${INBOX_ASK_TEXT_MAX} characters.`, { field: "question" });
  }
  if (passage !== undefined && (typeof passage !== "string" || passage.length > INBOX_ASK_TEXT_MAX)) {
    throw new InboxError("validation_error", `passage: at most ${INBOX_ASK_TEXT_MAX} characters.`, { field: "passage" });
  }
  if (source !== undefined && (typeof source !== "string" || source.length > INBOX_ASK_TEXT_MAX)) {
    throw new InboxError("validation_error", `source: at most ${INBOX_ASK_TEXT_MAX} characters.`, { field: "source" });
  }
  return { id, question, ...(passage ? { passage } : {}), ...(source ? { source } : {}) };
}

export function findInboxAskTurn(inboxDirPath: string, threadId: string, turnId: string): { conversation: InboxAskConversation; turn: InboxAskTurn } | null {
  const conversation = readForAsk(inboxDirPath, threadId);
  const turn = conversation?.turns.find((candidate) => candidate.id === turnId);
  return conversation && turn ? { conversation, turn } : null;
}

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

export function updateInboxAskTurn(inboxDirPath: string, threadId: string, turnId: string, patch: Partial<Omit<InboxAskTurn, "id" | "question" | "passage" | "source">>): { conversation: InboxAskConversation; turn: InboxAskTurn } | null {
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
