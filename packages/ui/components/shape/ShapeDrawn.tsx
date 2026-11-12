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
import { parseCssColor } from '../../utils/cssColor';
import { readThemeTokenValues } from '../../utils/themeTokens';
import { SHAPE_COLOR_NAMES, shapeContrastFixes, shapeLogoFill, type ShapeColors } from './shapeContrast';
import { syncKeptBoxes, type KeptBox } from './boxSelect';
import { SHAPE_SHARP_COLOR_NAMES, shapeSharpFixes, type ShapeSharpColors } from './sharpContrast';
import { holdDarkBoard, releaseDarkBoard } from './darkContrast';
import { ScenePlayers } from './scene/ScenePlayers';
import type { ShapeScene } from '@plannotator/core/shape-scene';

function holdShapeContrast(board: HTMLElement): () => void {
  const undo: (() => void)[] = [];
  const read = readThemeTokenValues(SHAPE_COLOR_NAMES, board);
  const colors = {} as ShapeColors;
  for (const name of SHAPE_COLOR_NAMES) {
    const c = parseCssColor(read?.[name]);
    if (!c) return () => {};
    colors[name] = c;
  }
  const fixes = shapeContrastFixes(colors);
  for (const [name, value] of Object.entries(fixes)) {
    board.style.setProperty(name, value);
    undo.push(() => board.style.removeProperty(name));
  }
  for (const el of board.querySelectorAll<SVGElement>('svg[data-brand] [fill]')) {
    const logo = parseCssColor(el.getAttribute('fill'));
    const fill = logo && logo.a > 0 ? shapeLogoFill(logo, colors, fixes) : null;
    if (!fill) continue;
    el.style.setProperty('fill', fill);
    undo.push(() => el.style.removeProperty('fill'));
  }
  return () => undo.forEach((u) => u());
}

function holdSharpLines(board: HTMLElement): () => void {
  const read = readThemeTokenValues(SHAPE_SHARP_COLOR_NAMES, board);
  const colors = {} as ShapeSharpColors;
  for (const name of SHAPE_SHARP_COLOR_NAMES) {
    const c = parseCssColor(read?.[name]);
    if (!c) return () => {};
    colors[name] = c;
  }
  const fixes = shapeSharpFixes(colors);
  for (const [name, value] of Object.entries(fixes)) board.style.setProperty(name, value);
  return () => {
    for (const name of Object.keys(fixes)) board.style.removeProperty(name);
  };
}

const SHARP_INPUTS = SHAPE_SHARP_COLOR_NAMES.filter((name) => !name.startsWith('shp-')).map((name) => `--${name}`);
function sharpInputs(board: HTMLElement): string {
  const cs = getComputedStyle(board);
  return SHARP_INPUTS.map((name) => cs.getPropertyValue(name).trim()).join('|');
}

