import { lineOf, thingsOf, type Thing } from './reading';
import { boxGap as boxGapOf, boxOf, boxesOverlap, centerOf, COLOR_NAMES, unionBox, type Box, type CanvasElement, type CanvasScene } from './scene';

/**
 * An agent's changes to a canvas, by intent: "add a box right of the gateway",
 * never coordinates it has to work out. One call is all or nothing: every bad
 * change is listed in one answer and the canvas stays as it was.
 *
 * Pure: the scene goes in, a new scene comes out. The caller (the Inbox
 * server) decides whether it may land (someone else may have changed the same
 * things since the agent last looked) and stores it.
 */
export type CanvasOp = Record<string, unknown>;

export interface ApplyContext {
  /** Who is changing the canvas; kept on what it adds (`customData.by`). */
  by: string;
  now: number;
  random?: () => number;
  /** Mermaid text → the Excalidraw elements an open Inbox window made of it. Absent for a diagram nobody converted. */
  mermaid?: Map<string, CanvasElement[]>;
}

export interface ApplyResult {
  ok: boolean;
  scene: CanvasScene;
  /** One line per change that was made, in order. */
  done: string[];
  /** One line per change that cannot be made. Any line here means nothing changed. */
  errors: string[];
  /** Elements that were there before and are now changed or removed. */
  touched: Set<string>;
  /** Elements this call added. */
  added: Set<string>;
  /**
   * The elements of the things a change named to overwrite, move, remove, replace or frame. These are what the agent
   * must have been shown; what only followed along (an arrow rerouted, a frame that grew) is in `touched` alone.
   */
  direct: Set<string>;
}

const PLACES = ['near', 'rightOf', 'leftOf', 'above', 'below', 'in'] as const;
type Place = (typeof PLACES)[number];
const ADD_KINDS = ['box', 'ellipse', 'diamond', 'note', 'text', 'frame', 'mermaid'];
const GAP = 110;
/** How far from what is on the canvas an agent may place a thing by coordinates. */
const AT_REACH = 20_000;
const FONT = 20;
const LINE = 25;
// Wider than the hand-drawn face really is: a label measured too narrow is cut off, one too wide only sits centred.
const CHAR = 12.5;

export class RefError extends Error {}

const FILLER = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'about', 'with', 'and', 'that', 'this', 'one', 'thing', 'called', 'named', 'labelled', 'labeled', 'saying', 'says']);
const KIND_WORDS: Record<string, string[]> = {
  box: ['box', 'rectangle', 'card'],
  note: ['note', 'sticky'],
  frame: ['frame', 'section'],
  arrow: ['arrow', 'connector', 'connection'],
  line: ['line'],
  text: ['text', 'label', 'words'],
  sketch: ['sketch', 'drawing', 'doodle', 'scribble'],
  picture: ['picture', 'image', 'photo', 'screenshot'],
  diamond: ['diamond', 'decision'],
  ellipse: ['ellipse', 'circle', 'oval'],
};

export interface ResolveOptions {
  /** A change that overwrites or removes: only an id or a thing's whole words name it, never a loose match. */
  exact?: boolean;
  /** How a loose name was read, for the answer ("'failing tests' read as ab12"). */
  notes?: string[];
}

/**
 * The one thing a name means: its id, the start of its id, or its words. Never a guess between two. Words may be
 * loose (part of the thing's words, in any order, with a kind word such as "note" or "frame") only when exactly one
 * thing fits, and the answer says how the name was read.
 */
export function resolveThing(ref: unknown, things: Thing[], scene: CanvasScene, options: ResolveOptions = {}): Thing {
  if (typeof ref !== 'string' || !ref.trim()) throw new RefError('name a thing by its id or its words');
  const name = ref.trim();
  const lower = name.toLowerCase();
  const list = (found: Thing[]) => found.slice(0, 6).map((t) => `  ${lineOf(t, scene, things)}`).join('\n');
  // A thing's whole words come first, before anything that could read the name as an id.
  const same = things.filter((t) => t.words.toLowerCase() === lower);
  if (same.length === 1) return same[0]!;
  if (same.length > 1) throw new RefError(`${JSON.stringify(name)} is the words of ${same.length} things; name one by its id:\n${list(same)}`);
  // An id is the whole id, as the reading prints it (or the element's own full id). Never the start of one.
  const byId = things.filter((t) => t.id === name || t.elementIds.includes(name));
  if (byId.length === 1) return byId[0]!;
  // Loose: part of its words, or its words in any order, with a kind word standing for the kind.
  const holds = things.filter((t) => t.words && t.words.toLowerCase().includes(lower));
  let loose = holds;
  if (loose.length === 0) {
    const words = lower.split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w));
    const kinds = new Set<string>();
    const rest = words.filter((w) => {
      const kind = Object.keys(KIND_WORDS).find((k) => KIND_WORDS[k]!.includes(w) || KIND_WORDS[k]!.includes(w.replace(/s$/, '')));
      if (kind) kinds.add(kind);
      return !kind;
    });
    const isNote = (t: Thing) => t.kind === 'box' && t.fill === 'yellow';
    const ofKind = (t: Thing) => kinds.size === 0 || kinds.has(t.kind) || (kinds.has('note') && isNote(t));
    if (rest.length > 0 || kinds.size > 0) {
      loose = things.filter((t) => ofKind(t) && rest.every((w) => t.words.toLowerCase().includes(w)) && (rest.length > 0 || t.kind !== 'arrow'));
    }
  }
  if (loose.length === 1 && !options.exact) {
    const thing = loose[0]!;
    options.notes?.push(`${JSON.stringify(name)} read as ${thing.id}${thing.words ? ` ${JSON.stringify(thing.words.slice(0, 60))}` : ''}`);
    return thing;
  }
  if (loose.length >= 1 && options.exact) {
    throw new RefError(`${JSON.stringify(name)} is neither an id nor a thing's whole words, and a change that overwrites or removes takes only those. ${loose.length === 1 ? 'It looks like this one; name it by its id' : 'Name one by its id'}:\n${list(loose)}`);
  }
  if (loose.length > 1) throw new RefError(`${JSON.stringify(name)} fits ${loose.length} things; name one by its id:\n${list(loose)}`);
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !FILLER.has(w));
  const close = things.filter((t) => words.some((w) => t.words.toLowerCase().includes(w)));
  throw new RefError(`nothing on the canvas is called ${JSON.stringify(name)}${close.length ? `; closest:\n${list(close)}` : ' (read the canvas to see what is there)'}`);
}

