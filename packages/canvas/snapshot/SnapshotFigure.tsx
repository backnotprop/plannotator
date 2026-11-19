/**
 * A snapshot in a plan: the picture it captured, drawn as part of the
 * document.
 *
 * It draws the snapshot's capture, not the canvas, so editing the canvas
 * does not change it. When the canvas has changed where the snapshot looked,
 * the caption says so in a few quiet words with one action, Update, which
 * takes the capture again (one undo step on the canvas).
 *
 * It is the ordinary renderer (`CanvasView`) over a small frozen store, so
 * it is real text and vector shapes: sharp at any zoom, themed with the
 * page, readable by a screen reader.
 *
 * A plan may hold many. A figure draws only while it is near the screen (an
 * IntersectionObserver with a margin); far away it is an empty box of the
 * right size. Whether it is behind is worked out only while it draws.
 */
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import { LIMITS } from '../model/codec';
import { isSafeImageSrc } from '../model/html-item';
import type { CanvasDocument, SnapshotCapture } from '../model/types';
import { CanvasView } from '../react/CanvasView';
import { CameraController, type Size, fitRect } from '../view/camera';
import { indexFor } from '../view/document-index';
import type { SnapshotFallbackImage } from './block';
import { frozenStore } from './frozen';
import { type CanvasRegistry, useRegisteredCanvas } from './registry';
import { type SnapshotStanding, snapshotStanding } from './resolve';
import { SNAPSHOT_STRINGS } from './strings';

/** How far outside the screen a figure starts drawing, in CSS pixels. */
export const FIGURE_NEAR_MARGIN = 1400;
/** A figure never draws its part of the canvas larger than life. */
export const FIGURE_MAX_ZOOM = 1;
/** The tallest a figure grows, in CSS pixels. */
export const FIGURE_MAX_HEIGHT = 420;

export interface SnapshotOpenRequest {
  canvas: string;
  snapshot: string;
  /** The figure's own box: the open transition starts from it and returns to it. */
  origin: HTMLElement;
  /** Where focus goes back to when the canvas closes. */
  returnFocus?: HTMLElement | null;
}

export interface SnapshotFigureProps {
  canvas: string;
  snapshot: string;
  /** A caption written in the plan. It wins over the snapshot's own name and is not renamed from here. */
  title?: string;
  /** The still picture to show when the canvas cannot be reached. */
  fallback?: SnapshotFallbackImage;
  /** Absent: the registry from context. */
  registry?: CanvasRegistry | null;
  /** Absent: the figure is not clickable. */
  onOpen?: (request: SnapshotOpenRequest) => void;
  resolveImageSrc?: (src: string) => string;
}

/** The nearest ancestor that scrolls up and down, or null for the window. */
export function scrollRootOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node;
  }
  return null;
}

/** What a capture shows, in words: the words of its objects, in drawing order, for someone who cannot see it. */
export function describeCapture(capture: SnapshotCapture, max = 12): string {
  const words: string[] = [];
  for (const object of capture.objects) {
    const text = object.type === 'frame' ? object.title : 'text' in object ? object.text : 'alt' in object ? (object.alt ?? '') : object.type === 'reference' ? (object.title ?? '') : object.type === 'arrow' ? (object.label ?? '') : '';
    const line = text.split('\n')[0].trim();
    if (line) words.push(line);
    if (words.length === max) break;
  }
  return words.join(', ');
}

const NO_SUBSCRIBE = () => () => {};
const NO_DOC = (): CanvasDocument | null => null;

function Picture({ capture, resolveImageSrc }: { capture: SnapshotCapture; resolveImageSrc?: (src: string) => string }) {
  const camera = useMemo(() => new CameraController(), []);
  const size = useRef<Size>({ w: 0, h: 0 });
  const refit = () => {
    if (size.current.w > 0) camera.set(fitRect(capture.rect, size.current, 0, FIGURE_MAX_ZOOM));
  };
  useEffect(refit);
  return (
    <CanvasView
      store={frozenStore(capture)}
      camera={camera}
      resolveImageSrc={resolveImageSrc}
      onSize={(next) => {
        size.current = next;
        refit();
      }}
      wordsAlways
      rootProps={{ 'aria-hidden': true }}
    />
  );
}

