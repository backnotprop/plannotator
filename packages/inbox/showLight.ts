/**
 * Show's light (design record "inbox-polish", item 6; inbox.css `data-lit`, `ib-lit`): the rows Show brought in
 * light up where they landed, for `SHOW_LIT_MS`, and the light is then taken off. One run at a time: a new one
 * takes the last one's place.
 *
 * Show never scrolls the list (the owner: "instead of scrolling me down all over the … place"). So each row's
 * light waits until that row is in view in the list, and then runs its whole time in front of the reader. The
 * rows still out of view are `unseen`, each with the edge of the list it is past: the list's pill counts them
 * (components/ListNewPill.tsx), and its press is `go`, the only thing here that scrolls.
 *
 * Where the rows are is measured when something can have moved them: the list scrolls, changes size, or is drawn
 * again. Never on a timer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion, SHOW_LIT_MS } from './settle';

export type ListEdge = 'top' | 'bottom';
/** A row Show brought in that the reader has not had in view yet, and the edge of the list it is past. */
export interface UnseenRow {
  id: string;
  edge: ListEdge;
}

const NONE: ReadonlySet<string> = new Set();
const NO_ROWS: readonly UnseenRow[] = [];
/** The share of a row that must show in the list for it to be in view. */
const IN_VIEW = 0.6;
/** `go` holds the count back until its scroll ends (`scrollend`), at most this long (a browser without that event, or no scroll needed). */
const GO_MS = 1200;

interface Run {
  stop: () => void;
  go: (edge: ListEdge) => void;
}

type SetLit = (change: (lit: ReadonlySet<string>) => ReadonlySet<string>) => void;

function startRun(ids: ReadonlySet<string>, after: number, body: HTMLElement | null, setLit: SetLit, setUnseen: (rows: readonly UnseenRow[]) => void): Run {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };
  const turnOn = (rows: readonly string[]) => {
    setLit((lit) => new Set([...lit, ...rows]));
    later(() => setLit((lit) => new Set([...lit].filter((id) => !rows.includes(id)))), SHOW_LIT_MS);
  };
  // No list to measure in (a compose send's own row, lit where it is drawn): every row at once.
  if (!body) {
    later(() => turnOn([...ids]), after);
    return { stop: () => timers.forEach(clearTimeout), go: () => {} };
  }

  const find = (id: string) => [...body.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`)].find((el) => el.getClientRects().length > 0) ?? null;
  /** The rows not yet in view, with the edge each is past. */
  const waiting = new Map<string, { el: HTMLElement; edge: ListEdge }>();
  /** `go` is scrolling the list: the count is held back until the scroll ends, so the pill does not flash on the way. */
  let going = false;
  let started = false;
  /** `go` asked before the rows had slid into place (the pill's press that is also Show): it goes once they are measured. */
  let goFirst: ListEdge | null = null;
  const publish = () => {
    if (!going) setUnseen([...waiting].map(([id, row]) => ({ id, edge: row.edge })));
  };
  const measure = () => {
    if (!started) return;
    const view = body.getBoundingClientRect();
    const seen: string[] = [];
    for (const [id, row] of [...waiting]) {
      // Drawn again (another shape), or gone (its group was closed): the row on screen now, or none.
      if (!row.el.isConnected || row.el.getClientRects().length === 0) {
        const next = find(id);
        if (!next) {
          waiting.delete(id);
          continue;
        }
        row.el = next;
      }
      const rect = row.el.getBoundingClientRect();
      const showing = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
      // A list with no height cannot say (no layout): the row counts as in view. While `go` scrolls the list no row
      // is taken as seen: one in view when the press came, or passed on the way, would spend its light as the list
      // leaves it. They are read where the scroll ends.
      if (!going && (view.height === 0 || showing >= rect.height * IN_VIEW)) {
        waiting.delete(id);
        seen.push(id);
      } else row.edge = rect.top + rect.height / 2 < view.top + view.height / 2 ? 'top' : 'bottom';
    }
    if (seen.length > 0) turnOn(seen);
    if (waiting.size === 0) unwatch();
    publish();
  };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  const redraw = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
  const unwatch = () => {
    body.removeEventListener('scroll', measure);
    resize?.disconnect();
    redraw?.disconnect();
  };
  // Once the rows have slid into place.
  later(() => {
    for (const id of ids) {
      const el = find(id);
      if (el) waiting.set(id, { el, edge: 'bottom' });
    }
    started = true;
    body.addEventListener('scroll', measure, { passive: true });
    resize?.observe(body);
    redraw?.observe(body, { childList: true, subtree: true });
    measure();
    if (goFirst) go(goFirst);
  }, after);
  const go = (edge: ListEdge) => {
    if (!started) {
      goFirst = edge;
      going = true;
      return;
    }
    // The nearest of the rows past that edge; focus follows the reader there.
    const rows = [...waiting.values()].filter((row) => row.edge === edge).map((row) => ({ el: row.el, top: row.el.getBoundingClientRect().top }));
    rows.sort((a, b) => (edge === 'bottom' ? a.top - b.top : b.top - a.top));
    const el = rows[0]?.el;
    going = !!el;
    if (!el) return publish();
    el.focus({ preventScroll: true });
    const arrived = () => {
      if (!going) return;
      going = false;
      clearTimeout(limit);
      body.removeEventListener('scrollend', arrived);
      measure();
    };
    const limit = later(arrived, GO_MS);
    body.addEventListener('scrollend', arrived);
    el.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return {
    stop: () => {
      timers.forEach(clearTimeout);
      unwatch();
    },
    go,
  };
}

export function useShowLight(): {
  /** The rows lit now (`data-lit`). */
  lit: ReadonlySet<string>;
  /** The rows of this run not yet in view. */
  unseen: readonly UnseenRow[];
  /**
   * Light `ids` no sooner than `after` ms (the rows' slide into place). With `body`, the list's scroll box, each
   * row is lit when it is in view there; without it, all at once.
   */
  light: (ids: ReadonlySet<string>, after: number, body?: HTMLElement | null) => void;
  /** Scroll the list to the nearest unseen row past that edge, bringing it to the middle. */
  go: (edge: ListEdge) => void;
} {
  const [lit, setLit] = useState(NONE);
  const [unseen, setUnseen] = useState(NO_ROWS);
  const run = useRef<Run | null>(null);
  const cancel = useCallback(() => {
    run.current?.stop();
    run.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const light = useCallback(
    (ids: ReadonlySet<string>, after: number, body?: HTMLElement | null) => {
      cancel();
      setLit(NONE);
      setUnseen(NO_ROWS);
      run.current = startRun(ids, after, body ?? null, setLit, (rows) => setUnseen(rows.length === 0 ? NO_ROWS : rows));
    },
    [cancel],
  );
  const go = useCallback((edge: ListEdge) => run.current?.go(edge), []);
  return { lit, unseen, light, go };
}