interface Work {
  scene: CanvasScene;
  ctx: ApplyContext;
  touched: Set<string>;
  added: Set<string>;
  direct: Set<string>;
  original: Set<string>;
  rand: () => number;
  /** What the board decided for the change being made (how a name was read, which side, a frame that grew): said after its line. */
  notes: string[];
  /** The things of the scene as it is now, read once and again only after a change (reading them costs time on a large canvas). */
  things: Thing[] | null;
}

function thingsNow(work: Work): Thing[] {
  return (work.things ??= thingsOf(work.scene));
}

function newId(work: Work): string {
  const letters = 'abcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    let id = '';
    for (let i = 0; i < 8; i++) id += letters[Math.floor(work.rand() * letters.length)];
    if (!work.scene.elements.some((e) => e.id === id || e.id.startsWith(id.slice(0, 4)))) return id;
  }
}

function base(work: Work, type: string, box: Box, extra: Partial<CanvasElement> = {}): CanvasElement {
  const el: CanvasElement = {
    id: newId(work),
    type,
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.w),
    height: Math.round(box.h),
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: Math.floor(work.rand() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(work.rand() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: work.ctx.now,
    link: null,
    locked: false,
    customData: { by: work.ctx.by },
    ...extra,
  };
  work.scene.elements.push(el);
  work.added.add(el.id);
  work.things = null;
  return el;
}

/** Record a change to an element that was already there. */
function touch(work: Work, el: CanvasElement, change: Partial<CanvasElement>): void {
  Object.assign(el, change);
  work.things = null;
  el.version = (el.version ?? 1) + 1;
  el.versionNonce = Math.floor(work.rand() * 2 ** 31);
  el.updated = work.ctx.now;
  if (work.original.has(el.id)) work.touched.add(el.id);
}

/** Wide characters (Chinese, Japanese, Korean, full-width forms) take two columns; marks that sit on a letter take none. */
function columns(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || c === 0xfeff) continue;
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300 ? 2 : 1;
  }
  return n;
}

/** Lines no wider than `maxChars` columns. A word longer than a line (and text with no spaces, as Chinese has none) breaks inside. */
function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const push = (word: string, line: string): string => {
    if (columns(word) <= maxChars) return word;
    let part = line ? '' : '';
    for (const ch of word) {
      if (columns(part + ch) > maxChars) {
        out.push(part);
        part = ch;
      } else part += ch;
    }
    return part;
  };
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && columns(`${line} ${word}`) > maxChars) {
        out.push(line);
        line = push(word, '');
      } else if (!line) line = push(word, '');
      else line = `${line} ${word}`;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

function textSize(lines: string[]): { w: number; h: number } {
  return { w: Math.max(10, Math.ceil(Math.max(...lines.map(columns)) * CHAR)), h: lines.length * LINE };
}

function textElement(work: Work, words: string, box: Box, extra: Partial<CanvasElement> = {}): CanvasElement {
  return base(work, 'text', box, {
    text: words,
    originalText: words,
    fontSize: FONT,
    fontFamily: 5,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
    ...extra,
  });
}

function label(work: Work, container: CanvasElement, words: string, at: [number, number]): CanvasElement {
  // An arrow's words fit along it, between the two things; a shape's words fit inside it (a diamond or an ellipse holds about half its width).
  const run = container.type === 'arrow' ? Math.hypot(container.width, container.height) * 0.62 : (Math.abs(container.width) - 20) * (container.type === 'diamond' ? 0.5 : container.type === 'ellipse' ? 0.7 : 1);
  const lines = wrap(words, Math.max(6, Math.floor(run / CHAR)));
  const size = textSize(lines);
  const el = textElement(work, lines.join('\n'), { x: at[0] - size.w / 2, y: at[1] - size.h / 2, w: size.w, h: size.h }, {
    originalText: words,
    containerId: container.id,
    frameId: container.frameId ?? null,
  });
  container.boundElements = [...(container.boundElements ?? []).filter((b) => b.type !== 'text'), { id: el.id, type: 'text' }];
  return el;
}

function colors(name: unknown): { stroke: string; fill: string } | null {
  if (name === undefined || name === null || name === '') return null;
  if (typeof name !== 'string') throw new RefError(`"color" is one of ${Object.keys(COLOR_NAMES).join(', ')}`);
  const key = name.toLowerCase().trim();
  const alias: Record<string, string> = { warning: 'yellow', amber: 'yellow', danger: 'red', error: 'red', ok: 'green', success: 'green', purple: 'violet', grey: 'gray', info: 'blue' };
  const found = COLOR_NAMES[alias[key] ?? key];
  if (!found) throw new RefError(`no colour ${JSON.stringify(name)}; use one of ${Object.keys(COLOR_NAMES).join(', ')}`);
  return found;
}

