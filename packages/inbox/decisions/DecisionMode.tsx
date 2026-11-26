/**
 * Decision mode (approval "inbox-decision-mode", direction A "Queue"; on unless Settings → Capabilities turns it off).
 *
 * One decision at a time in a large dialog over the dimmed Inbox, the next peeking behind it, a strip of one chip per
 * agent session. Each question is the thread's own card (DecisionCard.tsx). Its answer is the thread's draft, saved
 * through the existing picks route as the person answers (typed words after a pause, as in the thread).
 *
 * Nothing sends by itself (the owner, 2026-11-24). The Send button is always there and sends what is answered so far
 * through the existing reply route, one reply per agent session per thread (`sendTargetsOf`); what is not answered
 * stays open. Closing at any point keeps every answer as a draft on its card in the thread. After a Send the chip goes
 * Delivered, then Working, then Replied.
 *
 * Pictures open in the dialog's own viewer (ui ImageLightbox), and a question's prototypes in the thread's prototype
 * window, both over the dialog, so the person never leaves it. An attached file (not a picture) or a file the
 * message names opens beside the thread as from the thread's card: the dialog tucks into its pill meanwhile and comes
 * back on the same card once the file closes.
 *
 * No new keyboard shortcuts: Tab, Enter, Space, the arrows inside a choice group, and Escape, which walks out one
 * layer at a time (a field, the overview, then the dialog).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import type { InboxDecision, InboxInlineImage, InboxListRow, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind } from '@plannotator/core/inbox-types';
import { whenTime } from '@plannotator/core/inbox-format';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError, inboxApi } from '../api';
import { replyKeysToRenew, type SendTarget, type SentContents } from '../sendTargets';
import { agentName, formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { prefersReducedMotion } from '../settle';
import { registerReloadFlush } from '../stalePage';
import { Tip } from '../components/Tip';
import { inboxMessageImageUrl } from '../images';
import { choiceName } from '../optionSets';
import type { FileRef } from '../fileRefs';
import { usePickSave } from '../data/actions/picks';
import { useInboxQueryClient } from '../data/client';
import { changeThread } from '../data/queries/thread';
import { usePageLeave } from '../pageLeave';
import { createDecisionSaves, withPendingAnswers } from './saves';
import { useReasonDrafts } from './reasonDrafts';
import { DecisionCard, attachmentPictureUrl, type CardBody, type CardPicture } from './DecisionCard';
import { DecisionPrototype, useSittingThread } from './sittingThread';
import {
  AFTER_SEND_ORDER,
  AFTER_SEND_WORDS,
  afterSendOf,
  answerWords,
  emptyQueue,
  failedWords,
  freshPicks,
  groupIds,
  groupKeyOf,
  groupKeys,
  groupSendTargets,
  headLine,
  isActionDecision,
  isHandled,
  leftCount,
  markReplaced,
  mergeDecisions,
  nextId,
  placeAfter,
  previousId,
  putOff,
  replacementOf,
  sessionChips,
  chipDomKey,
  type GroupSend,
  type QueueState,
  type SessionChip,
} from './model';
import { newUuid } from '../uuid';
import { useOtherFieldVoice } from '../components/FieldVoice';

/** The answer lands as a stamp before the card leaves (brief §7). */
const STAMP_MS = 350;

export interface DecisionModeProps {
  /** The dialog is on screen (false while tucked into the pill behind an open thread). */
  open: boolean;
  /** The latest projection (`GET /api/inbox/decisions`), null until read. */
  decisions: readonly InboxDecision[] | null;
  /** The thread the sitting is scoped to, by its subject: drawn in the head; null or absent: nothing drawn. */
  scope?: string | null;
  /** The list rows, by thread id: where a sent reply is (Delivered, Replied). */
  rows: ReadonlyMap<string, InboxListRow>;
  /** Start on this decision. */
  start?: string | null;
  /** A new start: moves to `start` again. */
  startNonce?: number;
  phone: boolean;
  /** Read the projection again now. */
  refresh: () => void;
  /** The event stream's question lines (a replaced question swaps on screen). */
  subscribeQuestions: (listener: (question: InboxQuestion) => void) => () => void;
  /**
   * Open the thread behind the dialog: decision mode tucks into a pill. A card's "Open the thread" names its question
   * (`<message id>`, `key`): the thread scrolls to that question's card and puts focus on its prompt. `file`: an
   * attached file's id, or a file the message names; the dialog comes back once it closes.
   */
  onTuck: (threadId: string, file?: string | (FileRef & { messageId: string }), question?: { messageId: string; key: string }) => void;
  /** The sitting ends. */
  onClose: () => void;
  /** Tells the pill how many are left. */
  onLeft?: (left: number) => void;
  /**
   * Something went wrong while the dialog is closed or tucked away (a Send still on its way, an answer's save): the
   * window says so in its toast, the thread one press away.
   */
  onAway?: (notice: DecisionAwayNotice) => void;
}

/** What the window tells about a sitting it no longer shows. */
export interface DecisionAwayNotice {
  /** `send`: a reply did not go (its answers are drafts in the thread); `save`: an answer; `reason`: a Can't do it's reason. */
  kind: 'send' | 'save' | 'reason';
  threadId: string;
  /** The thread's subject, when known. */
  subject: string | null;
}

interface UndoEntry {
  id: string;
  kind: 'pick' | 'action' | 'later';
  before: QuestionAnswer | null;
  /** A Can't do it's reason: Undo puts it back under the card as its draft. */
  note?: string;
  /** When it was done (an action item's Done can be undone only inside its window). */
  at: number;
}

interface Banner {
  agent: string;
  withdrawn: boolean;
}

/** What one group's Send came to. */
type SendResult = 'sent' | 'draft' | 'failed';

/**
 * What a reply carries, for its key (`replyKeysToRenew`): each pick with its revision, so a changed answer (a new
 * pick is a new revision) takes a new key, and an unchanged retry replays the old one; and each action item whose
 * Done or Can't do it waits in the thread's draft, so one marked since takes a new key.
 */
function answersOf(target: SendTarget): string[] {
  return [
    ...target.questions.map((q) => `a:${q.message_id ?? target.message.id}/${q.key}@${q.revision}`),
    ...target.skip.map((q) => `s:${q.message_id ?? target.message.id}/${q.key}`),
    ...target.actions.map((a) => `x:${a.message_id ?? target.message.id}/${a.key}`),
  ];
}

/** The decision id of one of `answersOf`'s entries. */
function answerIdOf(entry: string): string {
  return entry.slice(2).replace(/@\d+$/, '');
}

