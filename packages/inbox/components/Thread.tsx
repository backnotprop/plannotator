import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxDecision, InboxDecisionDraft, InboxListRow, InboxMessageWire, InboxProjectRepo, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionAnswer, QuestionStatus } from '@plannotator/core/question-block';
import { inboxDecisionWords } from '@plannotator/core/inbox-questions';
import { isInboxTextKind, readInboxAttachmentKind, type InboxAnnotationRecord, type InboxAttachment, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { NOT_ATTACHED_TITLE, attachmentDeepLink, attachmentDisplayPath, attachmentForLink, openAttachmentTitle, useRefRepo } from '../links';
import { InboxApiError, inboxApi, type AttachmentsModel } from '../api';
import { annotationOf, attachmentFeedback } from '../attachments';
import { AttachmentTiles, AttachmentsCount, changedCount } from './AttachmentTiles';
import { AttachmentPane, type AttachmentPaneHandle } from './AttachmentPane';
import { attachmentSequence } from '../stepping';
import { AnnotationsChip } from './AnnotationsChip';
import { agentName, clockTime, dayWords, fullTime, plural, whenTime } from '../format';
import { titleIfClipped } from '../clipTitle';
import { answerWords, foldSnippet, holdingsOf, isDelivered, isPersonReply, lastNonNote, lookBoundary, newSinceLook, planFolds, snippetText, type FoldSnippet, type Holding } from '../folding';
import { AuthorMark, DecisionDiamond, Icon } from '../icons';
import { PILL_BAND_PX, atEnd, followBy, lookThrough, measureFirstLines, unseenArrivals, useSeenOnSight } from '../seenOnSight';
import { DecisionCard } from './DecisionCard';
import { GuideCard } from './GuideCard';
import { inboxMessageImageBase, markTallImage } from '../images';
import { reportUnsentReply } from '../unsent';
import { canToggleRead } from '../markRead';
import { NewMessageButton, NewMessageComposer, NewMessagePopover, hostName, useLiveSessions, type NewMessageMode } from './NewMessage';
import {
  AskerEndedNote,
  CLOSED_ROUTE,
  LEAVE,
  RouteChoice,
  SessionEndedMark,
  askerCanEnd,
  askerHasEnded,
  isRedirected,
  mergeRouteRows,
  othersLive,
  redirectedName,
  routeRace,
  type AskingSession,
  type RouteState,
} from './ReplyRoute';
import { ChangedNotice, ReplacedQuestionCard, ReplacesLine, StaleGuard, replacedBy, replacementOf, type JumpTarget } from './ReplacedQuestion';

const noop = () => {};
/** The agent superseded the question this call named (`422 question_superseded`). */
const isSuperseded = (cause: unknown): boolean => cause instanceof InboxApiError && cause.code === 'question_superseded';
const NO_ANNOTATIONS: never[] = [];
/** An unsent pick's tag on its card (MessageBody's statusLabel). */
const NOT_SENT_STATUS = { label: 'Not sent', tone: 'open' } as const;
const NO_IDS: ReadonlySet<string> = new Set();

/** The fold state of one open thread: in memory only, decided once when the thread opens. */
interface FoldState {
  threadId: string;
  /** Messages shown as one line. A message that arrives later is not in it, so it shows open. */
  folded: Set<string>;
  /** The middle of each long read run ("N earlier messages"), by run. */
  hidden: string[][];
  /** The runs whose "N earlier messages" was opened. */
  revealed: Set<number>;
}

/** "Today, 9:12 AM": a moment in the thread's meta line. */
function momentWords(iso: string): string {
  const day = dayWords(iso);
  return day ? `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${clockTime(iso)}` : '';
}

/** "Today, 9:12 AM to 5:48 PM", both days when they differ, one moment when the times are the same. */
function spanWords(from: string, to: string): string {
  if (dayWords(from) === dayWords(to)) return clockTime(from) === clockTime(to) ? momentWords(from) : `${momentWords(from)} to ${clockTime(to)}`;
  return `${momentWords(from)} to ${momentWords(to)}`;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * What the "↓ N new" pill counts and goes to, in thread order, of the
 * messages whose top is below the view (under the pill's band): the arrivals
 * not yet seen on sight (`data-arrival`, design record
 * "inbox-new-in-open-thread": the pill counts only unseen arrivals below);
 * only when none waits there, the messages that were new when the thread
 * opened (`data-new`). An arrival already seen (`data-sighted`) never counts.
 */
function newBelow(body: HTMLElement): HTMLElement[] {
  const bottom = body.getBoundingClientRect().bottom - PILL_BAND_PX;
  const below = (selector: string) => [...body.querySelectorAll<HTMLElement>(selector)].filter((a) => a.getBoundingClientRect().top > bottom);
  const arrivals = below('[data-message-article][data-arrival]:not([data-sighted])');
  return arrivals.length > 0 ? arrivals : below('[data-message-article][data-new]:not([data-arrival]):not([data-sighted])');
}

/** A folded line's snippet: the message's first words, or the person's answers. */
function SnippetText({ snippet }: { snippet: FoldSnippet }) {
  if (snippet.kind === 'words') return <>{snippet.text}</>;
  return (
    <>
      {snippet.parts.map((part, index) => (
        <span key={index} className="ib-fl-ans">
          {index > 0 && <span className="ib-fl-sep"> · </span>}
          {part.prompt} <span className="ib-fl-arr">→</span> <b>{part.answer}</b>
        </span>
      ))}
    </>
  );
}

/** What a folded line says a message holds. */
function HoldingChips({ holdings }: { holdings: Holding[] }) {
  if (holdings.length === 0) return <span className="ib-fl-chips" />;
  return (
    <span className="ib-fl-chips" data-holdings="">
      {holdings.map((h) => (
        <span key={h.kind} className={`ib-fl-chip${h.kind === 'open' ? ' ib-fl-open' : h.kind === 'picks' ? ' ib-fl-pick' : ''}`} data-holding={h.kind}>
          {h.kind === 'answered' || h.kind === 'delivered' ? <Icon name="check" size={14} /> : null}
          {h.kind === 'files' ? <Icon name="clip" size={14} /> : null}
          {h.kind === 'annotations' ? <Icon name="doc" size={14} /> : null}
          {h.kind === 'guide' ? <Icon name="book" size={14} /> : null}
          {h.text}
        </span>
      ))}
    </span>
  );
}

/**
 * The agent messages a Send answers, in thread order: each one with picks
 * waiting, and (`skip`, unless Keep open) each with questions left open,
 * which the Send skips on the reply to that message. The person's words
 * (which ride the last reply) go to the agent that wrote most recently,
 * never to an older asker: when the latest agent message comes from another
 * session than the last pick or skip answers, it comes last, with no picks
 * of its own; when the same session wrote both, the words ride the last
 * pick or skip, so one Send is one reply to that session.
 */
export function sendTargetsOf(
  thread: InboxThread,
  skip = true,
): { message: InboxMessageWire; questions: { key: string; revision: number }[]; skips: boolean }[] {
  const targets = thread.messages
    .filter((m) => m.author.kind === 'agent' && (m.questions ?? []).some((q) => q.state === 'picked' || (skip && q.state === 'open')))
    .map((m) => ({
      message: m,
      questions: (m.questions ?? []).filter((q) => q.state === 'picked').map((q) => ({ key: q.key, revision: q.revision })),
      skips: skip && (m.questions ?? []).some((q) => q.state === 'open'),
    }));
  const latest = thread.messages.filter((m) => m.author.kind === 'agent').at(-1) ?? thread.messages[0]!;
  const last = targets.at(-1)?.message;
  if (!last || (last.id !== latest.id && !sameSession(last, latest))) targets.push({ message: latest, questions: [], skips: false });
  return targets;
}

/** The skip chip's state: the default, or the person's choice for this Send. */
export type SkipChoice = 'auto' | 'skip' | 'keep';

/**
 * Whether a Send skips the questions it leaves unanswered. By default only
 * when it answers at least one question: a reply of words (or annotations)
 * alone leaves them all open. The chip's choice wins either way.
 */
export function skipsUnanswered(choice: SkipChoice, answersAny: boolean): boolean {
  return choice === 'skip' || (choice === 'auto' && answersAny);
}

/**
 * Whether a Send now would carry at least one answer: a saved pick not yet
 * sent, or one being saved (`pending`, keyed `<message id>/<key>`; null is a
 * pick being cleared).
 */
export function sendAnswersAny(thread: InboxThread, pending: ReadonlyMap<string, QuestionAnswer | null> = new Map()): boolean {
  for (const m of thread.messages) {
    if (m.author.kind !== 'agent') continue;
    for (const q of m.questions ?? []) {
      const id = `${m.id}/${q.key}`;
      if (pending.has(id)) {
        if (pending.get(id) !== null && (q.state === 'open' || q.state === 'picked')) return true;
      } else if (q.state === 'picked') {
        return true;
      }
    }
  }
  return false;
}

/** Two agent messages one session wrote (a message with no session matches none). */
function sameSession(a: InboxMessageWire, b: InboxMessageWire): boolean {
  if (a.author.kind !== 'agent' || b.author.kind !== 'agent') return false;
  return !!a.author.session && a.author.session === b.author.session && (a.author.host ?? '') === (b.author.host ?? '');
}

/**
 * The session a Send reaches, when its message names one: the last target's
 * when words or annotations ride on it (`carries`; the latest agent message,
 * or the last pick or skip when the same session wrote both), otherwise the
 * last message a pick or a skip answers (a message that only would have
 * carried words receives nothing, so its session is not asked about). With
 * nothing to send, the latest agent message's.
 */
function askingSessionOf(thread: InboxThread, options: { skip: boolean; carries: boolean }): AskingSession | null {
  const targets = sendTargetsOf(thread, options.skip);
  const sending = targets.filter((t) => t.questions.length > 0 || t.skips);
  const message = (options.carries ? targets.at(-1) : (sending.at(-1) ?? targets.at(-1)))!.message;
  if (message.author.kind !== 'agent' || !message.author.session) return null;
  return { message, session: message.author.session, host: message.author.host ?? '', name: agentName(message.author) };
}

/** One message's text, with its question cards (exported for its DOM test). */
export function MessageBody({
  message,
  projectRoot,
  repo,
  onOpenAttachment,
  readOnly,
  answers,
  onPick,
  footerFor,
  recordingOf,
  onToggleDecision,
  onOpenDecision,
  renderReplacedCard,
  renderReplacesLine,
}: {
  message: InboxMessageWire;
  /** The thread's project root: relative links start there or at the message's own folder. */
  projectRoot: string;
  /** The project's git `origin` (the thread payload's `project.repo`): bare `#123` refs link into it. */
  repo?: InboxProjectRepo | null;
  /** A link in the body to one of this message's attachments was followed. */
  onOpenAttachment: (attachment: InboxAttachment) => void;
  readOnly: boolean;
  answers: ReadonlyMap<string, QuestionAnswer>;
  onPick: (key: string, answer: QuestionAnswer | null) => void;
  footerFor: (key: string) => string | null;
  /** The switch's state per question key (the stored one, or a click not yet saved). */
  recordingOf: (key: string) => boolean | undefined;
  onToggleDecision: (key: string, next: boolean) => void;
  onOpenDecision: (key: string, anchor: HTMLElement) => void;
  /** A superseded question's card in place of its answer card (the question's key and number), or undefined to keep it. */
  renderReplacedCard?: (key: string, number: number) => React.ReactNode | undefined;
  /** The "Replaces …" line under a question's prompt, or null. */
  renderReplacesLine?: (key: string) => React.ReactNode;
}) {
  const blocks = useMemo(() => parseMarkdownToBlocks(message.body, { frontmatter: false }), [message.body]);
  const refRepo = useRefRepo(repo);
  // A tall screenshot in the body shows its top, cropped like the gallery's
  // (inbox.css); a click still opens it whole.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) markTallImage(event.target);
    };
    for (const img of body.querySelectorAll('img')) if (img.complete) markTallImage(img);
    // Load does not bubble: a capture listener on the body hears every image in it.
    body.addEventListener('load', onLoad, true);
    return () => body.removeEventListener('load', onLoad, true);
  }, []);
  // A link to a file this message attached opens it beside the thread; any
  // other local link is inert text (links.ts). Kept stable across renders,
  // so raw-HTML blocks do not redraw their links on every pick.
  const openRef = useRef(onOpenAttachment);
  openRef.current = onOpenAttachment;
  const resolveLocalLink = useCallback<LocalLinkResolver>(
    (href) => {
      const attachment = attachmentForLink(href, { attachments: message.attachments ?? [], root: projectRoot, base: message.base_path ?? null });
      if (!attachment) return { kind: 'unavailable', title: NOT_ATTACHED_TITLE };
      return {
        kind: 'open',
        title: openAttachmentTitle(attachmentDisplayPath(attachment, projectRoot)),
        href: attachmentDeepLink(message.thread_id, attachment.id),
        open: () => openRef.current(attachment),
      };
    },
    [message.attachments, message.base_path, message.thread_id, projectRoot],
  );
  const renderFooter = useCallback(
    (question: IndexedQuestion) => {
      const text = footerFor(question.question.key);
      return text ? <span className="ib-qfoot-st">{text}</span> : null;
    },
    [footerFor],
  );
  // Every question carries the tag (the record's 3.1): its switch is kept on
  // the question record (on by default where the block says `Decision: when
  // answered`, off elsewhere); a linked decision (`Decision: [statement](url)`)
  // is already recorded and keeps its own tag.
  const recording = useCallback(
    (question: IndexedQuestion) => (question.question.decision ? undefined : recordingOf(question.question.key)),
    [recordingOf],
  );
  // Replaced questions: the host's Quiet card in place of the answer card, and
  // the newer card's "Replaces …" line. Kept stable across renders.
  const replacedRef = useRef(renderReplacedCard);
  replacedRef.current = renderReplacedCard;
  const replacesRef = useRef(renderReplacesLine);
  replacesRef.current = renderReplacesLine;
  const questionCard = useCallback(
    (question: IndexedQuestion) => replacedRef.current?.(question.question.key, question.number),
    // A new identity when the questions change, so a card that was just replaced redraws.
    [message.questions],
  );
  const belowPrompt = useCallback(
    (question: IndexedQuestion) => replacesRef.current?.(question.question.key) ?? null,
    [message.questions],
  );

  // Read-only per question: a sent answer's tag is a plain tag while an open
  // question in the same message keeps its switch and card.
  const locked = useCallback(
    (question: IndexedQuestion) => {
      const wire = message.questions?.find((q) => q.key === question.question.key);
      return wire !== undefined && (wire.state === 'sent' || wire.decision_id !== null);
    },
    [message.questions],
  );

  // A pick not sent yet tags its card "Not sent", not "Answered" (the footer says when it was picked);
  // a sent answer, and a question a Mark read closed, keep the card's own tag.
  const statusLabel = useCallback(
    (question: IndexedQuestion, status: QuestionStatus) => {
      if (status !== 'answered' && status !== 'skipped') return undefined;
      const wire = message.questions?.find((q) => q.key === question.question.key);
      return wire && (wire.state === 'open' || wire.state === 'picked') ? NOT_SENT_STATUS : undefined;
    },
    [message.questions],
  );

  return (
    <div className="ib-body" data-message-id={message.id} ref={bodyRef}>
      <Viewer
        blocks={blocks}
        markdown={message.body}
        annotations={NO_ANNOTATIONS}
        onAddAnnotation={noop}
        onSelectAnnotation={noop}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        imageBaseDir={inboxMessageImageBase(message.id)}
        resolveLocalLink={resolveLocalLink}
        refRepo={refRepo}
        answerOnly
        readOnly={readOnly}
        questionAnswers={answers}
        onAnswerQuestion={(_blockId, answer, key) => onPick(key, answer)}
        renderQuestionFooter={renderFooter}
        questionDecisionScope="any"
        questionDecisionRecording={recording}
        onToggleQuestionDecisionRecording={onToggleDecision}
        onOpenQuestionDecision={onOpenDecision}
        questionDecisionLocked={locked}
        questionStatusLabel={statusLabel}
        renderQuestionCard={renderReplacedCard ? questionCard : undefined}
        renderQuestionBelowPrompt={renderReplacesLine ? belowPrompt : undefined}
      />
    </div>
  );
}

