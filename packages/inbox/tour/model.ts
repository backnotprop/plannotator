/**
 * The Inbox's onboarding tour (approval "inbox-onboarding-tour", v2 "show the
 * good parts"): a replay of real threads from building Plannotator with its
 * own Inbox. Pure: the fixture's shape, the tour's state machine, the coach
 * card each state shows, and the rows, messages and files the window's own
 * components draw. Nothing here touches the person's store: picks, comments,
 * drawings, Sends and the new thread live only in this state.
 *
 * Steps (tour v2 brief §3, with the owner's crawl-walk-run of 2026-10-25):
 * 1 open the question, 2 a plain question first (pick, Send; the answer
 * arrives with pictures), 3 pick a picture, 4 comment on words, 5 comment on
 * a line of EVALUATION.md, 6 Send (a replay), 7 the replay arrives with
 * screenshots in the text, circle one, then Artifacts, 8 comment on the film
 * at a moment and Send, 9 start a thread yourself with New message, then the
 * "Also in your Inbox" card, 10 the person's own Inbox (real).
 *
 * Every step can be fast-forwarded to its end state (`tourForward`), and a
 * click the tour cannot use is answered (Tour.tsx's nudges), never ignored.
 */
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type {
  InboxAnnotationRecord,
  InboxAttachmentState,
  InboxInlineImage,
  InboxListRow,
  InboxListSection,
  InboxMessageWire,
  InboxQuestion,
  InboxSectionId,
} from '@plannotator/core/inbox-types';
import { INBOX_SECTIONS, readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import { derivePersonThreadSubject, suggestPersonThreadName } from '@plannotator/core/inbox-questions';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { tourAssetLoaded, tourAssetUrl } from './assets';

export const TOUR_STEPS = 10;

/**
 * Step 10's prompt to copy (v1 step 6, "Get your first question"): one real
 * question about the work at hand, with pictures when the choice is visual.
 */
export const TOUR_FIRST_QUESTION_PROMPT =
  'Send me one real question in my Plannotator Inbox about what we’re working on now. If the choice is visual, show the options as pictures: screenshots you already have, or a small HTML mock you attach. Then end your turn, and act on my answer when it comes back.';
export const TOUR_THREAD = 'tour-vscode';
/** Thread B: the launch film, from the same real work. */
export const TOUR_FILM_THREAD = 'tour-film';
/** Thread C: the one the person starts in step 9. */
export const TOUR_NEW_THREAD = 'tour-new';
export const TOUR_PROJECT_ID = 'tour-project';
/** The one live session the tour's compose offers (step 9). */
export const TOUR_SESSION = 'tour-session';

// ─────────────────────────── The fixture ───────────────────────────

/** A comment box's suggestion: the developer's real comment, condensed. */
export interface TourSuggestion {
  phrase?: string;
  comment: string;
  /** A film: the moment, in seconds. */
  at?: number;
  /** A hint only (the person draws): `circle`. */
  markup?: string;
}

export interface TourFileRef {
  name: string;
  /** An attachment kind (`html`, `markdown`, `image`, `video`; read with readInboxAttachmentKind). */
  kind: string;
  size: number;
  /** The tour asset the file is. */
  asset: string;
  media_type?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  /** A film's still. */
  poster?: string;
  /** A line under the tile ("12 seconds of the 50-second cut"). */
  note?: string;
  suggest?: TourSuggestion;
}

export interface TourInlineImageRef {
  /** The src as the body writes it: a tour asset. */
  ref: string;
  name: string;
  size: number;
  media_type?: string;
  width?: number;
  height?: number;
  suggest?: TourSuggestion;
}

export interface TourFixtureMessage {
  id: string;
  who: 'developer' | 'agent';
  /** The real time, `HH:MM` on the 24-hour clock, in the developer's day. */
  time: string;
  body?: string;
  /** The message carries the question the tour turns on (the picture choices). */
  asks?: boolean;
  /** The message carries the plain question the tour starts with (step 2, crawl). */
  warmup?: boolean;
  /** Shown once the warm-up's answer was sent and its replay arrived (the agent's next message). */
  after_warmup?: boolean;
  /** 1 or 2: a message the tour replays after its thread's Send. */
  replay?: number;
  attachments?: TourFileRef[];
  inline_images?: TourInlineImageRef[];
  /** A comment the message's words suggest (step 3). */
  suggest?: TourSuggestion;
}

export interface TourFixtureThread {
  id: string;
  subject: string;
  thread_name: string | null;
  slice?: string;
  real_answer?: string;
  /** The warm-up question (added by the tour; the real thread asked nothing at 11:48): the answer the tour goes on with, and when the person's reply to it was sent. */
  warmup_answer?: string;
  warmup_reply_time?: string;
  picture_label?: string;
  picture_label_short?: string;
  /** When the person's replayed reply was sent. */
  reply_time?: string;
  /** The thread the person starts (step 9): compose's suggested words, and when. */
  person?: boolean;
  compose?: { body: string; time: string };
  messages: TourFixtureMessage[];
}

export interface TourFixture {
  v: number;
  date: string;
  project: string;
  developer: string;
  /** A tile's thumbnail → the larger picture the viewer shows. */
  full: Record<string, string>;
  threads: TourFixtureThread[];
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const TOUR_ASSET_RE = /^[a-z0-9][a-z0-9.-]*\.(webp|html|mp4|md)$/;

/** The fixture as the server serves it, checked: anything else is refused (the tour is then not offered on this load). */
export function parseTourFixture(input: unknown): TourFixture {
  const fail = (why: string): never => {
    throw new Error(`The tour's content is not readable: ${why}.`);
  };
  if (!input || typeof input !== 'object') fail('not an object');
  const f = input as Record<string, unknown>;
  if (f.v !== 2) fail('an unknown version');
  if (typeof f.project !== 'string' || typeof f.developer !== 'string' || typeof f.date !== 'string') fail('no project, developer or date');
  if (!Array.isArray(f.threads)) fail('no threads');
  const threads = (f.threads as unknown[]).map((t) => {
    const thread = t as TourFixtureThread;
    if (!thread || typeof thread.id !== 'string' || typeof thread.subject !== 'string' || !Array.isArray(thread.messages)) fail('a thread without id, subject or messages');
    if (thread.person && (typeof thread.compose?.body !== 'string' || !TIME_RE.test(thread.compose.time))) fail('a person’s thread without its words');
    for (const m of thread.messages) {
      if (typeof m.id !== 'string' || (m.who !== 'developer' && m.who !== 'agent') || !TIME_RE.test(m.time)) fail(`a message without id, author or time (${String(m.id)})`);
      for (const a of m.attachments ?? []) {
        if (!ASSET_OK(a.asset) || (a.poster && !ASSET_OK(a.poster))) fail(`a file that is not a tour asset (${String(a.asset)})`);
        if (typeof a.name !== 'string' || typeof a.size !== 'number') fail(`a file without name or size (${a.asset})`);
        if (readInboxAttachmentKind(a.kind) === 'file' && a.kind !== 'file') fail(`a file of an unknown kind (${String(a.kind)})`);
      }
      for (const i of m.inline_images ?? []) if (!ASSET_OK(i.ref) || !/\.webp$/.test(i.ref) || !(m.body ?? '').includes(`](${i.ref})`)) fail(`an image that is not a tour asset in its body (${String(i.ref)})`);
    }
    return thread;
  });
  for (const id of [TOUR_THREAD, TOUR_FILM_THREAD, TOUR_NEW_THREAD]) if (!threads.some((t) => t.id === id)) fail(`no ${id} thread`);
  const a = threads.find((t) => t.id === TOUR_THREAD)!;
  if (!a.messages.some((m) => m.warmup) || !a.messages.some((m) => m.asks) || typeof a.warmup_answer !== 'string') fail('no warm-up or picture question');
  const full: Record<string, string> = {};
  if (f.full && typeof f.full === 'object') {
    for (const [k, v] of Object.entries(f.full as Record<string, unknown>)) if (ASSET_OK(k) && typeof v === 'string' && ASSET_OK(v)) full[k] = v;
  }
  return { v: 2, date: f.date as string, project: f.project as string, developer: f.developer as string, full, threads };
}

function ASSET_OK(name: unknown): name is string {
  return typeof name === 'string' && TOUR_ASSET_RE.test(name);
}

/** "12:03 PM" from the fixture's `12:03`: the real time as it was read then, whatever the reader's clock. */
export function tourTime(time: string): string {
  const m = TIME_RE.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * An ISO time on the reader's own day at the fixture's wall-clock time, so a
 * list row reads "12:03 PM" as the thread does.
 */
export function tourIso(time: string, now: Date = new Date()): string {
  const m = TIME_RE.exec(time);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), m ? Number(m[1]) : 12, m ? Number(m[2]) : 0);
  return d.toISOString();
}

// ─────────────────────────── The state machine ───────────────────────────

export type TourRoute = 'list' | typeof TOUR_THREAD | typeof TOUR_FILM_THREAD | typeof TOUR_NEW_THREAD;

/** The file open in the pane (the real AttachmentPane, over the tour's file source). */
export interface TourOpenFile {
  id: string;
  /** Full screen; else side by side. */
  full: boolean;
}

export interface TourState {
  /** 1 to 10. */
  step: number;
  route: TourRoute;
  // The warm-up (step 2): a plain question, its Send, and its replay (the picture question arrives).
  warmPicked: string | null;
  warmAnswer: QuestionAnswer | null;
  warmSent: boolean;
  warmDelivered: boolean;
  warmArrived: boolean;
  /** What the tour question's draft answers: a choice's label, the person's own words (`“…”`), `Skipped`, or null. */
  picked: string | null;
  answer: QuestionAnswer | null;
  /** Every comment the person made in the tour: on words, on a file, on an image, on the film (InboxAnnotationRecord shapes, never stored). */
  comments: InboxAnnotationRecord[];
  file: TourOpenFile | null;
  /** The reply box is open (steps 4 to 6, and the film's reply). */
  replyOpen: boolean;
  // Thread A's replay.
  sent: boolean;
  delivered: boolean;
  arrived: number;
  // Thread B's replay.
  filmSent: boolean;
  filmDelivered: boolean;
  filmArrived: boolean;
  // Thread C.
  compose: 'closed' | 'open' | 'sent';
  newDelivered: boolean;
  newArrived: boolean;
  /** The step-9 card after its reply: false "That's the loop", true "Also in your Inbox". */
  also: boolean;
  /** Step 1 opens on the "How it's organised" card (a Next), then the question's row. */
  orient: boolean;
  /** The thread's Artifacts view is open (in place of the messages). */
  artifactsOpen: boolean;
  /** Step 7's Artifacts part: 0 not yet, 1 the card, 2 a tile was opened from the grid. */
  artifactsTour: 0 | 1 | 2;
  /** Threads opened since their last news. */
  looked: { a: boolean; film: boolean; new: boolean };
}

export const TOUR_START: TourState = {
  step: 1,
  route: 'list',
  warmPicked: null,
  warmAnswer: null,
  warmSent: false,
  warmDelivered: false,
  warmArrived: false,
  picked: null,
  answer: null,
  comments: [],
  file: null,
  replyOpen: false,
  sent: false,
  delivered: false,
  arrived: 0,
  filmSent: false,
  filmDelivered: false,
  filmArrived: false,
  compose: 'closed',
  newDelivered: false,
  newArrived: false,
  also: false,
  orient: true,
  artifactsOpen: false,
  artifactsTour: 0,
  looked: { a: false, film: false, new: false },
};

/** A step read from the address (`#tour=…`): a whole number from 1 to 10, anything else the nearest of them, 1 when none. */
export function tourStepOf(raw: string | null | undefined): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, TOUR_STEPS);
}

