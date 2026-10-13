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
 * focus events that change the answer without crossing a threshold). "On
 * screen" also means on top: a sheet, a popover or a toast drawn over the
 * first lines hides them (`onTop`).
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
/** The first line when the message has no sender row to measure. */
export const FIRST_LINE_PX = 24;
/** How often the dwell checks again while it runs: a sheet or a toast opening over the thread raises no event here. */
export const RECHECK_MS = 250;

export interface Span {
  top: number;
  bottom: number;
}

/** The first lines of a message, and `line`: the bottom of its first line (the sender row). */
export interface FirstLines extends Span {
  line: number;
}

/** The first lines of a message: from the top of its sender row to 96 px under it, or its bottom when it is shorter. */
export function firstLines(article: Span, senderTop: number | null, senderBottom: number | null): FirstLines {
  const top = senderTop ?? article.top;
  return {
    top,
    bottom: Math.min(article.bottom, (senderBottom ?? top) + FIRST_LINES_PX),
    line: Math.min(article.bottom, senderBottom ?? top + FIRST_LINE_PX),
  };
}

/**
 * What must be on screen: the first lines, or only the first line when the
 * view is too short to hold the first lines above the pill's band (a phone on
 * its side with the keyboard up), so a short view can still see a message.
 */
export function requiredLines(lines: FirstLines, view: Span, band = 0): Span {
  if (view.bottom - band - view.top >= lines.bottom - lines.top) return { top: lines.top, bottom: lines.bottom };
  return { top: lines.top, bottom: lines.line };
}

/** The first lines are wholly inside the view, above the band the pill covers (0 when it does not show). */
export function firstLinesInView(lines: Span, view: Span, band = 0): boolean {
  if (lines.bottom <= lines.top) return false;
  return lines.top >= view.top - 1 && lines.bottom <= view.bottom - band + 1;
}

/**
 * The points to test for something drawn over the first lines: the middle
 * of the article's visible width, near the top of the lines and halfway down.
 */
export function samplePoints(lines: Span, article: { left: number; right: number }, view: { left: number; right: number }): { x: number; y: number }[] {
  const left = Math.max(article.left, view.left);
  const right = Math.min(article.right, view.right);
  const x = right > left ? (left + right) / 2 : (article.left + article.right) / 2;
  const height = lines.bottom - lines.top;
  return [
    { x, y: lines.top + Math.min(8, height / 2) },
    { x, y: lines.top + height / 2 },
  ];
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

/**
 * How far the article is drawn from where it sits: the entrance animation of
 * an arrival (`data-arrived`, a 6 px rise) moves it while it runs, and where
 * it sits is what counts.
 */
function entranceShift(article: HTMLElement): number {
  if (!article.hasAttribute('data-arrived') || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0;
  const transform = window.getComputedStyle(article).transform;
  if (!transform || transform === 'none') return 0;
  const values = /^matrix(3d)?\(([^)]*)\)$/.exec(transform)?.[2]?.split(',').map(Number);
  if (!values) return 0;
  const ty = values.length === 16 ? values[13] : values[5];
  return ty !== undefined && Number.isFinite(ty) ? ty : 0;
}

/** The first lines of a message article, measured now, without the entrance animation's shift. */
export function measureFirstLines(article: HTMLElement): FirstLines {
  const shift = entranceShift(article);
  const box = article.getBoundingClientRect();
  const sender = article.querySelector<HTMLElement>('.ib-sender, .ib-fline');
  const head = sender?.getBoundingClientRect() ?? null;
  return firstLines({ top: box.top - shift, bottom: box.bottom - shift }, head ? head.top - shift : null, head ? head.bottom - shift : null);
}

/**
 * Nothing is drawn over the first lines: at each sample point the topmost
 * element is inside the article (a sheet, a popover, the toast or a menu over
 * them is not). Where the browser cannot tell (no `elementFromPoint`), the
 * other checks decide alone.
 */
function onTop(article: HTMLElement, lines: Span, view: DOMRect): boolean {
  if (typeof document.elementFromPoint !== 'function') return true;
  return samplePoints(lines, article.getBoundingClientRect(), view).every(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && article.contains(hit);
  });
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
      const band = state.current.pill ? PILL_BAND_PX : 0;
      const lines = requiredLines(measureFirstLines(article), view, band);
      return firstLinesInView(lines, view, band) && onTop(article, lines, view);
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
    // A sheet, a popover or the toast opening or closing over the first lines
    // raises none of the events above: look again while there is something to see.
    const recheck = setInterval(evaluate, RECHECK_MS);
    evaluateRef.current = evaluate;
    evaluate();
    return () => {
      evaluateRef.current = null;
      clearInterval(recheck);
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
