/**
 * Grid's looks (approval "inbox-agent-grid": landed and dropped work "stays until seen"). A line counts as seen only
 * once it was on the person's screen, at least half of it, in a tab that shows: an IntersectionObserver on each line
 * (no layout read), and nothing while the tab is hidden. A line behind "N more" or a closed Earlier is not drawn, so
 * not seen. The landed lines only counted in the Since line are seen when that line is.
 *
 * Looks are kept with the thread on its own computer (`POST grid/seen`, server inbox-grid-seen.ts): this Inbox's
 * threads here, a linked computer's through the forward (held in the outbox while it sleeps), so a look on a phone or
 * a linked computer counts everywhere. A line is sent when its landing or drop was not sent yet, and otherwise at
 * most every half hour while it shows (the Since line's "last look"); one write per computer per second at most.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { GridLine, GridModel } from '../../shared/inbox/grid';
import { post } from '../api';
import { inboxUrl } from '../inboxUrl';
import { tabShown } from '../data/shownPoll';

const FLUSH_MS = 1_000;
const AGAIN_MS = 30 * 60_000;
const BATCH = 200;

export type GridSeenSend = (machine: string | null, seen: { thread: string; through: number; at: number }[]) => Promise<unknown>;
const sendSeen: GridSeenSend = (machine, seen) => post(inboxUrl('/grid/seen', undefined, machine), { seen });

/** What was sent for each line, kept for the window's life: a line is not sent twice for the same look. */
const sent = new Map<string, { through: number; at: number }>();
const eventOf = (line: GridLine) => line.merged ?? line.dropped?.at ?? 0;

/**
 * `clockOf`: how far a line's computer's clock runs ahead (its times come here on this clock; they go back on its own).
 * Answers the ref for each line and for the Since line.
 */
export function useGridSeen(model: GridModel | null, clockOf: (machine: string | null) => number, send: GridSeenSend = sendSeen): { line: (el: HTMLElement | null) => (() => void) | void; since: (el: HTMLElement | null) => (() => void) | void } {
  const lines = useRef(new Map<string, GridLine>());
  const counted = useRef<GridLine[]>([]);
  const visible = useRef(new Set<string>());
  const sinceShown = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const clock = useRef(clockOf);
  clock.current = clockOf;
  const sender = useRef(send);
  sender.current = send;

  lines.current = new Map(model ? [...model.groups.flatMap((g) => g.lines), ...model.earlier].map((l) => [l.id, l]) : []);
  counted.current = model?.counted ?? [];

  const flush = useCallback(() => {
    if (!tabShown()) return;
    const now = Date.now();
    const out = new Map<string | null, { thread: string; through: number; at: number }[]>();
    const want = (line: GridLine) => {
      const through = eventOf(line);
      const was = sent.get(line.id);
      if (was && was.through >= through && now - was.at < AGAIN_MS) return;
      sent.set(line.id, { through, at: now });
      const ahead = clock.current(line.machine);
      const list = out.get(line.machine) ?? [];
      list.push({ thread: line.id, through: through > 0 ? through + ahead : 0, at: now + ahead });
      out.set(line.machine, list);
    };
    for (const id of visible.current) {
      const line = lines.current.get(id);
      if (line) want(line);
    }
    if (sinceShown.current) for (const line of counted.current) want(line);
    for (const [machine, seen] of out) {
      for (let i = 0; i < seen.length; i += BATCH) {
        const part = seen.slice(i, i + BATCH);
        // Not kept (offline, an older Inbox): those lines are sent again the next time they show.
        void sender.current(machine, part).catch(() => {
          for (const look of part) sent.delete(look.thread);
        });
      }
    }
  }, []);

  const soon = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      flush();
    }, FLUSH_MS);
  }, [flush]);

  // Made when the first line is drawn (a ref runs before an effect), ended with the page.
  const ensure = useCallback((): IntersectionObserver | null => {
    if (observer.current || typeof IntersectionObserver === 'undefined') return observer.current;
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const shown = entry.isIntersecting && entry.intersectionRatio >= 0.5;
          if (target.dataset.gridSince !== undefined) sinceShown.current = shown;
          else if (target.dataset.gridLine) {
            if (shown) visible.current.add(target.dataset.gridLine);
            else visible.current.delete(target.dataset.gridLine);
          }
        }
        soon();
      },
      { threshold: [0, 0.5] },
    );
    return observer.current;
  }, [soon]);

  useEffect(() => {
    // A tab that shows again sends what is on screen.
    const back = () => tabShown() && soon();
    document.addEventListener('visibilitychange', back);
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      document.removeEventListener('visibilitychange', back);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [soon]);

  // A line that changed while on screen (it landed as the person watched) is sent too.
  useEffect(() => {
    if (visible.current.size > 0 || sinceShown.current) soon();
  }, [model, soon]);

  const watch = useCallback((el: HTMLElement | null) => {
    const io = el ? ensure() : null;
    if (!el || !io) return;
    io.observe(el);
    return () => {
      io.unobserve(el);
      if (el.dataset.gridLine) visible.current.delete(el.dataset.gridLine);
      if (el.dataset.gridSince !== undefined) sinceShown.current = false;
    };
  }, [ensure]);
  return { line: watch, since: watch };
}

/** Tests: forget what was sent. */
export function forgetGridSeen(): void {
  sent.clear();
}