export interface ThreadPaneProps {
  thread: InboxThread;
  /**
   * The thread's list row's `sent`: the person's reply is the last message
   * (the Inbox's own notes read past), and when the agent read it (by the
   * store's seq, so a reply the agent was not given still reads as unread),
   * or null.
   */
  sent: { at: string; checked_at: string | null } | null;
  /** The thread's questions changed through a pick (the response's questions for that message). */
  onQuestions: (messageId: string, questions: InboxQuestion[]) => void;
  /** Something was written (a Send, resolve): read the thread and the list again. */
  onChanged: () => Promise<void>;
  onClose: () => void;
  /** The decisions this thread's questions recorded (the "Settled: ..." lines). */
  decisions: readonly InboxDecision[];
  /** Open a recorded decision on the Decisions page. */
  onOpenDecisionPage: (decision: InboxDecision) => void;
  /** The attachment open beside the thread (`#…&file=att_…`), its version, and an annotation to show. */
  file: { id: string; version: 'current' | 'sent'; focus: string | null } | null;
  /** `replace`: swap the history entry (stepping between files), so Back returns to the thread in one press. */
  onOpenFile: (file: { id: string; version: 'current' | 'sent'; focus: string | null } | null, options?: { replace?: boolean }) => void;
  /** Open the guided review a message carries (the record's 4.2). */
  onOpenGuide: (messageId: string) => void;
  /**
   * Where "new since you looked" starts (folding.ts `lookBoundary`), read
   * from the thread BEFORE the window recorded this look and kept until the
   * person leaves the thread. The window takes it from its own first read,
   * which lands before it records the look. Absent: the pane takes it from
   * the first thread it is given.
   */
  lookSeq?: number | null;
  /**
   * Seen on sight (design record "inbox-new-in-open-thread", approved
   * 2026-10-12): the seq the window's looks this visit covered (the look
   * recorded when the thread opened, raised as arrivals are seen). An agent
   * message after it arrived while the thread was open; once its first lines
   * have been on screen for a second (window in front, nothing over the
   * thread) the pane calls `onSeen` with the seq the look may now cover.
   * Null: the thread carries no seqs (an older Inbox). Absent `onSeen`: off.
   */
  seenThrough?: number | null;
  onSeen?: (throughSeq: number) => void;
  /** Something over the thread from outside the pane (a guided review, a dialog): nothing counts as seen. */
  covered?: boolean;
  /** The thread's list row as it is now: Mark read's state and whether it is offered. Null until the list has it. */
  row?: InboxListRow | null;
  /** Mark read, or move it back (the pressed button). Absent: no Mark read button. */
  onMarkRead?: (read: boolean) => void;
  /** Archive (`true`) or Unarchive. Absent: the pane calls the resolve route itself. */
  onArchive?: (archived: boolean) => void;
  /** The thread whose reply box should open (the warning toast's Reply); the pane calls `onReplyOpened` once it has. */
  replyRequest?: string | null;
  onReplyOpened?: () => void;
  /** On a phone the header leads with a Back button named for the screen under the thread ("Inbox", a project). */
  backLabel?: string;
  /** A phone: one screen at a time, so an open file takes the whole window (phone.ts). */
  phone?: boolean;
  /**
   * A window too narrow for the list beside the thread (stack.ts): the thread
   * covers the list, and its header leads with the way back to it.
   */
  stacked?: boolean;
  /** A window too narrow for a file beside the thread (stack.ts): an open file takes the whole window. */
  fileStacked?: boolean;
  /**
   * A file open beside the thread on a desktop hides the list and the
   * sidebar: the header then leads with `‹ Inbox` (`backLabel`), which closes
   * the file (through the pane's unsaved-comment question, as the file's ×
   * does) and calls this with the file's name, so the window can bring the
   * list back and put focus on this thread's row. Absent: no such button.
   */
  onBackToList?: (fileName: string | null) => void;
}

/** The thread's attachments as they are now and the annotations waiting for a Send, kept fresh. */
function useThreadAttachments(threadId: string, revision: unknown) {
  const [model, setModel] = useState<AttachmentsModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.attachments(threadId);
      setModel((current) => (current === null || current.serverSession === next.serverSession ? next : current));
    } catch {
      // The thread went away; the pane closes with it.
    }
  }, [threadId]);
  useEffect(() => {
    setModel(null);
  }, [threadId]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  // A file edited on disk shows as changed when the person comes back to the window.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);
  const patch = useCallback((update: (records: InboxAnnotationRecord[]) => InboxAnnotationRecord[]) => {
    setModel((current) => (current ? { ...current, annotations: update(current.annotations) } : current));
  }, []);
  return { model, load, patch };
}

