/**
 * Shape in the Inbox window (approval "shape-inbox-placement"): the thread
 * header's Pebble, the grid page the sidebar's Shape row opens, the board (in
 * its thread's pane, or over the grid). No keys of its own: ⌘K and Esc are the
 * window's.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { PanePart, ShapeBoardPart } from '../lazyParts';
import type { InboxThread } from '@plannotator/core/inbox-types';
// The parts by file, never the index: the index holds ShapeSurface, which only the lazy #shape-board may load.
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { ShapeGrid, shapeAgo, type ShapeGridItem } from '@plannotator/ui/components/shape/ShapeGrid';
import type { ShapeHost, ShapeReviewAt } from '@plannotator/ui/components/shape';
import type { ShapeBoardPlace, ShapeBoardProps } from './types';
import { inboxApi, type InboxShapeSummary } from '../api';
import { readRoute } from '../app/route';
import { writeRoute } from '../app/writeRoute';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { SidebarTrigger, useSidebar } from '../shell/sidebar';
import { shapeReview, shapeReviewMessage } from './review';

const ShapeBoard = ShapeBoardPart.Part;

/**
 * A board's reference to a message of its thread: the thread, landed on that message (`msg=`, as a search result
 * lands), the board closed. From the thread's own board the rest of the address stays (Back reopens the board).
 */
function showMessage(threadId: string, messageId: string) {
  const now = readRoute();
  writeRoute(now.page === 'inbox' && now.thread === threadId ? { ...now, shape: null, guide: null, guideAt: null, msg: messageId } : { page: 'inbox', project: null, thread: threadId, msg: messageId });
}

