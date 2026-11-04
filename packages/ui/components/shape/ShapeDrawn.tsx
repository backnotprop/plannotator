// A drawn view (Picture, How it works): the agent's HTML and SVG, sanitized,
// in its own shadow root so its CSS reaches nothing else and the board's
// reaches it only through the frame's variables. The board's motion (parts
// drawing in by step, the erase, the redraw of a changed part), its marks
// (Change it / Ask on any part), its reference bubbles and its links into
// code work on it from outside, through `data-step`, `data-mark`, `data-ref`
// and `data-code`.
//
// It stands on its own: every board prop is optional, so a host can draw one
// diagram without ShapeSurface (`ShapeDiagram` below), and a part with
// `data-code="src/a.ts#L42"` calls the host's `onCode` with that file and line.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  parseShapeCodeTarget,
  shapeCssProblems,
  shapeLinkUrl,
  shapePaintAllowed,
  shapeUrlAllowed,
  SHAPE_DROPPED_ATTRS,
  SHAPE_TOP_LAYER_ATTRS,
  SHAPE_URL_ATTRS,
  type ShapeCodeTarget,
  type ShapeDrawnView,
  type ShapeRef,
} from '@plannotator/core/shape';
import { useReducedMotion } from './Pebble';

export interface MarkState {
  fresh: ReadonlySet<string>;
  erasing: ReadonlySet<string>;
  noted: ReadonlySet<string>;
}

export const NO_MARKS: MarkState = { fresh: new Set(), erasing: new Set(), noted: new Set() };

/**
 * The frame every drawn view sits in: the variables an agent colours with
 * (light and dark follow the app's theme), the SVG classes of the Shape
 * skill's frame, and the board's motion. Keyframes live here because a
 * shadow root does not see the page's.
 */
