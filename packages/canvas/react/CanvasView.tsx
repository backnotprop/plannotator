/**
 * The renderer: a document and a camera in, DOM out. It reads the store and
 * never writes to it; everything a person can do lives in `CanvasEditor`,
 * which wraps this. A snapshot figure uses this component alone.
 *
 * Why DOM (with one SVG layer for arrows) and not a 2D canvas:
 * - Text is the content. The browser wraps, shapes, hyphenates and renders
 *   it sharply at any zoom, in any script, and keeps it selectable and
 *   readable by a screen reader. On a 2D canvas all of that is ours to
 *   rebuild.
 * - Pictures, sprites and sandboxed HTML items are elements already. A 2D
 *   canvas cannot hold an iframe.
 * - Theming is the host's CSS variables, light and dark, with no redraw.
 *
 * The board is a plain ground: no dots, no grid.
 *
 * What makes DOM fast enough:
 * - One element (`.pcv-world`) carries the camera as a CSS transform,
 *   written straight from the camera's listener. Panning and zooming never
 *   render React and never lay anything out.
 * - That element is deliberately NOT promoted to its own layer
 *   (`will-change: transform`). Measured: a promoted layer is rastered at
 *   full scale however far out the board is zoomed, so 2,000 objects at 12%
 *   zoom became a 60-megapixel layer and panned at 10 fps; unpromoted, the
 *   browser paints only what the view shows and it holds the display rate.
 * - Only objects in the render window are mounted (`view/cull.ts`), and the
 *   window is recomputed only when the view leaves it.
 * - Objects are placed with `transform`, so moving one is not a layout.
 * - Far out, the stylesheet draws less of each object (`data-lod`).
 */
import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import { arrowPoints, boundsOf, isBoundEnd, resolveArrow } from '../model/document';
import { type Point, type Rect, rectContainsPoint, rectFromPoints } from '../model/geometry';
import { isSafeImageSrc } from '../model/html-item';
import { type ArrowEnd, type ArrowObject, type CanvasDocument, type ImageObject, type ObjectId, isPlaced } from '../model/types';
import type { Camera, CameraController, Size } from '../view/camera';
import { type Lod, OVERSCAN, lodFor, lodForZoom, renderWindow, visibleIds, windowIsStale } from '../view/cull';
import { indexFor } from '../view/document-index';
import { curveRoute, endAngles, findHops, pointAlong, routePath } from '../view/route-path';
import { roughLine, seedOf } from '../view/rough';
import { ROUTE_BUDGET_MS, routesFor } from '../view/routes';
import { ArrowView, type EditEnd, FlatView, ObjectView, objectLabel } from './objects';
import { type Ground, groundUnder, pictureLooks } from './picture-look';

const NONE: ReadonlySet<ObjectId> = new Set();
/** Bare text in a size a board is read by from far off: it stays words at every level of detail. */
const isHeading = (size: string | undefined): boolean => size === 'title' || size === 'display';
/**
 * Past this many mounted objects, far out, each object is one flat element instead of its full markup. Only
 * that far: swapping markup as the zoom crosses a detail level costs a long frame (measured: 83 ms at 2,000
 * objects), which is worth paying on a board so large that it cannot pan otherwise, and not below.
 */
const FLAT_ABOVE = 4000;
/**
 * How many HTML items a view draws as themselves below full detail. An item runs no script, so its frame is a
 * still picture of itself, and a view with few of them keeps every frame at every zoom. But each frame is a
 * document of its own, and many in view cost frames when the whole board moves. Measured, headed, panning 2,000
 * objects at 12% with the board's HTML items in view: none drawn 118 fps; 12 drawn 80 fps with 3 of 322 frames
 * slow (inside the 60 fps budget, barely); 42 drawn 71 fps with 45 of 286 slow (outside it). Giving each frame
 * a layer of its own made it worse (61 fps). So up to this many are drawn, and a view holding more shows each
 * item's words (`alt`) in its box until it is zoomed in. All or none, so a board never shows a mix.
 */
