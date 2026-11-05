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
.shp-ex-lit:is([data-s="on"], [data-s="now"]) { opacity: 1; }
.shp-ex-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 6; pointer-events: none; --ex-inv: 1; }
.shp-ex-ring { position: absolute; box-shadow: 0 0 0 2px var(--mark); opacity: 0; transition: opacity .22s ease var(--ex-d, 0ms); pointer-events: none; }
.shp-ex-ring:is([data-s="on"], [data-s="now"]) { opacity: 1; }
.shp-ex-ring > i { position: absolute; inset: 0; border-radius: inherit; }
.shp-ex-ring .halo { box-shadow: 0 0 0 2px var(--mark), 0 0 0 7px var(--mark-soft); opacity: 0; transition: opacity .26s ease var(--ex-d, 0ms); }
.shp-ex-ring[data-s="now"] .halo { opacity: 1; }
.shp-ex-ring .pulse { box-shadow: 0 0 0 2px var(--mark); opacity: 0; }
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
/** What a tag keeps from words it steps aside from. */
const CLEAR = 4;

type Box = { left: number; top: number; right: number; bottom: number };
const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

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
function scaleOf(board: HTMLElement) {
  const b = board.getBoundingClientRect();
  return { b, k: board.offsetWidth && b.width ? b.width / board.offsetWidth : 1 };
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
  private rings = new Map<number, { el: HTMLElement; mark: HTMLElement }>();
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
          lit.setAttribute('class', 'shp-ex-lit');
          p.after(lit);
          this.lit.push({ i, el: lit });
        }
      }
      if (mark) {
        const ring = doc.createElement('div');
        ring.className = 'shp-ex-ring';
        ring.innerHTML = '<i class="halo"></i><i class="pulse"></i>';
        this.layer.appendChild(ring);
        this.rings.set(i, { el: ring, mark });
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
        if (child === this.layer || this.touched.includes(child) || child.classList.contains('shp-ex-lit')) continue;
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

  /** Puts the rings and the values on their parts, in the drawing's coordinates, counter-scaled to read the same. */
  place() {
    const { b, k } = scaleOf(this.board);
    if (!k) return;
    // What shows of the drawing: its frame, which clips 24 px outside itself, within the view it scrolls in.
    const host = (this.board.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
    const box = host?.closest?.('.shp-view');
    const frame = host?.closest?.('.shp-drawn');
    const v = box && box.clientWidth ? box.getBoundingClientRect() : null;
    const f = frame ? frame.getBoundingClientRect() : null;
    const view = v
      ? { left: Math.max(v.left, f ? f.left - FRAME_BLEED : -Infinity), right: Math.min(v.right, f ? f.right + FRAME_BLEED : Infinity), top: f ? f.top - FRAME_BLEED : -Infinity }
      : null;
    const words = view ? this.wordsOf() : [];
    const placed: Box[] = [];
    this.layer.style.setProperty('--ex-inv', String(Math.min(1.6, 1 / k)));
    const x = (v: number) => (v - b.left) / k;
    const y = (v: number) => (v - b.top) / k;
    for (const { el, mark } of this.rings.values()) {
      const r = mark.getBoundingClientRect();
      const radius = typeof getComputedStyle === 'function' ? getComputedStyle(mark).borderRadius : '';
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
        // Nor does it cover the drawing's own words (a frame's label) or a tag already placed: it steps right, up, or left of them.
        this.clear(tag, k, view, [...words, ...placed], flip);
        placed.push(tag.getBoundingClientRect());
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

  /** Moves a tag off what it covers: right of it, to its part's other edge, above it, or left of it; else leaves it. */
  private clear(tag: HTMLElement, k: number, view: { left: number; right: number; top: number }, taken: Box[], flip?: () => void) {
    const t = tag.getBoundingClientRect();
    const on = taken.filter((w) => meets(t, w));
    if (!on.length) return;
    const { left, top } = tag.style;
    const cls = tag.className;
    const by = (dx: number, dy: number) => () => {
      tag.style.left = `${parseFloat(left) + dx / k}px`;
      tag.style.top = `${parseFloat(top) + dy / k}px`;
    };
    const tries = [
      by(Math.max(...on.map((w) => w.right)) + CLEAR - t.left, 0),
      ...(flip ? [flip] : []),
      by(0, Math.min(...on.map((w) => w.top)) - CLEAR - t.bottom),
      by(Math.min(...on.map((w) => w.left)) - CLEAR - t.right, 0),
    ];
    for (const go of tries) {
      go();
      const r = tag.getBoundingClientRect();
      // Half a pixel's slack: a tag the edge just set at EDGE measures a hair inside it.
      if (r.left > view.left + EDGE - 0.5 && r.right < view.right - EDGE + 0.5 && r.top >= view.top && !taken.some((w) => meets(r, w))) return;
      Object.assign(tag.style, { left, top });
      tag.className = cls;
    }
  }

  /** The step on now (null: the whole path). Forward, a dot runs to it first and its light comes up as the dot lands. */
  set(step: number | null, dir: FollowDir, reduce: boolean) {
    this.stopMoving();
    const arrive = dir === 'fwd' && step !== null && step > 0 && !reduce ? this.travel(step - 1, step) : 0;
    const delay = (i: number) => (arrive && i === step ? Math.round(arrive * 0.82) : 0);
    for (const [i, { el }] of this.rings) {
      el.style.setProperty('--ex-d', `${delay(i)}ms`);
      el.setAttribute('data-s', this.stateOf(i, step));
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
    for (const el of this.touched) {
      el.removeAttribute('data-ex-s');
      el.removeAttribute('data-ex-i');
      (el as HTMLElement).style?.removeProperty('--ex-d');
    }
    for (const el of this.dimmed) el.removeAttribute('data-ex-dim');
  }
}
