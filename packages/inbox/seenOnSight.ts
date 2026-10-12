/**
 * Seen on sight (design record "inbox-new-in-open-thread", variant A,
 * approved 2026-10-12; not in this repo). An agent message that arrives while
 * its thread is open counts as seen once its first lines (the sender row and
 * about 96 px of the body, or the whole message when it is shorter) have been
 * inside the thread's view, clear of the "↓ N new" pill, for one second
 * without a break, while the tab is visible, the window has focus, and
 * nothing covers the thread (a file over it, a dialog, a guided review).
 * Then the window records the look up to that message (`POST /seen
 * { through_seq }`), never past a message the person was not shown.
 *
 * The rules are pure and live here; `useSeenOnSight` runs them over the
 * thread's DOM with an IntersectionObserver (and the scroll, visibility and
 * focus events that change the answer without crossing a threshold).
 */

import { useEffect, useRef } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { isPersonReply } from './folding';
import { pageInFront } from './sound';

/** How long the first lines must stay on screen. */
export const SEEN_DWELL_MS = 1000;
/** The body under the sender row that makes up "the first lines". */
export const FIRST_LINES_PX = 96;
/** Within this of the bottom, the person is at the end of the thread: an arrival scrolls into view. */
export const AT_END_PX = 24;
/** The band at the bottom of the thread the "↓ N new" pill sits over while it shows. */
export const PILL_BAND_PX = 56;

export interface Span {
  top: number;
  bottom: number;
}

/** The first lines of a message: from the top of its sender row to 96 px under it, or its bottom when it is shorter. */
export function firstLines(article: Span, senderTop: number | null, senderBottom: number | null): Span {
  const top = senderTop ?? article.top;
  return { top, bottom: Math.min(article.bottom, (senderBottom ?? top) + FIRST_LINES_PX) };
}

/** The first lines are wholly inside the view, above the band the pill covers (0 when it does not show). */
export function firstLinesInView(lines: Span, view: Span, band = 0): boolean {
  if (lines.bottom <= lines.top) return false;
  return lines.top >= view.top - 1 && lines.bottom <= view.bottom - band + 1;
}

/**
 * The seq of the newest agent message in a thread the window read: what the
 * look recorded for that read covers (`through_seq`). Null when the thread
 * carries no seqs (an older Inbox: the look then goes without the cap) or no
 * agent message.
 */
export function latestAgentSeq(thread: { messages: readonly InboxMessageWire[] }): number | null {
  if (thread.messages.some((m) => typeof m.seq !== 'number')) return null;
  let latest: number | null = null;
  for (const message of thread.messages) if (message.author.kind === 'agent') latest = Math.max(latest ?? 0, message.seq!);
  return latest;
}

/**
 * The agent messages that arrived after what the window's looks covered
 * (`through`), in thread order: those still to be seen on sight. The person's
 * own reply is a look at everything before it (the store's rule), so a
 * message they answered is not waiting to be seen. Null `through`: the
 * thread carries no seqs (an older Inbox), and nothing is tracked.
 */
export function unseenArrivals(messages: readonly InboxMessageWire[], through: number | null): InboxMessageWire[] {
  if (through === null) return [];
  let floor = through;
  for (const message of messages) if (isPersonReply(message) && typeof message.seq === 'number') floor = Math.max(floor, message.seq);
  return messages.filter((m) => m.author.kind === 'agent' && typeof m.seq === 'number' && m.seq > floor);
}

/**
 * How far the look may go once `seen` have been on screen: the seq of the
 * last arrival such that it and every arrival before it were seen. Null when
 * the first one still waits (the look never passes a message the person was
 * not shown: the store keeps one high-water mark per thread).
 */
export function lookThrough(arrivals: readonly InboxMessageWire[], seen: ReadonlySet<string>): number | null {
  let through: number | null = null;
  for (const message of arrivals) {
    if (!seen.has(message.id)) break;
    through = message.seq ?? through;
  }
  return through;
}

/** Scrolled to within AT_END_PX of the bottom. */
export function atEnd(body: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>): boolean {
  return body.scrollHeight - body.scrollTop - body.clientHeight <= AT_END_PX;
}

/**
 * How far to scroll down so an arrival's first lines show (with a little
 * room under them), or 0: never upward, never past what they need.
 */