export const TOUR_SKIPPED = 'Skipped';

export function tourPickOf(answer: QuestionAnswer | null | undefined): string | null {
  if (!answer) return null;
  const label = answer.selected?.[0];
  if (label) return label;
  const other = answer.other?.trim();
  if (other) return `“${other}”`;
  if (answer.skipped) return TOUR_SKIPPED;
  return null;
}

/** The replay's note starts with what the person did: "You picked B · …", "You answered “…”", "You skipped it". */
export function tourPickWords(picked: string): string {
  if (picked === TOUR_SKIPPED) return 'You skipped it';
  if (picked.startsWith('“')) return `You answered ${picked}`;
  return `You picked ${picked}`;
}

/** Where a comment sits, by what it is on. */
export type TourCommentTarget = 'message' | 'file' | 'image' | 'video';

export function tourCommentTarget(record: InboxAnnotationRecord, attachments: readonly InboxAttachmentState[]): TourCommentTarget {
  if (record.message) return 'message';
  const kind = readInboxAttachmentKind(attachments.find((a) => a.id === record.attachment_id)?.kind);
  return kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'file';
}

export type TourAction =
  | { type: 'open'; thread: string }
  | { type: 'list' }
  | { type: 'pick'; label: string | null; answer?: QuestionAnswer | null }
  /** The warm-up question (step 2): a pick, its Send, its replay. */
  | { type: 'warmPick'; label: string | null; answer?: QuestionAnswer | null }
  | { type: 'warmSend' }
  | { type: 'warmDelivered' }
  | { type: 'warmArrive' }
  /** A comment saved (new, or edited by id). */
  | { type: 'comment'; record: InboxAnnotationRecord }
  | { type: 'uncomment'; id: string }
  | { type: 'openFile'; id: string; full: boolean }
  | { type: 'fullFile'; full: boolean }
  | { type: 'closeFile' }
  | { type: 'reply'; open: boolean }
  | { type: 'artifacts'; open: boolean }
  | { type: 'send' }
  | { type: 'delivered' }
  | { type: 'arrive' }
  | { type: 'filmSend' }
  | { type: 'filmDelivered' }
  | { type: 'filmArrive' }
  | { type: 'compose'; open: boolean }
  | { type: 'composeSend' }
  | { type: 'newDelivered' }
  | { type: 'newArrive' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: number; realAnswer: string; fixture?: TourFixture }
  /** Fast-forward: the end of the current step, as the walk would leave it (the person's own picks and comments kept). */
  | { type: 'forward'; realAnswer: string; fixture?: TourFixture };

// ─── The ids and records the tour makes (never stored) ───

export const TOUR_REPLY_ID = 'tour-vscode-reply';
export const TOUR_WARM_REPLY_ID = 'tour-vscode-warm-reply';
export const TOUR_FILM_REPLY_ID = 'tour-film-reply';
export const TOUR_NEW_MESSAGE_ID = 'tour-new-0';

/** A tour attachment's id: `tour-att-<message>-<n>` for a file, `tour-img-<asset stem>` for an image in a message's text. */
export function tourAttachmentId(messageId: string, index: number): string {
  return `tour-att-${messageId}-${index}`;
}
export function tourInlineImageId(ref: string): string {
  return `tour-img-${ref.replace(/\.[^.]+$/, '')}`;
}
/** A tour file's path (only ever a key: annotation counts, records): never a real path. */
export function tourPath(messageId: string, name: string): string {
  return `tour/${messageId}/${name}`;
}

/** A comment record as the tour keeps it (the store's shape, so the window's chips and panels read it). */
export function tourRecord(input: {
  id: string;
  thread: string;
  message: string;
  attachment?: InboxAttachmentState | null;
  annotation: Record<string, unknown>;
  messageAt?: string;
  at?: string;
}): InboxAnnotationRecord {
  const at = input.at ?? new Date().toISOString();
  return {
    id: input.id,
    project_id: TOUR_PROJECT_ID,
    thread_id: input.thread,
    message_id: input.message,
    attachment_id: input.attachment?.id ?? '',
    path: input.attachment?.path ?? input.message,
    version: 'current',
    ...(input.attachment ? {} : { message: { at: input.messageAt ?? at } }),
    annotation: input.annotation,
    created_at: at,
    updated_at: at,
    removed_at: null,
    sent_reply_id: null,
  };
}