function elementsOf(work: Work, thing: Thing): CanvasElement[] {
  const ids = new Set(thing.elementIds);
  return work.scene.elements.filter((e) => ids.has(e.id) && !e.isDeleted);
}

/** A frame's thing and everything it holds, or the thing alone. */
function withContents(work: Work, thing: Thing): CanvasElement[] {
  if (thing.kind !== 'frame') return elementsOf(work, thing);
  const frameEl = elementsOf(work, thing)[0];
  const held = work.scene.elements.filter((e) => !e.isDeleted && frameEl && e.frameId === frameEl.id);
  return [...elementsOf(work, thing), ...held];
}

function obstacles(work: Work, ignore: Set<string>): Box[] {
  return work.scene.elements
    .filter((e) => !e.isDeleted && e.type !== 'frame' && e.type !== 'arrow' && e.type !== 'line' && !ignore.has(e.id) && !(e.type === 'text' && e.containerId))
    .map(boxOf);
}

type Segment = [number, number, number, number];

/** Every stretch of every arrow and line, so a new thing never sits on a connector. */
function connectorLines(work: Work, ignore: Set<string>): Segment[] {
  const out: Segment[] = [];
  for (const el of work.scene.elements) {
    if (el.isDeleted || (el.type !== 'arrow' && el.type !== 'line') || ignore.has(el.id)) continue;
    // An arrow attached to what is being moved follows it: not in the way.
    if ((el.startBinding && ignore.has(el.startBinding.elementId)) || (el.endBinding && ignore.has(el.endBinding.elementId))) continue;
    const points = el.points ?? [];
    for (let i = 1; i < points.length; i++) out.push([el.x + points[i - 1]![0]!, el.y + points[i - 1]![1]!, el.x + points[i]![0]!, el.y + points[i]![1]!]);
  }
  return out;
}

function crosses([x1, y1, x2, y2]: Segment, box: Box, margin = 8): boolean {
  const left = box.x - margin, right = box.x + box.w + margin, top = box.y - margin, bottom = box.y + box.h + margin;
  // Liang-Barsky: does any part of the segment lie inside the box?
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - left], [dx, right - x1], [-dy, y1 - top], [dy, bottom - y1]] as [number, number][]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function isFree(box: Box, taken: Box[], lines: Segment[] = []): boolean {
  return !taken.some((o) => boxesOverlap(o, box, 12)) && !lines.some((line) => crosses(line, box));
}

function frameAt(work: Work, box: Box): CanvasElement | undefined {
  const [cx, cy] = centerOf(box);
  return work.scene.elements.find((e) => !e.isDeleted && e.type === 'frame' && cx >= e.x && cx <= e.x + e.width && cy >= e.y && cy <= e.y + e.height);
}

/** Grow a frame so it holds a box with room to spare. */
function growFrame(work: Work, frame: CanvasElement, box: Box): void {
  const pad = 24;
  const right = Math.max(frame.x + frame.width, box.x + box.w + pad);
  const bottom = Math.max(frame.y + frame.height, box.y + box.h + pad);
  const left = Math.min(frame.x, box.x - pad);
  const top = Math.min(frame.y, box.y - pad);
  if (left !== frame.x || top !== frame.y || right !== frame.x + frame.width || bottom !== frame.y + frame.height) {
    touch(work, frame, { x: left, y: top, width: right - left, height: bottom - top });
    const name = thingsNow(work).find((t) => t.elementIds.includes(frame.id));
    const note = `frame ${name?.id ?? frame.id} grew to ${Math.round(right - left)}x${Math.round(bottom - top)} to hold it; nothing else moved`;
    if (!work.notes.includes(note)) work.notes.push(note);
  }
}

interface Spot {
  box: Box;
  frame?: CanvasElement;
}

