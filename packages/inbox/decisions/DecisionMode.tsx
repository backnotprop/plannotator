/**
 * Decision mode (approval "inbox-decision-mode", direction A "Queue";
 * experimental, off unless Settings → Capabilities → Experimental turns it on).
 *
 * One decision at a time in a large dialog, the next peeking behind it, a
 * progress strip of one chip per agent session. Picks save at once through
 * the existing picks route. Once a session's decisions in a thread are all
 * handled, its chip says "Sending in 5 s · Hold", and then its reply goes
 * through the existing reply route: one reply per agent session per thread
 * (`sendTargetsOf`, the skip and supersede rules unchanged). After a Send
 * the chip goes Delivered, then Working, then Replied.
 *
 * No new keyboard shortcuts: Tab, Enter, Space, the arrows inside a choice
 * group, and Escape, which walks out one layer at a time (an open field, the
 * close question, the overview, then the dialog).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import type { InboxDecision, InboxListRow, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError, inboxApi } from '../api';
import { replyKeysToRenew, type SendTarget, type SentContents } from '../sendTargets';
import { agentName, formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { prefersReducedMotion } from '../settle';
import { Tip } from '../components/Tip';
import { DecisionCard, type CardPicture, type CardWords } from './DecisionCard';
import {
  AFTER_SEND_ORDER,
  AFTER_SEND_WORDS,
  afterSendOf,
  answerWords,
  emptyQueue,
  freshPicks,
  groupHalfAnswered,
  groupIds,
  groupKeyOf,
  groupKeys,
  groupReady,
  groupSendTargets,
  headLine,
  holdSeconds,
  nextGroupSend,
  pauseHold,
  restartHold,
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

export { DECISION_HOLD_MS } from './model';
/**
 * How long an action item's Done or Can't do it can be undone here: inside the
 * actions route's own Undo window (10 s), with a margin so a press at the last
 * moment still reaches the server in time. A refusal is still shown.
 */
export const DECISION_ACTION_UNDO_MS = 9000;
/** The answer lands as a stamp before the card leaves (brief §7). */
const STAMP_MS = 350;

export interface DecisionModeProps {
  /** The dialog is on screen (false while tucked into the pill behind an open thread). */
  open: boolean;
  /** The latest projection (`GET /api/inbox/decisions`), null until read. */
  decisions: readonly InboxDecision[] | null;
  /**
   * The thread the sitting is scoped to, by its subject (thread only, owner
   * 2026-10-27: the window passes one thread's decisions in `decisions`).
   * Drawn in the head; null or absent: nothing drawn.
   */
  scope?: string | null;
  /** The list rows, by thread id: where a sent reply is (Delivered, Replied). */
  rows: ReadonlyMap<string, InboxListRow>;
  /** Start on this decision (a Stopped notification). */
  start?: string | null;
  /** A new start (another notification while the sitting is open): moves to `start` again. */
  startNonce?: number;
  phone: boolean;
  /** Read the projection again now. */
  refresh: () => void;
  /** The event stream's question lines (a replaced question swaps on screen). */
  subscribeQuestions: (listener: (question: InboxQuestion) => void) => () => void;
  /**
   * Open the thread behind the dialog: decision mode tucks into a pill. A
   * card's "Open the thread" names its question (`<message id>`, `key`): the
   * thread scrolls to that question's card and puts focus on its prompt
   * (thread only, approval "inbox-decide-thread-only").
   */
  onTuck: (threadId: string, fileId?: string, question?: { messageId: string; key: string }) => void;
  /** The sitting ends. */
  onClose: () => void;
  /** Tells the pill how many are left. */
  onLeft?: (left: number) => void;
  /** Tells the pill how many replies wait while it is tucked (their Hold is paused). */
  onPaused?: (paused: number) => void;
}

