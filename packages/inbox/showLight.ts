import { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion, SHOW_LIT_MS } from './settle';

export type ListEdge = 'top' | 'bottom';
export interface UnseenRow {
  id: string;
  edge: ListEdge;
}

const NONE: ReadonlySet<string> = new Set();
const NO_ROWS: readonly UnseenRow[] = [];
const IN_VIEW = 0.6;
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
  if (!body) {
    later(() => turnOn([...ids]), after);
    return { stop: () => timers.forEach(clearTimeout), go: () => {} };
  }

  const find = (id: string) => [...body.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`)].find((el) => el.getClientRects().length > 0) ?? null;
  const waiting = new Map<string, { el: HTMLElement; edge: ListEdge }>();
  let going = false;
  let started = false;
  let goFirst: ListEdge | null = null;
  const publish = () => {
    if (!going) setUnseen([...waiting].map(([id, row]) => ({ id, edge: row.edge })));
  };
  const measure = () => {
    if (!started) return;
    const view = body.getBoundingClientRect();
    const seen: string[] = [];
    for (const [id, row] of [...waiting]) {
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
      // A list with no height cannot say (no layout): the row counts as in view. While `go` scrolls, no row is taken as seen: it would spend its light as the list leaves it.
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
  lit: ReadonlySet<string>;
  unseen: readonly UnseenRow[];
  light: (ids: ReadonlySet<string>, after: number, body?: HTMLElement | null) => void;
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