/** Where a new or moved thing of a size goes, from the op's placement words. Always a free spot. */
function findSpot(work: Work, op: CanvasOp, size: { w: number; h: number }, ignore: Set<string>, fallback?: Box): Spot {
  const things = thingsNow(work);
  const taken = obstacles(work, ignore);
  const lines = connectorLines(work, ignore);
  if (op.at !== undefined) {
    const at = op.at as unknown;
    if (!Array.isArray(at) || at.length !== 2 || !at.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new RefError('"at" is [x, y]');
    const box = { x: at[0] as number, y: at[1] as number, w: size.w, h: size.h };
    // Somewhere a person would ever find it: on the board's own ground, not a continent away.
    const ground = unionBox(taken);
    const far = taken.length === 0 ? Math.max(Math.abs(box.x), Math.abs(box.y)) > AT_REACH : boxGapOf(ground, box) > AT_REACH;
    if (far) throw new RefError(`"at" [${at[0]}, ${at[1]}] is too far from ${taken.length === 0 ? 'the origin' : `what is on the canvas (around ${Math.round(ground.x)},${Math.round(ground.y)} ${Math.round(ground.w)}x${Math.round(ground.h)})`}: stay within ${AT_REACH} of it, or place by near, rightOf, leftOf, above, below`);
    return { box, frame: frameAt(work, box) };
  }
  const named = PLACES.filter((p) => op[p] !== undefined);
  if (named.length > 1) throw new RefError(`give one place, not ${named.join(' and ')}`);
  const place: Place | undefined = named[0];
  if (!place) {
    if (fallback) return { box: { x: fallback.x, y: fallback.y, w: size.w, h: size.h }, frame: frameAt(work, fallback) };
    // Nowhere said: under everything, at the left edge.
    const all = unionBox(taken);
    const box = taken.length === 0 ? { x: 0, y: 0, w: size.w, h: size.h } : { x: all.x, y: all.y + all.h + GAP, w: size.w, h: size.h };
    return { box };
  }
  const anchor = resolveThing(op[place], things, work.scene, { notes: work.notes });
  const a = anchor.box;
  if (place === 'in') {
    if (anchor.kind !== 'frame') throw new RefError(`"in" takes a frame; ${anchor.id} is a ${anchor.kind} (use near, rightOf, leftOf, above or below)`);
    const frame = elementsOf(work, anchor)[0]!;
    const pad = 24;
    const top = a.y + pad + 16;
    for (let y = top; y < a.y + Math.max(a.h, size.h + 80) + 4000; y += 20) {
      for (let x = a.x + pad; x + size.w <= a.x + Math.max(a.w, size.w + pad * 2) - pad + 1; x += 20) {
        const box = { x, y, w: size.w, h: size.h };
        if (isFree(box, taken, lines)) {
          work.notes.push(`inside ${anchor.id}`);
          return { box, frame };
        }
      }
    }
    return { box: { x: a.x + pad, y: top, w: size.w, h: size.h }, frame };
  }
  const tries: Place[] = place === 'near' ? ['rightOf', 'below', 'leftOf', 'above'] : [place];
  const at = (side: Place, step: number): Box => {
    // Room for an arrow's label between things side by side; less between rows.
    const d = (side === 'rightOf' || side === 'leftOf' ? GAP + 40 : GAP - 20) + step * 40;
    switch (side) {
      case 'rightOf':
        return { x: a.x + a.w + d, y: a.y + a.h / 2 - size.h / 2, w: size.w, h: size.h };
      case 'leftOf':
        return { x: a.x - d - size.w, y: a.y + a.h / 2 - size.h / 2, w: size.w, h: size.h };
      case 'above':
        return { x: a.x + a.w / 2 - size.w / 2, y: a.y - d - size.h, w: size.w, h: size.h };
      default:
        return { x: a.x + a.w / 2 - size.w / 2, y: a.y + a.h + d, w: size.w, h: size.h };
    }
  };
  if (place === 'near') {
    for (let ring = 1; ring <= 12; ring++) {
      const cells: [number, number][] = [];
      if (ring === 1) cells.push([1, 0], [0, 1], [-1, 0], [0, -1]);
      else for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) cells.push([dx, dy]);
      {
        for (const [dx, dy] of cells) {
          // The first ring is the four sides (right, below, left, above), as before; then the corners and outward.
          const box = {
            x: a.x + a.w / 2 - size.w / 2 + dx * (Math.max(a.w, size.w) / 2 + size.w / 2 + 50),
            y: a.y + a.h / 2 - size.h / 2 + dy * (Math.max(a.h, size.h) / 2 + size.h / 2 + 50),
            w: size.w,
            h: size.h,
          };
          if (!isFree(box, taken, lines)) continue;
          const home = anchor.frame ? things.find((t) => t.id === anchor.frame) : undefined;
          const where = dx === 0 ? (dy < 0 ? 'above' : 'below') : dy === 0 ? (dx < 0 ? 'left of' : 'right of') : `${dy < 0 ? 'above' : 'below'} and ${dx < 0 ? 'left of' : 'right of'}`;
          work.notes.push(`near put it ${where} ${anchor.id}; rightOf, leftOf, above or below picks a side`);
          return { box, frame: home ? elementsOf(work, home)[0] : frameAt(work, box) };
        }
      }
    }
  }
  for (let step = 0; step < 40; step++) {
    for (const side of tries) {
      const box = at(side, step);
      if (isFree(box, taken, lines)) {
        // Next to something in a frame stays in that frame (the frame grows to hold it).
        const home = anchor.frame ? things.find((t) => t.id === anchor.frame) : undefined;
        const sides: Record<string, string> = { rightOf: 'right of', leftOf: 'left of', above: 'above', below: 'below' };
        if (place === 'near') work.notes.push(`near put it ${sides[side]} ${anchor.id}; rightOf, leftOf, above or below picks a side`);
        else if (step > 0) work.notes.push(`${sides[side]} ${anchor.id}, further out to stay clear of what is there`);
        return { box, frame: home ? elementsOf(work, home)[0] : frameAt(work, box) };
      }
    }
  }
  return { box: at(tries[0]!, 0) };
}

function settle(work: Work, els: CanvasElement[], spot: Spot): void {
  if (!spot.frame) return;
  work.things = null;
  for (const el of els) el.frameId = spot.frame.id;
  growFrame(work, spot.frame, unionBox(els.map(boxOf)));
  // A frame draws over what it holds: it sits after its children.
  const list = work.scene.elements;
  const at = list.indexOf(spot.frame);
  const moved = els.filter((el) => list.indexOf(el) > at);
  if (moved.length) {
    for (const el of moved) list.splice(list.indexOf(el), 1);
    list.splice(list.indexOf(spot.frame), 0, ...moved);
  }
}

function edgePoint(box: Box, toward: [number, number], gap: number): [number, number] {
  const [cx, cy] = centerOf(box);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = box.w / 2 + gap;
  const hh = box.h / 2 + gap;
  const scale = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return [cx + dx * scale, cy + dy * scale];
}

function route(arrow: CanvasElement, from: Box, to: Box): Partial<CanvasElement> {
  const start = edgePoint(from, centerOf(to), 6);
  const end = edgePoint(to, centerOf(from), 6);
  const dx = Math.round(end[0] - start[0]);
  const dy = Math.round(end[1] - start[1]);
  return { x: Math.round(start[0]), y: Math.round(start[1]), width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]] };
}