export const SHAPE_FRAME_CSS = `
:host { display: block; }
.board {
  --paper: var(--shp-paper, var(--background));
  --ink: var(--foreground);
  --ink2: color-mix(in oklab, var(--foreground) 80%, transparent);
  --grey: var(--muted-foreground);
  --rule: var(--border);
  --mark: var(--primary);
  --mark-soft: color-mix(in oklab, var(--primary) 14%, transparent);
  --surface: var(--card);
  --raise: var(--popover);
  --sunk: var(--muted);
  position: relative;
  container-type: inline-size;
  container-name: board;
  color: var(--ink);
  font-size: 15px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.board.canvas { container-type: normal; transform-origin: 0 0; }
*, *::before, *::after { box-sizing: border-box; }
svg { overflow: visible; }
svg text { fill: var(--ink); font-family: inherit; }
svg .ink { stroke: var(--ink); fill: var(--paper); } svg .line { stroke: var(--ink); fill: none; }
svg .grey { stroke: var(--grey); fill: none; } svg .acc { stroke: var(--mark); fill: none; }
svg .acc-fill { fill: var(--mark-soft); stroke: var(--mark); } svg .dash { stroke-dasharray: 6 6; }
svg .t-acc { fill: var(--mark); } svg .t-grey { fill: var(--grey); } svg .t-ink2 { fill: var(--ink2); }
a { color: var(--mark); text-decoration: none; }
img { max-width: 100%; }

/* Draw: parts arrive in step order; lines draw on. */
.board.entering [data-step] { animation: shp-draw-in .5s cubic-bezier(.2,.7,.2,1) both; animation-delay: calc(.32s + var(--i, 0) * 110ms); }
.board.entering g[data-step] { animation-name: shp-fade-only; }
.board.entering .draw { stroke-dasharray: 1; animation: shp-stroke-on .62s cubic-bezier(.45,0,.2,1) both; animation-delay: calc(.4s + var(--i, 0) * 110ms); }
@keyframes shp-draw-in { from { opacity: 0; transform: translateY(8px); filter: blur(2px); } }
@keyframes shp-fade-only { from { opacity: 0; } }
@keyframes shp-stroke-on { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes shp-fade-out { to { opacity: 0; } }
.board.skip [data-step], .board.skip .draw, .board.skip .mk { animation: none !important; }
.board.reduce.entering [data-step], .board.reduce.entering .draw { animation: shp-fade-only .16s linear both; animation-delay: 0s; stroke-dasharray: none; }

/* A marked part: the ring while the agent reads it; erased and redrawn when it changes. */
.mk { border-radius: 6px; transition: box-shadow .25s, background-color .25s; }
.pinpointing .mk { cursor: pointer; }
.mk.noted { box-shadow: 0 0 0 2px color-mix(in oklab, var(--mark) 70%, transparent); background-color: color-mix(in oklab, var(--mark) 7%, transparent); }
.mk.erasing { animation: shp-erase .42s cubic-bezier(.55,0,.45,1) forwards; -webkit-mask-image: linear-gradient(90deg, transparent var(--e), #000 calc(var(--e) + 26%)); mask-image: linear-gradient(90deg, transparent var(--e), #000 calc(var(--e) + 26%)); }
@keyframes shp-erase { from { --e: -30%; } to { --e: 105%; opacity: .2; } }
.mk.fresh { background-image: linear-gradient(color-mix(in oklab, var(--mark) 16%, transparent), color-mix(in oklab, var(--mark) 16%, transparent)); background-repeat: no-repeat; background-size: var(--s) 100%; animation: shp-redraw .55s cubic-bezier(.2,.7,.2,1) both, shp-swash 2.6s cubic-bezier(.3,.6,.2,1) both; transition: background-size 0s; }
@keyframes shp-redraw { from { opacity: 0; transform: translateY(5px); filter: blur(2px); } }
@keyframes shp-swash { 0% { --s: 0%; } 22% { --s: 100%; } 70% { --s: 100%; opacity: 1; } 100% { --s: 100%; background-color: transparent; } }
.board.reduce .mk.erasing { animation: shp-fade-out .12s linear forwards; mask-image: none; -webkit-mask-image: none; }
.board.reduce .mk.fresh { animation: none; background-size: 100% 100%; }

/* A part that opens code. */
.shp-cl { cursor: pointer; outline: 1.5px dashed transparent; outline-offset: 3px; transition: outline-color .15s; }
.board:not(.pinpointing) .shp-cl:hover { outline-color: color-mix(in oklab, var(--mark) 60%, transparent); }
.shp-cl:focus-visible { outline: 2px solid var(--mark); outline-offset: 3px; }

/* Reference bubbles. */
.shp-rb { appearance: none; border: 0; display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; margin: 0 0 0 5px; border-radius: 999px; vertical-align: 2px;
  font: 600 10px/1 var(--font-mono, ui-monospace, monospace); color: var(--mark); background: color-mix(in oklab, var(--mark) 12%, var(--paper)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--mark) 30%, transparent);
  cursor: pointer; text-decoration: none; transition: transform .15s, background-color .15s, color .15s; font-style: normal; letter-spacing: 0; flex: none; }
.shp-rb:hover, .shp-rb.lit { background: var(--mark); color: var(--primary-foreground); }
.shp-rb:focus-visible { outline: 2px solid var(--mark); outline-offset: 2px; }
.shp-rb.flash { animation: shp-rb-flash 1.6s ease-out; }
@keyframes shp-rb-flash { 0%, 40% { background: var(--mark); color: var(--primary-foreground); box-shadow: 0 0 0 0 color-mix(in oklab, var(--mark) 55%, transparent); transform: scale(1.35); } 100% { box-shadow: 0 0 0 12px transparent; transform: none; } }
@media (prefers-reduced-motion: reduce) { .shp-rb.flash { animation: none; background: var(--mark); color: var(--primary-foreground); } }
`;

// One sanitizer of our own, so its hook reaches no other DOMPurify user.
// `isSupported` is no proof (a partial DOM reports true and sanitizes
// nothing), so the sanitizer proves itself on a known bad drawing first; if
// the proof fails, the board shows no drawing rather than an unsanitized one.
//
// Nothing loads from outside the board: every URL attribute goes through the
// format's allowlist (`files/…`, `#…`, a data:image; a link may be https), a
// `style` attribute through the view-css rules, and any other attribute may
// use only `url(#id)`. The values reach the hook decoded, as the page reads them.
let purifier: ReturnType<typeof DOMPurify> | null | undefined;
const PROOF_INPUT =
  '<b onclick="x()">kept</b><script>x()</script><img src="https:evil.invalid/i.png"><img srcset="https://evil.invalid/s.png 2x"><i style="background:u\\72l(//evil.invalid/a)">i</i><style>p{}</style>';
