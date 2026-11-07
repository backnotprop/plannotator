// The move between two layouts of the sheet on screen (G step 8g, 8j): Simple
// and Full of one sheet, or two sheets of one scope. Every part and band that
// both layouts draw travels from its place in the one to its place in the
// other. It is a FLIP move: both places are read from the two layouts, so
// nothing is measured on the page. A part moves by `translate` only, so its
// words never stretch; its box frame scales, drawn by a small SVG frame with a
// non-scaling stroke while the box's own border steps aside, and the words are
// seen through the frame as it is at that moment. Bands scale; their names
// translate. What only one layout draws fades.
//
// DOM only: the view (SystemView.tsx) renders the new layout, then starts the
// move in a layout effect before the browser paints, and runs it on the
// camera's spring (CAM_MS, launched at w/2) in the same frames as the camera.
import type { SheetLayout } from '../layout/types.ts';
import { CAM_MS, clamp, lerpRect, spring, SW_ENTER_AT, SW_IN, SW_LEAD, SW_STAGGER, wOf, type Rect } from './camera.ts';

/** What only Full draws, inside a sheet: lines, then the words that go with them. */
export const FULL_LINES = ['.sys-edges > .sys-edge', 'svg.sys-zones > line'];
export const FULL_WORDS = ['.sys-elabel', '.sys-letter.sys-mk', '.sys-aud', '.sys-zsplit', '.sys-pv:not(.sys-chip) > .sys-sub', '.sys-zlabel em', '.sys-ov-tint', '.sys-ov-mark'];

const SVGNS = 'http://www.w3.org/2000/svg';
let EASE: string | null = null;
/** The theme's own curve (--sys-ease-out), read once. */
export const easeOut = () => {
  if (EASE == null) {
    const probe = typeof document !== 'undefined' ? document.querySelector('.sys') : null;
    EASE = (probe && getComputedStyle(probe).getPropertyValue('--sys-ease-out').trim()) || 'cubic-bezier(0.23, 1, 0.32, 1)';
  }
  return EASE;
};

/** A fade's start on the app's own clock, so a film can step it with the camera (scripts/film.mjs). */
export const born = (a: Animation) => {
  (a as Animation & { __born?: number }).__born = performance.now();
  return a;
};

export const all = (root: Element | null, sel: string[]) => (root ? [...root.querySelectorAll<HTMLElement | SVGElement>(sel.join(','))] : []);

type Item =
  | { key: string; kind: 'part'; el: HTMLElement; from: Rect; to: Rect; pv: HTMLElement | null; frame: SVGSVGElement | null; right: HTMLElement[]; bottom: HTMLElement[]; stack: HTMLElement | null }
  | { key: string; kind: 'zone'; el: SVGElement; lab: HTMLElement | null; from: Rect; to: Rect };

export type Flip = { items: Item[]; S: { x: number; v: number; to: number }; stop: () => void; fades: Animation[]; done: boolean };

const same = (a: Rect, b: Rect) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h) < 0.5;

/** Where every travelling thing of a move in flight is now, by key, for a move that turns it round. */
export function placesOf(F: Flip | null | undefined): Map<string, Rect> {
  const at = new Map<string, Rect>();
  if (F) for (const it of F.items) at.set(it.key, lerpRect(it.from, it.to, F.S.x));
  return at;
}