/** The comment a suggestion makes on words of a message (as Plannotator's selection annotation). */
function suggestedMessageComment(fixture: TourFixture, thread: string, messageId: string): InboxAnnotationRecord | null {
  const m = threadOf(fixture, thread)?.messages.find((x) => x.id === messageId);
  if (!m?.suggest?.phrase) return null;
  return tourRecord({
    id: `tour-ann-${messageId}`,
    thread,
    message: messageId,
    messageAt: tourIso(m.time),
    annotation: { id: `tour-ann-${messageId}`, blockId: '', startOffset: 0, endOffset: 0, type: 'COMMENT', text: m.suggest.comment, originalText: m.suggest.phrase, createdA: 0 },
  });
}

/** The comment a file's suggestion makes (step 5's line, step 7's image, step 8's film moment). */
function suggestedFileComment(fixture: TourFixture, attachmentId: string): InboxAnnotationRecord | null {
  const found = tourAttachments(fixture, TOUR_ALL_SHOWN).find((a) => a.id === attachmentId);
  const suggest = found ? tourSuggestionFor(fixture, found) : null;
  if (!found || !suggest) return null;
  const kind = readInboxAttachmentKind(found.kind);
  const annotation: Record<string, unknown> =
    kind === 'video'
      ? { id: `tour-ann-${attachmentId}`, blockId: 'video', startOffset: 0, endOffset: 0, type: 'COMMENT', text: suggest.comment, originalText: '', createdA: 0, inboxVideo: { time: suggest.at ?? 0 } }
      : kind === 'image'
        ? { id: `tour-ann-${attachmentId}`, blockId: 'image', startOffset: 0, endOffset: 0, type: 'COMMENT', text: suggest.comment, originalText: '', createdA: 0 }
        : { id: `tour-ann-${attachmentId}`, blockId: '', startOffset: 0, endOffset: 0, type: 'COMMENT', text: suggest.comment, originalText: suggest.phrase ?? '', createdA: 0 };
  const threadId = fixture.threads.find((t) => t.messages.some((m) => m.id === found.message_id))?.id ?? TOUR_THREAD;
  return tourRecord({ id: `tour-ann-${attachmentId}`, thread: threadId, message: found.message_id, attachment: found, annotation });
}

/** The fixture's attachment ids the walk comments on, by role. */
function walkTargets(fixture: TourFixture) {
  const files = tourAttachments(fixture, TOUR_ALL_SHOWN);
  return {
    evaluation: files.find((a) => readInboxAttachmentKind(a.kind) === 'markdown')?.id ?? null,
    screenshot: files.find((a) => a.ref !== undefined && tourSuggestionFor(fixture, a) !== null)?.id ?? null,
    film: files.find((a) => readInboxAttachmentKind(a.kind) === 'video')?.id ?? null,
    asking: threadOf(fixture, TOUR_THREAD)?.messages.find((m) => m.asks)?.id ?? null,
  };
}

/** The warm-up's answer the tour goes on with (step 2): the fixture's, or none without it. Not a real answer: the tour added this question. */
export function tourWarmAnswer(fixture?: TourFixture): string | null {
  return fixture?.threads.find((t) => t.id === TOUR_THREAD)?.warmup_answer ?? null;
}

/**
 * The state the tour is in at a step reached directly (`#tour=N`, a reload):
 * as the walk would leave it, with the real answers picked and every
 * suggestion kept. Without the fixture, the comments are left out.
 */
export function tourStateAt(step: number, realAnswer: string, fixture?: TourFixture): TourState {
  const s = Math.min(Math.max(Math.trunc(step) || 1, 1), TOUR_STEPS);
  const t = fixture ? walkTargets(fixture) : null;
  const comment = (kind: 'message' | 'evaluation' | 'screenshot' | 'film'): InboxAnnotationRecord[] => {
    if (!fixture || !t) return [];
    const record = kind === 'message' ? (t.asking ? suggestedMessageComment(fixture, TOUR_THREAD, t.asking) : null) : t[kind] ? suggestedFileComment(fixture, t[kind]!) : null;
    return record ? [record] : [];
  };
  const looked = { a: true, film: false, new: false };
  if (s === 1) return TOUR_START;
  const start = { ...TOUR_START, orient: false };
  if (s === 2) return { ...start, step: 2, route: TOUR_THREAD, looked };
  const warm = tourWarmAnswer(fixture);
  const warmed = { ...start, route: TOUR_THREAD as TourRoute, looked, warmPicked: warm, warmSent: true, warmDelivered: true, warmArrived: true };
  if (s === 3) return { ...warmed, step: 3 };
  if (s === 4) return { ...warmed, step: 4, picked: realAnswer };
  if (s === 5) return { ...warmed, step: 5, picked: realAnswer, comments: comment('message') };
  const first = [...comment('message'), ...comment('evaluation')];
  if (s === 6) return { ...warmed, step: 6, picked: realAnswer, comments: first };
  const sentFirst = first.map((r) => ({ ...r, sent_reply_id: TOUR_REPLY_ID }));
  const replayed = { ...warmed, picked: realAnswer, comments: sentFirst, sent: true, delivered: true, arrived: 2 };
  if (s === 7) return { ...replayed, step: 7 };
  const shot = comment('screenshot');
  if (s === 8) return { ...replayed, step: 8, route: 'list', comments: [...sentFirst, ...shot], artifactsTour: 2 };
  const film = comment('film').map((r) => ({ ...r, sent_reply_id: TOUR_FILM_REPLY_ID }));
  const filmed = { ...replayed, artifactsTour: 2 as const, route: 'list' as TourRoute, comments: [...sentFirst, ...shot, ...film], filmSent: true, filmDelivered: true, filmArrived: true, looked: { ...looked, film: true } };
  if (s === 9) return { ...filmed, step: 9 };
  return { ...filmed, step: 10, compose: 'sent', newDelivered: true, newArrived: true, also: true };
}

/** Same target: the same file (or the same message's words). */
function sameTarget(a: InboxAnnotationRecord, b: InboxAnnotationRecord): boolean {
  return a.id === b.id || (a.attachment_id === b.attachment_id && a.message_id === b.message_id && !!a.message === !!b.message);
}

/**
 * Fast-forward (the owner, 2026-10-25): the end of the current step, as the
 * walk would leave it. The person's own picks and comments are kept where
 * they made them; only what is still missing is filled in, the same way
 * `#tour=N` does. Step 9 (New message) ends on "That's the loop", the new
 * thread open with its answer; a card with Next has nothing to skip.
 */
export function tourForward(state: TourState, realAnswer: string, fixture?: TourFixture): TourState {
  const { step } = state;
  if (step >= TOUR_STEPS) return state;
  if (step === 1 && state.orient) return { ...state, orient: false };
  let end: TourState;
  if (step === TOUR_STEPS - 1) {
    if (state.newArrived) return state;
    const done = tourStateAt(TOUR_STEPS, realAnswer, fixture);
    end = { ...done, step, also: false, route: TOUR_NEW_THREAD, looked: { ...done.looked, new: true } };
  } else {
    end = tourStateAt(step + 1, realAnswer, fixture);
  }
  const warmPicked = state.warmPicked ?? end.warmPicked;
  const warmAnswer = state.warmPicked ? state.warmAnswer : end.warmAnswer;
  const picked = end.picked === null ? null : (state.picked ?? end.picked);
  const answer = end.picked === null ? null : state.picked ? state.answer : end.answer;
  const sentId = (r: InboxAnnotationRecord): string | null => {
    if (r.sent_reply_id) return r.sent_reply_id;
    if (r.thread_id === TOUR_THREAD && end.sent) return TOUR_REPLY_ID;
    if (r.thread_id === TOUR_FILM_THREAD && end.filmSent) return TOUR_FILM_REPLY_ID;
    return null;
  };
  const mine = state.comments.map((r) => ({ ...r, sent_reply_id: sentId(r) }));
  const filled = end.comments.filter((r) => !mine.some((m) => sameTarget(m, r)));
  return { ...end, warmPicked, warmAnswer, picked, answer, comments: [...mine, ...filled] };
}

