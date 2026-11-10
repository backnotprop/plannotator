/**
 * Messages agents are writing right now, with a drawing in them (prototype;
 * packages/core/inbox-drafting.ts). The event stream's `drafting` frames land
 * here from App.tsx's one subscription; the open thread draws them
 * (components/LiveDrawings.tsx). No state in App, so a frame draws only the
 * drawing. Nothing is kept: a draft goes when its message lands, or when its
 * frames stop coming.
 */
import { useSyncExternalStore } from 'react';
import type { InboxDraftingFrame, LiveSvgFence } from '@plannotator/core/inbox-drafting';

export interface LiveDraft {
  call: string;
  /** The message's drawings so far, in order. */
  drawings: readonly LiveSvgFence[];
  done: boolean;
}

/** A draft whose frames stopped (the turn was stopped, the session ended) goes after this long. */
export const DRAFTING_STALE_MS = 20_000;
/** A finished draft waits this long for its message before it goes by itself. */
export const DRAFTING_DONE_MS = 15_000;

const NONE: readonly LiveDraft[] = [];
const threads = new Map<string, readonly LiveDraft[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function drop(threadId: string, call: string): void {
  const timer = timers.get(call);
  if (timer) clearTimeout(timer);
  timers.delete(call);
  const next = (threads.get(threadId) ?? NONE).filter((draft) => draft.call !== call);
  if (next.length > 0) threads.set(threadId, next);
  else threads.delete(threadId);
  changed();
}

export function noteDrafting(frame: InboxDraftingFrame): void {
  // The response was cut off: no message follows, so the drawing goes now.
  if (frame.dropped) {
    drop(frame.thread_id, frame.call);
    return;
  }
  const drafts = threads.get(frame.thread_id) ?? NONE;
  const draft: LiveDraft = { call: frame.call, drawings: frame.drawings, done: frame.done };
  threads.set(frame.thread_id, drafts.some((d) => d.call === frame.call) ? drafts.map((d) => (d.call === frame.call ? draft : d)) : [...drafts, draft]);
  const timer = timers.get(frame.call);
  if (timer) clearTimeout(timer);
  timers.set(frame.call, setTimeout(() => drop(frame.thread_id, frame.call), frame.done ? DRAFTING_DONE_MS : DRAFTING_STALE_MS));
  changed();
}

/** A message landed in the thread: the finished drafts were it. */
export function draftingLanded(threadId: string): void {
  for (const draft of threads.get(threadId) ?? NONE) if (draft.done) drop(threadId, draft.call);
}

export function useLiveDrafts(threadId: string): readonly LiveDraft[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => threads.get(threadId) ?? NONE,
    () => NONE,
  );
}

/**
 * Unfinished SVG markup as a document an `<img>` can draw: the tag cut short
 * at the end is left out and every open element is closed. The HTML parser
 * does the closing, as it would for a page; nothing it reads runs. Null while
 * there is no `<svg>` yet.
 */
export function drawablePartialSvg(source: string, entering?: DrawingEntrances): string | null {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return null;
  const lastOpen = source.lastIndexOf('<');
  const whole = lastOpen > source.lastIndexOf('>') ? source.slice(0, lastOpen) : source;
  if (!/<svg[\s>]/i.test(whole)) return null;
  try {
    const svg = new DOMParser().parseFromString(`<!doctype html><body>${whole}</body>`, 'text/html').querySelector('svg');
    if (!svg) return null;
    if (entering) markEntrances(svg, entering);
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return null;
  }
}

/** How long a shape takes to come in. */
export const DRAWING_ENTER_MS = 380;
/** Ease-out with a slight overshoot: the shape pops in and settles. */
const ENTER_EASING = 'cubic-bezier(0.34, 1.36, 0.64, 1)';
const ENTER_SHAPES = 'rect,circle,ellipse,line,polyline,polygon,path,text,image,use';
const ENTER_NEVER_INSIDE = 'defs,marker,symbol,clipPath,mask,pattern,linearGradient,radialGradient,filter';

/**
 * Which shapes of one drawing are still coming in. `seen` is kept between
 * frames by the caller: a shape's place among the drawing's shapes (a drawing
 * being written only grows at its end) to when it was first drawn.
 */
export interface DrawingEntrances {
  seen: Map<number, number>;
  now: number;
  /** The person asked for less motion: a shape fades in and does not grow. */
  reduced: boolean;
}

/**
 * Each shape scales and fades in once, when it first appears. The drawing is
 * an image whose document is replaced with every frame, which would start
 * every animation again; so a shape's animation is written with a negative
 * delay equal to its age, and each new document carries it on from where the
 * last one left it. A shape past its time gets nothing. A shape with its own
 * `transform` only fades: growing it from its center would move it.
 */
function markEntrances(svg: Element, entering: DrawingEntrances): void {
  let any = false;
  let index = 0;
  for (const shape of Array.from(svg.querySelectorAll(ENTER_SHAPES))) {
    if (shape.closest(ENTER_NEVER_INSIDE)) continue;
    const place = index++;
    let first = entering.seen.get(place);
    if (first === undefined) {
      first = entering.now;
      entering.seen.set(place, first);
    }
    const age = Math.max(0, Math.round(entering.now - first));
    if (age >= DRAWING_ENTER_MS) continue;
    any = true;
    const grows = !entering.reduced && !shape.hasAttribute('transform');
    const own = shape.getAttribute('style');
    const enter = grows
      ? `animation:pn-in ${DRAWING_ENTER_MS}ms ${ENTER_EASING} -${age}ms both;transform-box:fill-box;transform-origin:center`
      : `animation:pn-fade ${DRAWING_ENTER_MS}ms ease-out -${age}ms both`;
    shape.setAttribute('style', own ? `${own};${enter}` : enter);
  }
  if (!any) return;
  const style = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
  // `scale`, not `transform`: it never replaces a transform the drawing set in CSS.
  style.textContent = '@keyframes pn-in{from{opacity:0;scale:.86}}@keyframes pn-fade{from{opacity:0}}';
  svg.insertBefore(style, svg.firstChild);
}