/** A typed name as it is kept: one line, no longer than a title may be, cut at the end of a word and marked as cut. */
export function fitName(typed: string): string {
  const line = typed.replace(/\s+/g, ' ').trim();
  if (line.length <= LIMITS.title) return line;
  const cut = line.slice(0, LIMITS.title - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > LIMITS.title * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The smallest box a figure is drawn in, so that a very wide, very tall or tiny snapshot can still be seen and pressed. */
export const FIGURE_MIN = { w: 160, h: 64 } as const;

/** The box a figure of `rect` is drawn in: the shape of what it shows, never larger than life or taller than the cap, never smaller than `FIGURE_MIN`. */
export function figureBox(rect: { w: number; h: number }): { w: number; h: number } {
  const w = Math.min(rect.w * FIGURE_MAX_ZOOM, (FIGURE_MAX_HEIGHT * rect.w) / rect.h);
  const h = (w * rect.h) / rect.w;
  return { w: Math.ceil(Math.max(w, FIGURE_MIN.w)), h: Math.ceil(Math.max(h, FIGURE_MIN.h)) };
}

/** The snapshot's name, typed in place. Leaving the field saves it. */
function Name({ store, snapshot, title, placeholder }: { store: CanvasStore; snapshot: string; title: string; placeholder: string }) {
  return (
    <span
      className="pcv-figure-title"
      role="textbox"
      aria-label={SNAPSHOT_STRINGS.name}
      data-placeholder={placeholder}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onKeyDown={(event) => {
        // Enter ends the name (it is one line), unless an IME is using it to choose a candidate.
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = fitName(event.currentTarget.innerText);
        if (next !== title) store.dispatch({ type: 'edit-snapshot', id: snapshot, title: next });
        // An emptied field must be truly empty for the placeholder to show.
        if (!next) event.currentTarget.textContent = '';
      }}
    >
      {title}
    </span>
  );
}

export function SnapshotFigure({ canvas, snapshot: id, title, fallback, registry, onOpen, resolveImageSrc }: SnapshotFigureProps) {
  const store = useRegisteredCanvas(canvas, registry);
  const doc = useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIBE, store ? store.getDocument : NO_DOC, store ? store.getDocument : NO_DOC);
  const snapshot = doc?.snapshots[id];
  const capture = snapshot?.capture;
  const view = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  const describeId = useId();

  useEffect(() => {
    const el = view.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    // The margin only widens the observer's own root. A plan usually scrolls inside a pane, not the window, so the
    // root must be that pane, or a figure would start drawing only once it is already on screen.
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: scrollRootOf(el), rootMargin: `${FIGURE_NEAR_MARGIN}px 0px` });
    observer.observe(el);
    return () => observer.disconnect();
  }, [!!capture]);

  // Only a figure that is drawing asks whether it is behind.
  const standing: SnapshotStanding = useMemo(
    () => (near && store && doc && snapshot ? snapshotStanding(doc, indexFor(store), snapshot) : 'current'),
    [near, store, doc, snapshot],
  );

  // The still picture is an address written in a plan: loaded only if it is a picture address.
  const stillSrc = !store && fallback ? (resolveImageSrc ? resolveImageSrc(fallback.src) : fallback.src) : null;
  const still = fallback && isSafeImageSrc(stillSrc) ? { src: stillSrc, alt: fallback.alt } : null;
  const canOpen = !!onOpen && !!store && !!capture;
  const name = title ?? snapshot?.title ?? '';

  if (!capture || !store) {
    return (
      <figure className="pcv pcv-figure" data-standing="missing" data-canvas={canvas} data-snapshot={id}>
        {still ? (
          <img className="pcv-figure-still" src={still.src} alt={still.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        ) : (
          <div className="pcv-figure-empty">{store ? SNAPSHOT_STRINGS.noSnapshot : SNAPSHOT_STRINGS.noCanvas}</div>
        )}
        {title ? (
          <figcaption className="pcv-figure-caption">
            <span className="pcv-figure-title">{title}</span>
          </figcaption>
        ) : null}
      </figure>
    );
  }

  // The figure is exactly the shape of what it shows, never larger than
  // life and never taller than the cap.
  const { rect } = capture;
  const box = figureBox(rect);
  const width = box.w;
  const count = SNAPSHOT_STRINGS.items(capture.objects.length);
  const described = describeCapture(capture);

  return (
    <figure className="pcv pcv-figure" style={{ width: `min(100%, ${width}px)` }} data-standing={standing} data-canvas={canvas} data-snapshot={id}>
      <div className="pcv-figure-frame">
        <div ref={view} className="pcv-figure-view" style={{ aspectRatio: `${box.w} / ${box.h}` }}>
          {near ? <Picture capture={capture} resolveImageSrc={resolveImageSrc} /> : null}
        </div>
        {canOpen ? (
          <button
            ref={hit}
            type="button"
            className="pcv-figure-hit"
            aria-label={name ? SNAPSHOT_STRINGS.openNamed(name) : SNAPSHOT_STRINGS.open}
            aria-describedby={described ? `${describeId}` : undefined}
            onClick={() => view.current && onOpen?.({ canvas, snapshot: id, origin: view.current, returnFocus: hit.current })}
          />
        ) : null}
      </div>
      {described ? (
        <span id={describeId} className="pcv-sr">
          {described}
        </span>
      ) : null}
      <figcaption className="pcv-figure-caption">
        {title !== undefined ? (
          <span className="pcv-figure-title">{title}</span>
        ) : (
          <Name key={snapshot.title} store={store} snapshot={id} title={snapshot.title} placeholder={count} />
        )}
        {standing === 'behind' ? (
          <>
            <span className="pcv-figure-note">{SNAPSHOT_STRINGS.behind}</span>
            <button type="button" className="pcv-figure-action" onClick={() => store.dispatch({ type: 'update-snapshot', id })}>
              {SNAPSHOT_STRINGS.update}
            </button>
          </>
        ) : standing === 'detached' ? (
          <span className="pcv-figure-note">{SNAPSHOT_STRINGS.detached}</span>
        ) : null}
      </figcaption>
    </figure>
  );
}