/** A Fast-forward is offered: every card that asks the person to do something, or waits on a replay (not one with Next). */
export function tourCanForward(state: TourState, coach: Pick<TourCoach, 'next'> | null): boolean {
  return state.step < TOUR_STEPS && !!coach && !coach.next;
}

const isOpenThread = (state: TourState, id: string) => state.route === id;

/** Every message of the fixture shown (what the walk's comments are on). */
const TOUR_ALL_SHOWN: TourState = { ...TOUR_START, warmSent: true, warmDelivered: true, warmArrived: true, sent: true, delivered: true, arrived: 2, filmSent: true, filmDelivered: true, filmArrived: true, compose: 'sent', newDelivered: true, newArrived: true };

export function tourReducer(state: TourState, action: TourAction): TourState {
  if (state.step === TOUR_STEPS && action.type !== 'goto') return state;
  switch (action.type) {
    case 'goto':
      return tourStateAt(action.step, action.realAnswer, action.fixture);
    case 'forward':
      return tourForward(state, action.realAnswer, action.fixture);
    case 'open': {
      if (action.thread !== TOUR_THREAD && action.thread !== TOUR_FILM_THREAD && action.thread !== TOUR_NEW_THREAD) return state;
      if (action.thread === TOUR_NEW_THREAD && state.compose !== 'sent') return state;
      const looked =
        action.thread === TOUR_THREAD ? { ...state.looked, a: true } : action.thread === TOUR_FILM_THREAD ? { ...state.looked, film: true } : { ...state.looked, new: true };
      const step = state.step === 1 && action.thread === TOUR_THREAD ? 2 : state.step;
      const file = state.file && isOpenThread(state, action.thread) ? state.file : null;
      const same = action.thread === state.route;
      return { ...state, route: action.thread, step, looked, file, orient: false, replyOpen: same ? state.replyOpen : false, artifactsOpen: same ? state.artifactsOpen : false };
    }
    case 'list':
      return { ...state, route: 'list', file: null, replyOpen: false, artifactsOpen: false };
    case 'warmPick': {
      if (state.warmSent || state.route !== TOUR_THREAD || state.step !== 2) return state;
      const answer = action.answer !== undefined ? action.answer : null;
      const picked = action.answer !== undefined ? tourPickOf(action.answer) : action.label;
      return { ...state, warmPicked: picked, warmAnswer: answer };
    }
    case 'warmSend':
      if (state.warmSent || !state.warmPicked || state.step !== 2) return state;
      return { ...state, warmSent: true, warmDelivered: false, warmArrived: false, file: null, replyOpen: false };
    case 'warmDelivered':
      return state.warmSent ? { ...state, warmDelivered: true } : state;
    case 'warmArrive':
      // The agent's answer brings the picture question: step 3 starts on it.
      return state.warmDelivered && !state.warmArrived ? { ...state, warmArrived: true, step: state.step === 2 ? 3 : state.step, looked: { ...state.looked, a: state.route === TOUR_THREAD || state.looked.a } } : state;
    case 'pick': {
      if (state.sent || !state.warmArrived || state.route !== TOUR_THREAD || state.step > 6) return state;
      const answer =
        action.answer !== undefined
          ? action.answer
          : action.label && state.answer?.note
            ? { ...state.answer, selected: [action.label], other: undefined, skipped: undefined }
            : null;
      const picked = action.answer !== undefined ? tourPickOf(action.answer) : action.label;
      if (picked === null) return { ...state, picked: null, answer, step: state.step === 4 ? 3 : state.step };
      return { ...state, picked, answer, step: state.step === 3 ? 4 : state.step };
    }
    case 'comment': {
      const at = state.comments.findIndex((r) => r.id === action.record.id);
      const comments = at >= 0 ? state.comments.map((r, i) => (i === at ? { ...action.record, created_at: r.created_at } : r)) : [...state.comments, action.record];
      const next = { ...state, comments };
      // The step's own action: words (4), a file's line (5).
      if (state.step === 4 && action.record.message && action.record.thread_id === TOUR_THREAD) return { ...next, step: 5 };
      // Step 6 is the reply in the thread: the file closes, and the reply's Send is in view (a phone shows one screen).
      if (state.step === 5 && !action.record.message && action.record.thread_id === TOUR_THREAD) return { ...next, step: 6, file: null };
      // The film's comment rides the film thread's reply: the film closes, and Send is in view.
      if (state.step === 8 && !state.filmSent && action.record.thread_id === TOUR_FILM_THREAD) return { ...next, file: null };
      return next;
    }
    case 'uncomment':
      return { ...state, comments: state.comments.filter((r) => r.id !== action.id || r.sent_reply_id !== null) };
    case 'openFile':
      return { ...state, file: { id: action.id, full: action.full }, artifactsTour: state.artifactsTour === 1 && state.artifactsOpen ? 2 : state.artifactsTour };
    case 'artifacts':
      return { ...state, artifactsOpen: action.open, file: action.open ? state.file : null };
    case 'fullFile':
      return state.file ? { ...state, file: { ...state.file, full: action.full } } : state;
    case 'closeFile':
      return { ...state, file: null };
    case 'reply':
      return { ...state, replyOpen: action.open };
    case 'send': {
      if (state.sent || !state.picked || state.step !== 6) return state;
      const comments = state.comments.map((r) => (r.thread_id === TOUR_THREAD && r.sent_reply_id === null ? { ...r, sent_reply_id: TOUR_REPLY_ID } : r));
      return { ...state, sent: true, step: 7, delivered: false, arrived: 0, comments, replyOpen: false, file: null, looked: { ...state.looked, a: true } };
    }
    case 'delivered':
      return state.sent ? { ...state, delivered: true } : state;
    case 'arrive':
      return state.delivered && state.arrived < 2 ? { ...state, arrived: state.arrived + 1 } : state;
    case 'filmSend': {
      if (state.step !== 8 || state.filmSent || !state.comments.some((r) => r.thread_id === TOUR_FILM_THREAD && r.sent_reply_id === null)) return state;
      const comments = state.comments.map((r) => (r.thread_id === TOUR_FILM_THREAD && r.sent_reply_id === null ? { ...r, sent_reply_id: TOUR_FILM_REPLY_ID } : r));
      return { ...state, filmSent: true, comments, replyOpen: false, file: null };
    }
    case 'filmDelivered':
      return state.filmSent ? { ...state, filmDelivered: true } : state;
    case 'filmArrive':
      return state.filmDelivered ? { ...state, filmArrived: true } : state;
    case 'compose':
      if (state.step !== 9 || state.compose === 'sent') return state;
      return { ...state, compose: action.open ? 'open' : 'closed' };
    case 'composeSend':
      if (state.step !== 9 || state.compose === 'sent') return state;
      // The thread the person just started opens, as the toast's Open would: its delivery and the answer show there.
      return { ...state, compose: 'sent', route: TOUR_NEW_THREAD, file: null, replyOpen: false, artifactsOpen: false, looked: { ...state.looked, new: true } };
    case 'newDelivered':
      return state.compose === 'sent' ? { ...state, newDelivered: true } : state;
    case 'newArrive':
      return state.newDelivered ? { ...state, newArrived: true, looked: { ...state.looked, new: state.route === TOUR_NEW_THREAD } } : state;
    case 'next':
      if (state.step === 1 && state.orient) return { ...state, orient: false };
      if (state.step === 7 && tourImageCommented(state) && state.artifactsTour === 0) return { ...state, artifactsTour: 1, file: null };
      if (state.step === 7 && state.artifactsTour === 2) return { ...state, step: 8, route: 'list', file: null, artifactsOpen: false, replyOpen: false };
      if (state.step === 8 && state.filmArrived) return { ...state, step: 9, route: 'list', file: null, replyOpen: false };
      if (state.step === 9 && state.newArrived && !state.also) return { ...state, also: true };
      if (state.step === 9 && state.also) return { ...state, step: 10, file: null, route: 'list', replyOpen: false };
      return state;
    case 'back':
      if (state.step === 8 && !state.filmSent) return { ...state, step: 7, route: TOUR_THREAD, file: null, replyOpen: false, artifactsOpen: false };
      if (state.step === 5) return { ...state, step: 4, route: TOUR_THREAD, file: null };
      if (state.step === 4) return { ...state, step: 3, route: TOUR_THREAD, file: null };
      if (state.step === 2 && !state.warmSent) return { ...state, step: 1, route: 'list', file: null };
      return state;
  }
}