/** Arrows attached to things that moved follow them. */
function reroute(work: Work, moved: Set<string>): void {
  const byId = new Map(work.scene.elements.map((e) => [e.id, e]));
  for (const arrow of work.scene.elements) {
    if (arrow.isDeleted || arrow.type !== 'arrow' || moved.has(arrow.id)) continue;
    const a = arrow.startBinding?.elementId;
    const b = arrow.endBinding?.elementId;
    if (!(a && moved.has(a)) && !(b && moved.has(b))) continue;
    const from = a ? byId.get(a) : undefined;
    const to = b ? byId.get(b) : undefined;
    const points = arrow.points ?? [];
    const first: [number, number] = [arrow.x, arrow.y];
    const last: [number, number] = [arrow.x + (points[points.length - 1]?.[0] ?? 0), arrow.y + (points[points.length - 1]?.[1] ?? 0)];
    const fromBox = from && !from.isDeleted ? boxOf(from) : { x: first[0], y: first[1], w: 0, h: 0 };
    const toBox = to && !to.isDeleted ? boxOf(to) : { x: last[0], y: last[1], w: 0, h: 0 };
    touch(work, arrow, route(arrow, fromBox, toBox));
    const text = work.scene.elements.find((e) => !e.isDeleted && e.type === 'text' && e.containerId === arrow.id);
    if (text) {
      const [cx, cy] = centerOf(boxOf(arrow));
      touch(work, text, { x: Math.round(cx - text.width / 2), y: Math.round(cy - text.height / 2) });
    }
  }
}

function remove(work: Work, els: CanvasElement[]): void {
  const gone = new Set(els.map((e) => e.id));
  for (const el of work.scene.elements) {
    if (el.isDeleted) continue;
    if (gone.has(el.id) || (el.type === 'text' && el.containerId && gone.has(el.containerId))) {
      gone.add(el.id);
      touch(work, el, { isDeleted: true });
    }
  }
  for (const el of work.scene.elements) {
    if (el.isDeleted) continue;
    const change: Partial<CanvasElement> = {};
    if (el.startBinding && gone.has(el.startBinding.elementId)) change.startBinding = null;
    if (el.endBinding && gone.has(el.endBinding.elementId)) change.endBinding = null;
    if (el.boundElements?.some((b) => gone.has(b.id))) change.boundElements = el.boundElements.filter((b) => !gone.has(b.id));
    if (el.frameId && gone.has(el.frameId)) change.frameId = null;
    if (Object.keys(change).length) touch(work, el, change);
  }
}

function text(value: unknown, field: string, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new RefError(`"${field}" is missing`);
    return '';
  }
  if (typeof value !== 'string') throw new RefError(`"${field}" is text`);
  if (value.length > 4000) throw new RefError(`"${field}" is longer than 4,000 characters`);
  // Characters nobody can see are not words.
  const seen = value.replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '');
  if (required && !seen.trim()) throw new RefError(`"${field}" has no words in it`);
  return seen;
}

function describe(work: Work, el: CanvasElement): string {
  const things = thingsNow(work);
  const thing = things.find((t) => t.elementIds.includes(el.id));
  return thing ? lineOf(thing, work.scene, things) : el.id;
}