export const HTML_FRAMES_MAX = 8;
/** Whether a view at this detail, holding this many HTML items, draws them as themselves. */
export const htmlFramesKept = (lod: Lod, items: number): boolean => lod === 'full' || items <= HTML_FRAMES_MAX;
/** Past this many mounted objects shadows are not drawn: they are what costs frames when a crowded board zooms. */
const CROWDED = 500;

/** Whether half or more of `area` lies on `picture`. */
function mostlyOn(picture: Rect, area: Rect): boolean {
  const w = Math.min(picture.x + picture.w, area.x + area.w) - Math.max(picture.x, area.x);
  const h = Math.min(picture.y + picture.h, area.y + area.h) - Math.max(picture.y, area.y);
  return w > 0 && h > 0 && w * h * 2 >= area.w * area.h;
}

/** How long a line is, end to end. */
function lengthOf(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return Math.round(total);
}

/** A connector in the sketch look: its route drawn by hand, the same way every time. */
const SKETCH_LINES = new Map<string, string>();
function sketchLine(arrow: ArrowObject, points: Point[]): string {
  const seed = arrow.style?.seed ?? seedOf(arrow.id);
  const key = `${seed}|${arrow.style?.rough ?? 1}|${points.map((p) => `${p.x},${p.y}`).join(' ')}`;
  let d = SKETCH_LINES.get(key);
  if (d === undefined) {
    d = roughLine(points, arrow.style?.rough ?? 1, seed);
    if (SKETCH_LINES.size > 2000) SKETCH_LINES.clear();
    SKETCH_LINES.set(key, d);
  }
  return d;
}

/** What the layer of arrows is called, and how one arrow is said: its ends by their words, then its label. */
export const ARROWS_LABEL = 'Connections';
export const ARROW_WORDS = { arrow: 'Arrow', from: 'from', to: 'to', point: 'a point on the board' } as const;

function endWords(doc: CanvasDocument, end: ArrowEnd): string {
  if (!isBoundEnd(end)) return ARROW_WORDS.point;
  const target = doc.objects[end.object];
  if (!target) return ARROW_WORDS.point;
  if (target.type === 'group') return target.label ?? ARROW_WORDS.point;
  return isPlaced(target) ? objectLabel(target) : ARROW_WORDS.point;
}

export function arrowLabel(doc: CanvasDocument, arrow: ArrowObject): string {
  const words = `${ARROW_WORDS.arrow} ${ARROW_WORDS.from} ${endWords(doc, arrow.from)} ${ARROW_WORDS.to} ${endWords(doc, arrow.to)}`;
  return arrow.label ? `${words}, ${arrow.label}` : words;
}

export interface CanvasViewProps {
  store: CanvasStore;
  camera: CameraController;
  selection?: ReadonlySet<ObjectId>;
  editingId?: ObjectId | null;
  /**
   * Makes objects focusable (an editor). The id is the one object Tab lands on from outside the board; the
   * editor moves focus between the rest. Undefined: nothing on the board takes focus (a figure).
   */
  tabStop?: ObjectId | null;
  /** The objects being dragged right now. */
  carried?: ReadonlySet<ObjectId>;
  onEditEnd?: EditEnd;
  /**
   * Never draw at the wordless lowest detail (a figure in a plan: a picture of a diagram with no words tells a
   * reader nothing). A view holding so many objects that each is a flat patch is the one exception.
   */
  wordsAlways?: boolean;
  /** Turn a relative picture address into one the browser can load. */
  resolveImageSrc?: (src: string) => string;
  /** Extra world rects to keep mounted (where a camera animation is heading). */
  keepMounted?: Rect | null;
  /** How far past the view objects stay mounted, as a share of its size. */
  overscan?: number;
  /** Called with the view's size in CSS pixels, once known and on resize. */
  onSize?: (size: Size) => void;
  /** Drawn inside the world: moves and scales with the board. */
  worldOverlay?: React.ReactNode;
  /** Drawn over the view in screen space. */
  children?: React.ReactNode;
  /** Drawn over the view like `children`, but first in the document: first in the Tab order and for a screen reader. */
  lead?: React.ReactNode;
  rootRef?: React.Ref<HTMLDivElement>;
  rootProps?: React.HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
}