/** Step 7's image comment (a1.png, with or without its drawing) was saved. */
export function tourImageCommented(state: TourState): boolean {
  return state.comments.some((r) => r.thread_id === TOUR_THREAD && r.attachment_id.startsWith('tour-img-'));
}

/** The film's comment waits for its Send. */
export function tourFilmCommented(state: TourState): boolean {
  return state.comments.some((r) => r.thread_id === TOUR_FILM_THREAD && r.sent_reply_id === null);
}

/** Back is offered on steps 2 (before its Send), 4, 5 and 8 (before its Send); 3, 6, 7 and 9 have none once sent; 1 has nothing before it. */
export function tourCanBack(state: TourState): boolean {
  return (state.step === 2 && !state.warmSent) || state.step === 4 || state.step === 5 || (state.step === 8 && !state.filmSent);
}

/** The warm-up's replay after its Send (delivered, then the agent's answer with the pictures): about 60% under reduced motion. */
export function warmTimings(reduced: boolean): { delivered: number; reply: number } {
  return reduced ? { delivered: 660, reply: 1560 } : { delivered: 1100, reply: 2600 };
}

/** The replays' timings in ms after Send: about 60% of each under reduced motion. */
export function replayTimings(reduced: boolean): { delivered: number; first: number; second: number } {
  return reduced ? { delivered: 660, first: 1800, second: 3360 } : { delivered: 1100, first: 3000, second: 5600 };
}
export function filmTimings(reduced: boolean): { delivered: number; reply: number } {
  return reduced ? { delivered: 660, reply: 1440 } : { delivered: 1100, reply: 2400 };
}
export function newThreadTimings(reduced: boolean): { delivered: number; reply: number } {
  return reduced ? { delivered: 660, reply: 1920 } : { delivered: 1100, reply: 3200 };
}

/** The person's pick is not the real thread's answer: the replay says so, as a fact. */
export function pickDiffers(state: TourState, realAnswer: string): boolean {
  return state.picked !== null && state.picked !== realAnswer;
}

/** The warm-up's pick is not the one the tour goes on with (the tour says so plainly; it never claims a real answer). */
export function warmDiffers(state: TourState, warmReal: string | null): boolean {
  return state.warmPicked !== null && warmReal !== null && state.warmPicked !== warmReal;
}

// ─────────────────────────── The coach ───────────────────────────

/** What a coach card points at; the window resolves it to an element. */
export type TourTarget =
  | 'row'
  | 'film-row'
  | 'new-row'
  | 'warm-choices'
  | 'warm-send'
  | 'choices'
  | 'phrase'
  | 'composer'
  | 'eval-tile'
  | 'eval-line'
  | 'file'
  | 'reply'
  | 'reply-box'
  | 'delivered'
  | 'inline-img'
  | 'markup'
  | 'image-foot'
  | 'art-button'
  | 'art-grid'
  | 'film-tile'
  | 'film-rail'
  | 'film-composer'
  | 'film-send'
  | 'compose-btn'
  | 'compose-to'
  | 'compose-send'
  | 'arrival';

export interface TourCoach {
  /** Stable per card: a change moves focus to the new title and says it in the live region. */
  key: string;
  title: string;
  /** At most two sentences. */
  text: string;
  action?: string;
  /** One-line items in place of the text (the "Also in your Inbox" card). */
  items?: { mark: string; title: string; text: string }[];
  /** A small live picture under the text (the "How it's organised" card). */
  picture?: 'orient';
  next?: boolean;
  /** The Next button's words (default "Next"). */
  nextLabel?: string;
  wait?: boolean;
  target: TourTarget | null;
}

export interface TourDegraded {
  pictures?: boolean;
}

/** The four things the "Also in your Inbox" card names (the approved mock): they exist, and each could be a step. */
export const TOUR_ALSO_ITEMS: { mark: string; title: string; text: string }[] = [
  { mark: '📌', title: 'Pin a thread', text: 'to keep it at the top of the sidebar.' },
  { mark: '👍', title: 'Looks good', text: 'tells an agent in one click when there’s nothing to add.' },
  { mark: '↻', title: 'Re-ask', text: 'gathers an agent’s open questions into one fresh message.' },
  { mark: '➤', title: 'Send now', text: 'puts your reply into a turn that’s running.' },
];

/**
 * What is on screen that the state does not hold (read from the window as the
 * person works): a comment box open, a drawing made but not saved, a film's
 * moment pinned, the compose dialog's To chosen. The card follows it.
 */
export interface TourUi {
  composing?: boolean;
  /** The drawing surface (Mark up) is open over the picture. */
  annotating?: boolean;
  drawn?: boolean;
  /** "0:07": the film's comment pinned at that moment. */
  pinnedAt?: string | null;
  toChosen?: boolean;
}

/** The card asks the person to do something now (not a Next, not a replay): it carries the "Your turn" cue. */
export function tourYourTurn(coach: Pick<TourCoach, 'action' | 'next' | 'wait'>): boolean {
  return !!coach.action && !coach.next && !coach.wait;
}