/** Puts every travelling thing at its place of the moment e (0 the old layout, 1 the new). */
export function applyFlip(F: Flip, e: number) {
  for (const it of F.items) {
    const r = lerpRect(it.from, it.to, e), t = it.to;
    const dx = r.x - t.x, dy = r.y - t.y;
    if (it.kind === 'part') {
      it.el.classList.add('sys-flip');
      it.el.style.translate = `${dx}px ${dy}px`;
      if (it.frame) (it.frame.firstChild as SVGGElement).style.transform = `scale(${r.w / t.w}, ${r.h / t.h})`;
      // the words are seen through the frame as it is now: a larger frame lets
      // them out (a negative inset), a smaller one hides what is not yet inside
      if (it.pv) it.pv.style.clipPath = `inset(0 ${t.w - r.w}px ${t.h - r.h}px 0)`;
      for (const m of it.right) m.style.translate = `${r.w - t.w}px 0`;
      for (const c of it.bottom) c.style.translate = `0 ${r.h - t.h}px`;
      if (it.stack) it.stack.style.transform = `scale(${r.w / t.w}, ${r.h / t.h})`;
    } else {
      it.el.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w / t.w}, ${r.h / t.h}) translate(${-t.x}px, ${-t.y}px)`;
      if (it.lab) it.lab.style.translate = `${dx}px ${dy}px`;
    }
  }
}

/** Puts everything back where its layout has it, and takes the frames away. */
export function clearFlip(F: Flip) {
  for (const it of F.items) {
    const els = it.kind === 'part' ? [it.el, it.pv, it.frame?.firstChild as SVGGElement | undefined, it.stack, ...it.right, ...it.bottom] : [it.el, it.lab];
    for (const el of els) {
      if (!el) continue;
      el.style.translate = '';
      el.style.transform = '';
      el.style.clipPath = '';
    }
    if (it.kind === 'part') {
      it.el.classList.remove('sys-flip');
      it.frame?.remove();
    }
  }
}

/** The travelling frame of one box: its border and fill, drawn per side so a double top rule or a bottom rule travels too. */
function frameFor(el: HTMLElement, pv: HTMLElement, W: number, H: number): SVGSVGElement | null {
  const cs = getComputedStyle(pv);
  const side = (k: 'Top' | 'Right' | 'Bottom' | 'Left') => {
    const st = cs.getPropertyValue(`border-${k.toLowerCase()}-style`);
    return { w: st === 'none' || st === 'hidden' ? 0 : parseFloat(cs.getPropertyValue(`border-${k.toLowerCase()}-width`)) || 0, st, c: cs.getPropertyValue(`border-${k.toLowerCase()}-color`) };
  };
  const sides = { Top: side('Top'), Right: side('Right'), Bottom: side('Bottom'), Left: side('Left') };
  const fill = cs.backgroundColor;
  if (!Object.values(sides).some((s) => s.w > 0) && (!fill || fill === 'rgba(0, 0, 0, 0)' || fill === 'transparent')) return null;
  const bw = sides.Top.w;
  const ring = bw > 0 && sides.Top.st === 'solid' && (['Right', 'Bottom', 'Left'] as const).every((k) => Math.abs(sides[k].w - bw) < 0.05 && sides[k].st === 'solid');
  const rx = parseFloat(cs.borderTopLeftRadius) || 0;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'sys-pframe');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true');
  const g = document.createElementNS(SVGNS, 'g');
  const rect = document.createElementNS(SVGNS, 'rect');
  const at = (n: Element, o: Record<string, string | number>) => Object.entries(o).forEach(([k, v]) => n.setAttribute(k, String(v)));
  at(rect, ring ? { x: bw / 2, y: bw / 2, width: Math.max(0, W - bw), height: Math.max(0, H - bw), rx, fill, stroke: sides.Top.c, 'stroke-width': bw } : { x: 0, y: 0, width: W, height: H, rx, fill, stroke: 'none' });
  g.append(rect);
  if (!ring) {
    const seg = { Top: (o: number) => `M0 ${o}H${W}`, Bottom: (o: number) => `M0 ${H - o}H${W}`, Left: (o: number) => `M${o} 0V${H}`, Right: (o: number) => `M${W - o} 0V${H}` };
    for (const k of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const sd = sides[k];
      if (!sd.w) continue;
      // a double rule is two lines a third of its width each
      const dbl = sd.st === 'double' && sd.w >= 3, lw = dbl ? sd.w / 3 : sd.w;
      const p = document.createElementNS(SVGNS, 'path');
      at(p, { d: dbl ? seg[k](lw / 2) + seg[k](sd.w - lw / 2) : seg[k](sd.w / 2), stroke: sd.c, 'stroke-width': lw, fill: 'none' });
      if (sd.st === 'dashed') p.setAttribute('stroke-dasharray', `${lw * 3} ${lw * 3}`);
      g.append(p);
    }
  }
  svg.append(g);
  el.prepend(svg);
  return svg;
}

export type FlipOpts = {
  /** The sheet element drawn from the new layout. */
  root: Element;
  /** The layout the sheet showed before, and the one it shows now. */
  from: SheetLayout;
  to: SheetLayout;
  /** Places of a move in flight (placesOf), so a press during a move turns it round from where things are. */
  at?: Map<string, Rect>;
  /** Speed carried into the move, per second (a turn round is negative). */
  v0?: number;
  /** Fade in what only the new layout draws: 'full' (lines and words come back late, Simple to Full), 'sheet' (another sheet). */
  enter: 'none' | 'full' | 'sheet';
  onFrame?(e: number): void;
  onDone?(): void;
};

/** Starts the move: reads the new layout's things, puts them at their old places, and runs them home on the spring. */
export function startFlip(o: FlipOpts): Flip {
  const { root, from, to } = o;
  const at = o.at ?? new Map<string, Rect>();
  const items: Item[] = [];
  const fades: Animation[] = [];
  const ez = easeOut();
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);
  const fadeIn = (el: Element, delay: number, grow = false) =>
    fades.push(born((el as HTMLElement).animate(grow ? [{ opacity: 0, scale: '0.96', offset: 0 }] : [{ opacity: 0, offset: 0 }], { duration: SW_IN, delay, easing: ez, fill: 'backwards' })));
  for (const [id, p] of Object.entries(to.parts)) {
    const el = q<HTMLElement>(`:scope > .sys-parts > .sys-part[data-part="${CSS.escape(id)}"]`);
    if (!el) continue;
    const old = at.get('p:' + id) ?? from.parts[id];
    const dest = { x: p.x, y: p.y, w: p.w, h: p.h };
    if (!old) {
      if (o.enter === 'sheet') fadeIn(el, SW_LEAD);
      continue;
    }
    if (same(old, dest)) continue;
    const pv = el.querySelector<HTMLElement>(':scope > .sys-pv');
    items.push({
      key: 'p:' + id, kind: 'part', el, from: old, to: dest, pv,
      frame: pv ? frameFor(el, pv, dest.w, dest.h) : null,
      right: [...el.querySelectorAll<HTMLElement>(':scope > .sys-pv:not(.sys-chip) > .sys-top > .sys-marks:last-child')],
      bottom: [...el.querySelectorAll<HTMLElement>(':scope > .sys-win-cue')],
      stack: el.querySelector<HTMLElement>(':scope > .sys-win-stack'),
    });
  }
  for (const z of to.zones) {
    const el = q<SVGElement>(`svg.sys-zones rect[data-zone="${CSS.escape(z.id)}"]`);
    if (!el) continue;
    const oz = from.zones.find((x) => x.id === z.id);
    const old = at.get('z:' + z.id) ?? (oz && { x: oz.x, y: oz.y, w: oz.w, h: oz.h });
    const dest = { x: z.x, y: z.y, w: z.w, h: z.h };
    const lab = q<HTMLElement>(`.sys-zlabel[data-zone="${CSS.escape(z.id)}"]`);
    // a band only one layout has fades in with the move
    if (!old) {
      fadeIn(el, o.enter === 'sheet' ? SW_LEAD : 0);
      if (lab) fadeIn(lab, o.enter === 'sheet' ? SW_LEAD : 0);
      continue;
    }
    if (!same(old, dest)) items.push({ key: 'z:' + z.id, kind: 'zone', el, lab, from: old, to: dest });
  }
  if (o.enter !== 'none') {
    // what only the new layout draws comes back once the boxes are nearly home:
    // lines first, their words a stagger later, from 0.96 of their size
    for (const el of all(root, FULL_LINES)) fadeIn(el, SW_ENTER_AT);
    for (const el of all(root, FULL_WORDS)) fadeIn(el, SW_ENTER_AT + SW_STAGGER, true);
    if (o.enter === 'sheet') {
      const head = q(':scope > .sys-ann > .sys-head');
      if (head) fadeIn(head, SW_LEAD);
    }
  }
  const w = wOf(CAM_MS);
  const S = { x: 0, v: clamp(o.v0 ?? 0, -3 * w, 3 * w) + w / 2, to: 1 };
  const F: Flip = { items, S, fades, done: false, stop: () => {} };
  applyFlip(F, 0);
  F.stop = spring(S, w, (e) => {
    applyFlip(F, e);
    o.onFrame?.(e);
  }, () => {
    F.done = true;
    clearFlip(F);
    o.onDone?.();
  });
  return F;
}