export function ThreadPane({ thread, sent, onQuestions, onChanged, onClose, decisions, onOpenDecisionPage, file, onOpenFile, onOpenGuide, lookSeq, seenThrough = null, onSeen, covered = false, row, onMarkRead, onArchive, replyRequest, onReplyOpened, backLabel = 'Inbox', phone = false, stacked = false, fileStacked = false, onBackToList }: ThreadPaneProps) {
  const root = thread.messages[0]!;
  const asker = agentName(root.author);
  // Archived (resolved). What an agent wrote after the archive line behaves as
  // an open thread's: its questions are live, Reply goes to it, its files take
  // comments; the thread stays archived. `resolved` is the thread with nothing
  // after the archive: read only, as before.
  const archived = thread.resolved_at !== null;
  const archiveSeq = thread.archive_seq ?? null;
  const afterArchive = (message: InboxMessageWire) => archived && archiveSeq !== null && (message.seq ?? 0) > archiveSeq;
  const liveMessage = (message: InboxMessageWire) => !archived || afterArchive(message);
  const cameBack = archived && thread.messages.some((m) => m.author.kind === 'agent' && afterArchive(m));
  const resolved = archived && !cameBack;
  const agentMessages = thread.messages.filter((m) => m.author.kind === 'agent');
  const lastAgent = agentMessages[agentMessages.length - 1] ?? root;

  // Picks saved at once; shown before the server answers, then from the server.
  const [pending, setPending] = useState<ReadonlyMap<string, QuestionAnswer | null>>(new Map());
  const pickChain = useRef<Promise<void>>(Promise.resolve());
  const revisions = useRef(new Map<string, number>());
  const threadRef = useRef(thread);
  threadRef.current = thread;

  /** Switch clicks shown before the server answers, `<message id>/<key>` to on or off. */
  const [switching, setSwitching] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** The decision card open on one question, under the tag's words. */
  const [card, setCard] = useState<{ messageId: string; key: string; anchor: HTMLElement } | null>(null);
  /** Decisions a Send could not record (the answers stay sent). */
  const [refused, setRefused] = useState<{ key: string; message: string }[]>([]);
  const [box, setBox] = useState<{ open: boolean; text: string }>({ open: false, text: '' });
  /**
   * What this Send does with the questions it leaves unanswered: `auto` skips
   * them once the Send answers at least one question and keeps them open
   * otherwise (a reply of words alone leaves every question open, approval
   * "inbox-words-only-reply"); the chip's button picks `skip` or `keep`.
   */
  const [skipChoice, setSkipChoice] = useState<SkipChoice>('auto');
  /** Keep open: this Send leaves the unanswered questions open instead of skipping them. */
  const keepOpen = !skipsUnanswered(skipChoice, sendAnswersAny(thread, pending));
  const toggleKeepOpen = () => setSkipChoice(keepOpen ? 'skip' : 'keep');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendKeys = useRef<Map<string, string> | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const guardRef = useRef<HTMLDivElement>(null);

  // Replaced questions. A pick the person saved can be superseded while this
  // thread is open; the stale guard then says so before Send, once per
  // replacement. `seenReplaced` is every superseded question this pane has
  // shown (a replacement already on screen when the thread opened is read on
  // its card, so it never raises the guard); `stale` the ones that dropped a
  // pick since, until the person acts on the panel.
  const seenReplaced = useRef<{ threadId: string; ids: Set<string> } | null>(null);
  const [stale, setStale] = useState<string[]>([]);
  const [guard, setGuard] = useState(false);
  useEffect(() => {
    const superseded = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'superseded'));
    const seen = seenReplaced.current;
    if (!seen || seen.threadId !== thread.thread_id) {
      seenReplaced.current = { threadId: thread.thread_id, ids: new Set(superseded.map((q) => `${q.message_id}/${q.key}`)) };
      return;
    }
    const fresh: string[] = [];
    for (const q of superseded) {
      const id = `${q.message_id}/${q.key}`;
      if (seen.ids.has(id)) continue;
      seen.ids.add(id);
      if (q.answer !== null) fresh.push(id);
    }
    if (fresh.length > 0) setStale((current) => [...current, ...fresh.filter((id) => !current.includes(id))]);
  }, [thread]);

  // ── Folding (design record "Land", not in this repo) ──────────────────────
  // Read messages fold to one line; the thread opens at "New since you
  // looked". What is new is decided against the boundary from BEFORE this
  // look (the window's `lookSeq`, else the first thread this pane was given),
  // so the "New" marks last until the person leaves the thread.
  const one = thread.messages.length < 2;
  const lookRef = useRef<{ threadId: string; seq: number | null } | null>(null);
  if (!lookRef.current || lookRef.current.threadId !== thread.thread_id) lookRef.current = { threadId: thread.thread_id, seq: lookBoundary(thread) };
  const opened = lookSeq !== undefined ? lookSeq : lookRef.current.seq;
  // A reply the person sends during this visit is a look at everything before
  // it (the list's rule), so what it answers stops being new at once.
  const boundary = useMemo(
    () => (opened === null ? null : Math.max(opened, ...thread.messages.filter(isPersonReply).map((m) => m.seq ?? 0))),
    [opened, thread.messages],
  );
  const fresh = useMemo(() => newSinceLook(thread.messages, boundary), [thread.messages, boundary]);
  const showNew = !one && fresh.size > 0;
  // The fold is decided once, when the thread opens: opening a message never
  // makes others appear or disappear.
  const [foldState, setFoldState] = useState<FoldState | null>(null);
  let fold = foldState;
  if (!fold || fold.threadId !== thread.thread_id) {
    const plan = planFolds(thread.messages, fresh, boundary);
    fold = { threadId: thread.thread_id, folded: plan.folded, hidden: plan.hidden, revealed: new Set() };
    setFoldState(fold);
  }
  const foldRef = useRef(fold);
  foldRef.current = fold;
  const hiddenNow = new Set(fold.hidden.flatMap((ids, index) => (fold.revealed.has(index) ? [] : ids)));
  const allOpen = thread.messages.every((m) => !fold.folded.has(m.id)) && hiddenNow.size === 0;
  const sectionRef = useRef<HTMLElement>(null);
  /** After a fold changes: keep the message the person acted on in place, then move focus. */
  const anchorRef = useRef<{ id: string | null; top: number; focus: string | null; folding: boolean } | null>(null);
  const [announced, setAnnounced] = useState('');
  const announce = (text: string) => {
    setAnnounced('');
    setTimeout(() => setAnnounced(text), 30);
  };
  const articleOf = (id: string) => bodyRef.current?.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(id)}"]`) ?? null;
  const headOf = (id: string) => articleOf(id)?.querySelector<HTMLElement>('[data-fold-head]') ?? null;
  // The header's attachments band (design record "inbox-attachments-header",
  // variant Count): open per message, never remembered. It starts closed on
  // every visit to a thread, and a message that folds closes its band.
  const [headerFiles, setHeaderFiles] = useState<{ threadId: string; open: ReadonlySet<string> }>(() => ({ threadId: thread.thread_id, open: new Set() }));
  const headerOpen: ReadonlySet<string> = headerFiles.threadId === thread.thread_id ? headerFiles.open : NO_IDS;
  const setHeaderOpen = (id: string, open: boolean) =>
    setHeaderFiles((current) => {
      const ids = new Set(current.threadId === thread.thread_id ? current.open : []);
      if (open) ids.add(id);
      else ids.delete(id);
      return { threadId: thread.thread_id, open: ids };
    });
  /** Escape on the count or inside its band closes the band, focus back on the count; the thread stays open. */
  const closeHeaderOnEscape = (id: string) => (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !headerOpen.has(id)) return;
    event.preventDefault();
    setHeaderOpen(id, false);
    bodyRef.current?.querySelector<HTMLElement>(`[data-header-files="${CSS.escape(id)}"]`)?.focus();
  };
  const toggleMessage = (id: string) => {
    const folding = !fold.folded.has(id);
    if (folding) setHeaderOpen(id, false);
    anchorRef.current = { id, top: articleOf(id)?.getBoundingClientRect().top ?? 0, focus: id, folding };
    setFoldState((current) => {
      if (!current) return current;
      const folded = new Set(current.folded);
      if (folding) folded.add(id);
      else folded.delete(id);
      return { ...current, folded };
    });
  };
  /** The first message whose top is in view: what is above it may grow, it stays put. */
  const topVisible = (): string | null => {
    const body = bodyRef.current;
    if (!body) return null;
    const top = body.getBoundingClientRect().top;
    const articles = [...body.querySelectorAll<HTMLElement>('[data-message-article]')];
    const found = articles.find((a) => a.getBoundingClientRect().top >= top - 1) ?? articles[articles.length - 1];
    return found?.getAttribute('data-message-article') ?? null;
  };
  const expandAll = () => {
    const id = topVisible();
    anchorRef.current = { id, top: id ? (articleOf(id)?.getBoundingClientRect().top ?? 0) : 0, focus: null, folding: false };
    if (allOpen) {
      const last = thread.messages[thread.messages.length - 1]!;
      // The last real message stays open with it when notes trail it (it carries the reply's line).
      const lastReal = lastNonNote(thread.messages);
      setFoldState((current) => (current ? { ...current, folded: new Set(thread.messages.filter((m) => m !== last && m !== lastReal).map((m) => m.id)), revealed: new Set() } : current));
      setHeaderFiles({ threadId: thread.thread_id, open: new Set([...headerOpen].filter((id) => id === last.id)) });
      announce('Earlier messages folded');
    } else {
      setFoldState((current) => (current ? { ...current, folded: new Set(), revealed: new Set(current.hidden.map((_, index) => index)) } : current));
      announce(`All ${thread.messages.length} messages open`);
    }
  };
  const revealRun = (index: number) => {
    const first = fold.hidden[index]?.[0] ?? null;
    anchorRef.current = { id: null, top: 0, focus: first, folding: false };
    setFoldState((current) => (current ? { ...current, revealed: new Set(current.revealed).add(index) } : current));
    announce(`${plural(fold.hidden[index]?.length ?? 0, 'earlier message')} shown`);
  };
  /** Open a message that is folded or hidden in the middle fold; true when it was. */
  const unfold = useCallback((messageId: string): boolean => {
    const current = foldRef.current;
    const run = current.hidden.findIndex((ids, index) => !current.revealed.has(index) && ids.includes(messageId));
    if (!current.folded.has(messageId) && run < 0) return false;
    setFoldState((state) => {
      if (!state) return state;
      const folded = new Set(state.folded);
      folded.delete(messageId);
      return { ...state, folded, revealed: run < 0 ? state.revealed : new Set(state.revealed).add(run) };
    });
    return true;
  }, []);

  /** Scroll to a card or a message, focus it, and ring it briefly; a folded message opens first. */
  const jumpTo = useCallback((target: JumpTarget) => {
    if (unfold(target.messageId)) {
      requestAnimationFrame(() => jumpNow(target));
      return;
    }
    jumpNow(target);
  }, [unfold]);
  const jumpNow = (target: JumpTarget) => {
    const body = bodyRef.current;
    if (!body) return;
    const element =
      target.kind === 'message'
        ? body.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(target.messageId)}"]`)
        : body.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target.messageId)}"] [data-question-key="${CSS.escape(target.key)}"]`);
    if (!element) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
    element.focus({ preventScroll: true });
    if (target.kind === 'question') {
      element.classList.remove('ib-q-target-out');
      element.classList.add('ib-q-target');
      setTimeout(() => {
        element.classList.add('ib-q-target-out');
        element.classList.remove('ib-q-target');
        setTimeout(() => element.classList.remove('ib-q-target-out'), 700);
      }, 1400);
    }
  };

  // Attachments (step 2): the files as they are now, and the annotations that ride the next Send.
  const { model: files, load: reloadFiles, patch: patchRecords } = useThreadAttachments(thread.thread_id, thread);
  const attachments: InboxAttachmentState[] = files?.attachments ?? [];
  const records = files?.annotations ?? [];

  // The session that asked, and whether it is still there (only hosts whose
  // sessions poll the Inbox can be known to have ended). It is the session
  // the Send actually reaches: the latest agent message's when words or
  // annotations ride on it, else the last message a pick or a skip answers.
  const asking = askingSessionOf(thread, { skip: !keepOpen, carries: (box.open && box.text.trim() !== '') || records.length > 0 });
  const askerToWatch = asking && askerCanEnd(asking) ? asking.session : null;
  // New message (record 5.x): the project's live sessions, and what the button opened.
  const { model: live, load: loadLive } = useLiveSessions(thread.thread_id, askerToWatch);
  const askerEnded = !resolved && askerHasEnded(asking, live);
  const anyOtherLive = asking !== null && othersLive(asking, live).length > 0;
  const noteId = `ib-asker-note-${thread.thread_id}`;
  // The choice at Send, when the session that asked has ended.
  const [route, setRoute] = useState<RouteState>(CLOSED_ROUTE);
  useEffect(() => {
    if (!asking) return;
    setRoute((current) => (current.open ? mergeRouteRows(current, asking, live) : current));
    // Only a new read of the live sessions merges; `asking` follows the thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  const [newMessage, setNewMessage] = useState<NewMessageMode>(null);
  const pressNewMessage = async () => {
    if (newMessage?.kind === 'pick' || newMessage?.kind === 'none') {
      setNewMessage(null);
      return;
    }
    const now = await loadLive();
    const sessions = now?.sessions ?? [];
    setBox({ open: false, text: '' });
    setRoute(CLOSED_ROUTE);
    setNewMessage(sessions.length === 0 ? { kind: 'none' } : sessions.length === 1 ? { kind: 'compose', target: sessions[0]! } : { kind: 'pick' });
  };

  const fileRecords = useMemo(() => records.filter((r) => !r.guide), [records]);
  /** Something here takes annotations: an attached file, or a guided review's diffs. */
  const takesAnnotations = attachments.length > 0 || records.length > 0 || thread.messages.some((m) => m.guide);
  const [full, setFull] = useState(false);
  /** A narrow window (a phone): the open file is always full screen. */
  /** Bumped when the person opens a file, so focus moves into its pane. */
  const [paneFocus, setPaneFocus] = useState(0);
  const paneRef = useRef<AttachmentPaneHandle>(null);
  /** Every attachment of the thread in thread order: what the pane steps through. */
  const steps = useMemo(() => attachmentSequence(thread.messages, attachments), [thread.messages, attachments]);
  const openFile = (attachment: Pick<InboxAttachmentState, 'id' | 'kind'>, version: 'current' | 'sent' = 'current', focus: string | null = null) => {
    setFull(attachment.kind === 'html');
    onOpenFile({ id: attachment.id, version, focus });
  };
  /** A tile, or a link in a message: the file as it is now, focus in its pane (a typed comment in the open file asks first). */
  const openFromMessage = (attachment: Pick<InboxAttachmentState, 'id' | 'kind'> & { name?: string }) => {
    const go = () => {
      openFile(attachment);
      setPaneFocus((n) => n + 1);
    };
    const pane = paneRef.current;
    if (pane && file && file.id !== attachment.id) pane.leave(attachment.name ?? attachments.find((a) => a.id === attachment.id)?.name ?? 'that file', go);
    else go();
  };
  const openRecord = (record: InboxAnnotationRecord) => {
    // A comment on a guided review's diff: open that guide.
    if (record.guide) {
      onOpenGuide(record.message_id);
      return;
    }
    const attachment = attachments.find((a) => a.id === record.attachment_id);
    if (!attachment) return;
    const go = () => openFile(attachment, record.version === 'current' ? 'current' : 'sent', record.id);
    // Another file than the one open: a typed comment in the open file asks first.
    if (paneRef.current && file && file.id !== attachment.id) paneRef.current.leave(attachment.name, go);
    else go();
  };
  const countsByPath = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of fileRecords) counts.set(record.path, (counts.get(record.path) ?? 0) + 1);
    return counts;
  }, [fileRecords]);
  const saveRecord = useCallback(
    (record: InboxAnnotationRecord) => patchRecords((list) => [...list.filter((r) => r.id !== record.id), record]),
    [patchRecords],
  );
  const dropRecord = useCallback((id: string) => patchRecords((list) => list.filter((r) => r.id !== id)), [patchRecords]);
  const editRecord = async (record: InboxAnnotationRecord, text: string) => {
    try {
      const next = { ...annotationOf(record), text };
      const result = record.guide ? await inboxApi.saveGuideAnnotation(record.message_id, next) : await inboxApi.saveAnnotation(record.attachment_id, record.version, next);
      saveRecord(result.annotation);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not saved.');
    }
  };
  const removeRecord = async (record: InboxAnnotationRecord) => {
    try {
      await inboxApi.removeAnnotation(record.id);
      dropRecord(record.id);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not removed.');
    }
  };
  /** The annotations as Plannotator's feedback text: each file version's text read now, so line numbers are what the person read. */
  const buildFeedback = async (pending: readonly InboxAnnotationRecord[]): Promise<string> => {
    const texts = new Map<string, string>();
    for (const record of pending) {
      // A guided-review comment carries its own file and lines.
      if (record.guide) continue;
      const attachment = attachments.find((a) => a.id === record.attachment_id) ?? attachments.find((a) => a.path === record.path);
      if (!attachment) continue;
      const key = `${attachment.id}\0${record.version}`;
      if (texts.has(key)) continue;
      // Code comments carry their own lines and an image has none: only documents need their text read.
      const kind = readInboxAttachmentKind(attachment.kind);
      if (!isInboxTextKind(kind) || kind === 'code') continue;
      try {
        texts.set(key, (await inboxApi.view(attachment.id, record.version === 'current' ? 'current' : 'sent')).text);
      } catch {
        texts.set(key, '');
      }
    }
    return attachmentFeedback(pending, attachments, texts, thread.project.root);
  };

  useEffect(() => {
    // Another thread: nothing of the last one carries over.
    setPending(new Map());
    setBox({ open: false, text: '' });
    setError(null);
    setSwitching(new Map());
    setCard(null);
    setRefused([]);
    setNewMessage(null);
    setStale([]);
    setGuard(false);
    setRoute(CLOSED_ROUTE);
    setSkipChoice('auto');
    sendKeys.current = null;
    revisions.current.clear();
  }, [thread.thread_id]);

  // The subject in the header once it scrolls away, and the "↓ N new" pill
  // while new messages the person has not seen are below the view (its count:
  // those messages, never everything new this visit).
  const [chrome, setChrome] = useState({ subject: false, pill: 0 });
  const updateChrome = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const box = body.getBoundingClientRect();
    const subject = body.querySelector<HTMLElement>('.ib-subject');
    const next = {
      subject: subject !== null && subject.getBoundingClientRect().bottom < box.top + 4,
      pill: newBelow(body).length,
    };
    setChrome((current) => (current.subject === next.subject && current.pill === next.pill ? current : next));
  }, []);

  // ── Seen on sight (design record "inbox-new-in-open-thread", variant A) ──
  // An agent message that arrives while the thread is open counts as seen once
  // its first lines have been on screen for a second, the window in front and
  // nothing over the thread; the window then records the look up to it.
  /** Arrivals the person has seen this visit (kept for the visit: the pill leaves them out). */
  const [sighted, setSighted] = useState<{ threadId: string; ids: ReadonlySet<string> }>(() => ({ threadId: thread.thread_id, ids: new Set() }));
  const sightedIds: ReadonlySet<string> = sighted.threadId === thread.thread_id ? sighted.ids : NO_IDS;
  const arrivals = useMemo(() => (onSeen ? unseenArrivals(thread.messages, seenThrough) : []), [onSeen, thread.messages, seenThrough]);
  /** The arrivals still to be seen (and those seen whose look is not recorded yet): the pill counts these first. */
  const arrivalIds = useMemo(() => new Set(arrivals.map((m) => m.id)), [arrivals]);
  const candidates = arrivals.filter((m) => !sightedIds.has(m.id) && !fold.folded.has(m.id) && !hiddenNow.has(m.id)).map((m) => m.id);
  /** A file over the thread: full screen, or where it cannot sit beside it (a phone, a stacked window). */
  const fileCovers = file !== null && (full || phone || fileStacked);
  const arrivalsRef = useRef(arrivals);
  arrivalsRef.current = arrivals;
  const sightedRef = useRef(sightedIds);
  sightedRef.current = sightedIds;
  const sawOne = useCallback(
    (id: string) => {
      if (sightedRef.current.has(id)) return;
      const ids = new Set(sightedRef.current).add(id);
      sightedRef.current = ids;
      setSighted({ threadId: thread.thread_id, ids });
      // The look goes as far as every arrival up to it was seen, never past one that was not.
      const through = lookThrough(arrivalsRef.current, ids);
      if (through !== null) onSeen?.(through);
    },
    [onSeen, thread.thread_id],
  );
  // On a phone the pill sits in the foot and covers none of the thread.
  useSeenOnSight({ bodyRef, candidates, covered: covered || fileCovers, pill: chrome.pill > 0 && !phone, onSeen: sawOne });

  // Arrivals while the thread is open: announced to a screen reader, drawn
  // with a short entrance, and, when the person is at the end of the thread,
  // scrolled into view just far enough to show their first lines.
  const known = useRef<{ threadId: string; ids: Set<string> } | null>(null);
  const atEndRef = useRef(false);
  const [arrived, setArrived] = useState<{ threadId: string; ids: ReadonlySet<string> }>(() => ({ threadId: thread.thread_id, ids: new Set() }));
  const arrivedIds: ReadonlySet<string> = arrived.threadId === thread.thread_id ? arrived.ids : NO_IDS;
  useLayoutEffect(() => {
    const ids = thread.messages.map((m) => m.id);
    const before = known.current;
    known.current = { threadId: thread.thread_id, ids: new Set(ids) };
    if (!before || before.threadId !== thread.thread_id) return;
    const added = thread.messages.filter((m) => m.author.kind === 'agent' && !before.ids.has(m.id));
    if (added.length === 0) return;
    setArrived((current) => ({ threadId: thread.thread_id, ids: new Set([...(current.threadId === thread.thread_id ? current.ids : []), ...added.map((m) => m.id)]) }));
    const first = added[0]!;
    const asks = added.some((m) => (m.questions ?? []).some((q) => q.state === 'open'));
    announce(
      added.length === 1 ? `New message from ${agentName(first.author)}${asks ? ', with a question' : ''}` : `${added.length} new messages${asks ? ', with a question' : ''}`,
    );
    const body = bodyRef.current;
    if (!body || !atEndRef.current) return;
    const article = articleOf(first.id);
    if (!article) return;
    const by = followBy(measureFirstLines(article), body.getBoundingClientRect());
    if (by > 0) body.scrollBy?.({ top: by, behavior: reducedMotion() ? 'auto' : 'smooth' });
    // `announce` and `articleOf` are this render's; only a new thread payload matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const trackEnd = () => {
      atEndRef.current = atEnd(body);
    };
    trackEnd();
    body.addEventListener('scroll', trackEnd, { passive: true });
    body.addEventListener('scroll', updateChrome, { passive: true });
    window.addEventListener('resize', updateChrome);
    // The thread's own box changes without a scroll or a window resize when
    // the foot grows (the reply box, the stale guard, the New-message
    // composer) or a file opens beside it.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => updateChrome()) : null;
    resized?.observe(body);
    return () => {
      body.removeEventListener('scroll', trackEnd);
      body.removeEventListener('scroll', updateChrome);
      window.removeEventListener('resize', updateChrome);
      resized?.disconnect();
    };
  }, [updateChrome]);

  // Where the thread opens: at the "New since you looked" divider with the
  // last read line just above it, or at the top when nothing is new. Once per thread.
  const landed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!foldState || foldState.threadId !== thread.thread_id || landed.current === thread.thread_id) return;
    landed.current = thread.thread_id;
    const body = bodyRef.current;
    if (!body) return;
    const divider = body.querySelector<HTMLElement>('[data-new-divider]');
    const above = divider?.previousElementSibling as HTMLElement | null | undefined;
    body.scrollTop = divider ? Math.max(0, (above ? above.offsetTop : divider.offsetTop) - 6) : 0;
  }, [foldState, thread.thread_id]);

  // After a fold or an open: the message the person acted on stays where it
  // was, and keeps focus. Then the header subject and the pill follow. Only
  // when the fold, the thread or the file beside it changed (never on a keystroke in the reply box).
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const body = bodyRef.current;
    if (anchor && body) {
      const article = anchor.id ? articleOf(anchor.id) : null;
      if (article) {
        body.scrollTop += article.getBoundingClientRect().top - anchor.top;
        // A long message folded from below its top: bring its line into view.
        if (anchor.folding && article.getBoundingClientRect().top < body.getBoundingClientRect().top) article.scrollIntoView?.({ block: 'start' });
      }
      const focus = anchor.focus ? headOf(anchor.focus) : null;
      if (focus) {
        focus.focus({ preventScroll: true });
        const r = focus.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        if (r.top < b.top + 8 || r.bottom > b.bottom - 8) focus.scrollIntoView?.({ block: 'nearest' });
      }
    }
    updateChrome();
  }, [foldState, thread, file?.id, updateChrome, sighted]);

  /**
   * n goes to the first new message (at the divider); the pill to what it
   * counts (newBelow): the first arrival not yet seen below the view, else
   * the first message new at the open below it, which is the first new one
   * unless the person has read past it.
   */
  const jumpNew = useCallback((below = false) => {
    const body = bodyRef.current;
    const first = body?.querySelector<HTMLElement>('[data-message-article][data-new]');
    if (!body || !first) return;
    const target = below ? (newBelow(body)[0] ?? first) : first;
    const divider = target === first ? body.querySelector<HTMLElement>('[data-new-divider]') : null;
    (divider ?? target).scrollIntoView?.({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    target.querySelector<HTMLElement>('[data-fold-head]')?.focus({ preventScroll: true });
  }, []);

  // j / k move between messages (and the middle fold), n goes to the first
  // new one; Enter and Space are the buttons' own. Never while typing.
  useEffect(() => {
    if (one) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (event.key !== 'j' && event.key !== 'k' && event.key !== 'n') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target) {
        if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
        if (target.tagName === 'INPUT' && !['radio', 'checkbox'].includes((target as HTMLInputElement).type)) return;
        // Keys aimed at the open file, a dialog or a popover are theirs.
        if (target !== document.body && !sectionRef.current?.contains(target)) return;
        if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      }
      const body = bodyRef.current;
      if (!body) return;
      event.preventDefault();
      if (event.key === 'n') {
        jumpNew();
        return;
      }
      const heads = [...body.querySelectorAll<HTMLElement>('[data-fold-head]')];
      if (heads.length === 0) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const home = active?.closest('[data-message-article], [data-middle-fold]') ?? null;
      let index = heads.findIndex((h) => h === active || (home !== null && h.closest('[data-message-article], [data-middle-fold]') === home));
      if (index < 0) {
        const top = body.getBoundingClientRect().top;
        index = heads.findIndex((h) => h.getBoundingClientRect().top >= top) - (event.key === 'j' ? 1 : 0);
      }
      const next = heads[Math.max(0, Math.min(heads.length - 1, index + (event.key === 'j' ? 1 : -1)))];
      if (next) {
        next.focus({ preventScroll: true });
        next.scrollIntoView?.({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [one, jumpNew]);

  useEffect(() => {
    if (box.open) textRef.current?.focus();
  }, [box.open]);

  // The update control's restart guard: an unsent reply is the one thing a
  // restart (a page reload) would lose.
  const unsentSubject = box.open && box.text.trim() ? (thread.subject ?? 'this thread') : null;
  useEffect(() => {
    reportUnsentReply(unsentSubject ? { subject: unsentSubject } : null);
    return () => reportUnsentReply(null);
  }, [unsentSubject]);

  const questionById = (id: string): InboxQuestion | undefined => {
    for (const message of threadRef.current.messages) {
      for (const q of message.questions ?? []) if (`${q.message_id}/${q.key}` === id) return q;
    }
    return undefined;
  };

  const pick = (messageId: string, key: string, answer: QuestionAnswer | null) => {
    const id = `${messageId}/${key}`;
    setPending((current) => new Map(current).set(id, answer));
    setError(null);
    pickChain.current = pickChain.current.then(async () => {
      const known = questionById(id);
      const revision = Math.max(revisions.current.get(id) ?? 0, known?.revision ?? 0);
      try {
        const result = await inboxApi.pick(messageId, key, revision, answer);
        for (const q of result.questions) revisions.current.set(`${q.message_id}/${q.key}`, q.revision);
        onQuestions(messageId, result.questions);
      } catch (cause) {
        // The agent replaced the question meanwhile: reading the thread again redraws it as Replaced.
        if (!isSuperseded(cause)) setError(cause instanceof InboxApiError ? cause.message : 'The pick was not saved.');
        await onChanged();
      } finally {
        setPending((current) => {
          if (!current.has(id) || current.get(id) !== answer) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }
    });
  };

  const answersOf = (message: InboxMessageWire): Map<string, QuestionAnswer> => {
    const out = new Map<string, QuestionAnswer>();
    for (const q of message.questions ?? []) {
      const id = `${message.id}/${q.key}`;
      const answer = pending.has(id) ? pending.get(id)! : q.answer;
      if (answer) out.set(q.key, answer);
    }
    return out;
  };

  const sentAt = (replyId: string | null): string | null => {
    const reply = replyId ? thread.messages.find((m) => m.id === replyId) : undefined;
    return reply ? reply.created_at : null;
  };

  const footerFor = (message: InboxMessageWire) => (key: string): string | null => {
    const q = message.questions?.find((x) => x.key === key);
    if (!q) return null;
    if (q.state === 'sent') {
      const at = sentAt(q.sent_reply_id);
      // A Send skipped it because the person left it unanswered.
      if (q.answer?.skipped && q.answer.by_reply) return at ? `Skipped with your reply · ${whenTime(at)}` : 'Skipped with your reply';
      return at ? `Sent ${whenTime(at)}` : 'Sent';
    }
    if (q.state === 'closed' && q.set_aside_at) return `Closed unanswered when you marked it read · ${whenTime(q.set_aside_at)}`;
    if (q.state === 'picked' && q.picked_at) return `Picked ${whenTime(q.picked_at)}, not sent`;
    return null;
  };

  /** The question as the server last answered, with one question replaced. */
  const patchQuestion = (question: InboxQuestion) => {
    const message = threadRef.current.messages.find((m) => m.id === question.message_id);
    if (!message) return;
    onQuestions(message.id, (message.questions ?? []).map((q) => (q.key === question.key ? question : q)));
  };

  const recordingOf = (message: InboxMessageWire) => (key: string): boolean | undefined => {
    const id = `${message.id}/${key}`;
    if (switching.has(id)) return switching.get(id);
    return message.questions?.find((q) => q.key === key)?.decision_recording;
  };

  /** The tag's diamond: saved on the question at once, like a pick. */
  const toggleDecision = (messageId: string) => (key: string, next: boolean) => {
    const id = `${messageId}/${key}`;
    setSwitching((current) => new Map(current).set(id, next));
    setError(null);
    void inboxApi
      .setDecision(messageId, key, { recording: next })
      .then((result) => patchQuestion(result.question))
      .catch(async (cause) => {
        if (!isSuperseded(cause)) setError(cause instanceof InboxApiError ? cause.message : 'The switch was not saved.');
        await onChanged();
      })
      .finally(() =>
        setSwitching((current) => {
          if (current.get(id) !== next) return current;
          const updated = new Map(current);
          updated.delete(id);
          return updated;
        }),
      );
  };

  const openDecision = (messageId: string) => (key: string, anchor: HTMLElement) => setCard({ messageId, key, anchor });

  /** Done on the card: keep its words on the question and turn recording on. */
  const keepDecision = async (messageId: string, key: string, draft: InboxDecisionDraft | null) => {
    try {
      const result = await inboxApi.setDecision(messageId, key, { recording: true, draft });
      patchQuestion(result.question);
      setCard(null);
    } catch (cause) {
      throw new Error(cause instanceof InboxApiError ? cause.message : 'The decision was not kept.');
    }
  };

  // What a Send carries: every picked, unsent answer, per message. A pick on a
  // superseded question is never one of them (its state is "superseded").
  const picked = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'picked'));
  const picksCount = picked.length;
  // Picks the agent's replacement dropped since the person's last reply: the
  // reply box shows them struck, never in "N picks".
  const lastReplyAt = thread.messages.filter(isPersonReply).at(-1)?.created_at ?? '';
  const dropped = thread.messages.flatMap((m) =>
    (m.questions ?? []).filter((q) => {
      if (q.state !== 'superseded' || q.answer === null) return false;
      const by = thread.messages.find((x) => x.id === q.superseded_by?.message_id);
      return !by || by.created_at > lastReplyAt;
    }),
  );
  const staleQuestions = stale
    .map((id) => thread.messages.flatMap((m) => m.questions ?? []).find((q) => `${q.message_id}/${q.key}` === id))
    .filter((q): q is InboxQuestion => q !== undefined && q.state === 'superseded');
  /** Acting on the panel: these replacements were seen, so Send goes as asked from now on. */
  const acknowledgeStale = () => {
    setStale([]);
    setGuard(false);
  };
  /** Picks or annotations wait for a Send. */
  const waiting = picksCount > 0 || records.length > 0;
  // What a Send skips: every question still open with no pick (one being
  // saved counts as picked), unless the person pressed Keep open.
  const unanswered = thread.messages.flatMap((m) =>
    m.author.kind === 'agent'
      ? (m.questions ?? []).filter((q) => {
          if (q.state !== 'open') return false;
          const id = `${m.id}/${q.key}`;
          return !(pending.has(id) && pending.get(id) !== null);
        })
      : [],
  );
  const skipping = !keepOpen && unanswered.length > 0;

  const openBox = (withDraft: boolean) => {
    setNewMessage(null);
    setRoute((current) => ({ ...current, open: false, error: null }));
    const draft = withDraft ? picked.map((q) => (q.answer ? `${q.prompt.replace(/[?.!]\s*$/, '')}: ${answerWords(q.answer)}.` : '')).filter(Boolean).join(' ') : '';
    setBox({ open: true, text: draft });
    setError(null);
  };

  /** Back from the choice to the reply: the draft and its choice kept, focus at the end of the text. */
  const routeBack = useCallback(() => {
    setRoute((current) => ({ ...current, open: false, error: null }));
    requestAnimationFrame(() => {
      const text = textRef.current;
      if (text) {
        text.focus();
        text.setSelectionRange(text.value.length, text.value.length);
      } else {
        sendRef.current?.focus();
      }
    });
  }, []);

  const send = async (options: { despiteReplaced?: boolean; routed?: boolean } = {}) => {
    if (sending) return;
    // A pick was replaced while the person was answering: nothing goes until they have read that.
    if (staleQuestions.length > 0 && !options.despiteReplaced) {
      setGuard(true);
      return;
    }
    // The session that asked has ended and another is live: Send asks where
    // the reply goes first (the choice), and sends nothing yet.
    if (askerEnded && anyOtherLive && asking && !options.routed) {
      const empty = picksCount === 0 && records.length === 0 && !(box.open && box.text.trim()) && !skipping;
      if (empty) {
        setError('Write a reply or pick an answer first.');
        return;
      }
      setError(null);
      setRoute((current) => mergeRouteRows({ ...current, open: true, error: null, focus: current.focus + 1 }, asking, live));
      return;
    }
    // The choice's answer: another live session takes the reply (never the
    // session that asked, which a plain reply already reaches).
    const chosen =
      options.routed && route.selected && route.selected !== LEAVE && route.selected !== asking?.session
        ? (route.rows.find((row) => row.live.session === route.selected && !row.ended)?.live ?? null)
        : null;
    const to = chosen ? { host: chosen.host, session: chosen.session } : undefined;
    setSending(true);
    setError(null);
    /** Replies of this Send that went (or were already there, a retry's replays). */
    let went = 0;
    let total = 0;
    try {
      await pickChain.current;
      const current = threadRef.current;
      const words = box.open ? box.text.trim() : '';
      // A pick saved just now, or still being saved when Send was pressed, counts as an answer.
      const skip = skipsUnanswered(skipChoice, sendAnswersAny(current) || sendAnswersAny(thread, pending));
      const pendingAnnotations = records;
      const carries = words !== '' || pendingAnnotations.length > 0;
      // The latest agent message rides last only to carry the words and the
      // annotations; with neither, a target with nothing to send is left out.
      const targets = sendTargetsOf(current, skip).filter((t, index, all) => t.questions.length > 0 || t.skips || (carries && index === all.length - 1));
      total = targets.length;
      if (targets.length === 0) {
        setError('Write a reply or pick an answer first.');
        return;
      }
      if (!sendKeys.current) sendKeys.current = new Map(targets.map((t) => [t.message.id, crypto.randomUUID()]));
      const notRecorded: { key: string; message: string }[] = [];
      // The words and the annotations ride the last reply, after its picks.
      const feedback = pendingAnnotations.length > 0 ? await buildFeedback(pendingAnnotations) : '';
      for (const [index, target] of targets.entries()) {
        const last = index === targets.length - 1;
        const result = await inboxApi.reply(target.message.id, {
          idempotency_key: sendKeys.current.get(target.message.id) ?? crypto.randomUUID(),
          words: last ? words : '',
          questions: target.questions,
          skip_unanswered: skip,
          ...(last && feedback ? { feedback, annotation_ids: pendingAnnotations.map((r) => r.id) } : {}),
          // Only a message the ended session asked goes to the session picked;
          // an answer to another session's message still goes to that session.
          ...(to && target.message.author.kind === 'agent' && target.message.author.session === asking?.session ? { to } : {}),
        });
        went += 1;
        notRecorded.push(...result.decisions_refused);
      }
      setRefused(notRecorded);
      sendKeys.current = null;
      setRoute(CLOSED_ROUTE);
      setSkipChoice('auto');
      setBox({ open: false, text: '' });
      setFull(false);
      await onChanged();
      await reloadFiles();
      // The reply and where it is now sit at the foot of the thread.
      requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
    } catch (cause) {
      if (isSuperseded(cause)) {
        // The race: the agent replaced a picked question as the person sent.
        // Nothing went; the thread is read again and the panel says why.
        await onChanged();
        setGuard(true);
        return;
      }
      // The race: the chosen session ended before the reply went. Its row
      // greys and the next live one is selected; the error says what went
      // when an earlier part of this Send already had.
      if (to && cause instanceof InboxApiError && cause.code === 'session_not_live') {
        setRoute((current) => routeRace(current, to.session, { went, total }));
        if (went > 0) await onChanged();
        void loadLive();
        return;
      }
      setError(cause instanceof InboxApiError ? cause.message : 'The reply was not sent. Send again to retry.');
    } finally {
      setSending(false);
    }
  };

  const resolve = async (next: boolean) => {
    setError(null);
    if (onArchive) {
      onArchive(next);
      return;
    }
    try {
      await inboxApi.resolve(root.id, next);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The thread did not change.');
    }
  };

  // The last message is the person's: say where it is. A New message names
  // the session's host it went to, and is delivered as a turn (step 8). The
  // Inbox's own notes (Mark read's set-aside note, a late Undo's reopened
  // note) are read past: they are not the person's reply, and the line stays
  // on the reply before them.
  const last = lastNonNote(thread.messages) ?? thread.messages[0]!;
  const askedBy = (message: InboxMessageWire) => (message.reply_to ? thread.messages.find((m) => m.id === message.reply_to) : undefined);
  // A reply the person sent to another session names the session that took it
  // ("Claude Code (another session)" when it is the asker's own host).
  const toName = (message: InboxMessageWire, to: { host: string; session: string }) =>
    isRedirected(message) ? redirectedName(to, askedBy(message)) : hostName(to.host);
  const delivered =
    last.author.kind !== 'person'
      ? null
      : last.to
        ? last.delivery
          ? { state: 'delivered', text: `Delivered to ${toName(last, last.delivery)}, ${whenTime(last.delivery.at)}` }
          : { state: 'queued', text: `${toName(last, last.to)} takes it as its next turn.` }
        : sent?.checked_at
          ? { state: 'delivered', text: `Delivered to ${asker}, ${whenTime(sent.checked_at)}` }
          : askerEnded && asking
            ? { state: 'saved', ended: true, text: `Saved for ${asking.name}. The session that asked has ended, so it waits here until an agent reads this thread.` }
            : { state: 'saved', text: `Saved for ${asker}. It sees it when it checks.` };

  const waitingHoldsUp = [...new Set(lastAgent.questions?.filter((q) => q.state === 'open').flatMap((q) => q.holds_up) ?? [])];
  const [holdsOpen, setHoldsOpen] = useState(false);

  // The note sits at the top of the foot before the person replies: with the
  // reply box open, or with something waiting to send, or while the agent's
  // message is the last one. Never over the choice, the stale guard, a New
  // message, or a resolved thread; once the person's reply is the last
  // message, its own line says where it went.
  const showAskerNote =
    askerEnded &&
    asking !== null &&
    !route.open &&
    !(guard && staleQuestions.length > 0) &&
    newMessage?.kind !== 'compose' &&
    (box.open || waiting || last.author.kind !== 'person');

  const routeChoice = asking ? (
    <RouteChoice
      name={`route-${thread.thread_id}`}
      asking={asking}
      project={thread.project.name}
      state={route}
      sending={sending}
      onSelect={(id) => setRoute((current) => ({ ...current, selected: id, error: null }))}
      onSubmit={() => void send({ routed: true })}
      onBack={routeBack}
      onShowAll={() => setRoute((current) => ({ ...current, showAll: true }))}
    />
  ) : null;

  // While new messages are below the view: a pill that goes to them.
  const newPill = (
    <div className="ib-npill-wrap">
      <button
        type="button"
        className="ib-npill"
        data-new-pill=""
        data-off={chrome.pill > 0 ? undefined : ''}
        tabIndex={chrome.pill > 0 ? 0 : -1}
        aria-hidden={chrome.pill === 0}
        onClick={() => jumpNew(true)}
      >
        <Icon name="arrowDown" size={15} />
        {Math.max(1, chrome.pill)} new
      </button>
    </div>
  );

  // The warning toast's Reply: the reply box opens, once.
  useEffect(() => {
    if (replyRequest !== thread.thread_id) return;
    onReplyOpened?.();
    openBox(picksCount > 0);
    // openBox reads this render's picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyRequest, thread.thread_id]);

  // Mark read: pressed while the thread is marked read, offered while something here waits on the person.
  const readAt = row?.read_at ?? null;
  const markReadOffered = !resolved && row != null && onMarkRead !== undefined;
  const markReadEnabled = markReadOffered && canToggleRead(row!);
  const closedByRead = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'closed' && q.set_aside_at));

  const openAttachment = file ? attachments.find((a) => a.id === file.id) ?? null : null;
  const fileOpen = openAttachment !== null;
  // A file beside the thread hides the list (App.tsx `fileOpen`, from the route, so before the
  // attachments load too): the way back to it leads the header, as on an iPad (approved 2026-10-12).
  const backBesideFile = file !== null && !phone && !stacked && !fileStacked && onBackToList !== undefined;
  const backToList = () => {
    const name = openAttachment?.name ?? null;
    const go = () => {
      setFull(false);
      onBackToList!(name);
    };
    if (paneRef.current) paneRef.current.leave(null, go);
    else go();
  };

  const archiveButton = (
    <button
      type="button"
      className="ib-iconbtn"
      onClick={() => void resolve(!archived)}
      title={archived ? 'Unarchive' : 'Archive: the thread ends; the next message starts a new one'}
      aria-label={archived ? 'Unarchive the thread' : 'Archive the thread'}
      data-archive=""
    >
      <Icon name="archive" />
    </button>
  );
  const markReadButton = markReadOffered ? (
    <button
      type="button"
      className="ib-hbtn"
      data-mark-read=""
      aria-pressed={readAt !== null}
      disabled={!markReadEnabled}
      onClick={() => onMarkRead!(readAt === null)}
      title={
        readAt !== null
          ? 'Move it back to the top'
          : markReadEnabled
            ? `Out of the top until ${asker} writes again. Its waiting questions close unanswered.`
            : 'Nothing here waits on you'
      }
    >
      <Icon name="checkCircle" size={16} />
      {readAt !== null ? 'Read' : 'Mark read'}
      <kbd className="ib-kbd ib-wide">E</kbd>
    </button>
  ) : null;

  return (
    <>
    <section
      ref={sectionRef}
      onPointerOver={titleIfClipped}
      className={`ib-pane${fileOpen ? ' ib-withfile' : ''}`}
      aria-label={thread.subject ?? 'Thread'}
      data-thread-id={thread.thread_id}
    >
      <div className="ib-phead">
        {/* A phone leads with the way back to the list; Mark read and Archive move to the right, where the close was. */}
        {phone ? (
          <button type="button" className="ib-pback" onClick={onClose} aria-label={`Back to ${backLabel}`} data-phone-back="">
            <Icon name="chevL" size={18} />
            <span className="ib-pback-l">{backLabel}</span>
          </button>
        ) : (
          <>
            {/* A stacked thread covers the list: the way back to it leads, where the list was. */}
            {stacked && (
              <>
                <button type="button" className="ib-pback" onClick={onClose} aria-label={`Back to ${backLabel}`} title={`Back to ${backLabel}`} data-stack-back="">
                  <Icon name="chevL" size={16} />
                  <span className="ib-pback-l">{backLabel}</span>
                </button>
                <span className="ib-vsep" aria-hidden="true" />
              </>
            )}
            {/* A file beside the thread hides the list: the same way back leads; it closes the file. */}
            {backBesideFile && (
              <>
                <button
                  type="button"
                  className="ib-pback"
                  onClick={backToList}
                  aria-label={`Back to ${backLabel}`}
                  title={openAttachment ? `Close ${openAttachment.name} and show the list` : `Back to ${backLabel}`}
                  data-file-back=""
                >
                  <Icon name="chevL" size={16} />
                  <span className="ib-pback-l">{backLabel}</span>
                </button>
                <span className="ib-vsep" aria-hidden="true" />
              </>
            )}
            {archiveButton}
            {markReadOffered && (
              <>
                <span className="ib-vsep" aria-hidden="true" />
                {markReadButton}
              </>
            )}
          </>
        )}
        {one ? (
          <span className="ib-sp" />
        ) : (
          <>
            {/* The subject, once it has scrolled away (the heading stays the one a screen reader reads). */}
            <span className="ib-phsubj" dir="auto" data-header-subject="" data-on={chrome.subject ? '' : undefined} aria-hidden="true">
              {thread.subject ?? '(no subject)'}
            </span>
            <button
              type="button"
              className="ib-ptool"
              data-expand-all=""
              onClick={expandAll}
              title={allOpen ? 'Fold the earlier messages' : 'Expand all messages'}
              aria-label={allOpen ? 'Fold the earlier messages' : 'Expand all messages'}
            >
              <Icon name={allOpen ? 'collapse' : 'expand'} size={15} />
              <span className="ib-ptool-l">{allOpen ? 'Fold all' : 'Expand all'}</span>
            </button>
          </>
        )}
        {phone ? (
          <>
            {markReadButton}
            {archiveButton}
          </>
        ) : stacked || backBesideFile ? null : (
          <button type="button" className="ib-iconbtn" onClick={onClose} title="Close" aria-label="Close the thread">
            <Icon name="x" />
          </button>
        )}
      </div>
      <div className={`ib-pbody${one ? '' : ' ib-folding'}`} ref={bodyRef}>
        {/* A focus target (the way back's fallback, a stacked thread), never a tab stop. */}
        <h2 className="ib-subject" dir="auto" tabIndex={-1}>{thread.subject ?? '(no subject)'}</h2>
        {readAt !== null && !resolved && (
          <div className="ib-readline" data-read-line="">
            <Icon name="checkCircle" size={16} />
            <div>
              <span>
                Read {whenTime(readAt)}. It stays out of the top until {asker} writes again.
              </span>
              {closedByRead.length > 0 && (
                <>
                  <br />
                  <span>
                    {closedByRead.length === 1 ? '1 question was' : `${closedByRead.length} questions were`} closed unanswered; {asker} is told not to wait on{' '}
                    {closedByRead.length === 1 ? 'it' : 'them'}.
                  </span>
                </>
              )}
            </div>
            {onMarkRead && (
              <button type="button" onClick={() => onMarkRead(false)} data-move-back="">
                Move back
              </button>
            )}
          </div>
        )}
        {!one && (
          <div className="ib-tmeta" data-thread-meta="">
            <span>{plural(thread.messages.length, 'message')}</span>
            <span className="ib-tdot" aria-hidden="true" />
            <span>{spanWords(root.created_at, thread.messages[thread.messages.length - 1]!.created_at)}</span>
            {showNew && (
              <>
                <span className="ib-tdot" aria-hidden="true" />
                <b>{fresh.size} new since you looked</b>
              </>
            )}
          </div>
        )}
        {thread.messages.flatMap((message, index) => {
          const before: React.ReactNode[] = [];
          // The middle of a long read run: one "N earlier messages" in place of its messages.
          const run = fold.hidden.findIndex((ids, i) => !fold.revealed.has(i) && ids[0] === message.id);
          if (run >= 0) {
            const n = fold.hidden[run]!.length;
            before.push(
              <div className="ib-mfold" key={`fold-${run}`} data-middle-fold="">
                <button type="button" className="ib-mfold-b" data-fold-head="" onClick={() => revealRun(run)} aria-label={`Show ${plural(n, 'earlier message')}`}>
                  <span>
                    <Icon name="stack" size={14} />
                    {plural(n, 'earlier message')}
                  </span>
                </button>
              </div>,
            );
          }
          if (hiddenNow.has(message.id)) return before;
          const isNew = showNew && fresh.has(message.id);
          // "New since you looked", above the first new message (not above the first message of the thread).
          if (isNew && index > 0 && thread.messages.findIndex((m) => fresh.has(m.id)) === index) {
            before.push(
              <div className="ib-newdiv" key="new-divider" data-new-divider="" role="separator" aria-label={`New since you looked: ${plural(fresh.size, 'message')}`}>
                New since you looked
              </div>,
            );
          }
          const isAgent = message.author.kind === 'agent';
          const name = isAgent ? agentName(message.author) : 'You';
          // The day too when it is not today, and the whole moment on hover.
          const time = whenTime(message.created_at);
          const fullWhen = fullTime(message.created_at);
          const open = one || !fold.folded.has(message.id);
          if (!open) {
            const holdings = holdingsOf(message, {
              delivered: isDelivered(message, root),
              picked: (q) => {
                const id = `${message.id}/${q.key}`;
                return pending.has(id) ? pending.get(id) !== null : q.state === 'picked';
              },
            });
            const snippet = foldSnippet(message, thread.messages);
            const label = `${name}, ${time}${isNew ? ', new' : ''}${holdings.length > 0 ? `. ${holdings.map((h) => h.say).join(', ')}` : ''}. ${snippetText(snippet)}`;
            before.push(
              <article
                className="ib-message ib-folded"
                key={message.id}
                data-author={message.author.kind}
                data-message-article={message.id}
                data-folded=""
                data-new={isNew ? '' : undefined}
                data-sighted={sightedIds.has(message.id) ? '' : undefined}
                data-arrival={arrivalIds.has(message.id) ? '' : undefined}
                data-arrived={arrivedIds.has(message.id) ? '' : undefined}
                tabIndex={-1}
              >
                <button type="button" className={`ib-fline${isNew ? ' ib-fl-unread' : ''}`} data-fold-head="" aria-expanded={false} aria-label={label} onClick={() => toggleMessage(message.id)}>
                  {isAgent ? (
                    <AuthorMark author={message.author} big />
                  ) : (
                    <span className="ib-mk ib-big">
                      <Icon name="reply" />
                    </span>
                  )}
                  <span className="ib-fl-nm" data-clip="">{name}</span>
                  <span className="ib-fl-sn" dir="auto" data-snippet={snippet.kind} title={snippetText(snippet)}>
                    <SnippetText snippet={snippet} />
                  </span>
                  <HoldingChips holdings={holdings} />
                  <span className="ib-fl-tm" title={fullWhen}>
                    {isNew && <span className="ib-newtag">New</span>}
                    {time}
                  </span>
                </button>
              </article>,
            );
            return before;
          }
          const questions = message.questions ?? [];
          // Nothing left to answer: every question is sent or was superseded.
          const allSent = questions.length > 0 && questions.every((q) => q.state !== 'open' && q.state !== 'picked');
          const replacedCard = (key: string, number: number) => {
            const q = questions.find((x) => x.key === key);
            const replacement = q ? replacementOf(thread.messages, q) : null;
            if (!q || !replacement) return undefined;
            const answer = pending.has(`${message.id}/${key}`) ? (pending.get(`${message.id}/${key}`) ?? null) : q.answer;
            return <ReplacedQuestionCard question={q} number={number} total={questions.length} replacement={replacement} answer={answer} onJump={jumpTo} />;
          };
          const replacesLine = (key: string) => {
            const q = questions.find((x) => x.key === key);
            const old = q ? replacedBy(thread.messages, q) : [];
            return old.length > 0 ? <ReplacesLine old={old} onJump={jumpTo} /> : null;
          };
          // An agent message with files says so in its header (design record
          // "inbox-attachments-header", variant Count): a count in the "to you"
          // line opens the same tiles as the foot, in a band under the sender.
          const messageFiles = isAgent && (message.attachments?.length ?? 0) > 0 ? attachments.filter((a) => a.message_id === message.id) : [];
          const fileCount = isAgent ? Math.max(message.attachments?.length ?? 0, messageFiles.length) : 0;
          const filesOpen = fileCount > 0 && headerOpen.has(message.id);
          const bandId = `ib-hatts-${message.id}`;
          const count =
            fileCount > 0 ? (
              <AttachmentsCount
                messageId={message.id}
                count={fileCount}
                changed={changedCount(messageFiles)}
                open={filesOpen}
                controls={bandId}
                onToggle={() => setHeaderOpen(message.id, !filesOpen)}
                onKeyDown={closeHeaderOnEscape(message.id)}
              />
            ) : null;
          // With a count in a multi-message thread, the fold button cannot hold
          // it (a button inside a button): the fold button lies under the
          // sender as its hit area, and the sender's text (hidden from screen
          // readers, the button's label says it) lets clicks through to it.
          const cover = count !== null && !one;
          const toWords = (
            <>
              to {isAgent ? 'you' : message.to ? toName(message, message.to) : asker}
              {isAgent && askerEnded && message.id === asking?.message.id && <SessionEndedMark />}
            </>
          );
          const who = (
            <>
              {isAgent ? (
                cover ? (
                  <span className="ib-a11y-skip" aria-hidden="true">
                    <AuthorMark author={message.author} big />
                  </span>
                ) : (
                  <AuthorMark author={message.author} big />
                )
              ) : (
                <span className="ib-mk ib-big">
                  <Icon name="reply" />
                </span>
              )}
              {/* Spans, not divs: in a multi-message thread this sits inside the fold button. */}
              <span className="ib-whobox">
                <span className="ib-who" aria-hidden={cover || undefined} data-clip="">
                  <bdi>{name}</bdi> <span>in <bdi>{thread.project.name}</bdi></span>
                </span>
                {count ? (
                  <span className="ib-to ib-to-files">
                    <span aria-hidden={cover || undefined}>{toWords}</span>
                    {count}
                  </span>
                ) : (
                  <span className="ib-to">{toWords}</span>
                )}
              </span>
            </>
          );
          const foldLabel = `${name}, ${time}${isNew ? ', new' : ''}. Fold this message`;
          before.push(
            <article
              className="ib-message"
              key={message.id}
              data-author={message.author.kind}
              data-message-article={message.id}
              data-open={one ? undefined : ''}
              data-new={isNew ? '' : undefined}
              data-sighted={sightedIds.has(message.id) ? '' : undefined}
              data-arrival={arrivalIds.has(message.id) ? '' : undefined}
              data-arrived={arrivedIds.has(message.id) ? '' : undefined}
              tabIndex={-1}
            >
              <div className="ib-sender">
                {one ? (
                  who
                ) : cover ? (
                  <div className="ib-headwrap">
                    <button
                      type="button"
                      className="ib-head"
                      data-fold-head=""
                      aria-expanded={true}
                      aria-label={foldLabel}
                      onClick={() => toggleMessage(message.id)}
                    />
                    <span className="ib-head-face">{who}</span>
                  </div>
                ) : (
                  // The sender is the fold button; the time and Reply stay beside it.
                  <button
                    type="button"
                    className="ib-head"
                    data-fold-head=""
                    aria-expanded={true}
                    aria-label={foldLabel}
                    onClick={() => toggleMessage(message.id)}
                  >
                    {who}
                  </button>
                )}
                <div className="ib-tm">
                  {isNew && <span className="ib-newtag">New</span>}
                  <span title={fullWhen}>{time}</span>
                  {isAgent && liveMessage(message) && (
                    <button type="button" className="ib-mut" onClick={() => openBox(picksCount > 0)} title="Reply" aria-label="Reply">
                      <Icon name="reply" size={15} />
                    </button>
                  )}
                </div>
              </div>
              <div className="ib-msg">
                {count && (
                  <div className="ib-hatts" id={bandId} role="region" aria-label="Attachments in this message" hidden={!filesOpen} onKeyDown={closeHeaderOnEscape(message.id)} data-header-band={message.id}>
                    {filesOpen && (
                      <>
                        <AttachmentTiles
                          attachments={messageFiles}
                          annotationCounts={countsByPath}
                          onOpen={openFromMessage}
                          openId={file && !full && !phone && !fileStacked ? file.id : null}
                          placement="header"
                        />
                        <p className="ib-hatts-note">Also at the end of the message.</p>
                      </>
                    )}
                  </div>
                )}
                <MessageBody
                  message={message}
                  projectRoot={thread.project.root}
                  repo={thread.project.repo ?? null}
                  onOpenAttachment={openFromMessage}
                  readOnly={!isAgent || !liveMessage(message) || questions.length === 0 || allSent}
                  answers={answersOf(message)}
                  onPick={(key, answer) => pick(message.id, key, answer)}
                  footerFor={footerFor(message)}
                  recordingOf={recordingOf(message)}
                  onToggleDecision={toggleDecision(message.id)}
                  onOpenDecision={openDecision(message.id)}
                  renderReplacedCard={replacedCard}
                  renderReplacesLine={replacesLine}
                />
                {questions.map((q) => {
                  const decision = q.decision_id ? decisions.find((d) => d.id === q.decision_id) : undefined;
                  if (!decision) return null;
                  return (
                    <p className="ib-settled" key={q.key} data-question-settled={q.key}>
                      <DecisionDiamond />
                      <span>
                        Settled:{' '}
                        <a
                          href={`#decisions=${decision.project_id}&decision=${decision.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            onOpenDecisionPage(decision);
                          }}
                        >
                          {decision.text}
                        </a>
                      </span>
                    </p>
                  );
                })}
                {isAgent && (message.attachments?.length ?? 0) > 0 && (
                  <AttachmentTiles
                    attachments={attachments.filter((a) => a.message_id === message.id)}
                    annotationCounts={countsByPath}
                    onOpen={openFromMessage}
                    openId={file && !full && !phone && !fileStacked ? file.id : null}
                  />
                )}
                {message.guide && <GuideCard guide={message.guide} onOpen={() => onOpenGuide(message.id)} />}
                {message === lastAgent && liveMessage(lastAgent) && waitingHoldsUp.length > 0 && (
                  <div className="ib-waitfoot">
                    <b>Waiting on this answer</b>
                    <span className="ib-badge">Holds up {waitingHoldsUp.length}</span>
                    <span className="ib-sp" />
                    <button type="button" className="ib-mut" onClick={() => setHoldsOpen((v) => !v)} aria-expanded={holdsOpen}>
                      {holdsOpen ? 'Hide' : 'Show'} <Icon name={holdsOpen ? 'chevR' : 'chevD'} size={14} />
                    </button>
                  </div>
                )}
                {message === lastAgent && holdsOpen && waitingHoldsUp.length > 0 && (
                  <ul className="ib-holds">
                    {waitingHoldsUp.map((held) => (
                      <li key={held}>{held}</li>
                    ))}
                  </ul>
                )}
                {message === last && delivered && (
                  <div className="ib-delivered" data-delivery={delivered.state}>
                    <Icon name={'ended' in delivered && delivered.ended ? 'clock' : 'check'} size={14} />
                    {delivered.text}
                  </div>
                )}
              </div>
            </article>,
          );
          return before;
        })}
        {showNew && !phone && newPill}
        <div className="ib-sr" aria-live="polite" data-fold-live="">
          {announced}
        </div>
      </div>
      <div className="ib-pfoot">
        {/* One status region, always mounted, so a screen reader announces the note when it appears. */}
        <div role="status" id={noteId} data-asker-note="">
          {showAskerNote && asking && <AskerEndedNote asking={asking} project={thread.project.name} anyLive={anyOtherLive} />}
        </div>
        {cameBack && (
          <div className="ib-acts ib-archnote" data-came-back="">
            <span className="ib-st">Archived · {asker} wrote after you archived it. Your reply goes to it; the thread stays archived.</span>
            <button type="button" className="ib-btn" onClick={() => void resolve(false)}>
              Unarchive
            </button>
          </div>
        )}
        {resolved ? (
          <div className="ib-acts">
            <span className="ib-st">Archived. The next message from {asker} starts a new thread.</span>
            <button type="button" className="ib-btn" onClick={() => void resolve(false)}>
              Unarchive
            </button>
          </div>
        ) : guard && staleQuestions.length > 0 ? (
          <StaleGuard
            ref={guardRef}
            questions={staleQuestions}
            thread={thread}
            words={box.open ? box.text.trim() : ''}
            otherPicks={picksCount}
            annotations={records.length}
            onAnswerNew={(target) => {
              acknowledgeStale();
              requestAnimationFrame(() => jumpTo(target));
            }}
            onSendAnyway={() => {
              acknowledgeStale();
              void send({ despiteReplaced: true });
            }}
            onKeepEditing={() => {
              acknowledgeStale();
              requestAnimationFrame(() => (sendRef.current ?? textRef.current)?.focus());
            }}
          />
        ) : newMessage?.kind === 'compose' ? (
          <NewMessageComposer
            key={newMessage.target.session}
            thread={thread}
            target={newMessage.target}
            onCancel={() => setNewMessage(null)}
            onSent={async () => {
              setNewMessage(null);
              await onChanged();
              requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
            }}
          />
        ) : box.open ? (
          <>
            <div className="ib-reply-l">
              Reply to {asker} in {thread.project.name}
            </div>
            {staleQuestions.length > 0 && <ChangedNotice questions={staleQuestions} thread={thread} onJump={jumpTo} />}
            <div className="ib-rbox">
              <textarea
                ref={textRef}
                className="ib-rtext"
                aria-label={`Reply to ${asker}`}
                aria-describedby={showAskerNote ? noteId : undefined}
                placeholder="Write a reply"
                value={box.text}
                rows={2}
                onChange={(event) => setBox({ open: true, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    // With the choice open, the shortcut goes to it.
                    if (route.open) setRoute((current) => ({ ...current, focus: current.focus + 1 }));
                    else void send();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    if (route.open) routeBack();
                    else setBox({ open: false, text: '' });
                  }
                }}
              />
              {(picksCount > 0 || dropped.length > 0 || takesAnnotations || unanswered.length > 0) && (
                <div className={`ib-rfoot${keepOpen ? ' ib-keep' : ''}`}>
                  {picksCount > 0 && (
                    <span className="ib-rchip" data-picks-chip="">
                      <Icon name="check" size={13} />
                      {plural(picksCount, 'pick')}
                    </span>
                  )}
                  <SkipChip count={unanswered.length} keepOpen={keepOpen} onToggle={toggleKeepOpen} />
                  {dropped.length > 0 && (
                    <span className="ib-rchip ib-dropped" data-dropped-picks-chip="" title="Replaced; this pick won't be sent">
                      {dropped.length} {dropped.length === 1 ? 'pick' : 'picks'} on a replaced question
                    </span>
                  )}
                  {takesAnnotations && (
                    <AnnotationsChip records={records} attachments={attachments} onEdit={editRecord} onRemove={removeRecord} onOpen={openRecord} />
                  )}
                </div>
              )}
            </div>
            <div className="ib-sr" role="status">
              {skipping ? `${plural(unanswered.length, 'unanswered question')} will be skipped when you send.` : ''}
            </div>
            {route.open && asking ? (
              routeChoice
            ) : (
              <div className="ib-acts">
                <button type="button" className="ib-btn ib-pri" ref={sendRef} onClick={() => void send()} disabled={sending}>
                  <Icon name="send" size={15} />
                  Send
                </button>
                <button type="button" className="ib-btn ib-ghost" onClick={() => setBox({ open: false, text: '' })}>
                  Cancel
                </button>
                <span className="ib-sp" />
                {!archived && <NewMessageButton live={live} mode={newMessage} onClick={() => void pressNewMessage()} />}
              </div>
            )}
          </>
        ) : route.open && asking ? (
          routeChoice
        ) : (
          <>
          <div className="ib-acts">
            {waiting && <span className="ib-st">Not sent</span>}
            {waiting && (
              <button type="button" className="ib-btn ib-pri" ref={sendRef} onClick={() => void send()} disabled={sending}>
                <Icon name="send" size={15} />
                Send
              </button>
            )}
            <button type="button" className="ib-btn" onClick={() => openBox(picksCount > 0)}>
              <Icon name="reply" size={15} />
              {waiting ? 'Edit the reply' : 'Reply'}
            </button>
            {!archived && <NewMessageButton live={live} mode={newMessage} onClick={() => void pressNewMessage()} />}
            {waiting && unanswered.length > 0 && (
              <>
                <span className="ib-sp" />
                <span className={keepOpen ? 'ib-keep' : undefined}>
                  <SkipChip count={unanswered.length} keepOpen={keepOpen} onToggle={toggleKeepOpen} />
                </span>
              </>
            )}
            {/* A phone has no room to float the pill over the messages (it sat on a sender's row): it sits in this
                row's empty middle, laid over it, so the foot and the thread's view keep their size and Reply stays put.
                With Send waiting the row has no empty middle, and no pill. */}
            {showNew && phone && !waiting && newPill}
          </div>
          </>
        )}
        {!archived && (
          <NewMessagePopover
            thread={thread}
            asker={asker}
            askerHost={root.author.kind === 'agent' ? root.author.host : null}
            live={live}
            mode={newMessage}
            onPick={(target) => setNewMessage({ kind: 'compose', target })}
            onReplyInstead={() => openBox(picksCount > 0)}
            onClose={() => setNewMessage(null)}
          />
        )}
        {error && (
          <div className="ib-error" role="alert">
            {error}
          </div>
        )}
        {refused.map((entry) => (
          <div className="ib-error" role="status" key={entry.key} data-question-decision-refused={entry.key}>
            Not recorded as a decision: {entry.message.replace(/\.$/, '')}. The answer was sent.
          </div>
        ))}
      </div>
      {card && <ThreadDecisionCard thread={thread} card={card} answersOf={answersOf} onCancel={() => setCard(null)} onDone={keepDecision} />}
    </section>
    {openAttachment && (
      <AttachmentPane
        ref={paneRef}
        attachment={openAttachment}
        attachments={attachments}
        // The files' annotations only: a guided-review comment is on the guide's diff, not on a file.
        records={fileRecords}
        agent={asker}
        projectName={thread.project.name}
        projectRoot={thread.project.root}
        repo={thread.project.repo ?? null}
        version={file!.version}
        onVersion={(version) => onOpenFile({ id: openAttachment.id, version, focus: null })}
        full={full || phone || fileStacked}
        fullLocked={phone || fileStacked}
        phone={phone}
        steps={steps}
        // A step keeps the frame the person is in, and replaces the route.
        onStep={(attachmentId, version) => onOpenFile({ id: attachmentId, version, focus: null }, { replace: true })}
        onToggleFull={() => setFull((v) => !v)}
        focusId={file!.focus}
        focusRequest={paneFocus}
        readOnly={!liveMessage(thread.messages.find((m) => m.id === openAttachment.message_id) ?? root)}
        onSaved={saveRecord}
        onRemoved={dropRecord}
        onOpenAt={(attachmentId, version, focus) => onOpenFile({ id: attachmentId, version, focus }, { replace: true })}
        onClose={() => {
          setFull(false);
          onOpenFile(null);
        }}
        strip={{
          picks: picksCount,
          annotations: records.length,
          onBack: () => {
            setFull(false);
            onOpenFile(null);
          },
          onWriteReply: () => {
            setFull(false);
            openBox(picksCount > 0);
          },
        }}
      />
    )}
    </>
  );
}

/**
 * What a Send does with the questions left unanswered: "↷ 3 unanswered
 * questions will be skipped · Keep open", or, after Keep open, "3 unanswered
 * questions stay open · Skip them". Nothing when none is unanswered.
 */
function SkipChip({ count, keepOpen, onToggle }: { count: number; keepOpen: boolean; onToggle: () => void }) {
  if (count === 0) return null;
  const them = count === 1 ? 'it' : 'them';
  return (
    <span className="ib-skipchip" data-skip-chip={keepOpen ? 'keep' : 'skip'}>
      {/* The icon and the sentence are one item, so where the chip wraps (a narrow reply box) the icon stays with its words. */}
      <span className="ib-skip-s">
        {!keepOpen && <Icon name="forward" size={14} />}
        {keepOpen ? `${plural(count, 'unanswered question')} ${count === 1 ? 'stays' : 'stay'} open` : `${plural(count, 'unanswered question')} will be skipped`}
      </span>
      <button type="button" onClick={onToggle} data-skip-toggle="">
        {keepOpen ? `Skip ${them}` : 'Keep open'}
      </button>
    </span>
  );
}

/** The decision card for one question, drafted from its answer as it is now (a pick not yet saved included). */
function ThreadDecisionCard({
  thread,
  card,
  answersOf,
  onCancel,
  onDone,
}: {
  thread: InboxThread;
  card: { messageId: string; key: string; anchor: HTMLElement };
  answersOf: (message: InboxMessageWire) => Map<string, QuestionAnswer>;
  onCancel: () => void;
  onDone: (messageId: string, key: string, draft: InboxDecisionDraft | null) => Promise<void>;
}) {
  const message = thread.messages.find((m) => m.id === card.messageId);
  const question = message?.questions?.find((q) => q.key === card.key);
  if (!message || !question) return null;
  const drafted = inboxDecisionWords({
    answer: answersOf(message).get(card.key) ?? null,
    prompt: question.prompt,
    askerName: agentName(message.author),
    draft: null,
  });
  return (
    <DecisionCard
      key={`${card.messageId}/${card.key}`}
      anchor={card.anchor}
      drafted={drafted}
      draft={question.decision_draft}
      projectName={thread.project.name}
      onCancel={onCancel}
      onDone={(draft) => onDone(card.messageId, card.key, draft)}
    />
  );
}