interface UndoEntry {
  id: string;
  kind: 'pick' | 'action' | 'later';
  before: QuestionAnswer | null;
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
 * What a reply carries, for its key (`replyKeysToRenew`): each pick with its revision, so a changed answer
 * (a new pick is a new revision) takes a new key, and an unchanged retry replays the old one; and each
 * action item whose Done or Can't do it waits in the thread's draft, so one marked since takes a new key.
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

/** The agent replaced the question while the pick was on its way: the swap shows it, no error. Any other refusal is shown. */
function isSuperseded(error: unknown): boolean {
  return error instanceof InboxApiError && error.code === 'question_superseded';
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
  const carriedRef = useRef(carried);
  carriedRef.current = carried;
  /** Every decision a reply of this sitting carried. */
  const sentIds = useMemo(() => new Set([...carried.values()].flatMap((ids) => [...ids])), [carried]);
  const sentIdsRef = useRef(sentIds);
  sentIdsRef.current = sentIds;
  /**
   * The decisions the person answered or acted on in this sitting (a count: Undo takes one off). A group
   * starts its Hold by itself only when an answer it would send is one of these.
   */
  const [touched, setTouched] = useState<Map<string, number>>(new Map());
  /**
   * What the last fresh reads before a send said about a thread's reply draft and the comments waiting for its
   * Send, good until the next list read (`rows` is that read): the row may be older than they are, never newer.
   */
  const [draftRead, setDraftRead] = useState<Map<string, { reply: boolean; comments: number; rows: ReadonlyMap<string, InboxListRow> }>>(new Map());
  /** Sends on their way, by group: a second Send, "Keep as a draft" and "Send what you answered" wait for them. */
  const inFlight = useRef(new Map<string, Promise<SendResult>>());
  /**
   * The same groups as state, for what the render draws from them (the card's "Sending" lock, Undo, the close
   * question): the ref alone changes without a render, so a lock drawn from it stayed until something else
   * happened to render.
   */
  const [inFlightKeys, setInFlightKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** The card being edited (a box open, or words typed): its group's Hold waits meanwhile. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Words typed on a card the queue moved away from (Later, Previous, a notification): back when it is again. */
  const keptWords = useRef(new Map<string, CardWords>());
  /** Groups whose asking session has ended while their reply waited: it waits for the next agent. */
  const [ended, setEnded] = useState<Set<string>>(new Set());
  /** A notification asked for another card while words were typed here: a banner, never a move. */
  const [startBanner, setStartBanner] = useState<string | null>(null);
  /** Each reply's idempotency key and what it carried, by (group, message): a key is renewed when the answers change. */
  const sendKeys = useRef(new Map<string, string>());
  const sendContents = useRef(new Map<string, SentContents>());
  const rowsRef = useRef(props.rows);
  rowsRef.current = props.rows;
  const openRef = useRef(props.open);
  openRef.current = props.open;
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const [stamp, setStamp] = useState<{ id: string; value: QuestionAnswer | 'done' | 'cant' } | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const pendingSwap = useRef<{ old: string; replacement: string } | null>(null);
  /** A replacement on its way: the sitting is not done while it is. */
  const [swapPending, setSwapPending] = useState(false);
  const [overview, setOverview] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<Map<string, boolean>>(new Map());
  const [lightbox, setLightbox] = useState<{ pictures: CardPicture[]; index: number } | null>(null);
  const pickChain = useRef<Promise<void>>(Promise.resolve());
  const revisions = useRef(new Map<string, number>());
  /** Decisions whose pick is on its way to the server. */
  const pendingPicks = useRef(new Set<string>());
  const fieldOpenRef = useRef<(() => boolean) | null>(null);
  /** The card on screen holds words the person typed and has not answered with. */
  const unsavedWordsRef = useRef<(() => boolean) | null>(null);
  /** The `startNonce` already applied (each start moves to its card once). */
  const appliedStart = useRef<number | null>(null);
  const [, setTick] = useState(0);
  const escapedAt = useRef(0);
  const [touch, setTouch] = useState(false);
  const reduced = prefersReducedMotion();

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

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(hover: none) and (pointer: coarse)');
    setTouch(query.matches);
  }, []);

  // ── The projection folded in. ──
  useEffect(() => {
    if (!props.decisions) return;
    // The card on screen left the projection without the person's answer: ask its thread why
    // (the agent replaced it, or the thread was archived or answered elsewhere).
    const shown = queueRef.current.current;
    if (shown && !props.decisions.some((d) => d.id === shown) && !queueRef.current.gone.has(shown) && !isHandled(queueRef.current, shown)) void checkGone(shown);
    setQueue((current) => {
      let next = mergeDecisions(current, props.decisions!, sentIdsRef.current, pendingPicks.current);
      for (const d of props.decisions!) revisions.current.set(d.id, Math.max(revisions.current.get(d.id) ?? 0, d.question.revision));
      // A start (a Stopped notification), once per nonce, as soon as the queue holds it: on the first
      // read, or later when a notification arrives while the sitting is open.
      const nonce = props.startNonce ?? 0;
      if (props.start && appliedStart.current !== nonce && next.order.includes(props.start)) {
        appliedStart.current = nonce;
        // Words typed on the card on screen are never dropped by a notification: a banner offers the move instead.
        if (next.current !== props.start && next.current !== null && unsavedWordsRef.current?.() === true) {
          startBannerRef.current = props.start;
        } else {
          next = { ...next, current: props.start, later: new Set([...next.later].filter((l) => l !== props.start)) };
          return next;
        }
      }
      const swap = pendingSwap.current;
      if (swap && next.cache.has(swap.replacement)) {
        pendingSwap.current = null;
        swapDoneRef.current = true;
        next = placeAfter(next, swap.replacement, swap.old);
        if (next.current === swap.old || next.current === null || isHandled(next, next.current)) next = { ...next, current: swap.replacement };
      }
      const leftUnanswered = shown !== null && next.current === shown && next.gone.get(shown) === 'closed' && !isHandled(current, shown);
      // The card on screen became handled elsewhere (another tab, the thread): the next card. One the person went
      // back to on purpose (Previous, All) was handled already, and stays.
      const becameHandled = next.current !== null && isHandled(next, next.current) && !isHandled(current, next.current);
      if (!leftUnanswered && becameHandled && !stampRef.current) next = { ...next, current: nextId(next, next.current) };
      return next;
    });
    if (startBannerRef.current) {
      setStartBanner(startBannerRef.current);
      startBannerRef.current = null;
    }
    if (swapDoneRef.current) {
      swapDoneRef.current = false;
      setSwapPending(false);
    }
  }, [props.decisions, props.start, props.startNonce]);
  const startBannerRef = useRef<string | null>(null);
  const swapDoneRef = useRef(false);

