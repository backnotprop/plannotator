/**
 * "Follow an example" on the drawing itself (approval "trace-it-board" r5):
 * the example's path lights through the board's own parts (`data-mark`) and
 * arrows (`data-edge`), each step's value is written on its part, and every
 * part the example never touches fades back. Built once per example on the
 * How it works drawing (inside ShapeDrawn's shadow root); a step only changes
 * states, so every change is a cross-fade the browser can retarget mid-way.
 *
 * Motion: the dot runs on the arrow's own path (400–550 ms, eased in and
 * out) and the part it reaches pulses as it lands; the step's light comes up
 * as the dot lands. Every call cancels what is in flight first, so rapid
 * input leaves one step lit and no stray dot. Reduced motion: no dot, no
 * pulse, 150 ms fades.
 */
import type { ShapeExample } from '@plannotator/core/shape';
import type { FollowDir } from './followState';
import { outlineOf } from './litLine';

/** One ease-out for everything the card and the board do together; an in-out for the dot that travels. */
export const FOLLOW_EASE = 'cubic-bezier(.22, 1, .36, 1)';
const EASE_TRAVEL = 'cubic-bezier(.65, 0, .35, 1)';

/** `el.animate`, where the page has it (a test DOM may not): null otherwise. */
export function animate(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  return typeof (el as HTMLElement).animate === 'function' ? (el as HTMLElement).animate(frames, options) : null;
}