function add(work: Work, op: CanvasOp, fallback?: Box): { line: string; box: Box } {
  const kind = op.add;
  if (typeof kind !== 'string' || !ADD_KINDS.includes(kind)) throw new RefError(`"add" is one of ${ADD_KINDS.join(', ')}`);
  const color = colors(op.color);
  if (kind === 'mermaid') {
    const source = text(op.text, 'text');
    const made = work.ctx.mermaid?.get(source);
    if (!made) throw new RefError('a mermaid diagram is drawn by an open Inbox window, and none answered; add boxes and connect them instead, or try again when the person has the Inbox open');
    if (made.length === 0) throw new RefError('that mermaid text draws nothing');
    const from = unionBox(made.map(boxOf));
    const spot = findSpot(work, op, { w: from.w, h: from.h }, new Set(), fallback);
    const ids = new Map(made.map((e) => [e.id, newId(work)]));
    const swap = (id: string | null | undefined) => (id ? ids.get(id) ?? id : id);
    const group = newId(work);
    const copies = made.map((e) => {
      const copy: CanvasElement = {
        ...e,
        id: ids.get(e.id)!,
        x: Math.round(e.x - from.x + spot.box.x),
        y: Math.round(e.y - from.y + spot.box.y),
        groupIds: [...(e.groupIds ?? []).map((g) => `${group}-${g}`), group],
        containerId: swap(e.containerId ?? null) ?? null,
        boundElements: e.boundElements ? e.boundElements.map((b) => ({ ...b, id: swap(b.id)! })) : null,
        startBinding: e.startBinding ? { ...e.startBinding, elementId: swap(e.startBinding.elementId)! } : null,
        endBinding: e.endBinding ? { ...e.endBinding, elementId: swap(e.endBinding.elementId)! } : null,
        frameId: null,
        index: null,
        version: 1,
        updated: work.ctx.now,
        customData: { ...(e.customData ?? {}), by: work.ctx.by, mermaid: true },
      };
      if (e.type !== 'text' && e.type !== 'arrow' && e.type !== 'line') delete copy.containerId;
      work.scene.elements.push(copy);
      work.added.add(copy.id);
      work.things = null;
      return copy;
    });
    settle(work, copies, spot);
    const shapes = copies.filter((e) => e.type !== 'text' && e.type !== 'arrow' && e.type !== 'line').length;
    const arrows = copies.filter((e) => e.type === 'arrow').length;
    return { line: `added a mermaid diagram at ${Math.round(spot.box.x)},${Math.round(spot.box.y)} ${Math.round(from.w)}x${Math.round(from.h)}: ${shapes} shapes, ${arrows} arrows (a group; each part can be edited)`, box: spot.box };
  }
  if (kind === 'frame') {
    const title = text(op.text ?? op.title, 'text', false);
    const size = sizeOf(op, { w: 480, h: 320 });
    const spot = findSpot(work, op, size, new Set(), fallback);
    const el = base(work, 'frame', spot.box, { name: title || null, strokeColor: '#bbb', customData: { by: work.ctx.by } });
    return { line: `added ${describe(work, el)}`, box: spot.box };
  }
  const words = text(op.text, 'text', kind === 'text' || kind === 'note');
  if (kind === 'text') {
    const lines = wrap(words, 48);
    const size = textSize(lines);
    const spot = findSpot(work, op, size, new Set(), fallback);
    const el = textElement(work, lines.join('\n'), spot.box, { originalText: words, textAlign: 'left', verticalAlign: 'top', ...(color ? { strokeColor: color.stroke } : {}) });
    settle(work, [el], spot);
    return { line: `added ${describe(work, el)}`, box: spot.box };
  }
  // Long words get a wider thing, so a long note is a block and not a strip.
  const wide = Math.min(64, Math.max(kind === 'note' ? 22 : 20, Math.ceil(Math.sqrt(columns(words)) * 2.4)));
  const lines = wrap(words, wide);
  const inner = textSize(lines);
  const natural =
    kind === 'diamond'
      ? { w: Math.max(160, inner.w * 2 + 40), h: Math.max(90, inner.h * 2 + 30) }
      : kind === 'ellipse'
        ? { w: Math.max(150, Math.ceil(inner.w * 1.45) + 30), h: Math.max(80, Math.ceil(inner.h * 1.45) + 24) }
        : { w: Math.max(kind === 'note' ? 180 : 140, inner.w + 40), h: Math.max(kind === 'note' ? 120 : 64, inner.h + 34) };
  const size = sizeOf(op, natural);
  const spot = findSpot(work, op, size, new Set(), fallback);
  const paint = color ?? (kind === 'note' ? COLOR_NAMES.yellow! : null);
  const el = base(work, kind === 'box' || kind === 'note' ? 'rectangle' : kind, spot.box, {
    roundness: kind === 'diamond' || kind === 'ellipse' ? (kind === 'diamond' ? { type: 2 } : null) : { type: 3 },
    ...(paint ? { strokeColor: paint.stroke, backgroundColor: paint.fill } : {}),
    ...(kind === 'note' ? { customData: { by: work.ctx.by, note: true } } : {}),
  });
  const made = [el];
  if (words) made.push(label(work, el, words, centerOf(spot.box)));
  settle(work, made, spot);
  return { line: `added ${describe(work, el)}`, box: spot.box };
}

function sizeOf(op: CanvasOp, natural: { w: number; h: number }): { w: number; h: number } {
  if (op.size === undefined) return natural;
  const size = op.size as unknown;
  if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => typeof n === 'number' && n > 0 && n <= 20000)) throw new RefError('"size" is [width, height], each above 0 and at most 20000');
  return { w: Math.max(natural.w, size[0] as number), h: Math.max(natural.h, size[1] as number) };
}

function connect(work: Work, op: CanvasOp): string {
  const things = thingsNow(work);
  const from = resolveThing(op.connect ?? op.from, things, work.scene, { notes: work.notes });
  const to = resolveThing(op.to, things, work.scene, { notes: work.notes });
  if (from.id === to.id) throw new RefError(`"connect" and "to" are the same thing (${from.id})`);
  for (const end of [from, to]) {
    if (end.kind === 'arrow' || end.kind === 'line') throw new RefError(`${end.id} is ${end.kind === 'arrow' ? 'an arrow' : 'a line'}; connect two things, not a connector`);
  }
  const words = text(op.label, 'label', false);
  const color = colors(op.color);
  const bindable = (t: Thing) => (t.kind === 'sketch' ? undefined : elementsOf(work, t)[0]);
  const a = bindable(from);
  const b = bindable(to);
  const arrow = base(work, 'arrow', { x: 0, y: 0, w: 0, h: 0 }, {
    roundness: { type: 2 },
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
    startBinding: a ? { elementId: a.id, focus: 0, gap: 6 } : null,
    endBinding: b ? { elementId: b.id, focus: 0, gap: 6 } : null,
    ...(color ? { strokeColor: color.stroke } : {}),
  });
  Object.assign(arrow, route(arrow, from.box, to.box));
  for (const el of [a, b]) {
    if (el) touch(work, el, { boundElements: [...(el.boundElements ?? []), { id: arrow.id, type: 'arrow' }] });
  }
  if (a?.frameId && a.frameId === b?.frameId) arrow.frameId = a.frameId;
  if (words) label(work, arrow, words, centerOf(boxOf(arrow)));
  return `connected ${from.id} -> ${to.id}${words ? ` ${JSON.stringify(words)}` : ''} (arrow ${describeId(work, arrow)}, pointing at ${to.id})`;
}

function describeId(work: Work, el: CanvasElement): string {
  return thingsNow(work).find((t) => t.elementIds.includes(el.id))?.id ?? el.id;
}