  // A new start moves the banner off the old card.
  useEffect(() => {
    if (props.start) setBanner(null);
  }, [props.start, props.startNonce]);

  const stampRef = useRef(stamp);
  stampRef.current = stamp;

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

  /** Why the card on screen left: replaced (the banner and the swap), else the next card. */
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

  // ── Each send group: ready → a 5 s Hold → its reply (model `nextGroupSend`). ──
  /**
   * Whether a thread's reply goes from the thread: a reply draft, or comments waiting for the thread's Send
   * (the latest list row's `unsent`, or the fresh reads made before a send since it).
   */
  const draftOf = useCallback(
    (threadId: string) => {
      const row = props.rows.get(threadId);
      const read = draftRead.get(threadId);
      if (read && read.rows === props.rows) return read.reply || read.comments > 0;
      return (row?.unsent?.reply_at ?? null) !== null || (row?.unsent?.comments ?? 0) > 0;
    },
    [props.rows, draftRead],
  );
  const editingKey = editingId ? (queue.cache.get(editingId) ? groupKeyOf(queue.cache.get(editingId)!) : null) : null;
  /** A group's Hold runs only while the dialog is on screen, no close question is up, and none of its cards is being edited. */
  const runs = useCallback((key: string) => props.open && !confirm && editingKey !== key, [props.open, confirm, editingKey]);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  useEffect(() => {
    const at = Date.now();
    let started = false;
    setSends((current) => {
      let changed = false;
      const next = new Map(current);
      for (const key of groupKeys(queue)) {
        const state = next.get(key) ?? { kind: 'waiting' as const };
        const first = queue.cache.get(groupIds(queue, key)[0]!);
        const moved = nextGroupSend(state, {
          ready: groupReady(queue, key, carried.get(key)),
          touched: freshPicks(queue, key, carried.get(key)).some((id) => (touched.get(id) ?? 0) > 0),
          draft: first ? draftOf(first.thread.id) : false,
          open: runs(key),
          now: at,
        });
        if (moved !== state) {
          next.set(key, moved);
          changed = true;
          if (moved.kind === 'hold') started = true;
        }
      }
      return changed ? next : current;
    });
    // The countdown's first frame reads this clock: never an old one (it said "10 s" for a frame).
    if (started) setNow(at);
  }, [queue, carried, touched, draftOf, runs]);

