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
  shapeKeepSvgWhole,
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
import { syncKeptBoxes, type KeptBox } from './boxSelect';

/**
 * A drawing's files/ pictures get their real URL before the browser parses them, so nothing asks for the bare name first.
 * `tile`: each also carries `data-shp-pic`, for `tilePictures`.
 */
function resolveFiles(html: string, resolve: ((src: string) => string) | undefined, tile = false): string {
  if (!resolve && !tile) return html;
  const attr = (url: string) => url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return html.replace(/(<(?:img|image)\b)([^>]*?\s(?:src|href)=")(files\/[^"]+)"/gi, (_, open: string, head: string, src: string) => `${open}${tile ? ' data-shp-pic' : ''}${head}${resolve ? attr(resolve(src)) : src}"`);
}

/**
 * `pictureTiles`: a rounded tile behind each SVG picture the board keeps, its box plus a little room. An `<img>`
 * gets the same from the frame's CSS. A picture the drawing clips itself (the kit's `pic()` frames its own) is left
 * as drawn, and so is one with no plain size.
 */
function tilePictures(board: HTMLElement): void {
  for (const image of board.querySelectorAll<SVGImageElement>('image[data-shp-pic]')) {
    if (image.hasAttribute('clip-path') || image.closest('[clip-path]')) continue;
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(image.getAttribute(k) ?? (k === 'x' || k === 'y' ? 0 : NaN)));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const pad = Math.max(3, Math.min(10, Math.min(w, h) * 0.12));
    const tile = document.createElementNS(SVG_NS, 'rect');
    tile.setAttribute('class', 'shp-pic-tile');
    for (const [k, v] of [['x', x - pad], ['y', y - pad], ['width', w + pad * 2], ['height', h + pad * 2], ['rx', Math.min(12, pad + 5)]] as const) tile.setAttribute(k, String(Math.round(v * 10) / 10));
    image.before(tile);
  }
}

export interface MarkState {
  fresh: ReadonlySet<string>;
  erasing: ReadonlySet<string>;
  noted: ReadonlySet<string>;
}

/** A tagged part's top padding at least: the tag (2 px down, about 19 px tall) and a gap above the part's words. */
const TAG_ROOM = 28;
/** A tagged part's own inline padding-top, to put back when its tag goes. */
const tagPads = new WeakMap<HTMLElement, string>();

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
  --alert: var(--destructive);
  /* A few zone colours, each a hue mixed toward the ink (lines, words) or the paper (fills), so light and dark both hold. */
  --blue: color-mix(in oklab, #2f6fb0 74%, var(--ink));
  --blue-soft: color-mix(in oklab, #2f6fb0 13%, var(--paper));
  --amber: color-mix(in oklab, #b87a12 76%, var(--ink));
  --amber-soft: color-mix(in oklab, #d9971f 16%, var(--paper));
  --green: color-mix(in oklab, #2b8a57 74%, var(--ink));
  --green-soft: color-mix(in oklab, #2b8a57 13%, var(--paper));
  --plum: color-mix(in oklab, #9b3f78 74%, var(--ink));
  --plum-soft: color-mix(in oklab, #9b3f78 12%, var(--paper));
  --alert-soft: color-mix(in oklab, var(--destructive) 11%, var(--paper));
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
svg { overflow: visible; } svg svg { overflow: hidden; }
svg text { fill: var(--ink); font-family: inherit; }
svg .ink { stroke: var(--ink); fill: var(--paper); } svg .line { stroke: var(--ink); fill: none; }
svg .grey { stroke: var(--grey); fill: none; } svg .acc { stroke: var(--mark); fill: none; }
svg .acc-fill { fill: var(--mark-soft); stroke: var(--mark); } svg .dash { stroke-dasharray: 6 6; } svg .dash:not([fill]) { fill: none; } svg .dash:not([stroke]) { stroke: var(--grey); } svg .line.dash { stroke: var(--ink); } svg .acc.dash { stroke: var(--mark); } svg .alert.dash { stroke: var(--alert); } svg .grey.dash { stroke: var(--grey); } svg .acc-fill.dash { fill: var(--mark-soft); stroke: var(--mark); }
svg .t-acc { fill: var(--mark); } svg .t-grey { fill: var(--grey); } svg .t-ink2 { fill: var(--ink2); } svg .alert { stroke: var(--alert); fill: none; } svg .t-alert { fill: var(--alert); } svg .t-mono { font-family: var(--font-mono, ui-monospace, monospace); }
a { color: var(--mark); text-decoration: none; }
img { max-width: 100%; }
svg .obj { filter: drop-shadow(0 3px 10px rgb(0 0 0 / .18)); }
/* pictureTiles: a picture the board keeps sits on a light tile in both themes (white on a light board, a soft grey on a dark one). */
.board { --shp-pic-tile: color-mix(in oklab, var(--surface) calc(100% - var(--shp-is-dark, 0) * 100%), #e4e6ea); }
.shp-pic-tile { fill: var(--shp-pic-tile); stroke: color-mix(in oklab, var(--rule) calc(100% - var(--shp-is-dark, 0) * 100%), transparent); stroke-width: 1; }
img[data-shp-pic] { background: var(--shp-pic-tile); padding: 6px; border-radius: 10px; box-sizing: border-box; box-shadow: 0 0 0 1px color-mix(in oklab, var(--rule) calc(100% - var(--shp-is-dark, 0) * 100%), transparent); }
.if-dark { opacity: var(--shp-is-dark, 0); } .if-light { opacity: calc(1 - var(--shp-is-dark, 0)); }

/* Draw: parts arrive in step order; lines draw on. */
.board.entering [data-step] { animation: shp-draw-in .5s cubic-bezier(.2,.7,.2,1) both; animation-delay: calc(.32s + var(--i, 0) * 110ms); }
.board.entering g[data-step] { animation-name: shp-fade-only; }
.board.entering .draw { stroke-dasharray: 1; animation: shp-stroke-on .62s cubic-bezier(.45,0,.2,1) both; animation-delay: calc(.4s + var(--i, 0) * 110ms); }
@keyframes shp-draw-in { from { opacity: 0; transform: translateY(8px); filter: blur(2px); } }
@keyframes shp-fade-only { from { opacity: 0; } }
@keyframes shp-stroke-on { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes shp-fade-out { to { opacity: 0; } }
.board.skip [data-step], .board.skip .draw, .board.skip .mk { animation: none !important; }

/* A thing that travels (data-to): from its place to its point, again and again. Reduced motion: it holds still halfway. */
.shp-go { animation: shp-go 3.4s cubic-bezier(.45,0,.4,1) infinite; }
@keyframes shp-go { 0%, 8% { transform: translate(0, 0); opacity: 0; } 16% { opacity: 1; } 62% { transform: translate(var(--dx), var(--dy)); opacity: 1; } 72%, 100% { transform: translate(var(--dx), var(--dy)); opacity: 0; } }
.board.reduce .shp-go { animation: none; transform: translate(calc(var(--dx) / 2), calc(var(--dy) / 2)); }
@media (prefers-reduced-motion: reduce) { .shp-go { animation: none; transform: translate(calc(var(--dx) / 2), calc(var(--dy) / 2)); } }
.board.reduce.entering [data-step], .board.reduce.entering .draw { animation: shp-fade-only .16s linear both; animation-delay: 0s; stroke-dasharray: none; }

/* A board that takes a dragged box: the cross everywhere but a number, and no words selected on the way. */
@media (pointer: fine) {
  .board.boxable, .board.boxable * { cursor: crosshair !important; -webkit-user-select: none; user-select: none; }
  .board.boxable .shp-rb, .board.boxable .shp-rb * { cursor: pointer !important; }
}

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

/* A part a host tags: "changed" (a redrawn part, with .fresh) or "changed since asked" (.shp-stale: its code moved on).
   The ring and the tag stay inside the part's own box, so they never cover a connector's label or a neighbour; the
   tag gets room at the top of the part (the host's effect pads it), and an untagged part keeps its layout. */
.mk.shp-stale { outline: 1.5px dashed color-mix(in oklab, var(--warning, var(--mark)) 80%, transparent) !important; outline-offset: -5px; }
.mk[data-shp-tag]::after { content: attr(data-shp-tag); position: absolute; top: 2px; right: 8px; z-index: 1; font: 600 10.5px/1 var(--font-mono, ui-monospace, monospace); letter-spacing: .04em; text-transform: uppercase; padding: 4px 6px; border-radius: 6px; background: var(--mark); color: var(--primary-foreground); white-space: nowrap; pointer-events: none; }
.mk.shp-stale[data-shp-tag]::after { background: color-mix(in oklab, var(--warning, var(--mark)) 22%, var(--paper)); color: color-mix(in oklab, var(--warning, var(--mark)) 60%, var(--ink)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--warning, var(--mark)) 50%, transparent); }

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
/* A number the agent drew: its own look; it grows a little under the pointer. */
.shp-rb.own { display: revert; min-width: 0; height: auto; padding: 0; margin: 0; border-radius: 0; background: none; box-shadow: none; color: inherit; font: inherit; vertical-align: baseline; transform-box: fill-box; transform-origin: center; transition: transform .14s cubic-bezier(.2,.8,.2,1); }
.shp-rb.own:hover, .shp-rb.own.lit { background: none; color: inherit; transform: scale(1.14); }
.shp-rb.own.flash { animation: shp-rb-own-flash 1.2s ease-out; }
@keyframes shp-rb-own-flash { 0%, 40% { transform: scale(1.3); } 100% { transform: none; } }
@media (prefers-reduced-motion: reduce) { .shp-rb.own, .shp-rb.own:hover, .shp-rb.own.lit { transform: none; transition: none; } .shp-rb.own.flash { animation: none; } }
/* A number in an SVG's words. */
svg tspan.shp-rb { display: inline; fill: var(--mark); }
svg tspan.shp-rb:hover, svg tspan.shp-rb.lit { text-decoration: underline; }
/* A finger needs more than 16 px. */
@media (pointer: coarse) { .shp-rb.own:focus-visible { outline: none; } .board.peek .shp-rb:not(.own) { position: relative; min-width: 22px; height: 22px; font-size: 12px; } .board.peek .shp-rb:not(.own)::after { content: ""; position: absolute; inset: -11px; } }
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
  return p ? p.sanitize(shapeKeepSvgWhole(html), CONFIG) : '';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Parts of an SVG that are never drawn where they stand.
const UNDRAWN = new Set(['defs', 'symbol', 'clippath', 'mask', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'filter']);
const drawnWords = (root: Element): Element[] =>
  [root, ...root.querySelectorAll('text')].filter((t) => {
    if (t.localName !== 'text') return false;
    for (let at: Element | null = t; at && at.namespaceURI === SVG_NS; at = at.parentElement) if (UNDRAWN.has(at.localName.toLowerCase())) return false;
    return true;
  });

/**
 * In SVG only a `<text>` shows words, so an empty number among the shapes
 * (`<g data-ref="1"/>`) is drawn at the end of the nearest words: those just
 * before it, else just after it, in its own group first, then in the groups
 * around it. With no words in the drawing, it goes just after the SVG, as a
 * bubble. A shape (`<circle data-ref>`) stays where it is: it is the number.
 */
function placeNumber(el: Element): Element {
  const doc = el.ownerDocument;
  const copy = (spot: Element) => {
    for (const a of el.attributes) if (a.name === 'class' || a.name.startsWith('data-')) spot.setAttribute(a.name, a.value);
    el.remove();
    return spot;
  };
  for (let node: Element | null = el; node && node.parentElement?.namespaceURI === SVG_NS; node = node.parentElement) {
    let words: Element | undefined;
    for (let at = node.previousElementSibling; at && !words; at = at.previousElementSibling) words = drawnWords(at).pop();
    for (let at = node.nextElementSibling; at && !words; at = at.nextElementSibling) words = drawnWords(at)[0];
    if (!words) continue;
    const spot = copy(doc.createElementNS(SVG_NS, 'tspan'));
    spot.setAttribute('dx', '5');
    words.append(spot);
    return spot;
  }
  let svg = el.closest('svg');
  while (svg?.parentElement?.namespaceURI === SVG_NS) svg = svg.parentElement.closest('svg');
  if (!svg) return el;
  const spot = copy(doc.createElement('span'));
  svg.after(spot);
  return spot;
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
  /** A bubble was opened (PR and link bubbles open their URL themselves, unless they carry a picture). */
  onRefOpen?: (n: number) => void;
  /** A fixed canvas in a narrow space keeps a readable size and scrolls sideways. Absent: it shrinks to fit. */
  pan?: boolean;
  /**
   * The bubble's preview: hover or keyboard focus shows it (null hides it), a tap on a touch
   * screen pins it. Absent: a bubble only lights and opens, as before.
   */
  onRefPeek?: (n: number | null, el: HTMLElement, how: 'hover' | 'focus' | 'tap') => void;
  /**
   * A part with `data-code="path#L42"` was clicked (or Enter on it): the host
   * opens that file at that line. Absent: `data-code` does nothing. While
   * `pinpoint` is on, a click on a marked part picks the part instead.
   */
  onCode?: (target: ShapeCodeTarget, el: HTMLElement) => void;
  /** A `files/…` image's URL. */
  resolveSrc?: (src: string) => string;
  /** Each `files/…` picture on a rounded tile, light in both themes (`ShapeSurfaceProps.pictureTiles`). Absent: as drawn. */
  pictureTiles?: boolean;
  /** Pointing at marked parts (Change it / Ask). Board only. */
  pinpoint?: boolean;
  /** Select mode: a text selection inside a mark picks it. Board only. */
  select?: boolean;
  marks?: MarkState;
  /** Marked parts whose code changed since the drawing was made: a dashed outline, and the `tags.stale` words on them. */
  stale?: ReadonlySet<string>;
  /** Words a host puts on parts: `fresh` on `marks.fresh` parts ("changed"), `stale` on `stale` ones. Absent: no tag. */
  tags?: { fresh?: string; stale?: string };
  /** A dragged box can start here: the cross cursor, and no text selection. Board only. */
  boxable?: boolean;
  /** Kept boxes with their comments, on this view. Board only. */
  boxes?: readonly KeptBox[];
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
  const pan = !!props.pan && scaled && narrow;
  const k = scaled && fit ? Math.max(pan ? 0.55 : 0.2, Math.min(fit.w / drawn.width!, fit.h > 40 ? fit.h / drawn.height! : Infinity, 1.08)) : 1;
  const [contentKey, setContentKey] = useState(0);

  // The content: sanitized once per change, then marked up for the board.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = rootRef.current ?? host.attachShadow({ mode: 'open' });
    rootRef.current = root;
    const safeCss = shapeCssProblems(css).length ? '' : css;
    root.innerHTML = `<style>${SHAPE_FRAME_CSS}\n${safeCss}</style><div class="board${scaled ? ' canvas' : ''}${handlers.current.onRefPeek ? ' peek' : ''}">${resolveFiles(sanitizeShapeHtml(html), handlers.current.resolveSrc, !!handlers.current.pictureTiles)}</div>`;
    const board = root.querySelector<HTMLElement>('.board')!;
    if (handlers.current.pictureTiles) tilePictures(board);
    // Steps: the agent's numbers, in order, become 0, 1, 2… however sparse.
    const steps = [...board.querySelectorAll<HTMLElement | SVGElement>('[data-step]')];
    const order = [...new Set(steps.map((el) => Number(el.getAttribute('data-step')) || 0))].sort((a, b) => a - b);
    for (const el of steps) el.style.setProperty('--i', String(order.indexOf(Number(el.getAttribute('data-step')) || 0)));
    for (const el of board.querySelectorAll<HTMLElement>('[data-mark]')) el.classList.add('mk');
    for (let el of board.querySelectorAll<Element>('[data-ref]')) {
      const n = Number(el.getAttribute('data-ref'));
      const ref = (handlers.current.refs ?? []).find((r) => r.n === n);
      if (!ref) {
        el.remove();
        continue;
      }
      // Empty: the board draws the number. Not empty: what the agent drew is the number.
      if (!el.children.length && !el.textContent?.trim()) {
        if (el.namespaceURI === SVG_NS && (el.localName === 'g' || el.localName === 'tspan') && !el.closest('text')) el = placeNumber(el);
        el.textContent = String(n);
      } else el.classList.add('own');
      el.classList.add('shp-rb');
      el.setAttribute('role', ref.kind === 'pr' || ref.kind === 'link' ? 'link' : 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `Reference ${n}: ${ref.title}`);
      if (!handlers.current.onRefPeek) el.setAttribute('title', ref.title);
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
    board.classList.toggle('boxable', !!props.boxable);
  }, [phase, skip, reduce, pinpoint, props.boxable, contentKey]);

  // Kept boxes: inside the drawing, so they scroll and scale with it. A box belongs to the layout it was drawn on.
  const boxes = props.boxes;
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (board && boxes) syncKeptBoxes(board, boxes.filter((b) => !!b.box.tall === useTall), scaled ? k : 1);
  }, [boxes, useTall, scaled, k, contentKey]);

  // Marks, and a host's tags on them.
  const stale = props.stale;
  const freshTag = props.tags?.fresh;
  const staleTag = props.tags?.stale;
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    for (const el of board.querySelectorAll<HTMLElement>('[data-mark]')) {
      const id = el.getAttribute('data-mark')!;
      el.classList.toggle('noted', marks.noted.has(id));
      el.classList.toggle('erasing', marks.erasing.has(id));
      el.classList.toggle('fresh', marks.fresh.has(id));
      const isStale = !!stale?.has(id);
      el.classList.toggle('shp-stale', isStale);
      const tag = isStale ? staleTag : marks.fresh.has(id) ? freshTag : undefined;
      if (tag) {
        el.setAttribute('data-shp-tag', tag);
        // The tag sits in the part's corner: a part the drawing left in the flow becomes its containing block.
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        // Room for it above the part's own words; the part's own padding kept here (never in the DOM, where
        // the drawing could have written it) to put back when the tag goes.
        if (!tagPads.has(el)) {
          tagPads.set(el, el.style.paddingTop);
          const top = parseFloat(getComputedStyle(el).paddingTop) || 0;
          if (top < TAG_ROOM) el.style.paddingTop = `${TAG_ROOM}px`;
        }
      } else {
        el.removeAttribute('data-shp-tag');
        const pad = tagPads.get(el);
        if (pad !== undefined) {
          el.style.paddingTop = pad;
          tagPads.delete(el);
        }
      }
    }
  }, [marks, stale, freshTag, staleTag, contentKey]);

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
    let lastPointer = 'mouse';
    const onDown = (e: Event) => {
      lastPointer = (e as PointerEvent).pointerType || 'mouse';
    };
    const onOver = (e: Event) => {
      const b = bubbleOf(e.composedPath());
      if (!b) return;
      const n = Number(b.getAttribute('data-ref'));
      handlers.current.onRefHover?.(n);
      if ((e as PointerEvent).pointerType !== 'touch') handlers.current.onRefPeek?.(n, b, 'hover');
    };
    const onOut = (e: Event) => {
      const b = bubbleOf(e.composedPath());
      if (!b) return;
      handlers.current.onRefHover?.(null);
      if ((e as PointerEvent).pointerType !== 'touch') handlers.current.onRefPeek?.(null, b, 'hover');
    };
    const onFocusIn = (e: Event) => {
      const b = bubbleOf(e.composedPath());
      if (b?.matches(':focus-visible')) handlers.current.onRefPeek?.(Number(b.getAttribute('data-ref')), b, 'focus');
    };
    const onFocusOut = (e: Event) => {
      const b = bubbleOf(e.composedPath());
      if (b) handlers.current.onRefPeek?.(null, b, 'focus');
    };
    const openBubble = (b: HTMLElement) => {
      const n = Number(b.getAttribute('data-ref'));
      const ref = (handlers.current.refs ?? []).find((r) => r.n === n);
      if (!ref) return;
      if ((ref.kind !== 'pr' && ref.kind !== 'link') || (handlers.current.onRefPeek && ref.images?.length)) handlers.current.onRefOpen?.(n);
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
        // A tap has no hover: the first shows the bubble; the host opens it from there.
        if (lastPointer === 'touch' && handlers.current.onRefPeek) {
          (b as HTMLElement).blur?.();
          handlers.current.onRefPeek(Number(b.getAttribute('data-ref')), b, 'tap');
        }
        else openBubble(b);
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
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.addEventListener('mouseup', onUp);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
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
      className={`shp-drawn${canvas ? ' canvas' : ''}${useTall ? ' tall' : ''}${pan ? ' pan' : ''}`}
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
  marks,
  stale,
  tags,
}: {
  drawn: ShapeDrawnView;
  refs?: readonly ShapeRef[];
  onCode?: ShapeDrawnProps['onCode'];
  onRefOpen?: (ref: ShapeRef) => void;
  resolveSrc?: (src: string) => string;
  /** Draw in on mount. Default true (reduced motion: a short fade). */
  animate?: boolean;
  className?: string;
  /** Marks on parts by `data-mark` id (ShapeDrawn's): `noted` rings a part (you are here), `fresh` redraws one. Default none. */
  marks?: MarkState;
  /** Parts whose code changed since the drawing was made. Default none. */
  stale?: ReadonlySet<string>;
  /** Words on tagged parts (ShapeDrawn's `tags`). Default none. */
  tags?: ShapeDrawnProps['tags'];
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
        {...(marks ? { marks } : {})}
        {...(stale ? { stale } : {})}
        {...(tags ? { tags } : {})}
      />
    </div>
  );
}