function set(work: Work, op: CanvasOp): string {
  const things = thingsNow(work);
  const thing = resolveThing(op.set, things, work.scene, { exact: true });
  const els = elementsOf(work, thing);
  for (const el of els) work.direct.add(el.id);
  const said: string[] = [];
  if (op.text === undefined && op.color === undefined) throw new RefError('"set" changes "text" or "color"; give one');
  if (op.text !== undefined) {
    const words = text(op.text, 'text');
    if (thing.kind === 'sketch' || thing.kind === 'picture' || thing.kind === 'line') throw new RefError(`${thing.id} is a ${thing.kind} and has no words; add a text near it instead`);
    const main = els[0]!;
    if (thing.kind === 'frame') touch(work, main, { name: words });
    else if (thing.kind === 'text') {
      const lines = wrap(words, 48);
      const size = textSize(lines);
      touch(work, main, { text: lines.join('\n'), originalText: words, width: size.w, height: size.h });
    } else {
      const old = els.find((e) => e.type === 'text' && e.containerId === main.id);
      if (old) {
        const lines = wrap(words, main.type === 'arrow' ? 26 : Math.max(8, Math.floor((Math.abs(main.width) - 20) / CHAR)));
        const size = textSize(lines);
        const [cx, cy] = centerOf(boxOf(main));
        touch(work, old, { text: lines.join('\n'), originalText: words, width: size.w, height: size.h, x: Math.round(cx - size.w / 2), y: Math.round(cy - size.h / 2) });
        if (main.type !== 'arrow' && size.h + 24 > main.height) touch(work, main, { height: size.h + 34 });
      } else {
        label(work, main, words, centerOf(boxOf(main)));
        touch(work, main, {});
      }
    }
    said.push(`words ${JSON.stringify(words)}`);
  }
  if (op.color !== undefined) {
    const color = colors(op.color)!;
    for (const el of els) {
      const filled = el.type !== 'text' && el.type !== 'freedraw' && el.type !== 'arrow' && el.type !== 'line' && el.type !== 'frame';
      touch(work, el, { strokeColor: color.stroke, ...(filled ? { backgroundColor: color.fill } : {}) });
    }
    said.push(`colour ${String(op.color)}`);
  }
  return `set ${thing.id}: ${said.join(', ')}`;
}

function move(work: Work, op: CanvasOp): string {
  const things = thingsNow(work);
  const thing = resolveThing(op.move, things, work.scene, { notes: work.notes });
  if (thing.kind === 'arrow' && (thing.from?.attached || thing.to?.attached)) throw new RefError(`${thing.id} is an arrow attached to things; move those and it follows`);
  const els = withContents(work, thing);
  const ids = new Set(els.map((e) => e.id));
  for (const el of elementsOf(work, thing)) work.direct.add(el.id);
  const from = thing.kind === 'frame' ? boxOf(els[0]!) : thing.box;
  if (!PLACES.some((p) => op[p] !== undefined) && op.at === undefined) throw new RefError('"move" needs a place: near, rightOf, leftOf, above, below, in, or at');
  const spot = findSpot(work, op, { w: from.w, h: from.h }, ids);
  const dx = Math.round(spot.box.x - from.x);
  const dy = Math.round(spot.box.y - from.y);
  for (const el of els) touch(work, el, { x: el.x + dx, y: el.y + dy });
  if (thing.kind !== 'frame') {
    for (const el of els) el.frameId = spot.frame?.id ?? null;
    work.things = null;
    if (spot.frame) settle(work, els, spot);
  }
  reroute(work, ids);
  return `moved ${thing.id} to ${Math.round(spot.box.x)},${Math.round(spot.box.y)}`;
}

function frame(work: Work, op: CanvasOp): string {
  const names = op.frame as unknown;
  if (!Array.isArray(names) || names.length === 0) throw new RefError('"frame" is a list of things to put in a new frame');
  const things = thingsNow(work);
  const members = names.map((n) => resolveThing(n, things, work.scene, { notes: work.notes }));
  for (const m of members) if (m.kind === 'frame') throw new RefError(`${m.id} is a frame; a frame cannot go in a frame`);
  const title = text(op.title ?? op.text, 'title', false);
  const els = members.flatMap((m) => elementsOf(work, m));
  for (const el of els) work.direct.add(el.id);
  const around = unionBox(els.map(boxOf));
  const pad = 32;
  const el = base(work, 'frame', { x: around.x - pad, y: around.y - pad - 8, w: around.w + pad * 2, h: around.h + pad * 2 + 8 }, { name: title || null, strokeColor: '#bbb' });
  for (const member of els) touch(work, member, { frameId: el.id });
  return `framed ${members.map((m) => m.id).join(', ')} as ${describe(work, el)}`;
}

