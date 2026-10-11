import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxDecision, InboxDecisionDraft, InboxMessageWire, InboxProjectRepo, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionAnswer } from '@plannotator/core/question-block';
import { inboxDecisionWords } from '@plannotator/core/inbox-questions';
import { isInboxTextKind, readInboxAttachmentKind, type InboxAnnotationRecord, type InboxAttachment, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { NOT_ATTACHED_TITLE, attachmentDeepLink, attachmentDisplayPath, attachmentForLink, openAttachmentTitle, useRefRepo } from '../links';
import { InboxApiError, inboxApi, type AttachmentsModel } from '../api';
import { annotationOf, attachmentFeedback } from '../attachments';
import { AttachmentTiles } from './AttachmentTiles';
import { AttachmentPane, type AttachmentPaneHandle } from './AttachmentPane';
import { attachmentSequence } from '../stepping';
import { AnnotationsChip } from './AnnotationsChip';
import { agentName, clockTime, dayWords, plural } from '../format';
import { answerWords, foldSnippet, holdingsOf, isDelivered, lookBoundary, newSinceLook, planFolds, snippetText, type FoldSnippet, type Holding } from '../folding';
import { AuthorMark, DecisionDiamond, Icon } from '../icons';
import { DecisionCard } from './DecisionCard';
import { GuideCard } from './GuideCard';
import { inboxMessageImageBase } from '../images';
import { reportUnsentReply } from '../unsent';
import { NewMessageButton, NewMessageComposer, NewMessagePopover, hostName, useLiveSessions, type NewMessageMode } from './NewMessage';
import { ChangedNotice, ReplacedQuestionCard, ReplacesLine, StaleGuard, replacedBy, replacementOf, type JumpTarget } from './ReplacedQuestion';

const noop = () => {};
/** The agent superseded the question this call named (`422 question_superseded`). */
const isSuperseded = (cause: unknown): boolean => cause instanceof InboxApiError && cause.code === 'question_superseded';
const NO_ANNOTATIONS: never[] = [];

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

/** The first new message whose top is below the view (under the pill's band), or null. */
function newBelow(body: HTMLElement): HTMLElement | null {
  const bottom = body.getBoundingClientRect().bottom - 56;
  return [...body.querySelectorAll<HTMLElement>('[data-message-article][data-new]')].find((a) => a.getBoundingClientRect().top > bottom) ?? null;
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

  return (
    <div className="ib-body" data-message-id={message.id}>
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
        renderQuestionCard={renderReplacedCard ? questionCard : undefined}
        renderQuestionBelowPrompt={renderReplacesLine ? belowPrompt : undefined}
      />
    </div>
  );
}

export interface ThreadPaneProps {
  thread: InboxThread;
  /**
   * The thread's list row's `sent`: the person's reply is the last message,
   * and when the agent read it (by the store's seq, so a reply the agent was
   * not given still reads as unread), or null.
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
}

/**
 * A narrow window (a phone, under 768 px, where Plannotator's annotation panel
 * becomes an overlay): the open file takes the whole window.
 */
function useNarrowWindow(): boolean {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const list = matchMedia(query);
    const onChange = () => setNarrow(list.matches);
    onChange();
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, []);
  return narrow;
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

export function ThreadPane({ thread, sent, onQuestions, onChanged, onClose, decisions, onOpenDecisionPage, file, onOpenFile, onOpenGuide, lookSeq }: ThreadPaneProps) {
  const root = thread.messages[0]!;
  const asker = agentName(root.author);
  const resolved = thread.resolved_at !== null;
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
    () => (opened === null ? null : Math.max(opened, ...thread.messages.filter((m) => m.author.kind === 'person').map((m) => m.seq ?? 0))),
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
  const toggleMessage = (id: string) => {
    const folding = !fold.folded.has(id);
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
      setFoldState((current) => (current ? { ...current, folded: new Set(thread.messages.filter((m) => m !== last).map((m) => m.id)), revealed: new Set() } : current));
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

  // New message (record 5.x): the project's live sessions, and what the button opened.
  const { model: live, load: loadLive } = useLiveSessions(thread.thread_id);
  const [newMessage, setNewMessage] = useState<NewMessageMode>(null);
  const pressNewMessage = async () => {
    if (newMessage?.kind === 'pick' || newMessage?.kind === 'none') {
      setNewMessage(null);
      return;
    }
    const now = await loadLive();
    const sessions = now?.sessions ?? [];
    setBox({ open: false, text: '' });
    setNewMessage(sessions.length === 0 ? { kind: 'none' } : sessions.length === 1 ? { kind: 'compose', target: sessions[0]! } : { kind: 'pick' });
  };

  // Attachments (step 2): the files as they are now, and the annotations that ride the next Send.
  const { model: files, load: reloadFiles, patch: patchRecords } = useThreadAttachments(thread.thread_id, thread);
  const attachments: InboxAttachmentState[] = files?.attachments ?? [];
  const records = files?.annotations ?? [];
  const fileRecords = useMemo(() => records.filter((r) => !r.guide), [records]);
  /** Something here takes annotations: an attached file, or a guided review's diffs. */
  const takesAnnotations = attachments.length > 0 || records.length > 0 || thread.messages.some((m) => m.guide);
  const [full, setFull] = useState(false);
  /** A narrow window (a phone): the open file is always full screen. */
  const phone = useNarrowWindow();
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
    sendKeys.current = null;
    revisions.current.clear();
  }, [thread.thread_id]);

  // The subject in the header once it scrolls away, and the "↓ N new" pill while new messages are below the view.
  const [chrome, setChrome] = useState({ subject: false, pill: false });
  const updateChrome = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const box = body.getBoundingClientRect();
    const subject = body.querySelector<HTMLElement>('.ib-subject');
    const next = {
      subject: subject !== null && subject.getBoundingClientRect().bottom < box.top + 4,
      // Any new message below the view, not only the first.
      pill: newBelow(body) !== null,
    };
    setChrome((current) => (current.subject === next.subject && current.pill === next.pill ? current : next));
  }, []);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.addEventListener('scroll', updateChrome, { passive: true });
    window.addEventListener('resize', updateChrome);
    // The thread's own box changes without a scroll or a window resize when
    // the foot grows (the reply box, the stale guard, the New-message
    // composer) or a file opens beside it.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => updateChrome()) : null;
    resized?.observe(body);
    return () => {
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
  }, [foldState, thread, file?.id, updateChrome]);

  /**
   * n goes to the first new message (at the divider); the pill to the first
   * new message below the view, which is the first new one unless the person
   * has read past it.
   */
  const jumpNew = useCallback((below = false) => {
    const body = bodyRef.current;
    const first = body?.querySelector<HTMLElement>('[data-message-article][data-new]');
    if (!body || !first) return;
    const target = below ? (newBelow(body) ?? first) : first;
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
      return at ? `Sent ${clockTime(at)}` : 'Sent';
    }
    if (q.state === 'picked' && q.picked_at) return `Picked ${clockTime(q.picked_at)}, not sent`;
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
  const lastReplyAt = thread.messages.filter((m) => m.author.kind === 'person').at(-1)?.created_at ?? '';
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

  const openBox = (withDraft: boolean) => {
    setNewMessage(null);
    const draft = withDraft ? picked.map((q) => (q.answer ? `${q.prompt.replace(/[?.!]\s*$/, '')}: ${answerWords(q.answer)}.` : '')).filter(Boolean).join(' ') : '';
    setBox({ open: true, text: draft });
    setError(null);
  };

  const send = async (options: { despiteReplaced?: boolean } = {}) => {
    if (sending) return;
    // A pick was replaced while the person was answering: nothing goes until they have read that.
    if (staleQuestions.length > 0 && !options.despiteReplaced) {
      setGuard(true);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await pickChain.current;
      const current = threadRef.current;
      const words = box.open ? box.text.trim() : '';
      const targets = current.messages
        .filter((m) => m.author.kind === 'agent' && (m.questions ?? []).some((q) => q.state === 'picked'))
        .map((m) => ({
          message: m,
          questions: (m.questions ?? []).filter((q) => q.state === 'picked').map((q) => ({ key: q.key, revision: q.revision })),
        }));
      const pendingAnnotations = records;
      if (targets.length === 0) {
        if (!words && pendingAnnotations.length === 0) {
          setError('Write a reply or pick an answer first.');
          return;
        }
        const last = current.messages.filter((m) => m.author.kind === 'agent').at(-1) ?? current.messages[0]!;
        targets.push({ message: last, questions: [] });
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
          ...(last && feedback ? { feedback, annotation_ids: pendingAnnotations.map((r) => r.id) } : {}),
        });
        notRecorded.push(...result.decisions_refused);
      }
      setRefused(notRecorded);
      sendKeys.current = null;
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
      setError(cause instanceof InboxApiError ? cause.message : 'The reply was not sent. Send again to retry.');
    } finally {
      setSending(false);
    }
  };

  const resolve = async (next: boolean) => {
    setError(null);
    try {
      await inboxApi.resolve(root.id, next);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The thread did not change.');
    }
  };

  // The last message is the person's: say where it is. A New message names
  // the session's host it went to, and is delivered as a turn (step 8).
  const last = thread.messages[thread.messages.length - 1]!;
  const delivered =
    last.author.kind !== 'person'
      ? null
      : last.to
        ? last.delivery
          ? { state: 'delivered', text: `Delivered to ${hostName(last.delivery.host)}, ${clockTime(last.delivery.at)}` }
          : { state: 'queued', text: `${hostName(last.to.host)} takes it as its next turn.` }
        : sent?.checked_at
          ? { state: 'delivered', text: `Delivered to ${asker}, ${clockTime(sent.checked_at)}` }
          : { state: 'saved', text: `Saved for ${asker}. It sees it when it checks.` };

  const waitingHoldsUp = [...new Set(lastAgent.questions?.filter((q) => q.state === 'open').flatMap((q) => q.holds_up) ?? [])];
  const [holdsOpen, setHoldsOpen] = useState(false);

  const openAttachment = file ? attachments.find((a) => a.id === file.id) ?? null : null;
  const fileOpen = openAttachment !== null;

  return (
    <>
    <section
      ref={sectionRef}
      className={`ib-pane${fileOpen ? ' ib-withfile' : ''}`}
      aria-label={thread.subject ?? 'Thread'}
      data-thread-id={thread.thread_id}
    >
      <div className="ib-phead">
        <button
          type="button"
          className="ib-iconbtn"
          onClick={() => void resolve(!resolved)}
          title={resolved ? 'Reopen the thread' : 'Resolve the thread'}
          aria-label={resolved ? 'Reopen the thread' : 'Resolve the thread'}
        >
          <Icon name="archive" />
        </button>
        {one ? (
          <span className="ib-sp" />
        ) : (
          <>
            {/* The subject, once it has scrolled away (the heading stays the one a screen reader reads). */}
            <span className="ib-phsubj" data-header-subject="" data-on={chrome.subject ? '' : undefined} aria-hidden="true">
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
        <button type="button" className="ib-iconbtn" onClick={onClose} title="Close" aria-label="Close the thread">
          <Icon name="x" />
        </button>
      </div>
      <div className={`ib-pbody${one ? '' : ' ib-folding'}`} ref={bodyRef}>
        <h2 className="ib-subject">{thread.subject ?? '(no subject)'}</h2>
        {!one && (
          <div className="ib-tmeta" data-thread-meta="">
            <span>{plural(thread.messages.length, 'message')}</span>
            <span className="ib-tdot" aria-hidden="true" />
            <span>{spanWords(root.created_at, last.created_at)}</span>
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
          const time = clockTime(message.created_at);
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
                  <span className="ib-fl-nm">{name}</span>
                  <span className="ib-fl-sn" data-snippet={snippet.kind} title={snippetText(snippet)}>
                    <SnippetText snippet={snippet} />
                  </span>
                  <HoldingChips holdings={holdings} />
                  <span className="ib-fl-tm">
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
          const who = (
            <>
              {isAgent ? (
                <AuthorMark author={message.author} big />
              ) : (
                <span className="ib-mk ib-big">
                  <Icon name="reply" />
                </span>
              )}
              {/* Spans, not divs: in a multi-message thread this sits inside the fold button. */}
              <span className="ib-whobox">
                <span className="ib-who">
                  {name} <span>in {thread.project.name}</span>
                </span>
                <span className="ib-to">to {isAgent ? 'you' : message.to ? hostName(message.to.host) : asker}</span>
              </span>
            </>
          );
          before.push(
            <article
              className="ib-message"
              key={message.id}
              data-author={message.author.kind}
              data-message-article={message.id}
              data-open={one ? undefined : ''}
              data-new={isNew ? '' : undefined}
              tabIndex={-1}
            >
              <div className="ib-sender">
                {one ? (
                  who
                ) : (
                  // The sender is the fold button; the time and Reply stay beside it.
                  <button
                    type="button"
                    className="ib-head"
                    data-fold-head=""
                    aria-expanded={true}
                    aria-label={`${name}, ${time}${isNew ? ', new' : ''}. Fold this message`}
                    onClick={() => toggleMessage(message.id)}
                  >
                    {who}
                  </button>
                )}
                <div className="ib-tm">
                  {isNew && <span className="ib-newtag">New</span>}
                  {time}
                  {isAgent && !resolved && (
                    <button type="button" className="ib-mut" onClick={() => openBox(picksCount > 0)} title="Reply" aria-label="Reply">
                      <Icon name="reply" size={15} />
                    </button>
                  )}
                </div>
              </div>
              <div className="ib-msg">
                <MessageBody
                  message={message}
                  projectRoot={thread.project.root}
                  repo={thread.project.repo ?? null}
                  onOpenAttachment={openFromMessage}
                  readOnly={!isAgent || resolved || questions.length === 0 || allSent}
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
                    openId={file && !full && !phone ? file.id : null}
                  />
                )}
                {message.guide && <GuideCard guide={message.guide} onOpen={() => onOpenGuide(message.id)} />}
                {message === lastAgent && !resolved && waitingHoldsUp.length > 0 && (
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
                    <Icon name="check" size={14} />
                    {delivered.text}
                  </div>
                )}
              </div>
            </article>,
          );
          return before;
        })}
        {showNew && (
          // While new messages are below the view: a pill that goes to them.
          <div className="ib-npill-wrap">
            <button type="button" className="ib-npill" data-new-pill="" data-off={chrome.pill ? undefined : ''} tabIndex={chrome.pill ? 0 : -1} aria-hidden={!chrome.pill} onClick={() => jumpNew(true)}>
              <Icon name="arrowDown" size={15} />
              {fresh.size} new
            </button>
          </div>
        )}
        <div className="ib-sr" aria-live="polite" data-fold-live="">
          {announced}
        </div>
      </div>
      <div className="ib-pfoot">
        {resolved ? (
          <div className="ib-acts">
            <span className="ib-st">Resolved</span>
            <button type="button" className="ib-btn" onClick={() => void resolve(false)}>
              Reopen
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
                placeholder="Write a reply"
                value={box.text}
                rows={2}
                onChange={(event) => setBox({ open: true, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void send();
                  } else if (event.key === 'Escape') {
                    event.stopPropagation();
                    setBox({ open: false, text: '' });
                  }
                }}
              />
              {(picksCount > 0 || dropped.length > 0 || takesAnnotations) && (
                <div className="ib-rfoot">
                  {picksCount > 0 && (
                    <span className="ib-rchip" data-picks-chip="">
                      <Icon name="check" size={13} />
                      {plural(picksCount, 'pick')}
                    </span>
                  )}
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
            <div className="ib-acts">
              <button type="button" className="ib-btn ib-pri" ref={sendRef} onClick={() => void send()} disabled={sending}>
                <Icon name="send" size={15} />
                Send
              </button>
              <button type="button" className="ib-btn ib-ghost" onClick={() => setBox({ open: false, text: '' })}>
                Cancel
              </button>
              <span className="ib-sp" />
              <NewMessageButton live={live} mode={newMessage} onClick={() => void pressNewMessage()} />
            </div>
          </>
        ) : (
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
            <NewMessageButton live={live} mode={newMessage} onClick={() => void pressNewMessage()} />
          </div>
        )}
        {!resolved && (
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
        full={full || phone}
        phone={phone}
        steps={steps}
        // A step keeps the frame the person is in, and replaces the route.
        onStep={(attachmentId, version) => onOpenFile({ id: attachmentId, version, focus: null }, { replace: true })}
        onToggleFull={() => setFull((v) => !v)}
        focusId={file!.focus}
        focusRequest={paneFocus}
        readOnly={resolved}
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