/** A pick that answers a pick-one question at once (a choice, or Skip): the queue moves on when a click made it. */
function settlesAtOnce(decision: InboxDecision, before: QuestionAnswer | null, answer: QuestionAnswer | null): boolean {
  if (!answer) return false;
  if (answer.skipped) return !before?.skipped;
  if (readInboxQuestionKind(decision.question.kind) !== 'single' || answer.selected.length !== 1 || answer.other?.trim()) return false;
  return before?.selected[0] !== answer.selected[0] || !!before?.skipped;
}

export function DecisionMode(props: DecisionModeProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [queue, setQueue] = useState<QueueState>(emptyQueue);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const [sends, setSends] = useState<Map<string, GroupSend>>(new Map());
  const sendsRef = useRef(sends);
  sendsRef.current = sends;
  /** The decisions each group's replies carried in this sitting (a follow-up answered later is not among them). */
  const [carried, setCarried] = useState<Map<string, Set<string>>>(new Map());
  /** Every decision a reply of this sitting carried. */
  const sentIds = useMemo(() => new Set([...carried.values()].flatMap((ids) => [...ids])), [carried]);
  const sentIdsRef = useRef(sentIds);
  sentIdsRef.current = sentIds;
  /** Sends on their way, by group: a second Send waits for the one on its way. */
  const inFlight = useRef(new Map<string, Promise<SendResult>>());
  /** The same groups as state, for what the render draws from them (the card's "Sending" lock, Undo, the Send button). */
  const [inFlightKeys, setInFlightKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** Each reply's idempotency key and what it carried, by (group, message): a key is renewed when the answers change. */
  const sendKeys = useRef(new Map<string, string>());
  const sendContents = useRef(new Map<string, SentContents>());
  const rowsRef = useRef(props.rows);
  rowsRef.current = props.rows;
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const [stamp, setStamp] = useState<{ id: string; value: QuestionAnswer | 'done' | 'cant' } | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const pendingSwap = useRef<{ old: string; replacement: string } | null>(null);
  /** A replacement on its way: the sitting is not done while it is. */
  const [swapPending, setSwapPending] = useState(false);
  const [overview, setOverview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState<Map<string, boolean>>(new Map());
  const [lightbox, setLightbox] = useState<{ pictures: CardPicture[]; index: number } | null>(null);
  /** The question whose prototypes are open over the dialog (`<message id>/<key>`). */
  const [proto, setProto] = useState<{ messageId: string; key: string } | null>(null);
  /** An action item's marks on their way, in order (a pick's answers go through `saves`). */
  const pickChain = useRef<Promise<void>>(Promise.resolve());
  /** Each decision's revision as the projection last said. */
  const revisions = useRef(new Map<string, number>());
  /** Action items whose mark is on its way to the server. */
  const pendingPicks = useRef(new Set<string>());
  const fieldOpenRef = useRef<(() => boolean) | null>(null);
  const escapedAt = useRef(0);
  const reduced = prefersReducedMotion();
  const pickSave = usePickSave();
  const pickSaveRef = useRef(pickSave);
  pickSaveRef.current = pickSave;
  const client = useInboxQueryClient();
  const propsRef = useRef(props);
  propsRef.current = props;
  /** The dialog is gone (closed) or tucked into its pill: what goes wrong now is told by the window's toast. */
  const goneRef = useRef(false);
  const awayRef = useRef(!props.open);
  awayRef.current = goneRef.current || !props.open;

  // The sitting's thread, as the thread pane holds it: the card draws its message from there.
  const threadIdRef = useRef<string | null>(null);
  if (props.decisions?.[0]) threadIdRef.current = props.decisions[0].thread.id;
  const sitting = useSittingThread(threadIdRef.current);
  const held = sitting.held;
  const heldRef = useRef(held);
  heldRef.current = held;
  const messageOf = (id: string): InboxMessageWire | undefined => held?.thread.messages.find((m) => m.id === id);
  /** How many answers' save failures the window's toast told: a Send that then sends nothing tells it only once. */
  const savesToldAway = useRef(0);
  /** The thread of the sitting, for the window's toast. */
  const away = (kind: DecisionAwayNotice['kind']) => {
    if (kind === 'save') savesToldAway.current += 1;
    const threadId = threadIdRef.current;
    if (threadId) propsRef.current.onAway?.({ kind, threadId, subject: heldRef.current?.thread.subject ?? propsRef.current.scope ?? null });
  };

  /** Answers given here and not yet saved (drawn at once; the saved copy replaces them). Kept when a save fails. */
  const [pending, setPending] = useState<ReadonlyMap<string, QuestionAnswer | null>>(new Map());
  // The thread's own save machinery (saves.ts): typed words after their pause, one save at a time, conflicts saved over.
  const [saves] = useState(() =>
    createDecisionSaves({
      pick: (save) => pickSaveRef.current.mutateAsync(save),
      known: (id) => {
        const slash = id.indexOf('/');
        const onThread = heldRef.current?.thread.messages.find((m) => m.id === id.slice(0, slash))?.questions?.find((q) => q.key === id.slice(slash + 1));
        return Math.max(revisions.current.get(id) ?? 0, queueRef.current.cache.get(id)?.question.revision ?? 0, onThread?.revision ?? 0);
      },
      onPending: (next) => {
        if (!goneRef.current) setPending(next);
      },
      onSaved: (id, questions) => {
        const saved = questions.find((q) => `${q.message_id}/${q.key}` === id);
        if (!saved) return;
        revisions.current.set(id, saved.revision);
        setQueue((current) => {
          const known = current.cache.get(id);
          return known ? { ...current, cache: new Map(current.cache).set(id, { ...known, question: saved }) } : current;
        });
      },
      onFailed: (_id, message) => {
        if (awayRef.current) away('save');
        else setError(message);
      },
      onChanged: () => propsRef.current.refresh(),
    }),
  );
  /** The reasons typed under "Can't do it…", drafts like every answer (reasonDrafts.ts). */
  const { reasons, texts: reasonTexts } = useReasonDrafts((message) => {
    if (awayRef.current) away('reason');
    else setError(message);
  });
  /** The answers not saved yet go into the held thread: the thread card shows the dialog's latest words at once. */
  const showPendingInThread = useCallback(() => {
    const threadId = threadIdRef.current;
    if (threadId) changeThread(client, threadId, (model) => withPendingAnswers(model, saves.pending()));
  }, [client, saves]);

  /** Typed words waiting for their pause are saved now (a click, Send, a move, the dialog closing). */
  const flushTyped = useCallback(() => {
    saves.flush();
    reasons.flush();
  }, [saves, reasons]);
  // The stale page notice's Reload (stalePage.ts) waits for every save; one not saved stops the reload (false).
  useEffect(
    () =>
      registerReloadFlush(async () => {
        const saved = await Promise.all([saves.settled(), reasons.settled()]);
        for (let seen = pickChain.current; ; seen = pickChain.current) {
          await seen;
          if (seen === pickChain.current) break;
        }
        return saved.every(Boolean);
      }),
    [saves, reasons],
  );
  // The page hiding or going (a reload, a closed tab, a phone switching apps): the words in their pause go now.
  usePageLeave(() => {
    saves.leave();
    reasons.leave();
  });
  // The dialog going (closed, or the window left decision mode): the words still waiting are saved, the thread card
  // shows what is still on its way, and an answer not saved goes again (a failure now is told by the window's toast).
  useEffect(() => {
    goneRef.current = false;
    return () => {
      goneRef.current = true;
      awayRef.current = true;
      saves.flush();
      showPendingInThread();
      void saves.settled();
      void reasons.settled();
    };
  }, [saves, reasons, showPendingInThread]);

  // ── The dialog itself: a native modal <dialog>, shown while open. ──
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  // Tucked into the pill, the words waiting are saved (the thread behind shows them as its draft, at once).
  useEffect(() => {
    if (props.open) return;
    flushTyped();
    showPendingInThread();
  }, [props.open, flushTyped, showPendingInThread]);

  // ── The projection folded in. ──
  useEffect(() => {
    if (!props.decisions) return;
    // The card on screen left the projection without the person's answer: ask its thread why
    // (the agent replaced it, or the thread was archived or answered elsewhere).
    const shown = queueRef.current.current;
    if (shown && !props.decisions.some((d) => d.id === shown) && !queueRef.current.gone.has(shown) && !isHandled(queueRef.current, shown)) void checkGone(shown);
    setQueue((current) => {
      // An answer not saved yet (on its way, or refused and kept) keeps its card as the person left it.
      let next = mergeDecisions(current, props.decisions!, sentIdsRef.current, new Set([...pendingPicks.current, ...saves.pending().keys()]));
      for (const d of props.decisions!) revisions.current.set(d.id, Math.max(revisions.current.get(d.id) ?? 0, d.question.revision));
      const nonce = props.startNonce ?? 0;
      if (props.start && appliedStart.current !== nonce && next.order.includes(props.start)) {
        appliedStart.current = nonce;
        return { ...next, current: props.start, later: new Set([...next.later].filter((l) => l !== props.start)) };
      }
      const swap = pendingSwap.current;
      if (swap && next.cache.has(swap.replacement)) {
        pendingSwap.current = null;
        swapDoneRef.current = true;
        next = placeAfter(next, swap.replacement, swap.old);
        if (next.current === swap.old || next.current === null || isHandled(next, next.current)) next = { ...next, current: swap.replacement };
      }
      return next;
    });
    if (swapDoneRef.current) {
      swapDoneRef.current = false;
      setSwapPending(false);
    }
  }, [props.decisions, props.start, props.startNonce]);
  const appliedStart = useRef<number | null>(null);
  const swapDoneRef = useRef(false);

  // A replacement on its way counts as one left (the pill and the end screen wait for it).
  useEffect(() => props.onLeft?.(leftCount(queue) + (swapPending ? 1 : 0)), [queue, swapPending, props.onLeft]);
  // A replacement that never comes (answered elsewhere, or not this session's): the queue goes on without it.
  useEffect(() => {
    if (!swapPending) return;
    const timer = setTimeout(() => {
      pendingSwap.current = null;
      setSwapPending(false);
    }, 8000);
    return () => clearTimeout(timer);
  }, [swapPending]);

  // ── A question the agent replaced while the queue held it. ──
  const onReplaced = useCallback(
    (question: InboxQuestion) => {
      if (question.state !== 'superseded') return;
      const id = `${question.message_id}/${question.key}`;
      const state = queueRef.current;
      if (!state.order.includes(id) || state.gone.get(id) === 'replaced') return;
      const replacement = replacementOf(question);
      const old = state.cache.get(id);
      setQueue((current) => markReplaced(current, question));
      if (state.current === id) {
        setBanner({ agent: old ? agentLabel(old) : 'The agent', withdrawn: replacement === null });
        if (replacement) {
          pendingSwap.current = { old: id, replacement };
          setSwapPending(true);
        } else setQueue((current) => ({ ...current, current: nextId(current, id) }));
      }
      props.refresh();
    },
    [props.refresh],
  );
  useEffect(() => props.subscribeQuestions(onReplaced), [props.subscribeQuestions, onReplaced]);

  /** Why the card on screen left: replaced (the banner and the swap), else it stays where it is. */
  const checkGone = async (id: string) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    try {
      const { thread } = await inboxApi.thread(decision.thread.id);
      const question = thread.messages.flatMap((m) => [...(m.questions ?? []), ...(m.actions ?? [])]).find((q) => `${q.message_id}/${q.key}` === id);
      if (question?.state === 'superseded') return onReplaced(question);
    } catch {
      // The thread is gone (deleted): the next card.
    }
    setQueue((current) => (current.current === id ? { ...current, current: nextId(current, id) } : current));
  };

  // ── Send: only when the person presses it. ──
  /** Whether a thread's reply goes from the thread: a reply draft, or comments waiting for the thread's Send. */
  const setSend = (key: string, value: GroupSend) => setSends((current) => new Map(current).set(key, value));

  /**
   * Send one group's reply: `sent` (or nothing was left to send), `draft` (the thread's reply goes from the
   * thread), or `failed`. A send already on its way is the one awaited.
   */
  const sendGroup = useCallback((key: string): Promise<SendResult> => {
    const running = inFlight.current.get(key);
    if (running) return running;
    const run = sendOnce(key);
    inFlight.current.set(key, run);
    setInFlightKeys((current) => new Set(current).add(key));
    void run.finally(() => {
      inFlight.current.delete(key);
      setInFlightKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    });
    return run;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refresh]);

  const sendOnce = async (key: string): Promise<SendResult> => {
    const state = queueRef.current;
    const first = groupIds(state, key).map((id) => state.cache.get(id)).find((d): d is InboxDecision => d !== undefined);
    if (!first) return 'sent';
    const before = sendsRef.current.get(key) ?? { kind: 'waiting' as const };
    setSend(key, { kind: 'sending' });
    /** The replies of this group (one per message) that went, of how many. */
    let replies = { went: 0, of: 0 };
    try {
      await pickChain.current;
      // A thread whose reply goes from the thread (a reply draft, comments waiting): never from here. Both are
      // read fresh (the draft, and the thread's own row for its comments); a read that fails sends nothing.
      let draft: { draft: unknown };
      let model: Awaited<ReturnType<typeof inboxApi.thread>>;
      try {
        [draft, model] = await Promise.all([inboxApi.replyDraft(first.thread.id), inboxApi.thread(first.thread.id)]);
      } catch {
        setSend(key, { kind: 'failed', error: "Couldn't check the thread for a draft reply, so nothing was sent." });
        return 'failed';
      }
      const reply = draft.draft !== null && draft.draft !== undefined;
      // The thread's own row is the fresh count; an older Inbox without it falls back to the list's row.
      const comments = (model.row !== undefined ? model.row?.unsent?.comments : rowsRef.current.get(first.thread.id)?.unsent?.comments) ?? 0;
      if (reply || comments > 0) {
        setSend(key, { kind: 'draft' });
        return 'draft';
      }
      const { thread } = model;
      const targets = groupSendTargets(thread, first.session.key);
      if (targets.length === 0) {
        // Sent from the thread meanwhile: nothing left here.
        setSend(key, before.kind === 'sent' ? before : { kind: 'waiting' });
        props.refresh();
        return 'sent';
      }
      let sentAt: string | null = null;
      replies = { went: 0, of: targets.length };
      for (const target of targets) {
        const keyId = `${key}\u0002${target.message.id}`;
        const contents: SentContents = { value: target.message.id, answers: answersOf(target) };
        const last = sendContents.current.get(keyId);
        // A replay of a key answers the reply it wrote: a changed answer (a new revision) takes a new key.
        const renew = !sendKeys.current.has(keyId) || (last !== undefined && replyKeysToRenew(new Map([[keyId, last]]), new Map([[keyId, contents]])).length > 0);
        if (renew) sendKeys.current.set(keyId, newUuid());
        sendContents.current.set(keyId, contents);
        const result = await inboxApi.reply(target.message.id, {
          idempotency_key: sendKeys.current.get(keyId)!,
          words: '',
          questions: target.questions,
          ...(target.skip.length > 0 ? { skip: target.skip } : {}),
          // The session's Done and Can't do it waiting in the thread's draft go with its answers, as picks do.
          ...(target.actions.length > 0 ? { actions: target.actions } : {}),
        });
        const created = (result.reply as { created_at?: unknown } | null)?.created_at;
        if (typeof created === 'string') sentAt = created;
        // What this reply took, so a follow-up answered later is told apart from it.
        const ids = contents.answers.map(answerIdOf);
        setCarried((current) => new Map(current).set(key, new Set([...(current.get(key) ?? []), ...ids])));
        replies.went += 1;
      }
      setSend(key, { kind: 'sent', at: sentAt ?? new Date().toISOString() });
      setSaid(`Sent ${agentLabel(first)} your answers.`);
      props.refresh();
      return 'sent';
    } catch (cause) {
      // One reply went and another did not: the chip says how much went, never "Not sent".
      const part = replies.went > 0 ? { sent: replies.went, of: replies.of } : {};
      setSend(key, { kind: 'failed', error: cause instanceof InboxApiError ? cause.message : 'The reply was not sent.', ...part });
      props.refresh();
      return 'failed';
    }
  };

  /** The groups the Send button sends: each one with an answer no reply of this sitting carried yet. */
  const sendableKeys = groupKeys(queue).filter((key) => freshPicks(queue, key, carried.get(key)).length > 0);
  const answeredCount = sendableKeys.reduce((n, key) => n + freshPicks(queue, key, carried.get(key)).length, 0);
  const sendingAny = inFlightKeys.size > 0;
  /** An Other answer being dictated: Send waits for its words. */
  const otherVoice = useOtherFieldVoice();
  /**
   * Send these groups. Every answer on the cards is saved first (the thread's rounds, pickQueue.ts `forSend`): one that
   * cannot be saved sends nothing and says so, never a reply without an answer the person can see. Closed or tucked
   * away meanwhile, a failure is told by the window's toast.
   */
  const sendGroups = async (keys: readonly string[]) => {
    // An Other answer still being dictated: every way to send (Send, a strip's Try again) waits for its words.
    if (otherVoice.busyNow()) return;
    setError(null);
    const told = savesToldAway.current;
    const release = await saves.forSend();
    if (!release) {
      // Away, the answer's own save notice tells it (it is not a draft in the thread): once, said here if not yet.
      if (awayRef.current) {
        if (savesToldAway.current === told) away('save');
      } else setError('An answer was not saved, so nothing was sent.');
      return;
    }
    let results: SendResult[];
    try {
      results = await Promise.all(keys.map((key) => sendGroup(key)));
    } finally {
      release();
    }
    const failed = results.filter((r) => r === 'failed').length;
    // A reply draft waiting in the thread (`draft`) sends from there: the chip says so, the toast once away.
    if (awayRef.current) {
      if (failed > 0 || results.includes('draft')) away('send');
    } else if (failed > 0) setError(`${failed === 1 ? 'A reply was' : `${formatCount(failed)} replies were`} not sent. Your answers wait as drafts in the thread.`);
  };
  /** The Send button: what is answered goes, one reply per agent; what is not stays open. */
  const sendAnswered = () => sendGroups(sendableKeys);

  // ── After a Send: is the agent working on it? (its connection, every 3 s while open) ──
  useEffect(() => {
    if (!props.open) return;
    const watch = () => {
      for (const [key, state] of sendsRef.current) {
        if (state.kind !== 'sent') continue;
        const first = groupIds(queueRef.current, key).map((id) => queueRef.current.cache.get(id)).find(Boolean);
        if (!first || !first.session.session) continue;
        const row = props.rows.get(first.thread.id);
        if (afterSendOf(row, state.at, null) === 'replied') continue;
        void inboxApi
          .sessions(first.thread.id, first.session.session)
          .then((model) => setBusy((current) => new Map(current).set(key, model.asker?.connection?.busy === true)))
          .catch(() => {});
      }
    };
    watch();
    const timer = setInterval(watch, 3000);
    return () => clearInterval(timer);
  }, [props.open, props.rows]);

  // ── Moving through the queue. ──
  /** The next card after `from`: only while `from` is still on screen (the person may have gone elsewhere since). */
  const advance = (from: string) => {
    setQueue((current) => (current.current === from ? { ...current, current: nextId(current, from) } : current));
  };
  /** Move to another card: the words waiting are saved first. */
  const goTo = (id: string) => {
    flushTyped();
    setBanner(null);
    setStamp(null);
    setQueue((state) => ({ ...state, current: id }));
  };

  const land = (id: string, value: QuestionAnswer | 'done' | 'cant', words: string) => {
    setStamp({ id, value });
    setBanner(null);
    const left = leftCount(queueRef.current) - (isHandled(queueRef.current, id) ? 0 : 1);
    setSaid(`Answered: ${words}. ${left === 0 ? 'Nothing left.' : `${formatCount(Math.max(0, left))} left.`} It waits as a draft until you send.`);
    setTimeout(
      () => {
        setStamp((current) => (current?.id === id ? null : current));
        advance(id);
      },
      reduced ? 0 : STAMP_MS,
    );
  };

  /** The card is handled (or open again) now, as the person answered; the saved copy replaces it. */
  const drawAnswer = (id: string, answer: QuestionAnswer | null) => {
    setError(null);
    setQueue((current) => {
      const known = current.cache.get(id);
      if (!known) return current;
      const cache = new Map(current.cache).set(id, { ...known, question: { ...known.question, state: answer ? 'picked' : 'open', answer } });
      return { ...current, cache, later: answer ? new Set([...current.later].filter((l) => l !== id)) : current.later };
    });
  };

  /** A change on a question card (its draft): typed words wait for their pause, a click saves at once (saves.ts). */
  const changeAnswer = (decision: InboxDecision, key: string, answer: QuestionAnswer | null, pointer: boolean) => {
    const id = `${decision.message.id}/${key}`;
    if (id !== decision.id || sendingNow(decision)) return;
    const onThread = messageOf(decision.message.id)?.questions?.find((q) => q.key === key);
    const { before, typed } = saves.change(id, answer, onThread?.answer ?? decision.question.answer ?? null, onThread?.suggested_text ?? decision.question.suggested_text);
    drawAnswer(id, answer);
    if (typed) return;
    setUndo((stack) => [...stack, { id, kind: 'pick', before, at: Date.now() }]);
    // A pick-one choice or a Skip by a click or a tap answers the card: the next one rises, as before.
    if (pointer && settlesAtOnce(decision, before, answer)) land(id, answer!, answerWords(answer));
  };

  /** An action item's Done or Can't do it: it waits in the thread's draft, as the thread's own checklist does. */
  const act = (id: string, mark: { outcome: 'done' | 'cant'; note?: string }) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    flushTyped();
    setUndo((stack) => [...stack, { id, kind: 'action', before: null, at: Date.now(), ...(mark.note ? { note: mark.note } : {}) }]);
    setQueue((current) => {
      const cache = new Map(current.cache);
      cache.set(id, { ...decision, question: { ...decision.question, state: 'picked' } });
      return { ...current, cache, later: new Set([...current.later].filter((l) => l !== id)) };
    });
    pendingPicks.current.add(id);
    pickChain.current = pickChain.current.then(async () => {
      try {
        await inboxApi.markAction(decision.message.id, decision.question.key, mark, true);
        // The reason now waits as the mark's note: its own draft goes (Undo puts it back). That write failing is
        // never told and never stops a reload: the reason already went with the mark (it is tried again quietly).
        if (mark.outcome === 'cant' && reasons.text(id)) reasons.clear(decision.thread.id, id);
      } catch (cause) {
        setError(cause instanceof InboxApiError ? cause.message : 'That was not saved.');
        props.refresh();
      } finally {
        pendingPicks.current.delete(id);
      }
    });
    land(id, mark.outcome, mark.outcome === 'done' ? 'Done' : "Can't do it");
  };

  const later = (id: string) => {
    flushTyped();
    setUndo((stack) => [...stack, { id, kind: 'later', before: null, at: Date.now() }]);
    setBanner(null);
    setQueue((current) => putOff(current, id));
    setSaid('Put off until the end.');
  };

  /** A group whose reply is on its way: its cards take no pick until it lands (a pick would race the Send). */
  const sendingNow = (decision: InboxDecision) => sendsRef.current.get(groupKeyOf(decision))?.kind === 'sending' || inFlight.current.has(groupKeyOf(decision));

  /** Whether the last step can still be undone: not once its reply went. */
  const canUndo = (entry: UndoEntry | undefined): boolean => {
    if (!entry) return false;
    const decision = queue.cache.get(entry.id);
    if (!decision) return false;
    if (sentIds.has(entry.id) || queue.gone.get(entry.id) === 'sent') return false;
    return !(sends.get(groupKeyOf(decision))?.kind === 'sending' || inFlightKeys.has(groupKeyOf(decision)));
  };

  const undoLast = () => {
    const entry = undo.at(-1);
    if (!canUndo(entry)) return;
    flushTyped();
    setUndo((stack) => stack.slice(0, -1));
    const decision = queueRef.current.cache.get(entry!.id)!;
    if (entry!.kind === 'action') {
      // The mark waits in the draft: taking it back is one more save.
      pickChain.current = pickChain.current.then(async () => {
        try {
          await inboxApi.markAction(decision.message.id, decision.question.key, null, true);
          // A Can't do it taken back: its reason is the card's draft again, never lost with the mark.
          if (entry!.note && !reasons.text(entry!.id)) {
            reasons.type(decision.thread.id, entry!.id, entry!.note);
            reasons.flush();
          }
          setQueue((current) => {
            const cache = new Map(current.cache);
            const known = cache.get(entry!.id) ?? decision;
            cache.set(entry!.id, { ...known, question: { ...known.question, state: 'open', action_result: null } });
            const gone = new Map(current.gone);
            gone.delete(entry!.id);
            return { ...current, cache, gone, current: entry!.id };
          });
          setStamp(null);
          setError(null);
          setSaid('Undone.');
        } catch (cause) {
          setError(cause instanceof InboxApiError ? `Not undone: ${cause.message}` : 'Not undone.');
          props.refresh();
        }
      });
      return;
    }
    if (entry!.kind === 'pick') {
      saves.put(entry!.id, entry!.before);
      drawAnswer(entry!.id, entry!.before);
    }
    if (entry!.kind === 'later') setQueue((current) => ({ ...current, later: new Set([...current.later].filter((l) => l !== entry!.id)) }));
    setStamp(null);
    setQueue((current) => ({ ...current, current: entry!.id }));
    setSaid('Undone.');
  };

  /** Close: nothing is asked and nothing is sent; every answer stays a draft on its card in the thread. */
  const close = () => {
    flushTyped();
    props.onClose();
  };

  /** Escape: one layer at a time (focus in a field lets go of it first). */
  const escape = () => {
    if (lightbox || proto) return;
    if (fieldOpenRef.current?.()) return;
    if (overview) return setOverview(false);
    close();
  };

  const chips = useMemo(() => sessionChips(queue), [queue]);
  const current = queue.current ? (queue.cache.get(queue.current) ?? null) : null;
  const peek = current ? nextId({ ...queue, later: new Set([...queue.later, current.id]) }, current.id) : null;
  const peekDecision = peek && peek !== current?.id ? (queue.cache.get(peek) ?? null) : null;
  const prev = previousId(queue, queue.current);
  const next = current ? nextId(queue, current.id) : null;
  const after = queue.order.filter((id) => id !== queue.current && !isHandled(queue, id)).length;
  const undoable = canUndo(undo.at(-1));
  // A card whose answer a reply already took (Previous reaches it): read only.
  const sentAnswer = current && (sentIds.has(current.id) || queue.gone.get(current.id) === 'sent' || current.question.state === 'sent') ? current : null;
  const loaded = props.decisions !== null;
  // A replacement on its way is still a decision: the end screen waits for it.
  const done = loaded && queue.current === null && !swapPending;
  const sendingCard = current !== null && sentAnswer === null && (sends.get(groupKeyOf(current))?.kind === 'sending' || inFlightKeys.has(groupKeyOf(current)));
  // An action item's card shows: its reason saved earlier (this dialog, a dialog before, another window) comes back.
  const actionOnScreen = current && isActionDecision(current) ? current : null;
  useEffect(() => {
    if (actionOnScreen) reasons.load(actionOnScreen.thread.id, actionOnScreen.id);
    // Once per card shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionOnScreen?.id, reasons]);

  /** The card's message from the thread, with the thread's answers (its drafts) and the ones on their way. */
  const cardBody = (decision: InboxDecision): CardBody | null => {
    const message = messageOf(decision.message.id);
    if (!message || !held) return null;
    const answers = new Map<string, QuestionAnswer>();
    for (const q of message.questions ?? []) {
      const id = `${message.id}/${q.key}`;
      const answer = pending.has(id) ? pending.get(id)! : q.answer;
      if (answer) answers.set(q.key, answer);
    }
    const footerFor = (key: string): string | null => {
      const q = message.questions?.find((x) => x.key === key);
      if (q?.state === 'picked' && q.picked_at) return `Picked ${whenTime(q.picked_at)} · in your draft`;
      return null;
    };
    return { message, projectRoot: held.thread.project.root, repo: held.thread.project.repo ?? null, answers, footerFor };
  };

  /** A picture choice's zoom: the viewer over that question's choices, each named by its choice, on the one zoomed. */
  const openOptionSet = (decision: InboxDecision, key: string, _image: InboxInlineImage, choice: number) => {
    const message = messageOf(decision.message.id);
    const q = message?.questions?.find((x) => x.key === key) ?? decision.question;
    const labels = q.choices.map((c) => c.label);
    const pictures: CardPicture[] = [];
    let at = 0;
    q.choices.forEach((c, i) => {
      if (!c.image) return;
      if (i === choice) at = pictures.length;
      const captured = message?.inline_images?.find((image) => image.ref === c.image!.src);
      pictures.push({ name: choiceName(c.label, i, labels), alt: c.image.alt || c.label, src: captured ? attachmentPictureUrl(captured.id) : inboxMessageImageUrl(decision.message.id, c.image.src) });
    });
    if (pictures.length > 0) setLightbox({ pictures, index: at });
  };

  return (
    <dialog
      ref={dialogRef}
      className="ib-dm"
      data-decision-mode=""
      data-phone={props.phone ? '' : undefined}
      aria-labelledby="ib-dm-title"
      onCancel={(event) => {
        // The browser's own cancel (Escape, a phone's back): one layer, once (the keydown below may have taken it).
        event.preventDefault();
        if (Date.now() - escapedAt.current > 100) escape();
      }}
      onKeyDown={(event) => {
        // The prototype window and the viewer over the dialog take their own Escape.
        if (event.key !== 'Escape' || event.defaultPrevented || proto || lightbox) return;
        event.preventDefault();
        event.stopPropagation();
        escapedAt.current = Date.now();
        escape();
      }}
    >
      <div className="ib-dm-head">
        <h1 id="ib-dm-title">Decide</h1>
        {props.scope && (
          <Tip content={props.scope} cut>
            <span className="ib-dm-scope" dir="auto" data-decision-scope="">
              {props.scope}
            </span>
          </Tip>
        )}
        <span className="ib-dm-count" data-decision-head="">
          {loaded ? headLine(queue) : 'Reading what waits on you…'}
        </span>
        <span className="ib-dm-headacts">
          {undoable && (
            <button type="button" className="ib-dm-lnk" data-decision-undo="" onClick={undoLast}>
              <Icon name="reply" size={15} />
              Undo
            </button>
          )}
          {!done && loaded && (
            <button type="button" className="ib-dm-lnk" aria-pressed={overview} data-decision-overview="" onClick={() => setOverview((v) => !v)}>
              All
            </button>
          )}
          <Tip content="Close">
            <button type="button" className="ib-dm-x" aria-label="Close decision mode" data-decision-close="" onClick={close}>
              <Icon name="x" size={18} />
            </button>
          </Tip>
        </span>
      </div>
      <Strip
        chips={chips}
        sends={sends}
        rows={props.rows}
        busy={busy}
        queue={queue}
        onSendNow={(key) => void sendGroups([key])}
        onOpenThread={(key) => {
          const first = queue.cache.get(groupIds(queue, key)[0]!);
          if (first) props.onTuck(first.thread.id);
        }}
        byAgent={!!props.scope}
      />
      {error && (
        <div className="ib-error ib-dm-error" role="alert">
          {error}
        </div>
      )}
      <div className="ib-dm-stage">
        {overview ? (
          <Overview
            queue={queue}
            onPick={(id) => {
              setOverview(false);
              goTo(id);
            }}
          />
        ) : done ? (
          <EndScreen queue={queue} sends={sends} rows={props.rows} busy={busy} unsent={answeredCount} onClose={close} />
        ) : current ? (
          <div className="ib-dm-deck" data-reduced={reduced ? '' : undefined}>
            {/* The next card peeks behind this one: an edge, nothing to read. */}
            {peekDecision && <div className="ib-dm-peek" aria-hidden="true" data-decision-peek="" />}
            {otherVoice.wrap(<DecisionCard
              key={current.id}
              decision={current}
              body={isActionDecision(current) ? null : cardBody(current)}
              readFailed={sitting.failed}
              onReadAgain={sitting.retry}
              stamp={stamp?.id === current.id ? stamp.value : null}
              sent={sentAnswer !== null}
              sending={sendingCard}
              fieldOpenRef={fieldOpenRef}
              banner={
                banner ? (
                  <div className="ib-dm-banner" role="status" data-decision-replaced="">
                    <Icon name="warn" size={16} />
                    <span>
                      <b>{banner.withdrawn ? `${banner.agent} withdrew the last question.` : `${banner.agent} replaced this question just now.`}</b> Your pick, if any, wasn&apos;t sent.
                    </span>
                  </div>
                ) : undefined
              }
              onPick={(key, answer, pointer) => changeAnswer(current, key, answer, pointer)}
              onAction={(mark) => act(current.id, mark)}
              reason={reasonTexts.get(current.id) ?? ''}
              onReason={(text) => reasons.type(current.thread.id, current.id, text)}
              onOpenThread={(fileId) => {
                flushTyped();
                props.onTuck(current.thread.id, fileId, fileId ? undefined : { messageId: current.message.id, key: current.question.key });
              }}
              onOpenFileRef={(ref) => {
                flushTyped();
                props.onTuck(current.thread.id, { ...ref, messageId: current.message.id });
              }}
              onImage={(pictures, index) => setLightbox({ pictures, index })}
              onOptionSet={(key, image, choice) => openOptionSet(current, key, image, choice)}
              onTryPrototype={(key) => {
                flushTyped();
                setProto({ messageId: current.message.id, key });
              }}
            />)}
          </div>
        ) : (
          <div className="ib-dm-loading">Reading what waits on you…</div>
        )}
      </div>
      {/* Moving and sending: one row, always there (Send too, whatever card is on screen). */}
      <div className="ib-dm-nav" data-decision-nav="">
        {current && !overview && (
          <>
            <button type="button" className="ib-dm-lnk" data-decision-previous="" aria-label={props.phone ? 'Previous' : undefined} disabled={prev === null} onClick={() => prev && goTo(prev)}>
              <Icon name="back" size={15} />
              {!props.phone && 'Previous'}
            </button>
            <button type="button" className="ib-dm-lnk" data-decision-next="" aria-label={props.phone ? 'Next' : undefined} disabled={next === null || next === current.id} onClick={() => next && goTo(next)}>
              {!props.phone && 'Next'}
              <Icon name="chevR" size={15} />
            </button>
            {!isHandled(queue, current.id) && (
              <button type="button" className="ib-dm-lnk" data-decision-later="" onClick={() => later(current.id)}>
                <Icon name="clock" size={15} />
                Later
              </button>
            )}
            {!props.phone && <span className="ib-dm-after">{after === 0 ? 'The last one' : `${formatCount(after)} more after this`}</span>}
          </>
        )}
        <span className="ib-dm-navsp" />
        <button
          type="button"
          className="ib-btn ib-pri ib-dm-send"
          data-decision-send=""
          disabled={answeredCount === 0 || sendingAny || otherVoice.busy}
          aria-label={answeredCount === 0 ? 'Send: nothing answered yet' : `Send ${answeredCount === 1 ? '1 answer' : `${formatCount(answeredCount)} answers`}`}
          onClick={() => void sendAnswered()}
        >
          <Icon name="send" size={15} />
          {sendingAny ? 'Sending…' : answeredCount === 0 ? 'Send' : `Send ${formatCount(answeredCount)}`}
        </button>
      </div>
      <div className="ib-sr" aria-live="polite" data-decision-live="">
        {said}
      </div>
      {proto &&
        dialogRef.current &&
        createPortal(
          <DecisionPrototype
            proto={proto}
            held={held}
            answers={(() => {
              const id = `${proto.messageId}/${proto.key}`;
              const q = messageOf(proto.messageId)?.questions?.find((x) => x.key === proto.key);
              return pending.has(id) ? (pending.get(id) ?? null) : (q?.answer ?? null);
            })()}
            onPick={(answer) => {
              const decision = queueRef.current.cache.get(`${proto.messageId}/${proto.key}`);
              if (decision) changeAnswer(decision, proto.key, answer, false);
            }}
            onClose={() => setProto(null)}
          />,
          dialogRef.current,
        )}
      {lightbox &&
        createPortal(
          <ImageLightbox
            src={lightbox.pictures[lightbox.index]!.src}
            alt={lightbox.pictures[lightbox.index]!.name}
            // Each picture by its choice ("B · Quiet hover menu"), not its file's route; a finger swipes through them (approval "inbox-image-swipe").
            images={lightbox.pictures.length > 1 ? lightbox.pictures.map((p) => ({ src: p.src, alt: p.alt ?? p.name, name: p.name })) : undefined}
            swipe
            // The place opened, not the first picture with that URL: a picture two choices share opens as the one zoomed.
            at={lightbox.index}
            onClose={() => setLightbox(null)}
          />,
          dialogRef.current ?? document.body,
        )}
    </dialog>
  );
}

function agentLabel(decision: InboxDecision): string {
  return agentName(decision.message.author);
}

/** What a chip says about its session's reply. */
function chipSend(chip: SessionChip, sends: ReadonlyMap<string, GroupSend>, rows: ReadonlyMap<string, InboxListRow>, busy: ReadonlyMap<string, boolean>, queue: QueueState):
  | { kind: 'none' }
  | { kind: 'draft'; key: string }
  | { kind: 'failed'; key: string; error: string; words: string }
  | { kind: 'words'; text: string; tone: 'quiet' | 'ok' } {
  for (const key of chip.groups) {
    const state = sends.get(key);
    if (state?.kind === 'draft') return { kind: 'draft', key };
    if (state?.kind === 'failed') return { kind: 'failed', key, error: state.error, words: failedWords(state) };
  }
  const sent = chip.groups.map((key) => ({ key, state: sends.get(key) })).filter((g) => g.state?.kind === 'sent' || g.state?.kind === 'sending');
  if (sent.length === 0) return { kind: 'none' };
  if (sent.some((g) => g.state!.kind === 'sending')) return { kind: 'words', text: 'Sending', tone: 'quiet' };
  const stages = sent.map((g) => {
    const first = groupIds(queue, g.key).map((id) => queue.cache.get(id)).find(Boolean);
    return afterSendOf(first ? rows.get(first.thread.id) : undefined, (g.state as { at: string }).at, busy.get(g.key) ?? null);
  });
  const least = stages.reduce((a, b) => (AFTER_SEND_ORDER.indexOf(a) <= AFTER_SEND_ORDER.indexOf(b) ? a : b));
  return { kind: 'words', text: AFTER_SEND_WORDS[least], tone: least === 'replied' || least === 'delivered' || least === 'working' ? 'ok' : 'quiet' };
}

function Strip(props: {
  chips: SessionChip[];
  sends: ReadonlyMap<string, GroupSend>;
  rows: ReadonlyMap<string, InboxListRow>;
  busy: ReadonlyMap<string, boolean>;
  queue: QueueState;
  onSendNow: (key: string) => void;
  onOpenThread: (key: string) => void;
  /** Chips named by agent (a sitting scoped to one thread), else by project. */
  byAgent?: boolean;
}) {
  return (
    <ol className="ib-dm-strip" aria-label="Agents waiting" data-decision-strip="">
      {props.chips.map((chip) => {
        const send = chipSend(chip, props.sends, props.rows, props.busy, props.queue);
        const on = chip.dots.some((d) => d.state === 'current');
        const handled = chip.dots.filter((d) => d.state === 'done').length;
        return (
          <li key={chip.key} className="ib-dm-chip" data-on={on ? '' : undefined} data-decision-chip={chipDomKey(chip.key)} data-send={send.kind === 'words' ? send.text.toLowerCase() : send.kind}>
            <HostMark host={chip.host} />
            {/* Scoped to one thread, the project is the same for every chip: the agent names it. */}
            <span className="ib-dm-chipname">{props.byAgent ? chip.name : chip.label}</span>
            <span className="ib-dm-dots" role="img" aria-label={`${chip.name}: ${formatCount(handled)} of ${formatCount(chip.dots.length)} answered`}>
              {chip.dots.map((dot) => (
                <i key={dot.id} data-state={dot.state} />
              ))}
            </span>
            {send.kind === 'draft' && (
              <span className="ib-dm-hold-l" data-decision-draft="">
                This thread has a draft reply; send it from the thread ·{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onOpenThread(send.key)}>
                  Open the thread
                </button>
              </span>
            )}
            {send.kind === 'failed' && (
              <span className="ib-dm-hold-l ib-dm-bad">
                {send.words} ·{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onSendNow(send.key)}>
                  Try again
                </button>
              </span>
            )}
            {send.kind === 'words' && (
              <span className={`ib-dm-state${send.tone === 'ok' ? ' ib-dm-ok' : ''}`} data-decision-chip-state={send.text.toLowerCase()}>
                {send.text}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The read-only overview ("All"): every decision of the sitting, by agent; a row jumps to its card. No bulk accept. */
function Overview({ queue, onPick }: { queue: QueueState; onPick: (id: string) => void }) {
  const chips = sessionChips(queue);
  return (
    <div className="ib-dm-all" data-decision-all="">
      {chips.map((chip) => (
        <section key={chip.key} className="ib-dm-allg" aria-label={`${chip.name} · ${chip.label}`}>
          <h2>
            <HostMark host={chip.host} />
            {chip.name} <span>· {chip.label}</span>
          </h2>
          <ul>
            {chip.dots.map((dot) => {
              const d = queue.cache.get(dot.id)!;
              const state = queue.gone.get(dot.id) === 'sent' || d.question.state === 'sent' ? 'Sent' : isHandled(queue, dot.id) ? answerWordsOf(d) : queue.later.has(dot.id) ? 'Later' : d.question.stopped !== null ? 'Stopped' : 'Open';
              return (
                <li key={dot.id}>
                  <button type="button" className="ib-dm-allrow" data-on={dot.state === 'current' ? '' : undefined} onClick={() => onPick(dot.id)}>
                    <span className="ib-dm-allp">{d.question.prompt}</span>
                    <span className="ib-dm-alls">{state}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function answerWordsOf(decision: InboxDecision): string {
  if (isActionDecision(decision)) {
    const outcome = decision.question.action_result?.outcome;
    return outcome === 'cant' ? "Can't do it" : outcome === 'skip' ? 'Skipped' : 'Done';
  }
  return answerWords(decision.question.answer);
}

/** The end: nothing waits, and what each agent did with its reply. */
function EndScreen(props: { queue: QueueState; sends: ReadonlyMap<string, GroupSend>; rows: ReadonlyMap<string, InboxListRow>; busy: ReadonlyMap<string, boolean>; unsent: number; onClose: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const chips = sessionChips(props.queue);
  const handled = props.queue.order.filter((id) => {
    const reason = props.queue.gone.get(id);
    return reason !== 'replaced' && reason !== 'closed';
  }).length;
  return (
    <div className="ib-dm-end" data-decision-end="">
      <span className="ib-dm-endmark" aria-hidden="true">
        <Icon name="check" size={28} />
      </span>
      <h2 ref={ref} tabIndex={-1}>
        {props.unsent > 0 ? 'Everything is answered' : 'Nothing waits on you'}
      </h2>
      <p>
        {formatCount(handled)} {handled === 1 ? 'decision' : 'decisions'}.{' '}
        {props.unsent > 0 ? 'Your answers wait as drafts until you press Send. Each agent gets one reply per thread.' : 'Each agent gets one reply per thread.'}
      </p>
      {chips.length > 0 && (
        <ul className="ib-dm-endlist">
          {chips.map((chip) => {
            const send = chipSend(chip, props.sends, props.rows, props.busy, props.queue);
            const words =
              send.kind === 'words'
                ? send.text
                : send.kind === 'draft'
                  ? 'Send it from the thread (draft reply)'
                  : send.kind === 'failed'
                    ? send.words
                    : chip.dots.some((d) => d.state === 'done')
                      ? 'Draft, not sent'
                      : 'Nothing to send';
            return (
              <li key={chip.key} data-decision-end-row={chipDomKey(chip.key)}>
                <HostMark host={chip.host} />
                <span>
                  <b>{chip.name}</b> · {chip.label}
                </span>
                <span className="ib-dm-endstate">{words}</span>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="ib-btn ib-pri" data-decision-back="" onClick={props.onClose}>
        Back to the Inbox
      </button>
    </div>
  );
}