/** The light, in the drawing's own scope (a shadow root does not see the page's CSS). */
export const FOLLOW_DRAWN_CSS = `
.board.shp-ex-on [data-ex-dim] { opacity: .2; transition: opacity .3s ease; }
.board.shp-ex-on [data-ex-i] { cursor: pointer; }
.board.shp-ex-on [data-edge]:not([data-mark]), .board.shp-ex-on [data-edge]:not([data-mark]) :not([data-mark]) { transition: color .22s ease var(--ex-d, 0ms), fill .22s ease var(--ex-d, 0ms); }
.board.shp-ex-on [data-edge]:not([data-mark]):is([data-ex-s="on"], [data-ex-s="now"]),
.board.shp-ex-on [data-edge]:not([data-mark]):is([data-ex-s="on"], [data-ex-s="now"]) :not([data-mark]) { color: var(--mark); }
.board.shp-ex-on [data-edge]:is([data-ex-s="on"], [data-ex-s="now"]) text,
.board.shp-ex-on text[data-edge]:is([data-ex-s="on"], [data-ex-s="now"]) { fill: var(--mark); }
.board.shp-ex-on [data-edge][data-mark]:is([data-ex-s="on"], [data-ex-s="now"]) { color: var(--ink); }
.shp-ex-lit { fill: none !important; stroke: var(--mark) !important; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: none !important; opacity: 0; transition: opacity var(--ex-dur, .22s) ease var(--ex-d, 0ms); pointer-events: none; animation: none !important; }
.shp-ex-lit.shp-ex-head { fill: var(--mark) !important; stroke: none !important; }
.shp-ex-lit:is([data-s="on"], [data-s="now"]) { opacity: 1; }
.shp-ex-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 6; pointer-events: none; --ex-inv: 1; }
.shp-ex-ring { position: absolute; box-shadow: 0 0 0 2px var(--mark); opacity: 0; transition: opacity .22s ease var(--ex-d, 0ms); pointer-events: none; }
.shp-ex-ring:is([data-s="on"], [data-s="now"]) { opacity: 1; }
.shp-ex-ring > i { position: absolute; inset: 0; border-radius: inherit; }
.shp-ex-ring .halo { box-shadow: 0 0 0 2px var(--mark), 0 0 0 7px var(--mark-soft); opacity: 0; transition: opacity .26s ease var(--ex-d, 0ms); }
.shp-ex-ring[data-s="now"] .halo { opacity: 1; }
.shp-ex-ring .pulse { box-shadow: 0 0 0 2px var(--mark); opacity: 0; }
.shp-ex-ring.own { box-shadow: none; }
.shp-ex-ring.own .halo { box-shadow: 0 0 0 6px var(--mark-soft); }
.board.shp-ex-on [data-ex-own] { transition: stroke .22s ease var(--ex-d, 0ms), border-color .22s ease var(--ex-d, 0ms); }
.board.shp-ex-on [data-ex-own]:is([data-ex-s="on"], [data-ex-s="now"]) { stroke: var(--mark) !important; border-color: var(--mark) !important; }
.shp-ex-tag { position: absolute; pointer-events: none; appearance: none; border: 0; margin: 0; cursor: pointer; transform-origin: 100% 50%;
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px 0 4px; border-radius: 8px;
  background: var(--raise); color: var(--ink); white-space: nowrap;
  font: 500 13.5px/1 var(--font-sans, ui-sans-serif, system-ui); font-feature-settings: "ss01", "ss02", "cv01"; font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 1px color-mix(in oklab, var(--mark) 40%, transparent);
  opacity: 0; translate: 0 4px; transition: opacity .2s ease var(--ex-d, 0ms), translate .24s cubic-bezier(.22,1,.36,1) var(--ex-d, 0ms); }
.shp-ex-tag:is([data-s="on"], [data-s="now"]) { opacity: 1; translate: 0 0; pointer-events: auto; }
.shp-ex-tag::after { content: ""; position: absolute; inset: 0; border-radius: inherit; box-shadow: 0 0 0 2px var(--mark), 0 6px 18px -8px rgb(0 0 0 / .35); opacity: 0; transition: opacity .22s ease var(--ex-d, 0ms); pointer-events: none; }
.shp-ex-tag[data-s="now"]::after { opacity: 1; }
.shp-ex-tag .n { position: relative; display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 6px; background: var(--mark-soft); color: var(--mark); font-size: 11.5px; font-weight: 600; }
.shp-ex-tag .n::before { content: attr(data-n); position: absolute; inset: 0; display: grid; place-items: center; border-radius: inherit; background: var(--mark); color: var(--primary-foreground, #fff); opacity: 0; transition: opacity .22s ease var(--ex-d, 0ms); }
.shp-ex-tag[data-s="now"] .n::before { opacity: 1; }
.shp-ex-tag .bug { display: inline-flex; flex: none; margin-left: -3px; color: var(--mark); opacity: .7; }
.shp-ex-tag[data-s="now"] .bug { opacity: 1; }
.shp-ex-tag:focus-visible { outline: 2px solid var(--mark); outline-offset: 2px; }
.shp-ex-tag.bottom { transform: translate(-100%, -50%) scale(var(--ex-inv)); }
.shp-ex-tag.top { transform: translate(-100%, calc(-100% - 4px)) scale(var(--ex-inv)); transform-origin: 100% 100%; }
.shp-ex-tag.under { transform: translate(-50%, 0) scale(var(--ex-inv)); transform-origin: 50% 0; }
.shp-ex-tag.beside { transform: translate(0, -50%) scale(var(--ex-inv)); transform-origin: 0 50%; }
.shp-ex-dot { position: absolute; left: 0; top: 0; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: var(--mark);
  box-shadow: 0 0 0 3px var(--mark-soft), 0 0 12px 1px color-mix(in oklab, var(--mark) 40%, transparent); pointer-events: none; opacity: 0; will-change: transform, opacity; }
.board.reduce .shp-ex-ring, .board.reduce .shp-ex-ring .halo, .board.reduce .shp-ex-tag, .board.reduce .shp-ex-tag::after, .board.reduce .shp-ex-tag .n::before, .board.reduce .shp-ex-lit { transition: opacity .15s linear !important; translate: none !important; }
.board.reduce.shp-ex-on [data-edge], .board.reduce.shp-ex-on [data-edge] * { transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  .shp-ex-ring, .shp-ex-ring .halo, .shp-ex-tag, .shp-ex-tag::after, .shp-ex-tag .n::before, .shp-ex-lit { transition: opacity .15s linear !important; translate: none !important; }
  .board.shp-ex-on [data-edge], .board.shp-ex-on [data-edge] * { transition: none !important; }
}
`;

const GEOMETRY = 'path, line, polyline';
/** What a tag keeps from the edge of what shows of the drawing. */
const EDGE = 8;
/** How far the drawing's frame shows past itself (ShapeDrawn's `clip-path: inset(-24px)`). */
const FRAME_BLEED = 24;
/** What a tag keeps from words, parts and other tags (px on screen). */
const CLEAR = 4;

export type Box = { left: number; top: number; right: number; bottom: number };
const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const grow = (b: Box, n: number): Box => ({ left: b.left - n, top: b.top - n, right: b.right + n, bottom: b.bottom + n });
const moved = (b: Box, dx: number, dy: number): Box => ({ left: b.left + dx, top: b.top + dy, right: b.right + dx, bottom: b.bottom + dy });

