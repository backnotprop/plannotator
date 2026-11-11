import { useEffect, useRef } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { isPersonLook } from './folding';
import { pageInFront } from './sound';

export const SEEN_DWELL_MS = 1000;
export const FIRST_LINES_PX = 96;
export const AT_END_PX = 24;
export const PILL_BAND_PX = 56;
export const FIRST_LINE_PX = 24;
export const RECHECK_MS = 250;

export interface Span {
  top: number;
  bottom: number;
}

export interface FirstLines extends Span {
  line: number;
}

export function firstLines(article: Span, senderTop: number | null, senderBottom: number | null): FirstLines {
  const top = senderTop ?? article.top;
  return {
    top,
    bottom: Math.min(article.bottom, (senderBottom ?? top) + FIRST_LINES_PX),
    line: Math.min(article.bottom, senderBottom ?? top + FIRST_LINE_PX),
  };
}

export function requiredLines(lines: FirstLines, view: Span, band = 0): Span {
  if (view.bottom - band - view.top >= lines.bottom - lines.top) return { top: lines.top, bottom: lines.bottom };
  return { top: lines.top, bottom: lines.line };
}

export function firstLinesInView(lines: Span, view: Span, band = 0): boolean {
  if (lines.bottom <= lines.top) return false;
  return lines.top >= view.top - 1 && lines.bottom <= view.bottom - band + 1;
}

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

export function latestAgentSeq(thread: { messages: readonly InboxMessageWire[] }): number | null {
  if (thread.messages.some((m) => typeof m.seq !== 'number')) return null;
  let latest: number | null = null;
  for (const message of thread.messages) if (message.author.kind === 'agent') latest = Math.max(latest ?? 0, message.seq!);
  return latest;
}

export function unseenArrivals(messages: readonly InboxMessageWire[], through: number | null): InboxMessageWire[] {
  if (through === null) return [];
  let floor = through;
  for (const message of messages) if (isPersonLook(message) && typeof message.seq === 'number') floor = Math.max(floor, message.seq);
  return messages.filter((m) => m.author.kind === 'agent' && typeof m.seq === 'number' && m.seq > floor);
}

export function lookThrough(arrivals: readonly InboxMessageWire[], seen: ReadonlySet<string>): number | null {
  let through: number | null = null;
  for (const message of arrivals) {
    if (!seen.has(message.id)) break;
    through = message.seq ?? through;
  }
  return through;
}

export function atEnd(body: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>): boolean {
  return body.scrollHeight - body.scrollTop - body.clientHeight <= AT_END_PX;
}

export function followBy(lines: Span, view: Span, room = 12): number {
  return Math.max(0, lines.bottom - (view.bottom - room));
}

function dialogOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null;
}

/** Measured from where the article sits: the arrival animation (`data-arrived`, a 6 px rise) moves it while it runs. */
function entranceShift(article: HTMLElement): number {
  if (!article.hasAttribute('data-arrived') || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0;
  const transform = window.getComputedStyle(article).transform;
  if (!transform || transform === 'none') return 0;
  const values = /^matrix(3d)?\(([^)]*)\)$/.exec(transform)?.[2]?.split(',').map(Number);
  if (!values) return 0;
  const ty = values.length === 16 ? values[13] : values[5];
  return ty !== undefined && Number.isFinite(ty) ? ty : 0;
}

export function measureFirstLines(article: HTMLElement): FirstLines {
  const shift = entranceShift(article);
  const box = article.getBoundingClientRect();
  const sender = article.querySelector<HTMLElement>('.ib-fline');
  const head = sender?.getBoundingClientRect() ?? null;
  return firstLines({ top: box.top - shift, bottom: box.bottom - shift }, head ? head.top - shift : null, head ? head.bottom - shift : null);
}

function onTop(article: HTMLElement, lines: Span, view: DOMRect): boolean {
  if (typeof document.elementFromPoint !== 'function') return true;
  return samplePoints(lines, article.getBoundingClientRect(), view).every(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && article.contains(hit);
  });
}

export interface SeenOnSightOptions {
  bodyRef: React.RefObject<HTMLElement | null>;
  candidates: readonly string[];
  covered: boolean;
  pill: boolean;
  onSeen: (messageId: string) => void;
}

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyRef, key]);
}