/** The coach card a state shows (steps 1 to 9; step 10 is the person's own screen and has none). Copy: the approved mock, plus the owner's crawl step. */
export function tourCoach(state: TourState, names: { developer: string; agent: string }, degraded: TourDegraded = {}, ui: TourUi = {}): TourCoach | null {
  const { developer, agent } = names;
  const { step } = state;
  if (step === TOUR_STEPS) return null;
  if (step === 1 && state.orient)
    return {
      key: '1-orient',
      title: 'How it’s organised',
      text: 'It reads like email: projects on the left, and each row is a thread about one subject, such as a single feature. Open a thread and it’s a conversation, with files attached as tiles.',
      picture: 'orient',
      next: true,
      target: null,
    };
  if (step === 1)
    return {
      key: '1',
      title: 'An agent came back with a question',
      text: `${developer} asked ${agent} to rethink a VS Code feature, then went back to other work.`,
      action: 'Open the question it came back with.',
      target: 'row',
    };
  // Steps 2 to 7 happen in thread A; left mid-step, the card shows the way back.
  if (step <= 7 && state.route !== TOUR_THREAD)
    return { key: `back-${step}`, title: 'The question is in this thread', text: 'The tour goes on where you left it.', action: 'Open it again.', target: 'row' };
  if (step === 2) {
    if (state.warmSent)
      return {
        key: state.warmDelivered ? '2-delivered' : '2-sending',
        title: state.warmDelivered ? 'Delivered. Now watch.' : 'Sending…',
        text: `${agent} takes your answer as its next turn and goes to work.`,
        wait: true,
        target: state.warmDelivered ? 'delivered' : null,
      };
    if (state.warmPicked) return { key: '2-send', title: 'Send it back', text: 'Your pick waits in a draft until you send it.', action: 'Press Send.', target: 'warm-send' };
    return { key: '2', title: 'Start with a plain question', text: `${agent} checks one thing before it starts. Your answer goes back into the session that asked.`, action: 'Pick an answer.', target: 'warm-choices' };
  }
  if (step === 3)
    return degraded.pictures
      ? { key: '3', title: 'Pick a direction', text: `These are ${agent}’s four directions for the VS Code guide, each named on the card.`, action: 'Pick the direction you would build.', target: 'choices' }
      : { key: '3', title: 'The choices are pictures', text: `They are ${agent}’s mockups of VS Code; the magnifier looks closer.`, action: 'Pick the direction you would build.', target: 'choices' };
  if (step === 4)
    return ui.composing
      ? { key: '4-box', title: 'Say something about any words', text: 'Each comment box starts with one of the developer’s real comments; keep it or write your own.', action: 'Save the comment.', target: 'composer' }
      : { key: '4', title: 'Say something about any words', text: 'Select text in a message to comment on it; the comment goes with your reply.', action: 'Select the highlighted words.', target: 'phrase' };
  if (step === 5) {
    if (!state.file) return { key: '5', title: 'Files open right here', text: 'Agents attach plans, mocks and screenshots; you read them beside the thread.', action: 'Open EVALUATION.md.', target: 'eval-tile' };
    if (ui.composing) return { key: '5-box', title: 'Comment on any line', text: 'The comment stays on this file and rides your next reply.', action: 'Save it.', target: 'composer' };
    return { key: '5-file', title: 'Comment on any line', text: `The real file, as ${agent} sent it.`, action: 'Select the highlighted line to comment on it.', target: 'eval-line' };
  }
  if (step === 6)
    return state.replyOpen
      ? { key: '6-box', title: 'Everything goes back together', text: 'Here is your answer and both comments, ready to go.', action: 'Press Send to replay it.', target: 'reply-box' }
      : { key: '6', title: 'Everything goes back together', text: 'Your pick and both comments ride one reply, into the session that asked.', action: 'Press Send to see what goes.', target: 'reply' };
  if (step === 7) {
    if (state.arrived < 2)
      return {
        key: state.delivered ? '7-delivered' : '7-sending',
        title: state.delivered ? 'Delivered. Now watch.' : 'Sending…',
        text: 'In the real thread, the session that asked had your answer now.',
        wait: true,
        target: state.delivered ? 'delivered' : null,
      };
    if (state.artifactsTour === 2)
      return { key: '7-art-open', title: 'Every file in one place', text: 'Each tile opens in the same viewer, ready for comments.', next: true, target: 'file' };
    if (state.artifactsTour === 1)
      return state.artifactsOpen
        ? { key: '7-art-grid', title: 'Every file in one place', text: 'Everything this thread holds, as tiles: the mock, the notes, the screenshots.', action: 'Open any tile.', target: 'art-grid' }
        : { key: '7-art', title: 'Every file in one place', text: 'Artifacts gathers every file, picture and film in a thread, newest first.', action: 'Press Artifacts.', target: 'art-button' };
    if (tourImageCommented(state)) return { key: '7-drawn', title: 'Pictures take comments too', text: 'The drawing waits in your draft and goes with your next reply.', next: true, target: state.file ? 'image-foot' : 'arrival' };
    if (!state.file) return { key: '7', title: 'It keeps working, and shows you', text: `An hour later ${agent} was done, with screenshots right in the message.`, action: 'Open the first screenshot.', target: 'inline-img' };
    // While Mark up's drawing surface is open, the card stands clear of its tools (it points at nothing).
    if (ui.annotating && !ui.drawn) return { key: '7-drawing', title: 'Circle what you like', text: 'Drag on the picture to draw; Save keeps the drawing.', action: 'Drag a circle.', target: null };
    return ui.drawn
      ? { key: '7-drawn-unsaved', title: 'Circle what you like', text: 'Your circle is on the picture; the suggestion is the developer’s real reaction.', action: 'Save it.', target: 'image-foot' }
      : { key: '7-file', title: 'Circle what you like', text: 'Mark up draws on the picture, and the drawing goes with your words.', action: 'Press Mark up, then drag a circle.', target: 'markup' };
  }
  if (step === 8) {
    if (state.route !== TOUR_FILM_THREAD && !state.filmSent)
      return { key: '8-open', title: 'A film came in too', text: `The same work, a day earlier: ${agent} sent the launch film.`, action: 'Open the film thread.', target: 'film-row' };
    if (state.filmArrived) return { key: '8-done', title: 'It knew exactly where', text: `The moment and the frame went with your words, so ${agent} knew what to fix.`, next: true, target: 'arrival' };
    if (state.filmSent)
      return { key: state.filmDelivered ? '8-delivered' : '8-sending', title: state.filmDelivered ? 'Delivered.' : 'Sending…', text: `In the real thread, ${agent} answered a minute later.`, wait: true, target: 'delivered' };
    if (tourFilmCommented(state)) return { key: '8-send', title: 'Send it back', text: 'The comment, its moment and its frame go in one reply.', action: 'Press Send.', target: 'film-send' };
    const title = 'Comment on a film, at the moment';
    if (!state.file) return { key: '8', title, text: 'Videos play right in the thread.', action: 'Play guides-vscode.mp4.', target: 'film-tile' };
    if (ui.pinnedAt) return { key: '8-pinned', title, text: `Pinned at ${ui.pinnedAt}, with the frame beside your words.`, action: 'Press Comment.', target: 'film-composer' };
    return { key: '8-file', title, text: 'Pause anywhere; your comment keeps the time and the frame.', action: 'Play it and pause near the chapter text, or start typing.', target: 'film-rail' };
  }
  // Step 9.
  if (state.also) return { key: '9-also', title: 'Also in your Inbox', text: '', items: TOUR_ALSO_ITEMS, next: true, nextLabel: 'Connect my agents', target: null };
  if (state.newArrived) return { key: '9-loop', title: 'That’s the loop', text: 'Agents ask, you answer when you can, and they keep going.', next: true, target: state.route === TOUR_NEW_THREAD ? 'arrival' : 'new-row' };
  if (state.compose === 'sent')
    return { key: state.newDelivered ? '9-delivered' : '9-sending', title: state.newDelivered ? 'Delivered.' : 'Sending…', text: 'It went into that session as its next turn.', wait: true, target: state.route === TOUR_NEW_THREAD ? 'delivered' : 'new-row' };
  if (state.compose === 'open')
    return ui.toChosen
      ? { key: '9-to', title: 'Start a thread yourself', text: 'The words are the developer’s real request; the thread names itself.', action: 'Press Send.', target: 'compose-send' }
      : { key: '9-open', title: 'Start a thread yourself', text: 'To starts empty, so you always choose who gets it.', action: 'Choose Claude Code.', target: 'compose-to' };
  return { key: '9', title: 'Start a thread yourself', text: 'New message writes to any agent session that is running, in any project.', action: 'Press New message.', target: 'compose-btn' };
}

/** The coach card as one sentence for the live region. */
export function tourCoachSpeech(coach: TourCoach, step: number): string {
  const items = coach.items?.map((i) => `${i.title} ${i.text}`).join(' ') ?? '';
  const action = coach.action ? (tourYourTurn(coach) ? ` Your turn: ${coach.action}` : ` ${coach.action}`) : '';
  return `Step ${step} of ${TOUR_STEPS}. ${coach.title}.${coach.text ? ` ${coach.text}` : ''}${items ? ` ${items}` : ''}${action}`;
}

// ─────────────────────────── What the window draws ───────────────────────────

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: TOUR_SESSION, name: null };
const PERSON = { kind: 'person' as const };

function threadOf(fixture: TourFixture, id: string): TourFixtureThread | undefined {
  return fixture.threads.find((t) => t.id === id);
}

/** The tour thread's question (the picture choices), as core's parser reads it. */
export function tourQuestion(fixture: TourFixture) {
  const asking = threadOf(fixture, TOUR_THREAD)?.messages.find((m) => m.asks);
  const [q] = parseInboxQuestionBlocks(asking?.body ?? '');
  return asking && q ? { message: asking, question: q } : null;
}

/** The warm-up question (step 2: plain text), as core's parser reads it. */
export function tourWarmQuestion(fixture: TourFixture) {
  const asking = threadOf(fixture, TOUR_THREAD)?.messages.find((m) => m.warmup);
  const [q] = parseInboxQuestionBlocks(asking?.body ?? '');
  return asking && q ? { message: asking, question: q } : null;
}