/** The moves a tag tries, nearest first: a few px up or down, or a longer way along its row. */
const NEAR: readonly { dx: number; dy: number }[] = (() => {
  const out: { dx: number; dy: number }[] = [];
  for (let dy = -60; dy <= 60; dy += 6) for (let dx = -240; dx <= 240; dx += 12) out.push({ dx, dy });
  return out.sort((a, b) => Math.abs(a.dx) + 2.5 * Math.abs(a.dy) - (Math.abs(b.dx) + 2.5 * Math.abs(b.dy)));
})();

/**
 * Whether a tag still reads as its part's or arrow's: within 40 px of it, and over a part's column by
 * 40 px (half a narrow part), or within 40 px of an arrow's span.
 */
export function besideOf(a: Box, kind: 'mark' | 'edge'): (q: Box) => boolean {
  return (q) => {
    if (q.bottom < a.top - 40 || q.top > a.bottom + 40) return false;
    if (kind === 'edge') return q.right >= a.left - 40 && q.left <= a.right + 40;
    return Math.min(q.right, a.right) - Math.max(q.left, a.left) >= Math.min(40, (a.right - a.left) / 2);
  };
}

/**
 * Where a tag goes, near where it was put (`spots[0]`; `spots[1]` is its part's other edge): a spot in the
 * view (`fits`) that still reads as its part's or arrow's (`near`), covering none of the drawing's own words
 * (`words`) where any spot can, then as little of `hard` as it can (the other parts, the tags already placed:
 * none, where there is room), then crossing as few lines as it can (`soft`: points along the drawing's lines),
 * then the nearest. On a crowded phone a number may meet another number or a part, never the drawing's words.
 * Null: no such spot within reach (the tag stays where it was put).
 */
export function bestSpot(spots: readonly Box[], hard: readonly Box[], soft: readonly Box[], fits: (r: Box) => boolean, near: (r: Box) => boolean, words: readonly Box[] = []): { spot: number; dx: number; dy: number } | null {
  let best: { spot: number; dx: number; dy: number } | null = null;
  let bestCost = Infinity;
  for (const [spot, t] of spots.entries()) {
    const reach = { left: t.left - 260, right: t.right + 260, top: t.top - 70, bottom: t.bottom + 70 };
    const h = hard.filter((w) => meets(w, reach));
    const s = soft.filter((w) => meets(w, reach));
    const wd = words.filter((w) => meets(w, reach));
    const count = (r: Box, list: readonly Box[]) => {
      let n = 0;
      for (const w of list) if (meets(r, w)) n++;
      return n;
    };
    for (const m of NEAR) {
      const base = (Math.abs(m.dx) + 2.5 * Math.abs(m.dy)) / 4 + spot * 8;
      if (base >= bestCost) break;
      const r = moved(t, m.dx, m.dy);
      if (!fits(r) || !near(r)) continue;
      const cost = base + 100_000 * count(r, wd) + 1000 * count(r, h) + 30 * count(r, s);
      if (cost < bestCost) {
        best = { spot, dx: m.dx, dy: m.dy };
        bestCost = cost;
      }
    }
  }
  return best;
}

/**
 * A bug beside the number: this number steps the example (the debugger). Bug02 from @hugeicons/core-free-icons 4.4.0
 * (https://hugeicons.com), MIT License, Copyright (c) 2025 Hugeicons; free set only. Stroke Rounded, at the Inbox's 1.6.
 */
const BUG = [
  'M3.01206 6.59744C2.89214 7.65674 3.6584 10.1951 5.87693 10.255',
  'M18.2891 10.195C19.3684 10.255 20.9873 8.99582 20.9873 6.59741',
  'M20.0876 20.9879C20.1476 19.6088 19.2482 17.4742 17.5093 17.4142',
  'M3.90138 20.9881C3.84009 19.5998 4.7594 17.4509 6.53675 17.3905',
  'M3.01227 13.7926H5.21757',
  'M21 13.7926L18.8282 13.7926',
  'M11.9932 13.7926V10.8546M16.4902 2.99982L14.6914 4.79862M7.49615 2.99982L9.29496 4.79862',
  'M6.95612 8.61209C8.57504 9.77532 12.5924 11.4542 16.9695 8.68404',
  'M16.826 7.6767C13.2523 2.7 8.69536 5.09841 7.07644 7.8206C6.02093 9.59542 4.37823 13.8886 7.49616 18.5655C10.8539 22.6667 14.8113 20.808 16.4302 18.6494C17.9892 16.7906 19.5242 11.9938 16.826 7.6767Z',
];
const BUG_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${BUG.map((d) => `<path d="${d}"/>`).join('')}</svg>`;

/** The drawing's scale on screen (its canvas is scaled to fit, and may be mid-resize). */
export function scaleOf(board: HTMLElement) {
  const b = board.getBoundingClientRect();
  return { b, k: board.offsetWidth && b.width ? b.width / board.offsetWidth : 1 };
}

/** An element's corner radius in the drawing's coordinates: an HTML box's border-radius, an SVG rect's rx on screen. */
function radiusOf(el: Element, k: number): string {
  if (!(el instanceof SVGElement)) return getComputedStyle(el).borderRadius;
  if (el.localName !== 'rect') return '';
  const rx = parseFloat(getComputedStyle(el).getPropertyValue('rx')) || parseFloat(el.getAttribute('rx') ?? '') || 0;
  const m = (el as SVGGraphicsElement).getScreenCTM?.();
  return rx && m ? `${(rx * Math.hypot(m.a, m.b)) / k}px` : '';
}

const byAttr = (name: string, value: string) => `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;