/** The grid's card for a board. */
export function shapeGridItem(s: InboxShapeSummary): ShapeGridItem {
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

/** The thread header's Pebble: opens and closes the thread's board. A dot: it changed since you looked. */
export function ShapePebbleButton({ shape, open, onToggle }: { shape: InboxShapeSummary; open: boolean; onToggle: () => void }) {
  const tip = (
    <span className="ib-shape-tip">
      <b>Shape</b> v{shape.latest} · {shape.drawing ? 'drawing now' : `${shapeAgo(shape.updated)} ago`.replace('now ago', 'just now')}
    </span>
  );
  return (
    <Tip content={tip}>
      <button
        type="button"
        className={`ib-iconbtn ib-shapebtn${open ? ' ib-on' : ''}`}
        aria-label={`Shape, v${shape.latest}${shape.changed ? ', changed since you looked' : ''}`}
        aria-pressed={open}
        onClick={onToggle}
        data-shape-pebble={shape.id}
      >
        <Pebble alive={open || shape.drawing} reshaping={shape.drawing} size={18} />
        {shape.changed && !open && <span className="ib-shape-dot" aria-hidden="true" />}
      </button>
    </Tip>
  );
}

/**
 * The board, in its thread or over the grid: its ×, Esc or Back closes it (and the thread header's Pebble, in a
 * thread). Over the grid it covers the page's head, so the sidebar toggle every full page's head has sits at its
 * title's left: the board can take the window's width. `inThread` (the owner, 2026-11-16: "It should just fit within
 * the thread view"): it takes the messages' and the reply's place in the thread's own pane, under the thread's header,
 * on the thread's background, as the Artifacts view does; `sidebarToggle` false there while the list, with its own
 * toggle, is beside the thread.
 *
 * `onOpenReview`: a place in code on the board (a drawn part's `data-code`) opens the thread's review there; with Code
 * review on the board rides along as its corner card (ReviewPane), and the review open draws its own board, never this
 * one. `place` and `onNavigate`: where it starts (the place a link left it, back from the review) and where the person
 * goes on it. `back` and `headSide`: the way back to the board it came from, at the title's left, and the
 * thread's other boards at its right (Show me from a board, `ThreadShapeLayer`).
 */
export function ShapeLayer({
  host,
  id,
  onClose,
  thread,
  onOpenReview,
  onAddToReply,
  place = null,
  onNavigate,
  back = null,
  headSide,
  inThread = false,
  sidebarToggle = true,
}: {
  host: ShapeHost;
  id: string;
  onClose: () => void;
  thread: InboxThread | null;
  onOpenReview?: (messageId: string, at: ShapeReviewAt | null) => void;
  onAddToReply?: ShapeBoardProps['onAddToReply'];
  place?: ShapeBoardPlace | null;
  onNavigate?: ShapeBoardProps['onNavigate'];
  back?: ReactNode;
  headSide?: ReactNode;
  inThread?: boolean;
  sidebarToggle?: boolean;
}) {
  // A phone has none: there the sidebar is a sheet.
  const { isMobile } = useSidebar();
  const toggle = sidebarToggle && !isMobile;
  const reviewMessage = shapeReviewMessage(thread);
  const openReview = useRef(onOpenReview);
  openReview.current = onOpenReview;
  const review = useMemo(
    () => (reviewMessage && onOpenReview ? shapeReview(reviewMessage, (message, at) => openReview.current?.(message, at), inboxApi.guide) : null),
    // A new review in the thread, or new facts on it; not every render's new callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reviewMessage?.id, reviewMessage?.guide?.sha256, !!onOpenReview],
  );
  return (
    <ShapeBoardLayer
      host={host}
      id={id}
      onClose={onClose}
      thread={thread}
      review={review}
      onAddToReply={onAddToReply}
      place={place}
      onNavigate={onNavigate}
      headStart={!toggle && !back ? undefined : (
        <>
          {toggle && <SidebarTrigger />}
          {back}
        </>
      )}
      headSide={headSide}
      inThread={inThread}
    />
  );
}

/**
 * The layer itself, needing no sidebar: a review is a full window of its own, outside the sidebar's shell. `hidden`:
 * kept as it is (its view, its panel) while the review shows a part's code. `onCode`: a review lands a part on its line.
 * `place`: the view and panel it starts on (read once, when it mounts); `onNavigate`: each view or panel the person picks.
 */
export function ShapeBoardLayer({
  host,
  id,
  onClose,
  thread,
  hidden,
  onCode,
  review = null,
  onAddToReply,
  headStart,
  headSide,
  place = null,
  onNavigate,
  inThread = false,
}: {
  host: ShapeHost;
  id: string;
  onClose: () => void;
  thread: InboxThread | null;
  inThread?: boolean;
  hidden?: boolean;
  onCode?: ShapeBoardProps['onCode'];
  review?: ShapeBoardProps['review'];
  onAddToReply?: ShapeBoardProps['onAddToReply'];
  headStart?: ReactNode;
  headSide?: ReactNode;
  place?: ShapeBoardPlace | null;
  onNavigate?: ShapeBoardProps['onNavigate'];
}) {
  // The board is a chunk the Inbox serves: one that cannot arrive says so here, with Reload, and the next open
  // (this layer mounted again, or another board in it) asks for the chunk again.
  const [failedOn, setFailedOn] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  if (failedOn !== null && failedOn !== id) {
    setFailedOn(null);
    setAttempt(attempt + 1);
  }
  const failed = useCallback(() => {
    ShapeBoardPart.retry();
    setFailedOn(id);
  }, [id]);
  const layerRef = useRef<HTMLElement>(null);
  useFocusBackToPebble(layerRef, inThread);
  return (
    <section
      ref={layerRef}
      className={`ib-shape-layer pn-shape ${inThread ? 'ib-shape-inthread' : 'ib-wlayer'}`}
      data-shape-layer={id}
      data-shape-in-thread={inThread ? '' : undefined}
      // Open over the page, for the idle clock (idleClock.ts); over the grid `main` says so. Only once it is drawn.
      data-shape-open={inThread ? '' : undefined}
      aria-label="Shape"
      hidden={hidden}
    >
      <PanePart key={attempt} loading={<div className="ib-shape-loading" aria-busy="true" />} onFailed={failed}>
        <ShapeBoard
          host={host}
          id={id}
          onClose={onClose}
          onCode={onCode}
          review={review}
          onMessage={thread ? (messageId) => showMessage(thread.thread_id, messageId) : undefined}
          headStart={headStart}
          headSide={headSide}
          crosshair
          onAddToReply={thread ? onAddToReply : undefined}
          {...(place ? { initialView: place.view, initialPanel: place.panel } : {})}
          onNavigate={onNavigate}
        />
      </PanePart>
    </section>
  );
}

/**
 * A board in its thread closed with the focus in it, or on nothing (its ×, Esc, Back): the focus goes to the thread
 * header's Pebble that opens it again, as leaving the Artifacts view gives it back to the Artifacts button. A board
 * closed some other way (the thread closed, a press elsewhere) leaves the focus where it went.
 */
function useFocusBackToPebble(layerRef: RefObject<HTMLElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!on || !layer) return;
    return () => {
      const was = document.activeElement;
      if (was && was !== document.body && !layer.contains(was)) return;
      const pane = layer.closest('.ib-pane');
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (!pane?.isConnected || (now && now !== document.body && now.isConnected)) return;
        pane.querySelector<HTMLElement>('[data-shape-pebble]')?.focus();
      });
    };
  }, [layerRef, on]);
}

/** The grid page (the sidebar's Shape row): "Shape", Find, and every board newest first. */
export function ShapeGridPage({ shapes, onOpen }: { shapes: InboxShapeSummary[] | null; onOpen: (s: InboxShapeSummary) => void }) {
  const [query, setQuery] = useState('');
  const items = useMemo(() => (shapes ?? []).filter((s) => s.state === 'active').map(shapeGridItem), [shapes]);
  const byId = useMemo(() => new Map((shapes ?? []).map((s) => [s.id, s])), [shapes]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The page's heading takes focus, as the Board's does; Find is one Tab away.
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);
  return (
    <section className="ib-bpage ib-shape-page" data-shape-page="" aria-labelledby="ib-shape-title" aria-busy={shapes === null}>
      <div className="ib-bhead">
        <SidebarTrigger />
        <h1 id="ib-shape-title" ref={headingRef} tabIndex={-1}>
          Shape
        </h1>
        <span className="ib-bsp" />
        <label className="ib-shape-find">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Find by title or project" aria-label="Find by title or project" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div className="ib-shape-gridwrap">
        <ShapeGrid
          items={items}
          query={query}
          assetUrl={inboxApi.shapeFileUrl}
          onOpen={(id) => {
            const s = byId.get(id);
            if (s) onOpen(s);
          }}
        />
      </div>
    </section>
  );
}