export function followBy(lines: Span, view: Span, room = 12): number {
  return Math.max(0, lines.bottom - (view.bottom - room));
}

/** A native modal dialog is open over the window (the Inbox's update and sound dialogs are `<dialog>`s). */
function dialogOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null;
}

/** The first lines of a message article, measured now. */
export function measureFirstLines(article: HTMLElement): Span {
  const box = article.getBoundingClientRect();
  const sender = article.querySelector<HTMLElement>('.ib-sender, .ib-fline');
  const head = sender?.getBoundingClientRect() ?? null;
  return firstLines(box, head ? head.top : null, head ? head.bottom : null);
}

export interface SeenOnSightOptions {
  /** The thread's scrolling body (the view). */
  bodyRef: React.RefObject<HTMLElement | null>;
  /** The messages to watch: arrivals not yet seen, and not folded (a folded message is not on screen). */
  candidates: readonly string[];
  /** Something covers the thread (a file over it, a dialog, a guided review): nothing is seen. */
  covered: boolean;
  /** The pill shows: its band at the bottom of the view does not count as on screen. */
  pill: boolean;
  /** One message's first lines stayed on screen for the dwell. */
  onSeen: (messageId: string) => void;
}

/**
 * Watches the candidates and calls `onSeen` for each once its first lines
 * have been on screen for SEEN_DWELL_MS in a row with the window in front and
 * the thread uncovered. Any break (scrolled away, the tab hidden, the window
 * behind, a cover) restarts that message's dwell.
 */
export function useSeenOnSight({ bodyRef, candidates, covered, pill, onSeen }: SeenOnSightOptions): void {
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const state = useRef({ covered, pill });
  state.current = { covered, pill };
  const key = candidates.join(' ');
  const evaluateRef = useRef<(() => void) | null>(null);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // A cover lifting (or falling), or the pill's band changing, decides again without restarting a dwell already running.
  useEffect(() => {
    evaluateRef.current?.();
  }, [covered, pill]);

  useEffect(() => {
    // Kept across runs: a second arrival must not restart the first one's dwell.
    const timers = timersRef.current;
    for (const [id, timer] of timers) {
      if (candidates.includes(id)) continue;
      clearTimeout(timer);
      timers.delete(id);
    }
    const body = bodyRef.current;
    if (!body || candidates.length === 0) return;
    const articleOf = (id: string) => body.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(id)}"]`);
    const showing = (id: string): boolean => {
      if (state.current.covered || dialogOpen() || !pageInFront()) return false;
      const article = articleOf(id);
      if (!article) return false;
      const view = body.getBoundingClientRect();
      return firstLinesInView(measureFirstLines(article), view, state.current.pill ? PILL_BAND_PX : 0);
    };
    const evaluate = () => {
      for (const id of candidates) {
        if (!showing(id)) {
          const timer = timers.get(id);
          if (timer !== undefined) clearTimeout(timer);
          timers.delete(id);
          continue;
        }
        if (timers.has(id)) continue;
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            // Checked again at the end of the dwell: a dialog that opened meanwhile raises no event here.
            if (showing(id)) onSeenRef.current(id);
          }, SEEN_DWELL_MS),
        );
      }
    };
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(() => evaluate(), { root: body, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] })
        : null;
    for (const id of candidates) {
      const article = articleOf(id);
      if (article) observer?.observe(article);
    }
    body.addEventListener('scroll', evaluate, { passive: true });
    window.addEventListener('resize', evaluate);
    window.addEventListener('focus', evaluate);
    window.addEventListener('blur', evaluate);
    document.addEventListener('visibilitychange', evaluate);
    // A dialog closing hands focus back inside the page.
    document.addEventListener('focusin', evaluate);
    evaluateRef.current = evaluate;
    evaluate();
    return () => {
      evaluateRef.current = null;
      observer?.disconnect();
      body.removeEventListener('scroll', evaluate);
      window.removeEventListener('resize', evaluate);
      window.removeEventListener('focus', evaluate);
      window.removeEventListener('blur', evaluate);
      document.removeEventListener('visibilitychange', evaluate);
      document.removeEventListener('focusin', evaluate);
    };
    // The candidates by their ids (a new list each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyRef, key]);
}