  // Tucked behind a thread, behind the close question, or while one of its cards is being edited, a Hold
  // waits; then it runs on from where it was.
  useEffect(() => {
    const at = Date.now();
    setNow(at);
    setSends((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, state] of current) {
        const moved = pauseHold(state, runs(key), at);
        if (moved !== state) {
          next.set(key, moved);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [runs]);

  const pausedCount = [...sends.values()].filter((s) => s.kind === 'hold' && s.paused !== null).length;
  useEffect(() => props.onPaused?.(pausedCount), [pausedCount, props.onPaused]);

  const holding = [...sends.values()].some((s) => s.kind === 'hold' && s.paused === null);
  useEffect(() => {
    if (!holding) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [holding]);

  const setSend = (key: string, value: GroupSend) => setSends((current) => new Map(current).set(key, value));

  /** A Hold already running starts over (a pick, an Undo in its group). */
  const restartGroup = (key: string) => {
    const state = sendsRef.current.get(key);
    if (state?.kind === 'hold') {
      const at = Date.now();
      setNow(at);
      setSend(key, restartHold(state, at, runsRef.current(key)));
    }
  };
  /** The person answered or acted on a decision in this sitting: its group may start its Hold. */
  const touchDecision = (decision: InboxDecision, by: 1 | -1) => {
    setTouched((current) => {
      const next = new Map(current);
      const n = Math.max(0, (next.get(decision.id) ?? 0) + by);
      if (n === 0) next.delete(decision.id);
      else next.set(decision.id, n);
      return next;
    });
    restartGroup(groupKeyOf(decision));
  };
  /** A group whose reply is on its way: its cards take no pick until it lands (a pick would race the Send). */
  const sendingNow = (decision: InboxDecision) => sendsRef.current.get(groupKeyOf(decision))?.kind === 'sending' || inFlight.current.has(groupKeyOf(decision));

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
      setDraftRead((current) => new Map(current).set(first.thread.id, { reply, comments, rows: rowsRef.current }));
      if (reply || comments > 0) {
        setSend(key, { kind: 'draft', held: before.kind === 'held' && before.by === 'person' });
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
      for (const target of targets) {
        const keyId = `${key}\u0002${target.message.id}`;
        const contents: SentContents = { value: target.message.id, answers: answersOf(target) };
        const last = sendContents.current.get(keyId);
        // A replay of a key answers the reply it wrote: a changed answer (a new revision) takes a new key.
        const renew = !sendKeys.current.has(keyId) || (last !== undefined && replyKeysToRenew(new Map([[keyId, last]]), new Map([[keyId, contents]])).length > 0);
        if (renew) sendKeys.current.set(keyId, crypto.randomUUID());
        sendContents.current.set(keyId, contents);
        const result = await inboxApi.reply(target.message.id, {
          idempotency_key: sendKeys.current.get(keyId)!,
          words: '',
          questions: target.questions,
          ...(target.skip.length > 0 ? { skip: target.skip } : {}),
          // The session's Done and Can't do it waiting in the thread's draft go with its answers, as picks do:
          // one reply, never the answers here and the action items in a second Send.
          ...(target.actions.length > 0 ? { actions: target.actions } : {}),
        });
        const created = (result.reply as { created_at?: unknown } | null)?.created_at;
        if (typeof created === 'string') sentAt = created;
        // What this reply took, so a follow-up answered later is told apart from it.
        const ids = contents.answers.map(answerIdOf);
        setCarried((current) => new Map(current).set(key, new Set([...(current.get(key) ?? []), ...ids])));
      }
      setSend(key, { kind: 'sent', at: sentAt ?? new Date().toISOString() });
      setSaid(`Sent ${agentLabel(first)} your answers.`);
      props.refresh();
      return 'sent';
    } catch (cause) {
      setSend(key, { kind: 'failed', error: cause instanceof InboxApiError ? cause.message : 'The reply was not sent.' });
      props.refresh();
      return 'failed';
    }
  };

  // A Hold that ran out sends (never one paused: tucked, behind the close question, or its card being edited).
  useEffect(() => {
    for (const [key, state] of sends) if (state.kind === 'hold' && state.paused === null && state.until <= now) void sendGroup(key);
  }, [now, sends, sendGroup]);

  // ── After a Send: is the agent working on it? (its connection, every 3 s while open) ──
  useEffect(() => {
    if (!props.open) return;
    const watch = () => {
      for (const [key, state] of sendsRef.current) {
        const first = groupIds(queueRef.current, key).map((id) => queueRef.current.cache.get(id)).find(Boolean);
        if (!first || !first.session.session) continue;
        // A reply waiting to go to a session that ended (only a session that wakes can be told ended): it
        // waits for the next agent to read the thread.
        if ((state.kind === 'hold' || state.kind === 'held') && first.session.wakes) {
          void inboxApi
            .sessions(first.thread.id, first.session.session)
            .then((model) =>
              setEnded((current) => {
                const gone = model.asker?.live === false;
                if (gone === current.has(key)) return current;
                const next = new Set(current);
                if (gone) next.add(key);
                else next.delete(key);
                return next;
              }),
            )
            .catch(() => {});
          continue;
        }
        if (state.kind !== 'sent') continue;
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

  const land = (id: string, value: QuestionAnswer | 'done' | 'cant', words: string) => {
    setStamp({ id, value });
    setBanner(null);
    const left = leftCount(queueRef.current) - (isHandled(queueRef.current, id) ? 0 : 1);
    setSaid(`Answered: ${words}. ${left === 0 ? 'Nothing left.' : `${formatCount(Math.max(0, left))} left.`}`);
    setTimeout(
      () => {
        setStamp((current) => (current?.id === id ? null : current));
        advance(id);
      },
      reduced ? 0 : STAMP_MS,
    );
  };

  const savePick = (id: string, answer: QuestionAnswer | null) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    // Optimistic: the card is handled now; the saved copy replaces it.
    setQueue((current) => {
      const cache = new Map(current.cache);
      cache.set(id, { ...decision, question: { ...decision.question, state: answer ? 'picked' : 'open', answer } });
      return { ...current, cache, later: answer ? new Set([...current.later].filter((l) => l !== id)) : current.later };
    });
    setError(null);
    pendingPicks.current.add(id);
    pickChain.current = pickChain.current.then(async () => {
      const revision = Math.max(revisions.current.get(id) ?? 0, queueRef.current.cache.get(id)?.question.revision ?? 0);
      try {
        const result = await inboxApi.pick(decision.message.id, decision.question.key, revision, answer, { unsentOnly: true });
        const saved = result.questions.find((q) => q.key === decision.question.key);
        if (saved) {
          revisions.current.set(id, saved.revision);
          setQueue((current) => {
            const known = current.cache.get(id);
            if (!known) return current;
            return { ...current, cache: new Map(current.cache).set(id, { ...known, question: saved }) };
          });
        }
      } catch (cause) {
        if (!isSuperseded(cause)) setError(cause instanceof InboxApiError ? cause.message : 'The pick was not saved.');
        props.refresh();
      } finally {
        pendingPicks.current.delete(id);
      }
    });
  };

  const answer = (id: string, value: QuestionAnswer) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    if (sendingNow(decision)) return setSaid('Its reply is on its way; this answer is not changed.');
    setUndo((stack) => [...stack, { id, kind: 'pick', before: decision.question.state === 'picked' ? decision.question.answer : null, at: Date.now() }]);
    touchDecision(decision, 1);
    savePick(id, value);
    land(id, value, answerWords(value));
  };

  const act = (id: string, mark: { outcome: 'done' | 'cant'; note?: string }) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    setUndo((stack) => [...stack, { id, kind: 'action', before: null, at: Date.now() }]);
    touchDecision(decision, 1);
    setQueue((current) => {
      const cache = new Map(current.cache);
      cache.set(id, { ...decision, question: { ...decision.question, state: 'picked' } });
      return { ...current, cache, later: new Set([...current.later].filter((l) => l !== id)) };
    });
    // On its way, like a pick: a read that crosses it never undoes it.
    pendingPicks.current.add(id);
    pickChain.current = pickChain.current.then(async () => {
      try {
        await inboxApi.markAction(decision.message.id, decision.question.key, mark);
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
    setUndo((stack) => [...stack, { id, kind: 'later', before: null, at: Date.now() }]);
    setBanner(null);
    setQueue((current) => putOff(current, id));
    setSaid('Put off until the end.');
  };

  /** Whether the last step can still be undone: not once its reply went, and an action item only inside its window. */
  const canUndo = (entry: UndoEntry | undefined, at = Date.now()): boolean => {
    if (!entry) return false;
    const decision = queue.cache.get(entry.id);
    if (!decision) return false;
    if (sentIds.has(entry.id) || queue.gone.get(entry.id) === 'sent') return false;
    if (sends.get(groupKeyOf(decision))?.kind === 'sending' || inFlightKeys.has(groupKeyOf(decision))) return false;
    if (entry.kind === 'action') return at - entry.at < DECISION_ACTION_UNDO_MS;
    return true;
  };

  const undoLast = () => {
    const entry = undo.at(-1);
    if (!canUndo(entry)) return;
    setUndo((stack) => stack.slice(0, -1));
    const decision = queueRef.current.cache.get(entry!.id)!;
    if (entry!.kind === 'action') {
      // The card reopens only once the server took the Undo back: past its window it refuses, and says why.
      setSaid('Undoing…');
      pickChain.current = pickChain.current.then(async () => {
        try {
          await inboxApi.markAction(decision.message.id, decision.question.key, null);
          setQueue((current) => {
            const cache = new Map(current.cache);
            const known = cache.get(entry!.id) ?? decision;
            cache.set(entry!.id, { ...known, question: { ...known.question, state: 'open', action_result: null } });
            // It may have left the projection meanwhile (an action item inside its window waits on nobody).
            const gone = new Map(current.gone);
            gone.delete(entry!.id);
            return { ...current, cache, gone, current: entry!.id };
          });
          touchDecision(decision, -1);
          setStamp(null);
          setError(null);
          setSaid('Undone.');
        } catch (cause) {
          setError(cause instanceof InboxApiError ? `Not undone: ${cause.message}` : 'Not undone: it has gone to the agent.');
          setSaid('Not undone.');
          props.refresh();
        }
      });
      return;
    }
    if (entry!.kind === 'pick') {
      touchDecision(decision, -1);
      savePick(entry!.id, entry!.before);
    }
    if (entry!.kind === 'later') setQueue((current) => ({ ...current, later: new Set([...current.later].filter((l) => l !== entry!.id)) }));
    setStamp(null);
    setQueue((current) => ({ ...current, current: entry!.id }));
    setSaid('Undone.');
  };

  // An action item's Undo goes away when its window ends.
  const lastUndo = undo.at(-1);
  useEffect(() => {
    if (lastUndo?.kind !== 'action') return;
    const left = DECISION_ACTION_UNDO_MS - (Date.now() - lastUndo.at);
    if (left <= 0) return;
    const timer = setTimeout(() => setTick((t) => t + 1), left + 20);
    return () => clearTimeout(timer);
  }, [lastUndo]);

  // ── Closing: anything not sent asks first, and says what it is (read live while the question is up). ──
  /** Typed words on the card on screen, or kept from a card the queue moved away from (still waiting). */
  const wordsLeft = () =>
    unsavedWordsRef.current?.() === true ||
    [...keptWords.current.keys()].some((id) => queue.cache.has(id) && !isHandled(queue, id));
  const closeReasons = (): CloseReasons => {
    const reasons: CloseReasons = { half: 0, ready: 0, failed: 0, drafts: 0, sending: 0, words: wordsLeft() };
    for (const key of groupKeys(queue)) {
      const state = sends.get(key) ?? { kind: 'waiting' as const };
      if (state.kind === 'sending' || inFlightKeys.has(key)) {
        reasons.sending += 1;
        continue;
      }
      const fresh = freshPicks(queue, key, carried.get(key)).length > 0;
      if (state.kind === 'failed' && fresh) reasons.failed += 1;
      else if (state.kind === 'draft') reasons.drafts += 1;
      else if (groupHalfAnswered(queue, key, carried.get(key))) reasons.half += 1;
      else if (groupReady(queue, key, carried.get(key))) reasons.ready += 1;
    }
    return reasons;
  };

  /**
   * The close question let go (Escape, Keep deciding): its buttons leave the page, so focus goes back to the Close
   * button that asked it, never to the page itself (approval "inbox-keyboard-shortcuts", consistent Escape).
   */
  // Keep deciding puts focus on × once the confirm has gone (the effect below runs after that render, however late:
  // a frame timer could run before it on a slow machine and focus a × still behind the confirm).
  const focusCloseAfterConfirm = useRef(false);
  const keepDeciding = () => {
    focusCloseAfterConfirm.current = true;
    setConfirm(false);
  };
  useEffect(() => {
    if (confirm || !focusCloseAfterConfirm.current) return;
    focusCloseAfterConfirm.current = false;
    document.querySelector<HTMLElement>('[data-decision-mode] [data-decision-close]')?.focus();
  }, [confirm]);

  const requestClose = () => {
    const now = closeReasons();
    if (now.half + now.ready + now.failed + now.drafts + now.sending > 0 || now.words) setConfirm(true);
    else props.onClose();
  };

  /** The groups "Send what you answered" sends: every one with an answer no reply carried, except threads whose reply goes from the thread. */
  const sendableKeys = () =>
    groupKeys(queue).filter((key) => {
      if (sends.get(key)?.kind === 'draft') return false;
      const first = queue.cache.get(groupIds(queue, key)[0]!);
      if (first && draftOf(first.thread.id)) return false;
      return freshPicks(queue, key, carried.get(key)).length > 0;
    });

  /** Close only once every send on its way has landed; one that failed keeps the dialog open, never silent. */
  const closeAfter = async (sending: Promise<SendResult>[]) => {
    setClosing(true);
    const results = await Promise.all(sending);
    setClosing(false);
    const failed = results.filter((r) => r === 'failed').length;
    if (failed > 0) {
      setConfirm(false);
      setError(`${failed === 1 ? 'A reply was' : `${formatCount(failed)} replies were`} not sent. Try again from the chip, or close and keep the answers as a draft.`);
      return;
    }
    props.onClose();
  };

  const sendAnswered = () => void closeAfter([...new Set([...sendableKeys(), ...inFlight.current.keys()])].map((key) => sendGroup(key)));

  /** Keep as a draft: nothing more is sent; a reply already on its way is waited for (and its failure said). */
  const keepDraft = () => {
    // Nothing touched any more: should the dialog stay open (a reply on its way failed), every ready group
    // waits as Held · Send rather than starting its Hold again.
    setTouched(new Map());
    setSends((current) => {
      const next = new Map(current);
      for (const [key, state] of next) if (state.kind === 'hold' || state.kind === 'held') next.set(key, { kind: 'waiting' });
      return next;
    });
    void closeAfter([...inFlight.current.values()]);
  };

  /** Escape: one layer at a time (a box with words in it is a layer: it lets go of focus first). */
  const escape = () => {
    if (lightbox) return;
    if (confirm) return keepDeciding();
    if (fieldOpenRef.current?.()) return;
    if (overview) return setOverview(false);
    requestClose();
  };

  const chips = useMemo(() => sessionChips(queue), [queue]);
  const current = queue.current ? queue.cache.get(queue.current) ?? null : null;
  const peek = current ? nextId({ ...queue, later: new Set([...queue.later, current.id]) }, current.id) : null;
  const peekDecision = peek && peek !== current?.id ? queue.cache.get(peek) ?? null : null;
  const prev = previousId(queue, queue.current);
  const after = queue.order.filter((id) => id !== queue.current && !isHandled(queue, id)).length;
  const undoable = canUndo(lastUndo);
  // A card whose answer a reply already took (Previous reaches it): read only.
  const sentAnswer = current && (sentIds.has(current.id) || queue.gone.get(current.id) === 'sent' || current.question.state === 'sent') ? current : null;
  const loaded = props.decisions !== null;
  // A replacement on its way is still a decision: the end screen waits for it.
  const done = loaded && queue.current === null && !swapPending;
  const startTarget = startBanner && startBanner !== current?.id && !isHandled(queue, startBanner) ? queue.cache.get(startBanner) ?? null : null;
  const sendingCard = current !== null && sentAnswer === null && (sends.get(groupKeyOf(current))?.kind === 'sending' || inFlightKeys.has(groupKeyOf(current)));

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
        if (event.key !== 'Escape' || event.defaultPrevented) return;
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
            <button type="button" className="ib-dm-x" aria-label="Close decision mode" data-decision-close="" onClick={requestClose}>
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
        now={now}
        queue={queue}
        onHold={(key) => setSend(key, { kind: 'held', by: 'person' })}
        onSendNow={(key) => void sendGroup(key)}
        onOpenThread={(key) => {
          const first = queue.cache.get(groupIds(queue, key)[0]!);
          if (first) props.onTuck(first.thread.id);
        }}
        ended={ended}
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
              setQueue((state) => ({ ...state, current: id }));
            }}
          />
        ) : done ? (
          <EndScreen queue={queue} sends={sends} rows={props.rows} busy={busy} onClose={requestClose} />
        ) : current ? (
          <div className="ib-dm-deck" data-reduced={reduced ? '' : undefined}>
            {/* The next card peeks behind this one: an edge, nothing to read. */}
            {peekDecision && <div className="ib-dm-peek" aria-hidden="true" data-decision-peek="" />}
            <DecisionCard
              key={current.id}
              decision={current}
              phone={props.phone}
              touch={touch}
              stamp={stamp?.id === current.id ? stamp.value : null}
              sent={sentAnswer !== null}
              sending={sendingCard}
              reduced={reduced}
              fieldOpenRef={fieldOpenRef}
              unsavedWordsRef={unsavedWordsRef}
              keptWords={keptWords.current}
              onEditing={(editing) => setEditingId((was) => (editing ? current.id : was === current.id ? null : was))}
              banner={
                banner ? (
                  <div className="ib-dm-banner" role="status" data-decision-replaced="">
                    <Icon name="warn" size={16} />
                    <span>
                      <b>{banner.withdrawn ? `${banner.agent} withdrew the last question.` : `${banner.agent} replaced this question just now.`}</b> Your pick, if any, wasn&apos;t sent.
                    </span>
                  </div>
                ) : startTarget ? (
                  <div className="ib-dm-banner" role="status" data-decision-start-banner="">
                    <Icon name="warn" size={16} />
                    <span>
                      <b>{agentLabel(startTarget)} is stopped on you:</b> {startTarget.question.prompt} ·{' '}
                      <button
                        type="button"
                        className="ib-dm-lnk"
                        data-decision-start-go=""
                        onClick={() => {
                          setStartBanner(null);
                          setQueue((state) => ({ ...state, current: startTarget.id }));
                        }}
                      >
                        Go to it
                      </button>{' '}
                      (what you typed here stays)
                    </span>
                  </div>
                ) : undefined
              }
              onAnswer={(value) => answer(current.id, value)}
              onAction={(mark) => act(current.id, mark)}
              onLater={() => later(current.id)}
              onOpenThread={(fileId) => props.onTuck(current.thread.id, fileId, fileId ? undefined : { messageId: current.message.id, key: current.question.key })}
              onImage={(pictures, index) => setLightbox({ pictures, index })}
            />
            <div className="ib-dm-nav">
              <button
                type="button"
                className="ib-dm-lnk"
                data-decision-previous=""
                disabled={prev === null}
                onClick={() => {
                  if (prev) {
                    setBanner(null);
                    setQueue((state) => ({ ...state, current: prev }));
                  }
                }}
              >
                <Icon name="back" size={15} />
                Previous
              </button>
              <span className="ib-dm-after">{after === 0 ? 'The last one' : `${formatCount(after)} more after this`}</span>
            </div>
          </div>
        ) : (
          <div className="ib-dm-loading">Reading what waits on you…</div>
        )}
      </div>
      {confirm && <CloseConfirm reasons={closeReasons()} closing={closing} onKeep={keepDeciding} onKeepDraft={keepDraft} onSend={sendAnswered} />}
      <div className="ib-sr" aria-live="polite" data-decision-live="">
        {said}
      </div>
      {lightbox &&
        createPortal(
          <ImageLightbox
            src={lightbox.pictures[lightbox.index]!.src}
            alt={lightbox.pictures[lightbox.index]!.name}
            // Each picture by its choice ("B · Quiet hover menu"), not its file's route; a finger swipes through them (approval "inbox-image-swipe").
            images={lightbox.pictures.length > 1 ? lightbox.pictures.map((p) => ({ src: p.src, alt: p.alt ?? p.name, name: p.name })) : undefined}
            swipe
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

/** What closing would leave behind, and the words for it. */
interface CloseReasons {
  half: number;
  ready: number;
  failed: number;
  drafts: number;
  /** Replies on their way now: closing waits for them, and says so if one fails. */
  sending: number;
  words: boolean;
}

const agents = (n: number) => (n === 1 ? '1 agent' : `${formatCount(n)} agents`);
const replies = (n: number) => (n === 1 ? '1 reply' : `${formatCount(n)} replies`);

/**
 * The close question, in the words of what is left: agents half answered
 * (their picks are saved; the rest waits), replies answered and waiting to
 * send (a Hold, or Held), replies that failed, threads whose reply goes from
 * the thread (a reply draft), and words typed on the card and not answered.
 */
function CloseConfirm({ reasons, closing, onKeep, onKeepDraft, onSend }: { reasons: CloseReasons; closing: boolean; onKeep: () => void; onKeepDraft: () => void; onSend: () => void }) {
  const sendable = reasons.half + reasons.ready + reasons.failed;
  const nothing = sendable + reasons.drafts + reasons.sending === 0 && !reasons.words;
  const title = nothing
    ? 'Nothing is left to send'
    : reasons.failed > 0
      ? reasons.failed === 1
        ? "A reply didn't send"
        : "Some replies didn't send"
      : reasons.half > 0
        ? 'Some agents are half answered'
        : reasons.ready > 0
          ? reasons.ready === 1
            ? 'A reply is waiting to send'
            : 'Replies are waiting to send'
          : reasons.drafts > 0
            ? 'Your answers wait in a thread'
            : reasons.sending > 0
              ? 'A reply is on its way'
              : "What you typed isn't saved";
  const lines: string[] = [];
  if (reasons.failed > 0) lines.push(`${replies(reasons.failed)} failed to send. Your answers are saved in the thread.`);
  if (reasons.half > 0) lines.push(`${agents(reasons.half)} half answered: what you picked is saved, the rest still waits on you.`);
  if (reasons.ready > 0) lines.push(`${replies(reasons.ready)} answered and not sent yet.`);
  if (reasons.sending > 0) lines.push(`${replies(reasons.sending)} still sending: closing waits for ${reasons.sending === 1 ? 'it' : 'them'}, and says so if one fails.`);
  if (nothing) lines.push('Every reply has gone.');
  if (reasons.drafts > 0) lines.push(`${reasons.drafts === 1 ? 'A thread has' : `${formatCount(reasons.drafts)} threads have`} a draft reply: send ${reasons.drafts === 1 ? 'it' : 'them'} from the thread, with your answers.`);
  if (reasons.words) lines.push("The words you typed on this card aren't saved, and closing loses them.");
  return (
    <div className="ib-dm-confirm" role="alertdialog" aria-labelledby="ib-dm-confirm-t" aria-describedby="ib-dm-confirm-d" data-decision-confirm="">
      <h2 id="ib-dm-confirm-t">{title}</h2>
      <div id="ib-dm-confirm-d">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {sendable > 0 && <p>Send what you answered now, or keep it as a draft in each thread: nothing you picked is lost either way.</p>}
      </div>
      <div className="ib-dm-confirm-acts">
        <button type="button" className="ib-btn" autoFocus={sendable === 0} onClick={onKeep}>
          Keep deciding
        </button>
        <button type="button" className="ib-btn" data-decision-keep-draft="" disabled={closing} onClick={onKeepDraft}>
          {closing && sendable === 0 ? 'Waiting for the reply…' : sendable > 0 ? 'Keep as a draft' : 'Close'}
        </button>
        {sendable > 0 && (
          <button type="button" className="ib-btn ib-pri" data-decision-send-answered="" disabled={closing} autoFocus onClick={onSend}>
            {closing ? 'Sending…' : 'Send what you answered'}
          </button>
        )}
      </div>
    </div>
  );
}

/** What a chip says about its session's reply. */
function chipSend(chip: SessionChip, sends: ReadonlyMap<string, GroupSend>, rows: ReadonlyMap<string, InboxListRow>, busy: ReadonlyMap<string, boolean>, queue: QueueState, now: number):
  | { kind: 'none' }
  | { kind: 'hold'; key: string; seconds: number; paused: boolean }
  | { kind: 'held'; key: string }
  | { kind: 'draft'; key: string }
  | { kind: 'failed'; key: string; error: string }
  | { kind: 'words'; text: string; tone: 'quiet' | 'ok' } {
  for (const key of chip.groups) {
    const state = sends.get(key);
    if (state?.kind === 'hold') return { kind: 'hold', key, seconds: holdSeconds(state, now), paused: state.paused !== null };
    if (state?.kind === 'held') return { kind: 'held', key };
    if (state?.kind === 'draft') return { kind: 'draft', key };
    if (state?.kind === 'failed') return { kind: 'failed', key, error: state.error };
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
  now: number;
  queue: QueueState;
  onHold: (key: string) => void;
  onSendNow: (key: string) => void;
  onOpenThread: (key: string) => void;
  /** Groups whose asking session ended while their reply waited. */
  ended: ReadonlySet<string>;
  /** Chips named by agent (a sitting scoped to one thread), else by project. */
  byAgent?: boolean;
}) {
  return (
    <ol className="ib-dm-strip" aria-label="Agents waiting" data-decision-strip="">
      {props.chips.map((chip) => {
        const send = chipSend(chip, props.sends, props.rows, props.busy, props.queue, props.now);
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
            {send.kind === 'hold' && (
              <span className="ib-dm-hold-l" data-decision-hold="">
                {send.paused ? `Waiting · sends ${send.seconds} s after you finish ·` : `Sending in ${send.seconds} s ·`}{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onHold(send.key)}>
                  Hold
                </button>
              </span>
            )}
            {send.kind === 'held' && (
              <span className="ib-dm-hold-l" data-decision-held="">
                Held ·{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onSendNow(send.key)}>
                  Send
                </button>
              </span>
            )}
            {send.kind === 'draft' && (
              <span className="ib-dm-hold-l" data-decision-draft="">
                This thread has a draft reply; send it from the thread ·{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onOpenThread(send.key)}>
                  Open the thread
                </button>
              </span>
            )}
            {(send.kind === 'hold' || send.kind === 'held') && props.ended.has(send.key) && (
              <span className="ib-dm-hold-l" data-decision-ended="">
                Its session ended: the reply waits for the next agent that reads the thread.
              </span>
            )}
            {send.kind === 'failed' && (
              <span className="ib-dm-hold-l ib-dm-bad">
                Not sent ·{' '}
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
  if (isActionDecision(decision)) return decision.question.action_result?.outcome === 'cant' ? "Can't do it" : 'Done';
  return answerWords(decision.question.answer);
}

/** The end: nothing waits, and what each agent did with its reply. */
function EndScreen(props: { queue: QueueState; sends: ReadonlyMap<string, GroupSend>; rows: ReadonlyMap<string, InboxListRow>; busy: ReadonlyMap<string, boolean>; onClose: () => void }) {
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
        Nothing waits on you
      </h2>
      <p>
        {formatCount(handled)} {handled === 1 ? 'decision' : 'decisions'}. Each agent gets one reply per thread.
      </p>
      {chips.length > 0 && (
        <ul className="ib-dm-endlist">
          {chips.map((chip) => {
            const send = chipSend(chip, props.sends, props.rows, props.busy, props.queue, Date.now());
            const words =
              send.kind === 'words'
                ? send.text
                : send.kind === 'hold'
                  ? `Sending in ${send.seconds} s`
                  : send.kind === 'held'
                    ? 'Held'
                    : send.kind === 'draft'
                      ? 'Send it from the thread (draft reply)'
                      : send.kind === 'failed'
                        ? 'Not sent'
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