function replace(work: Work, op: CanvasOp): string[] {
  const things = thingsNow(work);
  const names = Array.isArray(op.replace) ? op.replace : [op.replace];
  if (names.length === 0) throw new RefError('"replace" names a thing or a list of things');
  const targets = names.map((n) => resolveThing(n, things, work.scene, { exact: true }));
  const items = op.with as unknown;
  if (!Array.isArray(items) || items.length === 0) throw new RefError('"replace" needs "with": a list of add and connect changes');
  for (const item of items) {
    if (!item || typeof item !== 'object' || (!('add' in item) && !('connect' in item))) throw new RefError('"with" holds only add and connect changes');
  }
  const frameThing = targets.length === 1 && targets[0]!.kind === 'frame' ? targets[0]! : undefined;
  let region: Box;
  let gone: CanvasElement[];
  if (frameThing) {
    const frameEl = elementsOf(work, frameThing)[0]!;
    gone = withContents(work, frameThing).filter((e) => e !== frameEl);
    region = { x: frameEl.x + 24, y: frameEl.y + 40, w: Math.max(200, frameEl.width - 48), h: Math.max(100, frameEl.height - 64) };
  } else {
    for (const t of targets) if (t.kind === 'frame') throw new RefError(`${t.id} is a frame; replace a frame alone (its contents are replaced), or name the things in it`);
    gone = targets.flatMap((t) => elementsOf(work, t));
    region = unionBox(targets.map((t) => t.box));
  }
  for (const el of gone) work.direct.add(el.id);
  remove(work, gone);
  const lines = [`replaced ${frameThing ? `what ${frameThing.id} held` : targets.map((t) => t.id).join(', ')} (${gone.length} element${gone.length === 1 ? '' : 's'} removed)`];
  // What has no place of its own flows left to right from the top left of the freed space.
  let x = region.x;
  let y = region.y;
  let row = 0;
  const frameEl = frameThing ? elementsOf(work, frameThing)[0] : frameAt(work, region);
  for (const item of items as CanvasOp[]) {
    if ('connect' in item) {
      lines.push(connect(work, item));
      continue;
    }
    const placed = PLACES.some((p) => item[p] !== undefined) || item.at !== undefined;
    const before = new Set(work.added);
    const made = add(work, item, placed ? undefined : { x, y, w: 1, h: 1 });
    lines.push(made.line);
    if (!placed) {
      const size = made.box;
      x += size.w + GAP;
      row = Math.max(row, size.h);
      if (x > region.x + Math.max(region.w, 720)) {
        x = region.x;
        y += row + GAP;
        row = 0;
      }
    }
    if (frameEl && !frameEl.isDeleted) {
      const fresh = work.scene.elements.filter((e) => work.added.has(e.id) && !before.has(e.id));
      settle(work, fresh, { box: made.box, frame: frameEl });
    }
  }
  return lines;
}

function one(work: Work, op: CanvasOp): string[] {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new RefError('a change is an object with one verb: add, connect, set, move, remove, frame or replace');
  // {"from": A, "to": B} is a connection too, as is {"connect": B, "from": A} (the arrow always points at "to", or at "connect" when "from" is given).
  if (!('connect' in op) && 'from' in op && 'to' in op) op = { ...op, connect: op.from };
  else if ('connect' in op && 'from' in op && !('to' in op)) op = { ...op, to: op.connect, connect: op.from };
  const verbs = ['add', 'connect', 'set', 'move', 'remove', 'frame', 'replace'].filter((v) => v in op);
  if (verbs.length !== 1) {
    throw new RefError(verbs.length === 0 ? `no verb in ${JSON.stringify(op).slice(0, 120)}; use add, connect, set, move, remove, frame or replace` : `one verb per change, not ${verbs.join(' and ')}`);
  }
  switch (verbs[0]) {
    case 'add':
      return [add(work, op).line];
    case 'connect':
      return [connect(work, op)];
    case 'set':
      return [set(work, op)];
    case 'move':
      return [move(work, op)];
    case 'frame':
      return [frame(work, op)];
    case 'replace':
      return replace(work, op);
    default: {
      const things = thingsNow(work);
      const thing = resolveThing(op.remove, things, work.scene, { exact: true });
      const line = lineOf(thing, work.scene, things);
      for (const el of elementsOf(work, thing)) work.direct.add(el.id);
      remove(work, elementsOf(work, thing));
      return [`removed ${line}`];
    }
  }
}

/** Every mermaid text a list of changes wants drawn (an open window draws them before `applyOps` runs). */
export function mermaidTexts(ops: unknown): string[] {
  const out: string[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const op of list) {
      if (!op || typeof op !== 'object') continue;
      const o = op as CanvasOp;
      if (o.add === 'mermaid' && typeof o.text === 'string') out.push(o.text);
      walk(o.with);
    }
  };
  walk(ops);
  return [...new Set(out)];
}

export function applyOps(scene: CanvasScene, ops: unknown, ctx: ApplyContext): ApplyResult {
  const copy: CanvasScene = { ...scene, elements: scene.elements.map((e) => ({ ...e })) };
  const work: Work = { scene: copy, ctx, touched: new Set(), added: new Set(), direct: new Set(), original: new Set(scene.elements.map((e) => e.id)), rand: ctx.random ?? Math.random, notes: [], things: null };
  const done: string[] = [];
  const errors: string[] = [];
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, scene, done, errors: ['"do" is a list of changes, for example [{"add": "note", "text": "…", "near": "<thing>"}]'], touched: work.touched, added: work.added, direct: work.direct };
  }
  if (ops.length > 200) return { ok: false, scene, done, errors: ['at most 200 changes in one call'], touched: work.touched, added: work.added, direct: work.direct };
  ops.forEach((op, i) => {
    try {
      work.notes = [];
      const lines = one(work, op as CanvasOp);
      // What the board decided on the agent's behalf is said, never silent.
      if (work.notes.length > 0) lines[lines.length - 1] += ` [${[...new Set(work.notes)].join('; ')}]`;
      done.push(...lines);
    } catch (error) {
      if (!(error instanceof RefError)) throw error;
      errors.push(`change ${i + 1}: ${error.message}`);
    }
  });
  if (errors.length > 0) return { ok: false, scene, done: [], errors, touched: new Set(), added: new Set(), direct: new Set() };
  return { ok: true, scene: copy, done, errors, touched: work.touched, added: work.added, direct: new Set([...work.direct].filter((id) => work.original.has(id))) };
}