const PROOF_FAILED = /onclick|<script|evil\.invalid|<style|srcset/i;
const CONFIG = {
  ADD_TAGS: ['foreignObject'],
  // HTML inside an SVG's foreignObject (a label in a box) is kept.
  HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true },
  ADD_ATTR: ['pathLength', 'target'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'form', 'template', 'source', 'animate', 'set', 'animateMotion', 'animateTransform', 'dialog', 'select', 'area', 'map'],
  // Nothing may open in the top layer: it sits over the whole app, past the frame's containment and clip.
  FORBID_ATTR: [...SHAPE_DROPPED_ATTRS, ...SHAPE_TOP_LAYER_ATTRS],
};
const WORDS_ONLY = /^(?:data-|aria-)|^(?:title|alt|class|id|role|lang|dir)$/;

function attributeAllowed(tag: string, name: string, value: string): boolean {
  if (SHAPE_DROPPED_ATTRS.includes(name) || SHAPE_TOP_LAYER_ATTRS.includes(name)) return false;
  if (SHAPE_URL_ATTRS.includes(name)) {
    // An image input loads its src; no input needs one.
    if (tag === 'input') return false;
    return shapeUrlAllowed(value, tag === 'a' && (name === 'href' || name === 'xlink:href'));
  }
  if (name === 'style') return shapeCssProblems(value).length === 0;
  return WORDS_ONLY.test(name) || shapePaintAllowed(value);
}

function sanitizer(): ReturnType<typeof DOMPurify> | null {
  if (purifier !== undefined) return purifier;
  const p = DOMPurify(window);
  p.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = ((node as Element).localName ?? (node as Element).tagName ?? '').toLowerCase();
    if (!attributeAllowed(tag, data.attrName.toLowerCase(), data.attrValue)) data.keepAttr = false;
  });
  const proof = p.sanitize(PROOF_INPUT, CONFIG);
  purifier = PROOF_FAILED.test(proof) || !proof.includes('kept') ? null : p;
  return purifier;
}

/** An agent's drawing, made safe: no script, handlers, outside loads, frames or <style>. Empty when this page cannot sanitize. */
export function sanitizeShapeHtml(html: string): string {
  const p = sanitizer();
  return p ? p.sanitize(html, CONFIG) : '';
}

const markOf = (path: EventTarget[]) => path.find((t): t is HTMLElement => t instanceof Element && (t as Element).hasAttribute('data-mark')) as HTMLElement | undefined;
const bubbleOf = (path: EventTarget[]) => path.find((t): t is HTMLElement => t instanceof Element && (t as Element).classList.contains('shp-rb')) as HTMLElement | undefined;
const codeOf = (path: EventTarget[]) => path.find((t): t is HTMLElement => t instanceof Element && (t as Element).classList.contains('shp-cl')) as HTMLElement | undefined;

export interface ShapeDrawnProps {
  drawn: ShapeDrawnView;
  /** entering: parts draw in by step; drawn: still; leaving: no pointing. Default drawn. */
  phase?: 'entering' | 'drawn' | 'leaving';
  /** Skip the draw-in (Esc). */
  skip?: boolean;
  /** Reduced motion. Default: the person's setting. */
  reduce?: boolean;
  /** References the drawing cites by `data-ref`; a bubble for a missing one is dropped. */
  refs?: readonly ShapeRef[];
  refHover?: number | null;
  refFlash?: number | null;
  onRefHover?: (n: number | null) => void;
  /** A bubble was opened (PR and link bubbles open their URL themselves). */
  onRefOpen?: (n: number) => void;
  /**
   * A part with `data-code="path#L42"` was clicked (or Enter on it): the host
   * opens that file at that line. Absent: `data-code` does nothing. While
   * `pinpoint` is on, a click on a marked part picks the part instead.
   */
  onCode?: (target: ShapeCodeTarget, el: HTMLElement) => void;
  /** A `files/…` image's URL. */
  resolveSrc?: (src: string) => string;
  /** Pointing at marked parts (Change it / Ask). Board only. */
  pinpoint?: boolean;
  /** Select mode: a text selection inside a mark picks it. Board only. */
  select?: boolean;
  marks?: MarkState;
  onHoverMark?: (el: HTMLElement | null) => void;
  /** A marked part was chosen; `text` is the selected words in Select mode. */
  onPickMark?: (el: HTMLElement, text?: string) => void;
  /**
   * The drawing's `.board`, each time it is drawn afresh (new content, or the
   * wide and tall layouts swapping), and null once it is gone. For a layer
   * that works on the drawing itself ("Follow an example").
   */
  onBoard?: (board: HTMLElement | null) => void;
}