function resolveFiles(html: string, resolve: ((src: string) => string) | undefined, tile = false): string {
  if (!resolve && !tile) return html;
  const attr = (url: string) => url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return html.replace(/(<(?:img|image)\b)([^>]*?\s(?:src|href)=")(files\/[^"]+)"/gi, (_, open: string, head: string, src: string) => `${open}${tile ? ' data-shp-pic' : ''}${head}${resolve ? attr(resolve(src)) : src}"`);
}

export interface MarkState {
  fresh: ReadonlySet<string>;
  erasing: ReadonlySet<string>;
  noted: ReadonlySet<string>;
}

const TAG_ROOM = 28;
const tagPads = new WeakMap<HTMLElement, string>();

export const NO_MARKS: MarkState = { fresh: new Set(), erasing: new Set(), noted: new Set() };

const SHARP = '.board[data-shp-style="sharp"]';
const SHARP_ZONE = ':not(.line, .ink, .grey, .acc, .alert, .acc-fill)';
const softIs = (zone: string) => `:is([style*="--${zone}-soft"], [fill*="--${zone}-soft"])`;
const SHAPE_SHARP_CSS = `
/* Sharp: thin lines, small corners, quiet zones with a thin edge, filled heads. */
${SHARP} {
  --shp-r: 3px;
  --shp-hair: color-mix(in oklab, var(--ink) 52%, var(--paper));
  --shp-wire: color-mix(in oklab, var(--ink) 64%, var(--paper));
  --blue-soft: color-mix(in oklab, #2f6fb0 6%, var(--paper));
  --amber-soft: color-mix(in oklab, #d9971f 7%, var(--paper));
  --green-soft: color-mix(in oklab, #2b8a57 6%, var(--paper));
  --plum-soft: color-mix(in oklab, #9b3f78 6%, var(--paper));
  --alert-soft: color-mix(in oklab, var(--destructive) 8%, var(--paper));
  --shp-zone-blue: color-mix(in oklab, var(--blue) 82%, var(--paper));
  --shp-zone-amber: color-mix(in oklab, var(--amber) 82%, var(--paper));
  --shp-zone-green: color-mix(in oklab, var(--green) 82%, var(--paper));
  --shp-zone-plum: color-mix(in oklab, var(--plum) 82%, var(--paper));
  --shp-zone-alert: var(--alert);
}
${SHARP} svg :is(.line, .grey, .acc, .alert, .ink, .acc-fill) { stroke-width: 1px; vector-effect: non-scaling-stroke; stroke-linecap: butt; stroke-linejoin: miter; }
${SHARP} svg .dash { stroke-dasharray: 5 4; }
${SHARP} svg :is(rect, circle, ellipse, polygon):is(.line, .ink) { stroke: var(--shp-hair); }
${SHARP} svg :is(path, line, polyline).line { stroke: var(--shp-wire); }
${SHARP} svg rect:is(.line, .ink, .grey, .acc, .alert, .acc-fill) { rx: var(--shp-r); ry: var(--shp-r); }
/* The kit's arrowhead: closed, filled in its line's colour. */
${SHARP} svg path.shp-head:is(.line, .grey, .acc, .alert) { stroke: none; }
${SHARP} svg .shp-head.line { fill: var(--shp-wire); } ${SHARP} svg .shp-head.grey { fill: var(--grey); } ${SHARP} svg .shp-head.acc { fill: var(--mark); } ${SHARP} svg .shp-head.alert { fill: var(--alert); }
/* A zone: a rect the drawing fills with a -soft colour. Small corners, and a 1 px edge in its hue. */
${SHARP} svg rect${SHARP_ZONE}:is([style*="-soft"], [fill*="-soft"]) { rx: var(--shp-r); ry: var(--shp-r); stroke-width: 1px; vector-effect: non-scaling-stroke; }
${['blue', 'amber', 'green', 'plum', 'alert'].map((z) => `${SHARP} svg rect${SHARP_ZONE}${softIs(z)} { stroke: var(--shp-zone-${z}); }`).join('\n')}
/* darkContrast's zone edge (a shape it found with no line of its own), as thin as the rest. */
${SHARP}.dark-hold [data-shp-edge] { stroke-width: 1px; vector-effect: non-scaling-stroke; box-shadow: inset 0 0 0 1px var(--shp-edge); }
/* darkContrast's light tile behind a kept picture: the same small corner. */
${SHARP}.dark-hold .shp-pic-tile { rx: var(--shp-r); ry: var(--shp-r); }
${SHARP}.dark-hold img[data-shp-pic] { border-radius: var(--shp-r); }
/* Chips, cards, tiles, stickies, pictures, drawn things and path pills: the same corner, the same hairline. */
${SHARP} svg .tag rect { rx: 2px; ry: 2px; stroke-width: 1px; vector-effect: non-scaling-stroke; }
${SHARP} svg .tag rect[stroke-dasharray] { stroke-dasharray: 5 4; }
${SHARP} svg :is(rect.obj, .obj rect) { rx: var(--shp-r); ry: var(--shp-r); stroke-width: 1px; vector-effect: non-scaling-stroke; }
${SHARP} svg .obj { filter: none; }
${SHARP} svg svg[data-draw] [stroke-width] { stroke-width: 1.25px; vector-effect: non-scaling-stroke; }
${SHARP} svg svg[data-draw] rect { rx: 2px; ry: 2px; }
${SHARP} svg svg[data-icon] { stroke-width: 1.5; }
/* Follow an example's light over a line (followPainter): as thin as the line, a touch heavier so it reads. */
${SHARP} svg .shp-ex-lit { stroke-width: 1.5px; vector-effect: non-scaling-stroke; stroke-linecap: butt; stroke-linejoin: miter; }
${SHARP} .pick { border-radius: 3px; border-width: 1px; }
${SHARP} .mk { border-radius: 2px; }
`;

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
/* darkContrast, on a dark board only (.dark-hold, set by holdDarkBoard): a zone with no line of its own gets an edge in its hue, and a kept picture sits on a light tile. A light board gets none of it. */
.board.dark-hold [data-shp-edge] { stroke-width: 1.5px; box-shadow: inset 0 0 0 1.5px var(--shp-edge); }
.board.dark-hold [data-shp-edge="blue"] { stroke: var(--shp-edge-blue); --shp-edge: var(--shp-edge-blue); }
.board.dark-hold [data-shp-edge="amber"] { stroke: var(--shp-edge-amber); --shp-edge: var(--shp-edge-amber); }
.board.dark-hold [data-shp-edge="green"] { stroke: var(--shp-edge-green); --shp-edge: var(--shp-edge-green); }
.board.dark-hold [data-shp-edge="plum"] { stroke: var(--shp-edge-plum); --shp-edge: var(--shp-edge-plum); }
.board.dark-hold [data-shp-edge="alert"] { stroke: var(--shp-edge-alert); --shp-edge: var(--shp-edge-alert); }
.board.dark-hold .shp-pic-tile { fill: #e4e6ea; stroke: none; }
.board.dark-hold img[data-shp-pic] { background: #e4e6ea; padding: 6px; border-radius: 10px; box-sizing: border-box; object-fit: contain; }
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
${SHAPE_SHARP_CSS}
`;

let purifier: ReturnType<typeof DOMPurify> | null | undefined;
const PROOF_INPUT =
  '<b onclick="x()">kept</b><script>x()</script><img src="https:evil.invalid/i.png"><img srcset="https://evil.invalid/s.png 2x"><i style="background:u\\72l(//evil.invalid/a)">i</i><style>p{}</style>';
const PROOF_FAILED = /onclick|<script|evil\.invalid|<style|srcset/i;
const CONFIG = {
  ADD_TAGS: ['foreignObject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true },
  ADD_ATTR: ['pathLength', 'target'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'form', 'template', 'source', 'animate', 'set', 'animateMotion', 'animateTransform', 'dialog', 'select', 'area', 'map'],
  FORBID_ATTR: [...SHAPE_DROPPED_ATTRS, ...SHAPE_TOP_LAYER_ATTRS],
};
const WORDS_ONLY = /^(?:data-|aria-)|^(?:title|alt|class|id|role|lang|dir)$/;

function attributeAllowed(tag: string, name: string, value: string): boolean {
  if (SHAPE_DROPPED_ATTRS.includes(name) || SHAPE_TOP_LAYER_ATTRS.includes(name)) return false;
  if (SHAPE_URL_ATTRS.includes(name)) {
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

export function sanitizeShapeHtml(html: string): string {
  const p = sanitizer();
  return p ? p.sanitize(shapeKeepSvgWhole(html), CONFIG) : '';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const UNDRAWN = new Set(['defs', 'symbol', 'clippath', 'mask', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'filter']);
const drawnWords = (root: Element): Element[] =>
  [root, ...root.querySelectorAll('text')].filter((t) => {
    if (t.localName !== 'text') return false;
    for (let at: Element | null = t; at && at.namespaceURI === SVG_NS; at = at.parentElement) if (UNDRAWN.has(at.localName.toLowerCase())) return false;
    return true;
  });

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
  phase?: 'entering' | 'drawn' | 'leaving';
  skip?: boolean;
  reduce?: boolean;
  refs?: readonly ShapeRef[];
  refHover?: number | null;
  refFlash?: number | null;
  onRefHover?: (n: number | null) => void;
  onRefOpen?: (n: number) => void;
  pan?: boolean;
  top?: boolean;
  onRefPeek?: (n: number | null, el: HTMLElement, how: 'hover' | 'focus' | 'tap') => void;
  onCode?: (target: ShapeCodeTarget, el: HTMLElement) => void;
  resolveSrc?: (src: string) => string;
  darkContrast?: boolean;
  pinpoint?: boolean;
  select?: boolean;
  marks?: MarkState;
  stale?: ReadonlySet<string>;
  tags?: { fresh?: string; stale?: string };
  boxable?: boolean;
  boxes?: readonly KeptBox[];
  onHoverMark?: (el: HTMLElement | null) => void;
  onPickMark?: (el: HTMLElement, text?: string) => void;
  onBoard?: (board: HTMLElement | null) => void;
  scenes?: Readonly<Record<string, ShapeScene>>;
  sceneLook?: 'technical';
}

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
const PAN_FADE = 28;
const PAN_TRACK = 56;
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
  const pan = !!props.pan && scaled && narrow;
  const k = scaled && fit ? Math.max(pan ? 0.55 : 0.2, Math.min(fit.w / drawn.width!, fit.h > 40 ? fit.h / drawn.height! : Infinity, 1.08)) : 1;
  const [contentKey, setContentKey] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = rootRef.current ?? host.attachShadow({ mode: 'open' });
    rootRef.current = root;
    const safeCss = shapeCssProblems(css).length ? '' : css;
    root.innerHTML = `<style>${SHAPE_FRAME_CSS}\n${safeCss}</style><div class="board${scaled ? ' canvas' : ''}${handlers.current.onRefPeek ? ' peek' : ''}" data-shp-style="sharp">${resolveFiles(sanitizeShapeHtml(html), handlers.current.resolveSrc, !!handlers.current.darkContrast)}</div>`;
    const board = root.querySelector<HTMLElement>('.board')!;
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

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const track = trackRef.current;
    if (!frame || !track || !pan) return;
    const fit = frame.querySelector<HTMLElement>('.shp-drawn-fit');
    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth, clientHeight } = frame;
      const below = fit ? fit.offsetTop + fit.offsetHeight : 0;
      const more = scrollWidth - clientWidth;
      track.hidden = more <= 1;
      frame.style.setProperty('--shp-fl', scrollLeft > 1 ? `${PAN_FADE}px` : '0px');
      frame.style.setProperty('--shp-fr', scrollLeft < more - 1 ? `${PAN_FADE}px` : '0px');
      track.style.left = `${scrollLeft + (clientWidth - PAN_TRACK) / 2}px`;
      track.style.top = `${Math.max(below, Math.min(below + 12, clientHeight - 4))}px`;
      const thumb = track.firstElementChild as HTMLElement | null;
      if (thumb && scrollWidth) {
        thumb.style.width = `${(clientWidth / scrollWidth) * 100}%`;
        thumb.style.left = `${(scrollLeft / scrollWidth) * 100}%`;
      }
    };
    update();
    frame.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(frame);
    if (fit) ro?.observe(fit);
    return () => {
      frame.removeEventListener('scroll', update);
      ro?.disconnect();
      frame.style.removeProperty('--shp-fl');
      frame.style.removeProperty('--shp-fr');
    };
  }, [pan, k]);

  const darkContrast = !!props.darkContrast;
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    let undoPalette = () => {};
    const release = () => {
      releaseDarkBoard(board);
      undoPalette();
      undoPalette = () => {};
    };
    const hold = () => {
      release();
      undoPalette = holdShapeContrast(board);
      if (darkContrast) holdDarkBoard(board);
    };
    const tokens = () => {
      const cs = getComputedStyle(board);
      return ['--shp-paper', '--background', '--foreground', '--card', '--border', '--muted-foreground', '--primary', '--destructive'].map((t) => cs.getPropertyValue(t)).join('|');
    };
    let key = tokens();
    hold();
    if (typeof MutationObserver === 'undefined') return release;
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const now = tokens();
        if (now === key) return;
        key = now;
        hold();
      });
    };
    const watch = new MutationObserver(again);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    scheme?.addEventListener?.('change', again);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
      scheme?.removeEventListener?.('change', again);
      release();
    };
  }, [darkContrast, contentKey]);

  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    board.classList.toggle('entering', phase === 'entering');
    board.classList.toggle('skip', skip);
    board.classList.toggle('reduce', reduce);
    board.classList.toggle('pinpointing', pinpoint);
    board.classList.toggle('boxable', !!props.boxable);
  }, [phase, skip, reduce, pinpoint, props.boxable, contentKey]);

  const boxes = props.boxes;
  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (board && boxes) syncKeptBoxes(board, boxes.filter((b) => !!b.box.tall === useTall), scaled ? k : 1);
  }, [boxes, useTall, scaled, k, contentKey]);

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
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
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

  useLayoutEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('.board');
    if (!board) return;
    let undo = holdSharpLines(board);
    if (typeof MutationObserver === 'undefined') return undo;
    let key = sharpInputs(board);
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const now = sharpInputs(board);
        if (now === key) return;
        key = now;
        undo();
        undo = holdSharpLines(board);
      });
    };
    const watch = new MutationObserver(again);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    scheme?.addEventListener?.('change', again);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
      scheme?.removeEventListener?.('change', again);
      undo();
    };
  }, [darkContrast, contentKey]);

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
        if (lastPointer === 'touch' && handlers.current.onRefPeek) {
          (b as HTMLElement).blur?.();
          handlers.current.onRefPeek(Number(b.getAttribute('data-ref')), b, 'tap');
        }
        else openBubble(b);
        return;
      }
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

  return (
    <div
      ref={frameRef}
      className={`shp-drawn${canvas ? ' canvas' : ''}${useTall ? ' tall' : ''}${pan ? ' pan' : ''}${canvas && props.top ? ' top' : ''}`}
      style={FRAME_CONTAIN}
      onPointerLeave={() => props.onHoverMark?.(null)}
    >
      <div className="shp-drawn-fit" style={scaled && fit ? { width: drawn.width! * k, height: drawn.height! * k } : undefined}>
        <div ref={hostRef} className="shp-drawn-host" />
      </div>
      {pan && (
        <div ref={trackRef} className="shp-pan-track" aria-hidden="true">
          <i />
        </div>
      )}
      {props.scenes && <ScenePlayers board={rootRef.current?.querySelector<HTMLElement>('.board') ?? null} drawnKey={contentKey} scenes={props.scenes} reduce={reduce} look={props.sceneLook} />}
    </div>
  );
}

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
  animate?: boolean;
  className?: string;
  marks?: MarkState;
  stale?: ReadonlySet<string>;
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
