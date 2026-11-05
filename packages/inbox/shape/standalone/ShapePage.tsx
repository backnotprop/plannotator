/**
 * The standalone Shape page (approvals "shape-living-board" decision 6 and
 * "shape-landing-grid": "standalone, under a small Plannotator header"). What
 * `plannotator shape open` shows a person who does not use the Plannotator
 * Inbox: the grid of boards (the Inbox's ShapeGrid), then a board (the
 * Inbox's ShapeBoard over this page's host). Esc or Back returns to the grid.
 *
 * Every state is a URL: the grid is `/`, a board `#shape=shp_…` (with
 * `&view=` and `&panel=` as the board moves). No keys of its own: Esc is the
 * board's (approved for Shape), and the page closes the board on an Esc the
 * board did not use, as the Inbox does.
 *
 * One event stream per page (`/api/shapes/events`): a change re-reads the
 * list and tells the open board. Shape off (config `inboxShape`): the routes
 * answer 404 and the page says Shape is off.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shapeViewNow, type ShapeViewId } from '@plannotator/core/shape';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { ShapeGrid, type ShapeGridItem } from '@plannotator/ui/components/shape/ShapeGrid';
import type { ShapePanelTab } from '@plannotator/ui/components/shape';
import { ShapeApiError, type ShapePageApi, type ShapeSummaryWire } from './api';
import { createStandaloneShapeHost } from './host';

const ShapeBoard = lazy(() => import('#shape-board'));

const VIEWS: readonly ShapeViewId[] = ['picture', 'how', 'know', 'code'];
const PANELS: readonly ShapePanelTab[] = ['ask', 'refs'];

export interface ShapeRoute {
  shape: string | null;
  view: ShapeViewId | null;
  panel: ShapePanelTab | null;
}

/** The page's state from its address: `#shape=shp_…&view=how&panel=ask`, else the grid. */
export function parseShapeHash(hash: string): ShapeRoute {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const shape = params.get('shape');
  // A saved link to the old What to know or Requirements view: `know`, which the board opens as its Shape view, at those words.
  const view = shapeViewNow(params.get('view')) as ShapeViewId | null;
  const panel = params.get('panel') as ShapePanelTab | null;
  return {
    shape: shape && /^shp_[0-9A-Za-z]+$/.test(shape) ? shape : null,
    view: view && VIEWS.includes(view) ? view : null,
    panel: panel && PANELS.includes(panel) ? panel : null,
  };
}

export function shapeHash(route: ShapeRoute): string {
  if (!route.shape) return '';
  const params = new URLSearchParams({ shape: route.shape });
  if (route.view && route.view !== 'picture') params.set('view', route.view);
  if (route.panel) params.set('panel', route.panel);
  return `#${params.toString()}`;
}

/** The grid's card for a board. */
export function shapePageItem(s: ShapeSummaryWire): ShapeGridItem {
  return {
    id: s.id,
    title: s.title,
    project: s.project.name,
    updated: s.updated,
    drawing: s.drawing,
    changed: s.changed,
    picture: s.preview?.picture ?? null,
    refs: s.preview?.refs ?? [],
  };
}

/** "8 boards", "1 board". */
export function boardCount(n: number): string {
  return n === 1 ? '1 board' : `${n} boards`;
}

type Status = 'loading' | 'on' | 'off' | 'unreachable';

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </svg>
  );
}

export interface ShapePageProps {
  api: ShapePageApi;
  /** The page's event stream (tests pass a stand-in). */
  openEvents?: () => EventSource;
  /** The window (tests pass happy-dom's). */
  win?: Window;
}