/** How much room the view has, for a fixed canvas. */
function useFit(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setSize({
        w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return size;
}

const noop = () => {};
const FRAME_CONTAIN: React.CSSProperties = { contain: 'layout', clipPath: 'inset(-24px)' };

export function ShapeDrawn(props: ShapeDrawnProps) {
  const { drawn, phase = 'drawn', skip = false, pinpoint = false, marks = NO_MARKS, refHover = null, refFlash = null } = props;
  const systemReduce = useReducedMotion();
  const reduce = props.reduce ?? systemReduce;
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<ShadowRoot | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  const canvas = drawn.width !== undefined && drawn.height !== undefined;
  const fit = useFit(frameRef, canvas);
  const narrow = canvas ? (fit ? fit.w < 700 : false) : false;
  const useTall = canvas && narrow && !!drawn.tall;
  const html = useTall ? drawn.tall!.html : drawn.html;
  const css = useTall ? drawn.tall!.css ?? drawn.css ?? '' : drawn.css ?? '';
  const scaled = canvas && !useTall;
  // No height to fill (a diagram in a flowing page): fit the width alone.
  const k = scaled && fit ? Math.max(0.2, Math.min(fit.w / drawn.width!, fit.h > 40 ? fit.h / drawn.height! : Infinity, 1.08)) : 1;
  const [contentKey, setContentKey] = useState(0);

  // The content: sanitized once per change, then marked up for the board.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = rootRef.current ?? host.attachShadow({ mode: 'open' });
    rootRef.current = root;
    const safeCss = shapeCssProblems(css).length ? '' : css;
    root.innerHTML = `<style>${SHAPE_FRAME_CSS}\n${safeCss}</style><div class="board${scaled ? ' canvas' : ''}">${sanitizeShapeHtml(html)}</div>`;
    const board = root.querySelector<HTMLElement>('.board')!;
    // Steps: the agent's numbers, in order, become 0, 1, 2… however sparse.
    const steps = [...board.querySelectorAll<HTMLElement | SVGElement>('[data-step]')];
    const order = [...new Set(steps.map((el) => Number(el.getAttribute('data-step')) || 0))].sort((a, b) => a - b);
    for (const el of steps) el.style.setProperty('--i', String(order.indexOf(Number(el.getAttribute('data-step')) || 0)));
    for (const el of board.querySelectorAll<HTMLElement>('[data-mark]')) el.classList.add('mk');
    for (const el of board.querySelectorAll<HTMLElement>('[data-ref]')) {
      const n = Number(el.getAttribute('data-ref'));
      const ref = (handlers.current.refs ?? []).find((r) => r.n === n);
      if (!ref) {
        el.remove();
        continue;
      }
      el.textContent = String(n);
      el.classList.add('shp-rb');
      el.setAttribute('role', ref.kind === 'pr' || ref.kind === 'link' ? 'link' : 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `Reference ${n}: ${ref.title}`);
      el.setAttribute('title', ref.title);
    }
    if (handlers.current.onCode) {
      for (const el of board.querySelectorAll<HTMLElement>('[data-code]')) {
        const at = parseShapeCodeTarget(el.getAttribute('data-code'));
        if (!at) continue;
        el.classList.add('shp-cl');
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        if (!el.hasAttribute('title')) el.setAttribute('title', `Open ${at.path} at line ${at.line}`);
      }
    }
    const resolve = handlers.current.resolveSrc;
    if (resolve) for (const img of board.querySelectorAll<HTMLImageElement>('img[src^="files/"]')) img.src = resolve(img.getAttribute('src')!);
    setContentKey((x) => x + 1);
    handlers.current.onBoard?.(board);
  }, [html, css, scaled]);
  useEffect(() => () => handlers.current.onBoard?.(null), []);

  // The canvas scale.
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    if (scaled) {
      board.style.width = `${drawn.width}px`;
      board.style.height = `${drawn.height}px`;
      board.style.transform = `scale(${k})`;
    } else {
      board.style.width = board.style.height = board.style.transform = '';
    }
  }, [scaled, k, drawn.width, drawn.height, contentKey]);

  // Motion and mode.
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    board.classList.toggle('entering', phase === 'entering');
    board.classList.toggle('skip', skip);
    board.classList.toggle('reduce', reduce);
    board.classList.toggle('pinpointing', pinpoint);
  }, [phase, skip, reduce, pinpoint, contentKey]);

  // Marks.
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    for (const el of board.querySelectorAll<HTMLElement>('[data-mark]')) {
      const id = el.getAttribute('data-mark')!;
      el.classList.toggle('noted', marks.noted.has(id));
      el.classList.toggle('erasing', marks.erasing.has(id));
      el.classList.toggle('fresh', marks.fresh.has(id));
    }
  }, [marks, contentKey]);

  // Bubbles: lit with their list row, flashed from it.
  useEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    for (const el of board.querySelectorAll<HTMLElement>('.shp-rb')) {
      const n = Number(el.getAttribute('data-ref'));
      el.classList.toggle('lit', refHover === n);
      el.classList.toggle('flash', refFlash === n);
      if (refFlash === n) el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
  }, [refHover, refFlash, contentKey, reduce]);

  // Pointing, clicking and keys inside the shadow root.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onMove = (e: Event) => {
      const h = handlers.current;
      const hover = h.onHoverMark ?? noop;
      if (!h.pinpoint || bubbleOf(e.composedPath())) return hover(null);
      hover(markOf(e.composedPath()) ?? null);
    };
    const onOver = (e: Event) => {
      const b = bubbleOf(e.composedPath());
      if (b) handlers.current.onRefHover?.(Number(b.getAttribute('data-ref')));
    };
    const onOut = (e: Event) => {
      if (bubbleOf(e.composedPath())) handlers.current.onRefHover?.(null);
    };
    const openBubble = (b: HTMLElement) => {
      const n = Number(b.getAttribute('data-ref'));
      const ref = (handlers.current.refs ?? []).find((r) => r.n === n);
      if (!ref) return;
      if (ref.kind !== 'pr' && ref.kind !== 'link') handlers.current.onRefOpen?.(n);
      else {
        const url = shapeLinkUrl(ref.target);
        if (url) window.open(url, '_blank', 'noreferrer');
      }
    };
    const openCode = (el: HTMLElement) => {
      const at = parseShapeCodeTarget(el.getAttribute('data-code'));
      if (at) handlers.current.onCode?.(at, el);
    };
    const onClick = (e: Event) => {
      const path = e.composedPath();
      const b = bubbleOf(path);
      if (b) {
        e.stopPropagation();
        openBubble(b);
        return;
      }
      // A drawing's link never moves the page it sits on: `#…` scrolls inside the drawing (never the host's
      // hash, which is the Inbox's route), an http(s) link opens in a new tab, and anything else does nothing.
      // Any element with an href is held (an `<area>` the store and sanitizer refuse would still be caught); only a
      // link (`<a>`, `<area>`) is followed, the way below. Another element's href (`<use href="#icon">`) moves nothing.
      const withHref = path.filter((t): t is Element => t instanceof Element && (t.hasAttribute('href') || t.hasAttribute('xlink:href')));
      if (withHref.length) e.preventDefault();
      const link = withHref.find((t) => t.localName === 'a' || t.localName === 'area');
      if (link) {
        const href = (link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? '').trim();
        if (href.startsWith('#')) {
          const id = decodeURIComponent(href.slice(1));
          const to = id ? (root as ShadowRoot).getElementById?.(id) : null;
          to?.scrollIntoView({ block: 'nearest', behavior: handlers.current.reduce ? 'auto' : 'smooth' });
        } else {
          const url = shapeLinkUrl(href);
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      const h = handlers.current;
      if (path.some((t) => t instanceof Element && /^(A|BUTTON|SELECT)$/.test((t as Element).tagName))) return;
      const mark = h.pinpoint && h.onPickMark ? markOf(path) : undefined;
      if (mark) return h.onPickMark!(mark);
      const code = codeOf(path);
      if (code && h.onCode) {
        e.stopPropagation();
        openCode(code);
      }
    };
    const onKey = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const b = bubbleOf(e.composedPath());
      const code = b ? undefined : codeOf(e.composedPath());
      if (!b && !code) return;
      ke.preventDefault();
      if (b) openBubble(b);
      else openCode(code!);
    };
    const onUp = () => {
      const h = handlers.current;
      if (!h.select || !h.onPickMark) return;
      requestAnimationFrame(() => {
        const sel = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? document.getSelection();
        const text = sel?.toString().trim();
        if (!sel || sel.isCollapsed || !text) return;
        const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
        const mark = anchor?.closest<HTMLElement>('[data-mark]');
        if (mark && root.contains(mark)) h.onPickMark!(mark, text);
      });
    };
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.addEventListener('mouseup', onUp);
    return () => {
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('mouseup', onUp);
    };
  }, [contentKey]);

  // The frame contains the drawing: its css styles the shadow host (`:host`),
  // and without this `:host { position: fixed; inset: 0 }` (or a huge
  // transform) would lay the drawing over the whole app. Layout containment
  // makes the frame the box anything fixed is placed in, and the clip keeps
  // every pixel within 24px of the frame: room for a ring, a focus outline
  // or a border a pixel over, which paint containment would cut. Inline, so
  // it holds even where the host page has not loaded shape.css.
  return (
    <div
      ref={frameRef}
      className={`shp-drawn${canvas ? ' canvas' : ''}${useTall ? ' tall' : ''}`}
      style={FRAME_CONTAIN}
      onPointerLeave={() => props.onHoverMark?.(null)}
    >
      <div className="shp-drawn-fit" style={scaled && fit ? { width: drawn.width! * k, height: drawn.height! * k } : undefined}>
        <div ref={hostRef} className="shp-drawn-host" />
      </div>
    </div>
  );
}