function wireQuestion(message: TourFixtureMessage, parsed: ReturnType<typeof parseInboxQuestionBlocks>[number], answer: QuestionAnswer | null, state: 'open' | 'picked' | 'sent', sentReply: string | null, at: string | null): InboxQuestion {
  return {
    key: parsed.key,
    position: parsed.position,
    kind: parsed.kind,
    prompt: parsed.prompt,
    context: parsed.parsed.context,
    choices: parsed.parsed.choices.map((c) => ({ label: c.label, description: c.description, recommended: c.recommended, settled: c.settled })) as InboxQuestion['choices'],
    recommendation: parsed.parsed.recommendation,
    suggested_text: parsed.parsed.suggested_text,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state,
    answer,
    revision: answer ? 1 : 0,
    sent_revision: state === 'sent' ? 1 : 0,
    picked_by: null,
    picked_at: at,
    sent_reply_id: sentReply,
    message_id: message.id,
    superseded_by: null,
  };
}

/** The answer the card shows for a label picked in the tour. */
export function tourAnswer(label: string, key: string, prompt: string): QuestionAnswer {
  return { v: 1, key, kind: 'single', prompt, selected: [label] };
}

/** The suggestion a tour file's comment box opens with. */
export function tourSuggestionFor(fixture: TourFixture, attachment: Pick<InboxAttachmentState, 'id' | 'message_id' | 'ref' | 'name'>): TourSuggestion | null {
  for (const thread of fixture.threads)
    for (const m of thread.messages) {
      if (m.id !== attachment.message_id) continue;
      if (attachment.ref !== undefined) return m.inline_images?.find((i) => i.ref === attachment.ref)?.suggest ?? null;
      return m.attachments?.find((_a, i) => tourAttachmentId(m.id, i) === attachment.id)?.suggest ?? null;
    }
  return null;
}

/** The fixture file a tour attachment is (its asset, poster, note). */
export function tourFileOf(fixture: TourFixture, attachmentId: string): TourFileRef | TourInlineImageRef | null {
  for (const thread of fixture.threads)
    for (const m of thread.messages) {
      const i = (m.attachments ?? []).findIndex((_, n) => tourAttachmentId(m.id, n) === attachmentId);
      if (i >= 0) return m.attachments![i]!;
      const img = m.inline_images?.find((x) => tourInlineImageId(x.ref) === attachmentId);
      if (img) return img;
    }
  return null;
}

/** A tour file's asset: what its URL loads. */
export function tourAssetOf(fixture: TourFixture, attachmentId: string): string | null {
  const ref = tourFileOf(fixture, attachmentId);
  if (!ref) return null;
  return 'asset' in ref ? ref.asset : ref.ref;
}

function attachmentState(message: TourFixtureMessage, file: TourFileRef | TourInlineImageRef, id: string, now: Date, inline: boolean): InboxAttachmentState {
  const sentAt = tourIso(message.time, now);
  return {
    id,
    path: tourPath(message.id, file.name),
    named_path: null,
    name: file.name,
    kind: (inline ? 'image' : (file as TourFileRef).kind) as InboxAttachmentState['kind'],
    sent_sha256: `tour-${id}`,
    size: file.size,
    sent_at: sentAt,
    sent_mtime: sentAt,
    ...(file.media_type ? { media_type: file.media_type } : {}),
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
    ...('duration_ms' in file && file.duration_ms ? { duration_ms: file.duration_ms } : {}),
    message_id: message.id,
    ...(inline ? { ref: (file as TourInlineImageRef).ref } : {}),
    // As it was sent: nothing in the tour changed since.
    current: { sha256: `tour-${id}`, size: file.size, mtime: sentAt },
    changed_since_sent: false,
    unavailable: null,
  };
}

/**
 * Every file of the tour (attachments, and the images messages show in their
 * text), as the window's attachments route answers them: current is what was
 * sent, nothing changed. Images in text come only once their message arrived.
 */
export function tourAttachments(fixture: TourFixture, state: TourState, now: Date = new Date()): InboxAttachmentState[] {
  const out: InboxAttachmentState[] = [];
  for (const thread of fixture.threads)
    for (const m of thread.messages) {
      if (!messageShown(thread, m, state)) continue;
      (m.attachments ?? []).forEach((a, i) => out.push(attachmentState(m, a, tourAttachmentId(m.id, i), now, false)));
      for (const img of m.inline_images ?? []) out.push(attachmentState(m, img, tourInlineImageId(img.ref), now, true));
    }
  return out;
}

function messageShown(thread: TourFixtureThread, m: TourFixtureMessage, state: TourState): boolean {
  if (m.after_warmup) return state.warmArrived;
  if (!m.replay) return true;
  if (thread.id === TOUR_THREAD) return state.arrived >= m.replay;
  if (thread.id === TOUR_FILM_THREAD) return state.filmArrived;
  if (thread.id === TOUR_NEW_THREAD) return state.newArrived;
  return false;
}

export interface TourMessageView {
  wire: InboxMessageWire;
  time: string;
  who: string;
  to: string;
  fixture: TourFixtureMessage | null;
  /** Part of a replay after Send: drawn under the replay divider, tagged Replay. */
  replay: boolean;
  /** The person's own replayed message (a reply, or the new thread's first). */
  reply: boolean;
}

function wireMessage(thread: TourFixtureThread, m: TourFixtureMessage, now: Date, questions: InboxQuestion[] | undefined, files: readonly InboxAttachmentState[]): InboxMessageWire {
  const mine = files.filter((a) => a.message_id === m.id);
  const attachments = mine.filter((a) => a.ref === undefined).map(({ message_id: _m, current: _c, changed_since_sent: _ch, unavailable: _u, ...rest }) => rest);
  const inline = mine.filter((a) => a.ref !== undefined).map(({ message_id: _m, current: _c, changed_since_sent: _ch, unavailable: _u, ...rest }) => rest as InboxInlineImage);
  return {
    id: m.id,
    project_id: TOUR_PROJECT_ID,
    thread_id: thread.id,
    reply_to: null,
    author: m.who === 'agent' ? AGENT : PERSON,
    subject: tourSubject(thread),
    body: m.body ?? '',
    created_at: tourIso(m.time, now),
    resolved_at: null,
    idempotency_key: null,
    thread_name: tourThreadName(thread),
    questions: questions ?? [],
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(inline.length > 0 ? { inline_images: inline } : {}),
  } as InboxMessageWire;
}

function personReply(thread: TourFixtureThread, id: string, replyTo: string, body: string, time: string, comments: number, now: Date): InboxMessageWire {
  return {
    id,
    project_id: TOUR_PROJECT_ID,
    thread_id: thread.id,
    reply_to: replyTo,
    author: PERSON,
    subject: tourSubject(thread),
    body,
    created_at: tourIso(time, now),
    resolved_at: null,
    idempotency_key: null,
    questions: [],
    ...(comments > 0 ? { sent_annotations: comments } : {}),
  } as InboxMessageWire;
}

/** A thread's subject: thread C's comes from its words, as compose names a thread the person starts. */
export function tourSubject(thread: TourFixtureThread): string {
  if (thread.person && thread.compose) return derivePersonThreadSubject(thread.compose.body) ?? thread.compose.body;
  return thread.subject;
}

/** A thread's chip: thread C's is compose's own suggestion for its words. */
export function tourThreadName(thread: TourFixtureThread): string | null {
  if (thread.person && thread.compose) return suggestPersonThreadName(thread.compose.body) || null;
  return thread.thread_name;
}