export function ShapePage({ api, openEvents, win = window }: ShapePageProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [shapes, setShapes] = useState<ShapeSummaryWire[] | null>(null);
  const [route, setRoute] = useState<ShapeRoute>(() => parseShapeHash(win.location.hash));
  const [query, setQuery] = useState('');
  const listeners = useRef(new Set<(ids: string[]) => void>());
  const reading = useRef<AbortController | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The board was opened from this page's grid (Back returns there); else it was the address the page opened at. */
  const openedHere = useRef(false);
  const lastOpened = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const subscribe = useCallback((listener: (ids: string[]) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const host = useMemo(() => createStandaloneShapeHost({ api, subscribe }), [api, subscribe]);

  const refresh = useCallback(() => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    api
      .shapes(controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        setShapes(answer.shapes);
        setStatus('on');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ShapeApiError && error.status === 404) setStatus('off');
        else if (!(error instanceof ShapeApiError)) setStatus((s) => (s === 'loading' ? 'unreachable' : s));
      });
  }, [api]);

  // Who serves the page (its serverSession), then the boards and the one event stream.
  useEffect(() => {
    let stream: EventSource | null = null;
    let closed = false;
    void api
      .info()
      .then((info) => {
        if (closed) return;
        if (!info.on) {
          setStatus('off');
          return;
        }
        refresh();
        stream = openEvents ? openEvents() : new EventSource('/api/shapes/events');
        stream.addEventListener('shapes', (event) => {
          let ids: string[] = [];
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as { ids?: unknown };
            if (Array.isArray(data.ids)) ids = data.ids.filter((x): x is string => typeof x === 'string');
          } catch {
            // an empty list: read everything again
          }
          for (const listener of listeners.current) listener(ids);
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(refresh, 60);
        });
      })
      .catch(() => {
        if (!closed) setStatus('unreachable');
      });
    return () => {
      closed = true;
      stream?.close();
      reading.current?.abort();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [api, refresh, openEvents]);

  // Back and Forward: the address is the state.
  useEffect(() => {
    const follow = () => setRoute(parseShapeHash(win.location.hash));
    win.addEventListener('popstate', follow);
    win.addEventListener('hashchange', follow);
    return () => {
      win.removeEventListener('popstate', follow);
      win.removeEventListener('hashchange', follow);
    };
  }, [win]);

  const open = useCallback(
    (id: string) => {
      const next: ShapeRoute = { shape: id, view: null, panel: null };
      win.history.pushState(null, '', shapeHash(next));
      openedHere.current = true;
      lastOpened.current = id;
      setRoute(next);
    },
    [win],
  );

  const close = useCallback(() => {
    if (openedHere.current) {
      openedHere.current = false;
      win.history.back();
      return;
    }
    win.history.replaceState(null, '', win.location.pathname + win.location.search);
    setRoute({ shape: null, view: null, panel: null });
  }, [win]);

  // Esc the board did not use closes it (the board marks the Esc it uses, in its capture listener).
  useEffect(() => {
    if (!route.shape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [route.shape, close, win]);

  // Back on the grid: focus the card that was open, else the heading.
  useEffect(() => {
    if (route.shape) return;
    const id = lastOpened.current;
    const card = id ? win.document.querySelector<HTMLElement>(`[data-shape-card="${id}"]`) : null;
    (card ?? headingRef.current)?.focus({ preventScroll: !!card });
  }, [route.shape, win]);

  const board = route.shape ? (shapes ?? []).find((s) => s.id === route.shape) ?? null : null;
  useEffect(() => {
    win.document.title = route.shape ? `${board?.title ?? 'Board'} · Shape` : 'Plannotator Shape';
  }, [route.shape, board?.title, win]);

  const onNavigate = useCallback(
    (state: { view: ShapeViewId; panel: ShapePanelTab | null }) => {
      if (!route.shape) return;
      win.history.replaceState(null, '', shapeHash({ shape: route.shape, view: state.view, panel: state.panel }));
    },
    [route.shape, win],
  );

  const items = useMemo(() => (shapes ?? []).filter((s) => s.state === 'active').map(shapePageItem), [shapes]);
  /** The count and Find show once there is a board to count or find. */
  const hasBoards = status === 'on' && items.length > 0;
  const boardOpen = status === 'on' && !!route.shape;

  let body: ReactNode;
  if (status === 'off') {
    body = (
      <div className="shp-page-note" data-shape-page-off="">
        <Pebble alive={false} size={40} />
        <h2>Shape is off.</h2>
      </div>
    );
  } else if (status === 'unreachable') {
    body = (
      <div className="shp-page-note" role="alert">
        <Pebble alive={false} size={40} />
        <h2>The Shape page's server is not running.</h2>
      </div>
    );
  } else {
    body = (
      <ShapeGrid
        items={items}
        query={query}
        onOpen={open}
        assetUrl={host.assetUrl}
        empty={
          query ? undefined : shapes === null ? (
            <span aria-busy="true" />
          ) : (
            <div className="shp-page-note" data-shape-page-empty="">
              <Pebble alive size={40} />
              <h2>No boards yet.</h2>
              <p>Boards your agents draw and keep current: a picture of the work you can point at to change or ask.</p>
            </div>
          )
        }
      />
    );
  }

  return (
    <div className="shp-page" data-shape-page="">
      <div className="shp-page-pane">
        <section className="shp-page-grid" aria-labelledby="shp-page-title" aria-busy={status === 'loading'} inert={boardOpen ? true : undefined}>
          <header className="shp-page-head">
            <span className="shp-page-brand">
              <Pebble alive={false} size={22} />
              <span>Plannotator</span>
            </span>
            <h1 id="shp-page-title" ref={headingRef} tabIndex={-1}>
              Shape
            </h1>
            {hasBoards && <span className="shp-page-sum">{boardCount(items.length)}</span>}
            <span className="shp-page-sp" />
            {hasBoards && (
              <label className="shp-page-find">
                <SearchIcon />
                <input type="search" placeholder="Find by title or project" aria-label="Find by title or project" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            )}
          </header>
          <div className="shp-page-body">{body}</div>
        </section>
        {boardOpen && (
          <section className="shp-page-board pn-shape" data-shape-layer={route.shape} aria-label="Shape">
            <Suspense fallback={<div className="shp-page-loading" aria-busy="true" />}>
              <ShapeBoard
                key={route.shape}
                host={host}
                id={route.shape!}
                onClose={close}
                initialView={route.view ?? undefined}
                initialPanel={route.panel}
                onNavigate={onNavigate}
              />
            </Suspense>
          </section>
        )}
      </div>
    </div>
  );
}