/**
 * One drawing on its own, outside ShapeSurface: a diagram whose parts open
 * code (`data-code`) and whose bubbles open references. It draws in once
 * when it mounts (or when `drawn` changes) and then holds still. For a host
 * such as code review answering "show me how this works".
 */
export function ShapeDiagram({
  drawn,
  refs,
  onCode,
  onRefOpen,
  resolveSrc,
  animate = true,
  className,
}: {
  drawn: ShapeDrawnView;
  refs?: readonly ShapeRef[];
  onCode?: ShapeDrawnProps['onCode'];
  onRefOpen?: (ref: ShapeRef) => void;
  resolveSrc?: (src: string) => string;
  /** Draw in on mount. Default true (reduced motion: a short fade). */
  animate?: boolean;
  className?: string;
}) {
  const [phase, setPhase] = useState<'entering' | 'drawn'>(animate ? 'entering' : 'drawn');
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!animate) return;
    setPhase('entering');
    const t = window.setTimeout(() => setPhase('drawn'), 2900);
    return () => window.clearTimeout(t);
  }, [drawn, animate]);
  return (
    <div className={`shp-diagram${className ? ` ${className}` : ''}`}>
      <ShapeDrawn
        drawn={drawn}
        phase={phase}
        refs={refs}
        refHover={hover}
        onRefHover={setHover}
        onRefOpen={(n) => {
          const ref = refs?.find((r) => r.n === n);
          if (ref) onRefOpen?.(ref);
        }}
        onCode={onCode}
        resolveSrc={resolveSrc}
      />
    </div>
  );
}
