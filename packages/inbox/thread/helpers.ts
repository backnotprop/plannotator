/** The thread pane's plain helpers: its constants, the fold's state, the words of its moments, and who a Send reaches. */
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxMessageWire, InboxQuestion, InboxThread, InboxUpload } from '@plannotator/core/inbox-types';
import { capQuestionPrompt, emptyQuestionAnswer, indexQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import { inboxAskingMessage, type InboxAnnotationRecord, type InboxQuestionState } from '@plannotator/core/inbox-types';
import type { OutboxView } from '../api';
import { annotationOf } from '../attachments';
import { agentName, clockTime, dayWords } from '../format';
import { PILL_BAND_PX, atEnd } from '../seenOnSight';
import type { AskingSession } from '../components/ReplyRoute';
import type { SentAnswerGroup } from '../sentReply';
import { routeSendAnnotations, sendTargetsOf } from '../sendTargets';

export const noop = () => {};
export const NO_ANNOTATIONS: never[] = [];
export const NO_IDS: ReadonlySet<string> = new Set();
/** The reply box starts with no files: they come only from a paste (compose's tiles and upload path). */
export const NO_UPLOADS: InboxUpload[] = [];
export const NO_OUTBOX: readonly OutboxView[] = [];

/** The fold state of one open thread: in memory only, decided once when the thread opens. */
export interface FoldState {
  threadId: string;
  /** Messages shown as one line. A message that arrives later is not in it, so it shows open. */
  folded: Set<string>;
  /** The middle of each long read run ("N earlier messages"), by run. */
  hidden: string[][];
  /**
   * How many of each run's messages show, counted from its newest end: a step of "Show 20 earlier" adds
   * FOLD_STEP, "Show all" the rest (approval "inbox-thread-fold-steps").
   */
  shown: number[];
  /** The messages the last step brought in: they fade in once (`data-fold-new`). */
  stepped: ReadonlySet<string>;
}

/** Messages one step of the middle fold brings in, just above the newer ones (approval "inbox-thread-fold-steps"). */
export const FOLD_STEP = 20;
/** The part of a run still behind its fold: its oldest messages, all but the `shown` newest. */
export const stillHidden = (ids: readonly string[], shown = 0): readonly string[] => (shown >= ids.length ? [] : ids.slice(0, ids.length - shown));

/** "Today, 9:12 AM": a moment in the thread's meta line. */
export function momentWords(iso: string): string {
  const day = dayWords(iso);
  return day ? `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${clockTime(iso)}` : '';
}

/** "Today, 9:12 AM to 5:48 PM", both days when they differ, one moment when the times are the same. */
export function spanWords(from: string, to: string): string {
  if (dayWords(from) === dayWords(to)) return clockTime(from) === clockTime(to) ? momentWords(from) : `${momentWords(from)} to ${clockTime(to)}`;
  return `${momentWords(from)} to ${momentWords(to)}`;
}

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * What the "↓ N new" pill counts and goes to, in thread order, of the
 * messages whose top is below the view (under the pill's band): the arrivals
 * not yet seen on sight (`data-arrival`, design record
 * "inbox-new-in-open-thread": the pill counts only unseen arrivals below);
 * only when none waits there, the messages that were new when the thread
 * opened (`data-new`). An arrival already seen (`data-sighted`) never counts,
 * and neither does a message the person has had on screen this visit
 * (`passed`): once its top was in the view, or the view went past it, it is
 * read as far as the pill is concerned, so scrolling back up never brings it
 * back. `mark` (the tab visible and nothing over the thread) adds what is on
 * screen now to `passed`; scrolled to the end, everything is on screen.
 */
export function newBelow(body: HTMLElement, passed: Set<string>, mark: boolean): HTMLElement[] {
  const bottom = body.getBoundingClientRect().bottom - PILL_BAND_PX;
  const end = mark && body.scrollHeight > 0 && atEnd(body);
  const below = (selector: string) =>
    [...body.querySelectorAll<HTMLElement>(selector)].filter((a) => {
      const id = a.getAttribute('data-message-article') ?? '';
      if (passed.has(id)) return false;
      if (end || a.getBoundingClientRect().top <= bottom) {
        if (mark) passed.add(id);
        return false;
      }
      return true;
    });
  const arrivals = below('[data-message-article][data-arrival]:not([data-sighted])');
  const atOpen = below('[data-message-article][data-new]:not([data-arrival]):not([data-sighted])');
  return arrivals.length > 0 ? arrivals : atOpen;
}

/** A wire message's question states, for the shared asking rule. */
export const questionStatesOf = (message: InboxMessageWire): InboxQuestionState[] => (message.questions ?? []).map((q) => q.state);

/**
 * A question's empty answer as its card builds it (ui's QuestionBlock:
 * `emptyQuestionAnswer` of the question Viewer indexes from the same body),
 * so a Skip from the open-questions list saves what the card's Skip saves.
 */
export function emptyAnswerFor(message: InboxMessageWire, q: { key: string; prompt: string; question: InboxQuestion }): QuestionAnswer {
  const indexed = indexQuestionBlocks(parseMarkdownToBlocks(message.body, { frontmatter: false }), { decisionLines: false }).find(
    (i) => i.question.key === q.key,
  );
  if (indexed) return emptyQuestionAnswer(indexed);
  const kind = q.question.kind === 'multi' || q.question.kind === 'text' ? q.question.kind : 'single';
  return { v: 1, key: q.key, kind, prompt: capQuestionPrompt(q.prompt), selected: [] };
}

/**
 * The session a Send reaches, when its message names one: the last target's
 * when words or annotations ride on it (`carries`; the latest agent message,
 * or the last pick or skip when the same session wrote both), otherwise the
 * last message a pick or a skip answers (a message that only would have
 * carried words receives nothing, so its session is not asked about). With
 * nothing to send, the latest agent message's.
 */
export function askingSessionOf(thread: InboxThread, options: { skip: ReadonlySet<string>; carries: boolean }): AskingSession | null {
  // Nothing rides on the latest message: the shared rule the list row's delivery uses too (core
  // inbox-delivery), plus the questions the person chose to skip, when any.
  const message = options.carries
    ? sendTargetsOf(thread, options.skip).at(-1)!.message
    : (lastSkipOrPick(thread, options.skip) ?? inboxAskingMessage(thread.messages, questionStatesOf, false));
  if (!message) return null;
  if (message.author.kind !== 'agent' || !message.author.session) return null;
  return { message, session: message.author.session, host: message.author.host ?? '', name: agentName(message.author) };
}

/** The last agent message a pick or a chosen skip answers (null when the person chose no skip: the shared rule decides). */
export function lastSkipOrPick(thread: InboxThread, skip: ReadonlySet<string>): InboxMessageWire | null {
  if (skip.size === 0) return null;
  let found: InboxMessageWire | null = null;
  for (const m of thread.messages) {
    if (m.author.kind !== 'agent') continue;
    if ((m.questions ?? []).some((q) => q.state === 'picked' || (q.state === 'open' && skip.has(`${m.id}/${q.key}`)))) found = m;
  }
  return found;
}

/**
 * The other sessions a Send reaches besides the words' (`words`, askingSessionOf): a pick, a skip, an action item
 * or a comment on another session's message rides a reply to that session (sendTargetsOf, routeSendAnnotations).
 * Only those whose message came through a waking connection, which can end (askerCanEnd); each once.
 */
export function otherSendSessions(
  thread: InboxThread,
  options: { skip: ReadonlySet<string>; carries: boolean; records: readonly InboxAnnotationRecord[] },
  words: AskingSession | null,
): AskingSession[] {
  const plain = sendTargetsOf(thread, options.skip).filter(
    (t, index, all) => t.questions.length > 0 || t.skip.length > 0 || t.actions.length > 0 || (options.carries && index === all.length - 1),
  );
  const out: AskingSession[] = [];
  for (const { message } of routeSendAnnotations(thread, plain, options.records).targets) {
    if (message.author.kind !== 'agent' || !message.author.session || message.wakes !== true) continue;
    const session = message.author.session;
    if (session === words?.session || out.some((s) => s.session === session)) continue;
    out.push({ message, session, host: message.author.host ?? '', name: agentName(message.author) });
  }
  return out;
}

/**
 * A second agent in a thread (handoff "multi-agent-thread-model", option A): an agent message from another
 * session than the thread's first agent (`first`: the root's author, or the session a thread the person started
 * is addressed to). A reply to it goes to that session, so the window names it, not the first agent.
 */
export function isOtherAgent(message: InboxMessageWire | null | undefined, first: { host?: string | null; session?: string | null } | null): boolean {
  if (message?.author.kind !== 'agent' || !first) return false;
  return (message.author.session ?? null) !== (first.session ?? null) || (message.author.host ?? null) !== (first.host ?? null);
}

/** The key a reply of a Send keeps across retries: one per session (a message with no session is its own). */
export function replyKeyOf(message: InboxMessageWire): string {
  return message.author.kind === 'agent' && message.author.session ? `s:${message.author.host ?? ''}\u0000${message.author.session}` : `m:${message.id}`;
}

/** The sessions a comment tags with `@` (ui's `Annotation.mentions`): a tag there sends the whole reply to them. */
export function commentTags(record: InboxAnnotationRecord): string[] {
  const mentions = annotationOf(record)?.mentions;
  return Array.isArray(mentions) ? mentions.filter((id): id is string => typeof id === 'string') : [];
}

export const NO_SENT_ANSWERS: readonly SentAnswerGroup[] = [];