/** The messages a thread shows in this state, in order, each in the store's wire shape. */
export function tourMessages(fixture: TourFixture, threadId: string, state: TourState, now: Date = new Date()): TourMessageView[] {
  const thread = threadOf(fixture, threadId);
  if (!thread) return [];
  const files = tourAttachments(fixture, state, now);
  const developer = fixture.developer;
  const out: TourMessageView[] = [];
  if (thread.person && thread.compose) {
    if (state.compose !== 'sent') return [];
    const first = personReply(thread, TOUR_NEW_MESSAGE_ID, '', thread.compose.body, thread.compose.time, 0, now);
    out.push({ wire: { ...first, reply_to: null }, time: tourTime(thread.compose.time), who: 'You', to: 'to Claude Code', fixture: null, replay: false, reply: true });
  }
  for (const m of thread.messages) {
    if (!messageShown(thread, m, state)) continue;
    let questions: InboxQuestion[] | undefined;
    const parsed = m.body ? parseInboxQuestionBlocks(m.body) : [];
    if (parsed.length > 0 && thread.id === TOUR_THREAD && m.warmup) {
      const p = parsed[0]!;
      const answer = state.warmAnswer ? { ...state.warmAnswer, key: p.key, prompt: p.prompt } : state.warmPicked ? tourAnswer(state.warmPicked, p.key, p.prompt) : null;
      questions = [wireQuestion(m, p, answer, state.warmSent ? 'sent' : answer ? 'picked' : 'open', state.warmSent ? TOUR_WARM_REPLY_ID : null, answer ? tourIso(thread.warmup_reply_time ?? '11:49', now) : null)];
    } else if (parsed.length > 0 && thread.id === TOUR_THREAD) {
      const p = parsed[0]!;
      const answer = state.answer ? { ...state.answer, key: p.key, prompt: p.prompt } : state.picked ? tourAnswer(state.picked, p.key, p.prompt) : null;
      questions = [wireQuestion(m, p, answer, state.sent ? 'sent' : answer ? 'picked' : 'open', state.sent ? TOUR_REPLY_ID : null, answer ? tourIso(thread.reply_time ?? '12:17', now) : null)];
    }
    const who = m.who === 'agent' ? 'Claude Code' : developer;
    const replayed = !!m.replay || !!m.after_warmup;
    const to = m.who === 'agent' ? `to ${replayed || thread.id !== TOUR_THREAD ? 'you' : developer}` : 'to Claude Code';
    out.push({ wire: wireMessage(thread, m, now, questions, files), time: tourTime(m.time), who, to, fixture: m, replay: replayed, reply: false });
    // The warm-up's reply follows its question.
    if (thread.id === TOUR_THREAD && m.warmup && state.warmSent && state.warmPicked) {
      const body = state.warmPicked === TOUR_SKIPPED ? 'Skipped 1 question.' : 'Answered 1 question.';
      out.push({ wire: personReply(thread, TOUR_WARM_REPLY_ID, m.id, body, thread.warmup_reply_time ?? '11:49', 0, now), time: tourTime(thread.warmup_reply_time ?? '11:49'), who: 'You', to: 'to Claude Code', fixture: null, replay: false, reply: true });
    }
    // The person's replayed reply follows what it answers.
    if (thread.id === TOUR_THREAD && m.asks && state.sent && state.picked) {
      const n = state.comments.filter((r) => r.sent_reply_id === TOUR_REPLY_ID).length;
      const body = state.picked === TOUR_SKIPPED ? 'Skipped 1 question.' : 'Answered 1 question.';
      out.push({ wire: personReply(thread, TOUR_REPLY_ID, m.id, body, thread.reply_time ?? '12:17', n, now), time: tourTime(thread.reply_time ?? '12:17'), who: 'You', to: 'to Claude Code', fixture: null, replay: false, reply: true });
    }
    if (thread.id === TOUR_FILM_THREAD && !m.replay && state.filmSent) {
      const n = state.comments.filter((r) => r.sent_reply_id === TOUR_FILM_REPLY_ID).length;
      out.push({ wire: personReply(thread, TOUR_FILM_REPLY_ID, m.id, '', thread.reply_time ?? '18:10', n, now), time: tourTime(thread.reply_time ?? '18:10'), who: 'You', to: 'to Claude Code', fixture: null, replay: false, reply: true });
    }
  }
  return out;
}

function row(fixture: TourFixture, thread: TourFixtureThread, state: TourState, section: InboxSectionId, now: Date): InboxListRow {
  const views = tourMessages(fixture, thread.id, state, now);
  const first = views[0];
  const last = views[views.length - 1];
  const isA = thread.id === TOUR_THREAD;
  // Thread A asks twice: the warm-up until its Send, then (once the answer arrived) the picture question until its Send.
  const warmAsks = isA && !state.warmSent;
  const asks = warmAsks || (isA && state.warmArrived && !state.sent);
  const opened = state.route === thread.id;
  const looked = isA ? state.looked.a : thread.id === TOUR_FILM_THREAD ? state.looked.film : state.looked.new;
  const unread = section === 'waiting' || (section === 'new' && !opened && !looked);
  const lastPerson = last?.reply === true;
  const unsentHere = state.comments.filter((r) => r.thread_id === thread.id && r.sent_reply_id === null).length;
  const pickWaiting = warmAsks ? !!state.warmPicked : asks && !!state.picked;
  return {
    thread_id: thread.id,
    project_id: TOUR_PROJECT_ID,
    project: { id: TOUR_PROJECT_ID, name: fixture.project },
    subject: tourSubject(thread),
    thread_name: tourThreadName(thread),
    author: thread.person ? PERSON : AGENT,
    created_at: first?.wire.created_at ?? tourIso('12:00', now),
    last_at: last?.wire.created_at ?? tourIso('12:00', now),
    last_author: lastPerson ? 'person' : 'agent',
    message_count: views.length,
    resolved_at: null,
    questions: { open: asks && !pickWaiting ? 1 : 0, picked: pickWaiting ? 1 : 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: section === 'waiting',
    section,
    unread,
    answered_not_sent: pickWaiting,
    unsent: pickWaiting || unsentHere > 0 ? { reply_at: null, picks: pickWaiting ? 1 : 0, comments: unsentHere } : null,
    waiting_since: null,
    unseen: unread ? 1 : 0,
    sent: section === 'sent' ? { at: last?.wire.created_at ?? tourIso('12:00', now), checked_at: null } : null,
    guide: false,
    ...(thread.person ? { addressee: { host: 'claude-code', session: TOUR_SESSION } } : {}),
  } as InboxListRow;
}

/** The tour Inbox's list in this state: A, B (the film) and, once the person sent it, C. */
export function tourSections(fixture: TourFixture, state: TourState, now: Date = new Date()): InboxListSection[] {
  const placed: Partial<Record<InboxSectionId, InboxListRow[]>> = {};
  const add = (section: InboxSectionId, r: InboxListRow) => (placed[section] ??= []).push(r);
  const a = threadOf(fixture, TOUR_THREAD);
  const film = threadOf(fixture, TOUR_FILM_THREAD);
  const c = threadOf(fixture, TOUR_NEW_THREAD);
  if (c && state.compose === 'sent') add(state.newArrived ? 'new' : 'sent', row(fixture, c, state, state.newArrived ? 'new' : 'sent', now));
  if (film) {
    const section: InboxSectionId = state.filmSent && !state.filmArrived ? 'sent' : 'new';
    add(section, row(fixture, film, state, section, now));
  }
  if (a) {
    const section: InboxSectionId = state.sent ? (state.arrived > 0 ? 'new' : 'sent') : state.warmSent && !state.warmArrived ? 'sent' : 'waiting';
    add(section, row(fixture, a, state, section, now));
  }
  return INBOX_SECTIONS.map((s) => ({ id: s.id, label: s.label, threads: placed[s.id] ?? [] }));
}

/** The sidebar's count for the tour project: threads waiting on the person. */
export function tourWaitingCount(state: TourState): number {
  return state.sent || (state.warmSent && !state.warmArrived) ? 0 : 1;
}

export { tourAssetUrl };

/**
 * The larger picture the viewer shows for a tile's thumbnail (the fixture's `full` map), else the thumbnail
 * itself: also when the larger one is not in memory and the thumbnail is.
 */
export function tourFullPicture(fixture: TourFixture, name: string): string {
  const full = fixture.full[name];
  if (!full) return name;
  return !tourAssetLoaded(full) && tourAssetLoaded(name) ? name : full;
}