type StepState = 'on' | 'now' | 'later';

/**
 * The example on the picture, for as long as it is followed. `set` moves the
 * light; `place` puts the rings and tags back on their parts (after a resize);
 * `destroy` leaves the drawing exactly as it was.
 */
export class FollowPainter {
  private layer: HTMLDivElement;
  private touched: Element[] = [];
  private dimmed: Element[] = [];
  private lit: { i: number; el: SVGElement }[] = [];
  /** `own`: the part's own border or stroke, which takes the mark colour when lit in place of the ring's line (one border, not two). */
  private rings = new Map<number, { el: HTMLElement; mark: HTMLElement; own: Element | null }>();
  private tags: { tag: HTMLButtonElement; i: number; el: Element; kind: 'mark' | 'edge' }[] = [];
  private ro: ResizeObserver | null = null;
  private moving: Animation[] = [];
  private movers: Element[] = [];

  constructor(
    private board: HTMLElement,
    private ex: ShapeExample,
  ) {
    const root = board.getRootNode() as ShadowRoot | Document;
    if (!(root as ShadowRoot).getElementById?.('shp-ex-style')) {
      const style = board.ownerDocument.createElement('style');
      style.id = 'shp-ex-style';
      style.textContent = FOLLOW_DRAWN_CSS;
      (root instanceof Document ? root.head : root).appendChild(style);
    }
    board.classList.add('shp-ex-on');
    const doc = board.ownerDocument;
    this.layer = doc.createElement('div');
    this.layer.className = 'shp-ex-layer';
    ex.steps.forEach((s, i) => {
      const mark = s.part ? board.querySelector<HTMLElement>(byAttr('data-mark', s.part)) : null;
      const edges = s.arrow ? [...board.querySelectorAll(byAttr('data-edge', s.arrow))] : [];
      for (const el of [...(mark ? [mark] : []), ...edges]) {
        el.setAttribute('data-ex-i', String(i));
        this.touched.push(el);
      }
      // The arrow's light: its own lines, drawn again in the mark colour over them, so it can fade.
      for (const e of edges) {
        const lines = e.matches(GEOMETRY) ? [e] : [...e.querySelectorAll(GEOMETRY)];
        for (const p of lines) {
          const lit = p.cloneNode(false) as SVGElement;
          for (const a of ['class', 'style', 'data-step', 'data-mark', 'data-edge', 'data-ex-i', 'id', 'marker-start', 'marker-mid', 'marker-end']) lit.removeAttribute(a);
          // A filled arrowhead (the kit's `.shp-head`) lights filled, not as an outline.
          lit.setAttribute('class', p.classList.contains('shp-head') ? 'shp-ex-lit shp-ex-head' : 'shp-ex-lit');
          p.after(lit);
          this.lit.push({ i, el: lit });
        }
      }
      if (mark) {
        const ring = doc.createElement('div');
        ring.className = 'shp-ex-ring';
        ring.innerHTML = '<i class="halo"></i><i class="pulse"></i>';
        const own = outlineOf(mark);
        if (own) {
          ring.classList.add('own');
          own.setAttribute('data-ex-own', '');
        }
        this.layer.appendChild(ring);
        this.rings.set(i, { el: ring, mark, own });
      }
      const line = edges.find((e) => e instanceof SVGElement) ?? edges[0];
      const anchor: { el: Element; kind: 'mark' | 'edge' } | null = mark ? { el: mark, kind: 'mark' } : line ? { el: line, kind: 'edge' } : null;
      if (anchor) {
        const tag = doc.createElement('button');
        tag.type = 'button';
        tag.className = 'shp-ex-tag';
        tag.setAttribute('aria-label', `Step ${i + 1}: ${s.text}. ${s.tag}`);
        tag.setAttribute('data-ex-i', String(i));
        const n = doc.createElement('span');
        n.className = 'n';
        n.textContent = String(i + 1);
        n.setAttribute('data-n', String(i + 1));
        const bug = doc.createElement('span');
        bug.className = 'bug';
        bug.setAttribute('aria-hidden', 'true');
        bug.innerHTML = BUG_SVG;
        tag.append(n, bug, doc.createTextNode(s.tag));
        this.layer.appendChild(tag);
        this.tags.push({ tag, i, ...anchor });
      }
    });
    // Dim what the example never touches: the siblings along each touched part's way up to the board.
    const keep = new Set<Element>();
    for (const el of this.touched) for (let e: Element | null = el; e && e !== board; e = e.parentElement) keep.add(e);
    const walk = (node: Element) => {
      for (const child of [...node.children]) {
        // Another layer on the drawing (`data-shp-overlay`: the stack badges) dims its own pieces by their parts.
        if (child === this.layer || child.hasAttribute('data-shp-overlay') || this.touched.includes(child) || child.classList.contains('shp-ex-lit')) continue;
        if (keep.has(child)) walk(child);
        else {
          child.setAttribute('data-ex-dim', '');
          this.dimmed.push(child);
        }
      }
    };
    walk(board);
    board.appendChild(this.layer);
    this.place();
    if (typeof ResizeObserver !== 'undefined') {
      const host = (root as ShadowRoot).host as HTMLElement | undefined;
      this.ro = new ResizeObserver(() => this.place());
      this.ro.observe(host?.closest('.shp-drawn') ?? board);
      this.ro.observe(board);
    }
  }