function unionWindow(a: Rect, b: Rect | null | undefined): Rect {
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function CanvasView({
  store,
  camera,
  selection = NONE,
  editingId = null,
  tabStop,
  carried,
  onEditEnd,
  wordsAlways,
  resolveImageSrc,
  keepMounted = null,
  overscan = OVERSCAN,
  onSize,
  worldOverlay,
  children,
  lead,
  rootRef,
  rootProps,
}: CanvasViewProps) {
  const doc = useSyncExternalStore(store.subscribe, store.getDocument, store.getDocument);
  const index = indexFor(store);
  const router = routesFor(store);
  // Draw again when routes that were waiting have been finished.
  useSyncExternalStore(router.subscribe, router.getVersion, router.getVersion);
  // And when a picture has been looked at: what lies over it takes its ink from it.
  useSyncExternalStore(pictureLooks.subscribe, pictureLooks.getVersion, pictureLooks.getVersion);
  const root = useRef<HTMLDivElement | null>(null);
  const world = useRef<HTMLDivElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<number | null>(null);
  const chipRef = useRef(0);
  const chipStyle = useRef<HTMLStyleElement | null>(null);
  const viewId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const overscanRef = useRef(overscan);
  const size = useRef<Size>({ w: 0, h: 0 });
  const [window_, setWindow] = useState<Rect | null>(null);
  const windowRef = useRef<Rect | null>(null);
  // The detail the zoom alone would ask for; how many objects are mounted has the last word (`lodFor`).
  const [zoomLod, setZoomLod] = useState<Lod>(() => lodForZoom(camera.get().z));
  const lodRef = useRef(zoomLod);
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      if (typeof rootRef === 'function') rootRef(el);
      else if (rootRef) (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [rootRef],
  );

  /** Write the camera to the DOM. No React state unless the window or the detail level must change. */
  const paint = useCallback(
    (c: Camera) => {
      const rootEl = root.current;
      const worldEl = world.current;
      if (!rootEl || !worldEl) return;
      worldEl.style.transform = `translate(${-c.x * c.z}px, ${-c.y * c.z}px) scale(${c.z})`;
      // The zoom is published only where it is read (the overlay's outlines
      // and handles), and only when it changes. A custom property set on the
      // root would be inherited by every object and restyle all of them on
      // every frame of a pan.
      if (zoomRef.current !== c.z) {
        zoomRef.current = c.z;
        overlay.current?.style.setProperty('--pcv-z', String(c.z));
      }
      // Frame titles grow as the board shrinks, so they can still be read. The size is a rule in this view's
      // own small stylesheet, rewritten only when it changes step. Not a custom property on the board: that
      // is inherited by every object, and each change of step restyled all of them (measured as long frames
      // while zooming a 2,000-object board).
      const chip = Math.round(Math.max(1, Math.min(3.3, 0.9 / c.z)) * 8) / 8;
      if (chip !== chipRef.current && chipStyle.current) {
        chipRef.current = chip;
        chipStyle.current.textContent = `[data-pcv-view="${viewId}"] .pcv-frame-chip{transform:scale(${chip});max-width:max(${(100 / chip).toFixed(2)}%,${(160 / chip).toFixed(1)}px)}`;
      }
      const nextLod = lodForZoom(c.z);
      if (nextLod !== lodRef.current) {
        lodRef.current = nextLod;
        setZoomLod(nextLod);
      }
      if (size.current.w > 0 && windowIsStale(windowRef.current, c, size.current, overscanRef.current)) {
        windowRef.current = renderWindow(c, size.current, overscanRef.current);
        setWindow(windowRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      if (next.w === size.current.w && next.h === size.current.h) return;
      size.current = next;
      windowRef.current = null;
      onSizeRef.current?.(next);
      paint(camera.get());
    };
    zoomRef.current = null;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const stop = camera.subscribe(paint);
    paint(camera.get());
    return () => {
      observer.disconnect();
      stop();
    };
  }, [camera, paint]);

  // A new overscan takes effect at once: the window is recomputed for it.
  useLayoutEffect(() => {
    if (overscanRef.current === overscan) return;
    overscanRef.current = overscan;
    windowRef.current = null;
    paint(camera.get());
  }, [overscan, camera, paint]);

  const mounted = useMemo(() => {
    if (!window_) return [];
    return visibleIds(doc, index, unionWindow(window_, keepMounted));
  }, [doc, index, window_, keepMounted]);

  const asked = lodFor(zoomLod === 'full' ? 1 : zoomLod === 'plain' ? 0.3 : 0.1, mounted.length);
  const flat = asked === 'far' && mounted.length > FLAT_ABOVE;
  const lod: Lod = asked === 'far' && wordsAlways && !flat ? 'plain' : asked;

  // Notes lying exactly on one another (pasted twice, or put there by an agent): only the top one casts a
  // shadow, or a pile's shadows add up to a black halo. Looked for only where shadows are drawn at all.
  const buried = new Set<ObjectId>();
  if (lod === 'full' && mounted.length <= CROWDED) {
    const top = new Map<string, ObjectId>();
    for (const id of mounted) {
      const object = doc.objects[id];
      if (object?.type !== 'note') continue;
      const key = `${object.x},${object.y},${object.w},${object.h}`;
      const under = top.get(key);
      if (under) buried.add(under);
      top.set(key, id);
    }
  }

  // HTML items stay drawn at low detail unless the view holds too many of them at once (`HTML_FRAMES_MAX`).
  let frames = 0;
  if (lod !== 'full') for (const id of mounted) if (doc.objects[id]?.type === 'html' && ++frames > HTML_FRAMES_MAX) break;
  const framesKept = htmlFramesKept(lod, frames);

  const placed: React.ReactNode[] = [];
  const arrows: React.ReactNode[] = [];
  const lines: { arrow: ArrowObject; points: Point[]; d?: string }[] = [];
  // The pictures drawn so far, back to front. Words and lines that lie on one (half of them or more) are read
  // against it, not against the board (`groundUnder`). Nothing is looked for on a board with no picture in view.
  const pictures: ImageObject[] = [];
  const groundOf = (area: Rect, whole: (picture: ImageObject) => boolean): Ground | undefined => {
    for (let i = pictures.length - 1; i >= 0; i--) {
      const picture = pictures[i];
      if (!whole(picture)) continue;
      const src = resolveImageSrc ? resolveImageSrc(picture.src) : picture.src;
      return groundUnder(isSafeImageSrc(src) ? pictureLooks.get(src) : null, picture, area);
    }
    return undefined;
  };
  // Routes that are stale are worked out as they are drawn, for a few milliseconds; the rest keep their last
  // shape and are finished next frame (the router says when).
  const deadline = performance.now() + ROUTE_BUDGET_MS;
  const overlayNodes: React.ReactNode[] = [];
  for (const id of mounted) {
    const object = doc.objects[id];
    if (!object) continue;
    if (object.type === 'arrow') {
      // An elbow connector is routed round what is in the way; far out, where a route could not be told from a
      // line, it is the straight line between its ends. A straight one always is, and a curve is its arc.
      const routed = lod !== 'far' && (object.routing ?? 'elbow') === 'elbow' ? router.get(id, deadline) : null;
      if (routed) lines.push({ arrow: object, points: routed.points });
      else {
        const g = resolveArrow(doc, object);
        // A curve is one arc between its two ends. A loop back to the same object keeps its own shape.
        if (g && !g.via && object.routing === 'curve') lines.push({ arrow: object, ...curveRoute(g.from, g.to) });
        else if (g) lines.push({ arrow: object, points: arrowPoints(g) });
      }
    } else if (object.type !== 'group' && flat && editingId !== id && tabStop !== id && !(object.type === 'text' && isHeading(object.size)) && object.type !== 'ink') {
      // Far out on a crowded board: a flat patch each. Small bare text has nothing to show at this size (a
      // title still does, and a drawn line is one path already: both are drawn as themselves, below).
      if (object.type !== 'text') placed.push(<FlatView key={id} object={object} />);
      if (selection.size === 1 && selection.has(id)) {
        overlayNodes.push(<div key={id} className="pcv-outline" style={{ transform: `translate(${object.x}px, ${object.y}px)`, width: object.w, height: object.h }} />);
      }
    } else if (object.type !== 'group') {
      if (object.type === 'image') pictures.push(object);
      const ground = (object.type === 'text' || object.type === 'ink') && pictures.length ? groundOf(object, (picture) => mostlyOn(picture, object)) : undefined;
      placed.push(
        <ObjectView
          key={id}
          object={object}
          selected={selection.has(id)}
          editing={editingId === id}
          rich={object.type !== 'html' || lod === 'full' || framesKept}
          resolveImageSrc={resolveImageSrc}
          onEditEnd={onEditEnd}
          tabIndex={tabStop === undefined ? undefined : tabStop === id ? 0 : -1}
          carried={carried?.has(id) ?? false}
          buried={buried.has(id)}
          ground={ground}
        />,
      );
      // The selection outline is its own element in the overlay, so its
      // width can follow the zoom without the object reading the zoom. One
      // object gets its own outline; several get one outline round them all
      // (below), not a pile of overlapping ones.
      if (selection.size === 1 && selection.has(id)) {
        overlayNodes.push(<div key={id} className="pcv-outline" style={{ transform: `translate(${object.x}px, ${object.y}px)`, width: object.w, height: object.h }} />);
      }
    }
  }

  // Hops are found among the lines on screen, once all of them are known.
  const hops = lod === 'full' ? findHops(lines.map((line) => line.points)) : null;
  lines.forEach(({ arrow, points, d }, i) => {
    const angles = endAngles(points);
    const at = pointAlong(points, arrow.style?.labelAt ?? 0.5);
    const last = points[points.length - 1];
    arrows.push(
      <ArrowView
        key={arrow.id}
        arrow={arrow}
        label={arrowLabel(doc, arrow)}
        room={arrow.label ? lengthOf(points) : 0}
        d={arrow.style?.look === 'sketch' ? sketchLine(arrow, points) : (d ?? routePath(points, hops?.[i]))}
        x1={points[0].x}
        y1={points[0].y}
        a1={angles.start}
        x2={last.x}
        y2={last.y}
        a2={angles.end}
        lx={at.x}
        ly={at.horizontal ? at.y : at.y}
        selected={selection.has(arrow.id)}
        ground={pictures.length ? groundOf(rectFromPoints(points[0], last), (picture) => rectContainsPoint(picture, points[0]) && rectContainsPoint(picture, last)) : undefined}
      />,
    );
  });

  if (selection.size > 1) {
    const around = boundsOf(doc, selection);
    if (around) overlayNodes.push(<div key="selection" className="pcv-outline" style={{ transform: `translate(${around.x}px, ${around.y}px)`, width: around.w, height: around.h }} />);
  }

  return (
    <div {...rootProps} ref={setRoot} className={rootProps?.className ? `pcv pcv-root ${rootProps.className}` : 'pcv pcv-root'} data-pcv-view={viewId} data-lod={lod} data-crowded={mounted.length > CROWDED ? '' : undefined}>
      <style ref={chipStyle} />
      {lead}
      <div ref={world} className="pcv-world">
        {placed}
        <svg className="pcv-arrows" role="group" aria-label={ARROWS_LABEL}>
          {arrows}
        </svg>
        <div ref={overlay} className="pcv-overlay">
          {overlayNodes}
          {worldOverlay}
        </div>
      </div>
      {children}
    </div>
  );
}
