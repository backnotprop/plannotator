/**
 * A snapshot in a plan: a live, read-only window onto part of a canvas.
 *
 * It is the same renderer as the editor (`CanvasView`), with a camera fixed
 * on the snapshot's rectangle, so it is current by construction: when the
 * canvas changes, the figure is already showing the change.
 *
 * A plan may hold many. What keeps that cheap:
 * - every figure of a canvas shares that canvas's one store and one index;
 * - a figure draws only while it is near the screen (an
 *   IntersectionObserver with a margin). Far away it is an empty box of the
 *   right size, so the page does not jump and memory does not grow with the
 *   number of figures;
 * - a change to the canvas re-renders only the objects that changed, in
 *   only the figures that are drawing.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import type { CanvasDocument } from '../model/types';
import { CanvasView } from '../react/CanvasView';
import { CameraController, type Size, fitRect } from '../view/camera';
import { indexFor } from '../view/document-index';
import type { SnapshotFallbackImage } from './block';
import { type CanvasRegistry, useRegisteredCanvas } from './registry';
import { type ResolvedSnapshot, resolveSnapshot, sameResolution } from './resolve';
import { SNAPSHOT_STRINGS } from './strings';

/** How far outside the screen a figure starts drawing, in CSS pixels. */
export const FIGURE_NEAR_MARGIN = 800;
/** A figure never draws its part of the canvas larger than life. */
export const FIGURE_MAX_ZOOM = 1;
/** The tallest a figure grows, in CSS pixels. */
export const FIGURE_MAX_HEIGHT = 420;

export interface SnapshotOpenRequest {
  canvas: string;
  snapshot: string;
  /** The figure's own box: the open transition starts from it. */
  origin: HTMLElement;
  /** Where focus goes back to when the canvas closes. */
  returnFocus?: HTMLElement | null;
}

export interface SnapshotFigureProps {
  canvas: string;
  snapshot: string;
  /** A caption from the plan. Absent: the snapshot's own title. */
  title?: string;
  /** The still picture to show when the canvas cannot be reached. */
  fallback?: SnapshotFallbackImage;
  /** Absent: the registry from context. */
  registry?: CanvasRegistry | null;
  /** Absent: the figure is not clickable. */
  onOpen?: (request: SnapshotOpenRequest) => void;
  resolveImageSrc?: (src: string) => string;
}

function problemText(resolved: ResolvedSnapshot): string | null {
  switch (resolved.problem) {
    case 'some-deleted':
      return SNAPSHOT_STRINGS.someDeleted(resolved.missing, resolved.total);
    case 'all-deleted':
      return SNAPSHOT_STRINGS.allDeleted;
    case 'frame-deleted':
      return SNAPSHOT_STRINGS.frameDeleted;
    case 'no-snapshot':
      return SNAPSHOT_STRINGS.noSnapshot;
    case 'no-canvas':
      return SNAPSHOT_STRINGS.noCanvas;
    default:
      return null;
  }
}

const NO_SUBSCRIBE = () => () => {};
const NO_DOC = (): CanvasDocument | null => null;

/** The snapshot's current answer, with a stable identity while nothing about it changed. */
function useResolved(store: CanvasStore | undefined, snapshot: string): ResolvedSnapshot {
  const doc = useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIBE, store ? store.getDocument : NO_DOC, store ? store.getDocument : NO_DOC);
  const last = useRef<ResolvedSnapshot | null>(null);
  return useMemo(() => {
    const next = resolveSnapshot(doc, store ? indexFor(store) : null, snapshot);
    if (last.current && sameResolution(last.current, next)) return last.current;
    last.current = next;
    return next;
  }, [doc, store, snapshot]);
}

function LiveView({ store, resolved, resolveImageSrc }: { store: CanvasStore; resolved: ResolvedSnapshot; resolveImageSrc?: (src: string) => string }) {
  const camera = useMemo(() => new CameraController(), []);
  const size = useRef<Size>({ w: 0, h: 0 });
  const rect = resolved.rect;
  const refit = () => {
    if (rect && size.current.w > 0) camera.set(fitRect(rect, size.current, 0, FIGURE_MAX_ZOOM));
  };
  useEffect(refit);
  return (
    <CanvasView
      store={store}
      camera={camera}
      only={resolved.only}
      resolveImageSrc={resolveImageSrc}
      onSize={(next) => {
        size.current = next;
        refit();
      }}
      rootProps={{ 'aria-hidden': true }}
    />
  );
}

export function SnapshotFigure({ canvas, snapshot, title, fallback, registry, onOpen, resolveImageSrc }: SnapshotFigureProps) {
  const store = useRegisteredCanvas(canvas, registry);
  const resolved = useResolved(store, snapshot);
  const view = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = view.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: `${FIGURE_NEAR_MARGIN}px 0px` });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resolved.rect !== null, !!store]);

  const caption = title ?? resolved.title;
  const note = problemText(resolved);
  const still = !store && fallback ? fallback : null;
  const canOpen = !!onOpen && !!store && !!resolved.rect;

  let body: React.ReactNode;
  if (store && resolved.rect) {
    body = (
      <div ref={view} className="pcv-figure-view" style={{ aspectRatio: `${resolved.rect.w} / ${resolved.rect.h}`, maxHeight: Math.min(FIGURE_MAX_HEIGHT, Math.ceil(resolved.rect.h)) }}>
        {near ? <LiveView store={store} resolved={resolved} resolveImageSrc={resolveImageSrc} /> : null}
      </div>
    );
  } else if (still) {
    body = <img className="pcv-figure-still" src={resolveImageSrc ? resolveImageSrc(still.src) : still.src} alt={still.alt} loading="lazy" decoding="async" />;
  } else {
    body = <div className="pcv-figure-empty">{note}</div>;
  }

  return (
    <figure className="pcv pcv-figure" data-status={store ? resolved.status : 'still'} data-canvas={canvas} data-snapshot={snapshot}>
      <div className="pcv-figure-frame">
        {body}
        {canOpen ? (
          <button
            ref={hit}
            type="button"
            className="pcv-figure-hit"
            aria-label={caption ? SNAPSHOT_STRINGS.openNamed(caption) : SNAPSHOT_STRINGS.open}
            onClick={() => view.current && onOpen?.({ canvas, snapshot, origin: view.current, returnFocus: hit.current })}
          />
        ) : null}
      </div>
      {caption || (note && body && resolved.rect) || canOpen ? (
        <figcaption className="pcv-figure-caption">
          {caption ? <span className="pcv-figure-title">{caption}</span> : null}
          {note && (resolved.rect || still) ? <span className="pcv-figure-note">{note}</span> : null}
          {canOpen ? <span className="pcv-figure-hint">{SNAPSHOT_STRINGS.open}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