  private stateOf(i: number, step: number | null): StepState {
    return step === null ? 'on' : i < step ? 'on' : i === step ? 'now' : 'later';
  }

  /**
   * Puts the rings and the values on their parts, in the drawing's coordinates, counter-scaled to read the same.
   * `quick`: while the drawing only scales (the card's room animation, every frame), just the counter-scale:
   * everything sits in the drawing's own coordinates, so nothing else moves until a full place when it lands.
   */
  place(options: { quick?: boolean } = {}) {
    const { b, k } = scaleOf(this.board);
    if (!k) return;
    this.layer.style.setProperty('--ex-inv', String(Math.min(1.6, 1 / k)));
    if (options.quick) return;
    // What shows of the drawing: its frame, which clips 24 px outside itself, within the view it scrolls in.
    const host = (this.board.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
    const box = host?.closest?.('.shp-view');
    const frame = host?.closest?.('.shp-drawn');
    const v = box && box.clientWidth ? box.getBoundingClientRect() : null;
    const f = frame ? frame.getBoundingClientRect() : null;
    // A panning drawing (a wide one on a phone) scrolls inside its frame, and the drawing's own box clips:
    // each tag stays inside that box, the whole drawing, not the slice that shows now, so it pans with its part.
    const fitBox = frame?.classList.contains('pan') ? frame.querySelector('.shp-drawn-fit')?.getBoundingClientRect() : null;
    const view = v
      ? fitBox
        ? { left: fitBox.left, right: fitBox.right, top: fitBox.top, bottom: fitBox.bottom }
        : { left: Math.max(v.left, f ? f.left - FRAME_BLEED : -Infinity), right: Math.min(v.right, f ? f.right + FRAME_BLEED : Infinity), top: f ? f.top - FRAME_BLEED : -Infinity, bottom: Infinity }
      : null;
    const words = view ? this.wordsOf().map((w) => grow(w, 3)) : [];
    const parts = view ? this.partsOf() : [];
    const lines = view ? this.linesOf() : [];
    const placed: Box[] = [];
    const x = (v: number) => (v - b.left) / k;
    const y = (v: number) => (v - b.top) / k;
    for (const { el, mark, own } of this.rings.values()) {
      // A part with its own line: the halo and the pulse follow that line's box and corners.
      const at = own ?? mark;
      const r = at.getBoundingClientRect();
      const radius = typeof getComputedStyle === 'function' ? radiusOf(at, k) : '';
      Object.assign(el.style, { left: `${x(r.left)}px`, top: `${y(r.top)}px`, width: `${r.width / k}px`, height: `${r.height / k}px`, borderRadius: radius });
    }
    for (const { tag, i, el, kind } of this.tags) {
      const s = this.ex.steps[i]!;
      const r = el.getBoundingClientRect();
      let flip: (() => void) | undefined;
      tag.classList.remove('top', 'bottom', 'under', 'beside');
      if (kind === 'mark') {
        const bottom = s.tagAt === 'bottom';
        tag.classList.add(bottom ? 'bottom' : 'top');
        tag.style.left = `${x(r.right) - 12}px`;
        tag.style.top = `${y(bottom ? r.bottom : r.top)}px`;
        // Its part's other edge, should this one have no room.
        flip = () => {
          tag.classList.replace(bottom ? 'bottom' : 'top', bottom ? 'top' : 'bottom');
          tag.style.top = `${y(bottom ? r.top : r.bottom)}px`;
        };
      } else if (el instanceof SVGElement) {
        tag.classList.add('under');
        tag.style.left = `${x(r.left + r.width / 2)}px`;
        tag.style.top = `${y(r.bottom) + 8}px`;
      } else {
        tag.classList.add('beside');
        tag.style.left = `${x(r.right) + 10}px`;
        tag.style.top = `${y(r.top + r.height / 2)}px`;
      }
      // A tag that would run past the view it is read in comes back inside it.
      if (view) {
        const t = tag.getBoundingClientRect();
        const shift = t.left < view.left + EDGE ? view.left + EDGE - t.left : t.right > view.right - EDGE ? Math.max(view.left + EDGE - t.left, view.right - EDGE - t.right) : 0;
        if (shift) tag.style.left = `${parseFloat(tag.style.left) + shift / k}px`;
        // Nor does it cover the drawing's own words (an arrow's label), another part or a tag already placed.
        // Its own part: on an edge (the approved look), never across the middle of it.
        const half = tag.getBoundingClientRect().height / 2 + 0.5;
        const own = kind === 'mark' && r.height > 2 * half ? [{ left: r.left, right: r.right, top: r.top + half, bottom: r.bottom - half }] : [];
        const hard = [...parts.filter((p) => !p.el.contains(el)).map((p) => p.box), ...own, ...placed];
        const soft = lines.filter((l) => !(kind === 'mark' && el.contains(l.el))).flatMap((l) => l.boxes);
        this.clear(tag, k, view, words, hard, soft, besideOf(r, kind), flip);
        placed.push(grow(tag.getBoundingClientRect(), CLEAR));
      }
    }
  }

  /** Where the drawing's own words are: every line of its text, outside the layer the tags are in. */
  private wordsOf(): Box[] {
    const doc = this.board.ownerDocument;
    if (typeof doc.createRange !== 'function') return [];
    const out: Box[] = [];
    const walk = doc.createTreeWalker(this.board, 4 /* NodeFilter.SHOW_TEXT */);
    const range = doc.createRange();
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim() || this.layer.contains(n)) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects?.() ?? []) if (r.width && r.height) out.push(r);
    }
    return out;
  }

  /** The drawing's parts (`data-mark`s holding no other), on screen. A part as big as a quarter of the drawing is a zone, not a part. */
  private partsOf(): { el: Element; box: Box }[] {
    const b = this.board.getBoundingClientRect();
    const zone = (b.width * b.height) / 4;
    const out: { el: Element; box: Box }[] = [];
    for (const el of this.board.querySelectorAll('[data-mark]')) {
      if (this.layer.contains(el) || el.querySelector('[data-mark]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.width * r.height < zone) out.push({ el, box: grow(r, 2) });
    }
    return out;
  }

  /** The drawing's lines (arrows, rules), as small boxes along each one, on screen. */
  private linesOf(): { el: Element; boxes: Box[] }[] {
    const out: { el: Element; boxes: Box[] }[] = [];
    for (const el of this.board.querySelectorAll<SVGGeometryElement>(GEOMETRY)) {
      if (this.layer.contains(el) || el.classList.contains('shp-ex-lit') || el.closest('defs, marker, symbol, clipPath, mask, pattern')) continue;
      if (typeof el.getTotalLength !== 'function') continue;
      try {
        const len = el.getTotalLength();
        const m = el.getScreenCTM?.();
        if (!m || !(len > 0)) continue;
        const n = Math.max(2, Math.min(150, Math.ceil((len * Math.hypot(m.a, m.b)) / 6)));
        const boxes: Box[] = [];
        for (let i = 0; i <= n; i++) {
          const p = el.getPointAtLength((len * i) / n);
          const s = new DOMPoint(p.x, p.y).matrixTransform(m);
          boxes.push({ left: s.x - 2, top: s.y - 2, right: s.x + 2, bottom: s.y + 2 });
        }
        out.push({ el, boxes });
      } catch {
        // No geometry to read here.
      }
    }
    return out;
  }

  /**
   * Moves a tag that covers something, or is cut off by the edge of what shows, to the nearest free spot
   * beside its part (`bestSpot`): off the drawing's words, the other parts and the tags already placed,
   * crossing as few lines as it can. Where nothing beside it is free (a crowded phone), the spot that
   * covers least.
   */
  private clear(tag: HTMLElement, k: number, view: { left: number; right: number; top: number; bottom: number }, words: Box[], hard: Box[], soft: Box[], near: (r: Box) => boolean, flip?: () => void) {
    const t = tag.getBoundingClientRect() as Box;
    // Half a pixel's slack: a tag the edge just set at EDGE measures a hair inside it.
    const fits = (r: Box) => r.left > view.left + EDGE - 0.5 && r.right < view.right - EDGE + 0.5 && r.top >= view.top && r.bottom <= view.bottom;
    if (fits(t) && !words.some((w) => meets(t, w)) && !hard.some((w) => meets(t, w)) && !soft.some((w) => meets(t, w))) return;
    const { left, top } = tag.style;
    const cls = tag.className;
    const restore = () => {
      Object.assign(tag.style, { left, top });
      tag.className = cls;
    };
    const spots: Box[] = [t];
    if (flip) {
      flip();
      spots.push(tag.getBoundingClientRect());
      restore();
    }
    const go = bestSpot(spots, hard, soft, fits, near, words);
    if (!go) return;
    if (go.spot === 1) flip!();
    tag.style.left = `${parseFloat(tag.style.left) + go.dx / k}px`;
    tag.style.top = `${parseFloat(tag.style.top) + go.dy / k}px`;
  }

  /** The step on now (null: the whole path). Forward, a dot runs to it first and its light comes up as the dot lands. */
  set(step: number | null, dir: FollowDir, reduce: boolean) {
    this.stopMoving();
    const arrive = dir === 'fwd' && step !== null && step > 0 && !reduce ? this.travel(step - 1, step) : 0;
    const delay = (i: number) => (arrive && i === step ? Math.round(arrive * 0.82) : 0);
    for (const [i, { el, own }] of this.rings) {
      el.style.setProperty('--ex-d', `${delay(i)}ms`);
      el.setAttribute('data-s', this.stateOf(i, step));
      own?.setAttribute('data-ex-s', this.stateOf(i, step));
    }
    for (const { tag, i } of this.tags) {
      const state = this.stateOf(i, step);
      tag.style.setProperty('--ex-d', `${delay(i)}ms`);
      tag.setAttribute('data-s', state);
      // A step still to come has no tag yet: nothing to land on with the keys, or to read out.
      tag.tabIndex = state === 'later' ? -1 : 0;
      if (state === 'later') tag.setAttribute('aria-hidden', 'true');
      else tag.removeAttribute('aria-hidden');
    }
    for (const { i, el } of this.lit) {
      // The arrow being taken lights up under the dot, over its whole run.
      el.style.setProperty('--ex-dur', arrive && i === step ? `${arrive}ms` : '');
      el.style.setProperty('--ex-d', '0ms');
      el.setAttribute('data-s', this.stateOf(i, step));
    }
    for (const el of this.touched) {
      const i = Number(el.getAttribute('data-ex-i'));
      (el as HTMLElement).style?.setProperty('--ex-d', `${delay(i)}ms`);
      el.setAttribute('data-ex-s', this.stateOf(i, step));
    }
  }

  /** The element a step sits at: its part, else its arrow. */
  elementOf(i: number): Element | null {
    const s = this.ex.steps[i];
    if (!s) return null;
    return (s.part && this.board.querySelector(byAttr('data-mark', s.part))) || (s.arrow && this.board.querySelector(byAttr('data-edge', s.arrow))) || null;
  }

  /** The dot, from the step just left to the step on now, on the arrow's own path. Returns when it lands (ms). */
  private travel(from: number, to: number): number {
    const { b, k } = scaleOf(this.board);
    const toBoard = (px: number, py: number) => ({ x: (px - b.left) / k, y: (py - b.top) / k });
    const target = this.ex.steps[to]!;
    const pts: { x: number; y: number }[] = [];
    const edge = target.arrow ? this.board.querySelector(byAttr('data-edge', target.arrow)) : null;
    const line = edge ? ((edge.matches(GEOMETRY) ? edge : edge.querySelector(`:is(${GEOMETRY}):not(.shp-ex-lit)`)) as SVGGeometryElement | null) : null;
    if (line && typeof line.getTotalLength === 'function') {
      // The arrow's line without its head: a path's first subpath, sampled on its own geometry.
      let probe: SVGGeometryElement = line;
      if (line.localName === 'path') {
        probe = line.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path') as SVGPathElement;
        probe.setAttribute('d', (line.getAttribute('d') ?? '').split(/(?=[Mm])/)[0] ?? '');
        probe.style.visibility = 'hidden';
        line.after(probe);
      }
      try {
        const len = probe.getTotalLength();
        const m = probe.getScreenCTM?.();
        if (m && len > 0) {
          for (let i = 0; i <= 40; i++) {
            const p = probe.getPointAtLength((len * i) / 40);
            const sp = new DOMPoint(p.x, p.y).matrixTransform(m);
            pts.push(toBoard(sp.x, sp.y));
          }
        }
      } catch {
        // No geometry here: the straight way below.
      }
      if (probe !== line) probe.remove();
    }
    if (pts.length < 2) {
      // No arrow: from the edge of the part just left to the facing edge of the next, straight.
      const a = this.elementOf(from)?.getBoundingClientRect();
      const z = this.elementOf(to)?.getBoundingClientRect();
      if (!a || !z) return 0;
      const dx = z.left + z.width / 2 - (a.left + a.width / 2);
      const dy = z.top + z.height / 2 - (a.top + a.height / 2);
      const [p0, p1] =
        Math.abs(dy) > Math.abs(dx)
          ? dy < 0
            ? [toBoard(a.left + a.width / 2, a.top), toBoard(z.left + z.width / 2, z.bottom)]
            : [toBoard(a.left + a.width / 2, a.bottom), toBoard(z.left + z.width / 2, z.top)]
          : dx < 0
            ? [toBoard(a.left, a.top + a.height / 2), toBoard(z.right, z.top + z.height / 2)]
            : [toBoard(a.right, a.top + a.height / 2), toBoard(z.left, z.top + z.height / 2)];
      for (let i = 0; i <= 8; i++) pts.push({ x: p0.x + ((p1.x - p0.x) * i) / 8, y: p0.y + ((p1.y - p0.y) * i) / 8 });
    }
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    const duration = Math.round(Math.max(400, Math.min(550, 380 + length * 0.6)));
    const inv = Math.min(1.6, 1 / k);
    const dot = this.board.ownerDocument.createElement('div');
    dot.className = 'shp-ex-dot';
    this.layer.appendChild(dot);
    this.movers.push(dot);
    const n = pts.length - 1;
    const frames = pts.map((p, i) => {
      const o = i / n;
      return { offset: o, transform: `translate(${p.x}px, ${p.y}px) scale(${inv})`, opacity: o < 0.1 ? o / 0.1 : o > 0.9 ? (1 - o) / 0.1 : 1 };
    });
    const run = animate(dot, frames, { duration, easing: EASE_TRAVEL, fill: 'none' });
    if (!run) {
      dot.remove();
      return 0;
    }
    run.onfinish = () => dot.remove();
    this.moving.push(run);
    // The part answers as the dot lands: a ring that widens and fades (transform and opacity only).
    const ring = this.rings.get(to);
    if (ring) {
      const pulse = ring.el.querySelector<HTMLElement>('.pulse')!;
      const r = ring.mark.getBoundingClientRect();
      const w = Math.max(1, r.width / k);
      const h = Math.max(1, r.height / k);
      const p = animate(
        pulse,
        [
          { opacity: 0.7, transform: 'scale(1)' },
          { opacity: 0, transform: `scale(${1 + 16 / w}, ${1 + 16 / h})` },
        ],
        { duration: 420, delay: duration - 40, easing: FOLLOW_EASE },
      );
      if (p) this.moving.push(p);
    }
    return duration;
  }

  private stopMoving() {
    for (const a of this.moving) a.cancel();
    for (const el of this.movers) el.remove();
    this.moving = [];
    this.movers = [];
  }

  destroy() {
    this.stopMoving();
    this.ro?.disconnect();
    this.layer.remove();
    this.board.classList.remove('shp-ex-on');
    for (const { el } of this.lit) el.remove();
    for (const { own } of this.rings.values()) {
      own?.removeAttribute('data-ex-own');
      own?.removeAttribute('data-ex-s');
    }
    for (const el of this.touched) {
      el.removeAttribute('data-ex-s');
      el.removeAttribute('data-ex-i');
      (el as HTMLElement).style?.removeProperty('--ex-d');
    }
    for (const el of this.dimmed) el.removeAttribute('data-ex-dim');
  }
}
