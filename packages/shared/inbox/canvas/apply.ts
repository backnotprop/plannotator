import { lineOf, thingsOf, type Thing } from './reading';
import { boxGap as boxGapOf, boxOf, boxesOverlap, centerOf, COLOR_NAMES, unionBox, wordsOf, type Box, type CanvasElement, type CanvasScene } from './scene';

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
  /** A call that was refused: the elements of the things its errors list, as they are now (shown to the caller by that answer). */
  listed?: Set<string>;
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

/** A frame's title is one line over its corner: this many characters at most. */
export const FRAME_TITLE_MAX = 120;

/** A change that cannot be made. `things`: the things its message lists, as they are now (an answer that prints a thing's line has shown it). */
export class RefError extends Error {
  things: Thing[];
  constructor(message: string, things: Thing[] = []) {
    super(message);
    this.things = things;
  }
}

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{fe0f}\u{e0020}-\u{e007f}]/u;
/** Scripts whose letters join, where a joiner or a non-joiner between two letters changes how they are drawn (Persian, Hindi, Sinhala and the like). */
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Words without the characters nobody can see: zero-width spaces, word joiners, byte-order marks, soft hyphens,
 * direction marks. Two invisible characters carry meaning and stay where they do: the joiner inside an emoji
 * (a woman, a skin tone and a laptop joined are one technologist) and the joiner or non-joiner between two letters of
 * a script whose letters join. Anywhere else they go too. Letters and their marks are put in their composed form, so
 * the same words always compare equal.
 */
export function seenWords(value: string): string {
  const chars = Array.from(value.normalize('NFC'));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (/[\u200b\u200e\u200f\u2060\ufeff\u00ad]/.test(ch)) continue;
    if (ch === '\u200d' || ch === '\u200c') {
      const before = out[out.length - 1] ?? '';
      let next = '';
      for (let j = i + 1; j < chars.length && !next; j++) if (!/[\u200b-\u200f\u2060\ufeff\u00ad]/.test(chars[j]!)) next = chars[j]!;
      const emoji = ch === '\u200d' && EMOJI.test(before) && EMOJI.test(next);
      const letters = JOINING.test(before) && JOINING.test(next);
      if (!emoji && !letters) continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/** A name and a thing's words, made comparable: the same invisible characters gone, one space between words, no case. */
const plain = (words: string) => seenWords(words).replace(/\s+/g, ' ').trim().toLowerCase();

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
  const lower = plain(name);
  const list = (found: Thing[]) => found.slice(0, 6).map((t) => `  ${lineOf(t, scene, things)}`).join('\n');
  // A thing's whole words come first, before anything that could read the name as an id.
  const same = things.filter((t) => t.words && plain(t.words) === lower);
  if (same.length === 1) return same[0]!;
  if (same.length > 1) throw new RefError(`${JSON.stringify(name)} is the words of ${same.length} things; name one by its id:\n${list(same)}`, same.slice(0, 6));
  // An id is the whole id, as the reading prints it (or the element's own full id). Never the start of one.
  const byId = things.filter((t) => t.id === name || t.elementIds.includes(name));
  if (byId.length === 1) return byId[0]!;
  // Loose: part of its words, or its words in any order, with a kind word standing for the kind.
  const holds = things.filter((t) => t.words && plain(t.words).includes(lower));
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
      loose = things.filter((t) => ofKind(t) && rest.every((w) => plain(t.words).includes(w)) && (rest.length > 0 || t.kind !== 'arrow'));
    }
  }
  if (loose.length === 1 && !options.exact) {
    const thing = loose[0]!;
    options.notes?.push(`${JSON.stringify(name)} read as ${thing.id}${thing.words ? ` ${JSON.stringify(Array.from(thing.words).slice(0, 60).join(''))}` : ''}`);
    return thing;
  }
  if (loose.length >= 1 && options.exact) {
    throw new RefError(`${JSON.stringify(name)} is neither an id nor a thing's whole words, and a change that overwrites or removes takes only those. ${loose.length === 1 ? 'It looks like this one; name it by its id' : 'Name one by its id'}:\n${list(loose)}`, loose.slice(0, 6));
  }
  if (loose.length > 1) throw new RefError(`${JSON.stringify(name)} fits ${loose.length} things; name one by its id:\n${list(loose)}`, loose.slice(0, 6));
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !FILLER.has(w));
  const close = things.filter((t) => words.some((w) => plain(t.words).includes(w)));
  throw new RefError(`nothing on the canvas is called ${JSON.stringify(name)}${close.length ? `; closest, as they are now:\n${list(close)}` : ' (read the canvas to see what is there)'}`, close.slice(0, 6));
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

/**
 * Lines no wider than `maxChars` columns, to GUESS how much room words need. Never what is stored: a thing's words
 * are kept exactly as given, and the editor wraps them on screen itself (a label to its shape, a text to its width).
 * A word longer than a line (and text with no spaces, as Chinese has none) breaks inside.
 */
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

/**
 * The hand-drawn face has no marks that stack on a letter (and none of Vietnamese's or a "Zalgo" text's): drawn with
 * it, the marks fall beside the letters as stray characters. Words that still hold such marks after composing are
 * drawn in the plain face (2), whose letters carry their marks.
 */
const fontFor = (words: string) => (/\p{M}/u.test(words.replace(/[\u{fe0f}\u{20e3}]/gu, '')) ? 2 : 5);

function textElement(work: Work, words: string, box: Box, extra: Partial<CanvasElement> = {}): CanvasElement {
  return base(work, 'text', box, {
    // The words, exactly: no line break is ever put into them. The editor wraps them for display and keeps them whole in `originalText`.
    text: words,
    originalText: words,
    fontSize: FONT,
    fontFamily: fontFor(words),
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
    ...extra,
  });
}

/** The width the editor wraps a label to (Excalidraw's own rule: an arrow's label gets 70% of its width and at least 11 times its font size). */
function labelRun(container: CanvasElement): number {
  const w = Math.abs(container.width);
  if (container.type === 'arrow') return Math.max(0.7 * w, FONT * 11);
  if (container.type === 'ellipse') return Math.round((w / 2) * Math.SQRT2) - 10;
  if (container.type === 'diamond') return Math.round(w / 2) - 10;
  return w - 10;
}

/** About how large a label's words will be once the editor has wrapped them to their shape: a guess, on the generous side. */
function labelSize(container: CanvasElement, words: string): { w: number; h: number } {
  const run = labelRun(container);
  const size = textSize(wrap(words, Math.max(4, Math.floor(run / CHAR))));
  return { w: Math.min(size.w, Math.max(10, Math.round(run))), h: size.h };
}

/** The middle of an arrow, where the editor puts its label: its middle point, or the middle of its middle stretch. */
function midOf(arrow: CanvasElement): [number, number] {
  const points = arrow.points ?? [];
  if (points.length === 0) return centerOf(boxOf(arrow));
  const at = (i: number): [number, number] => [arrow.x + (Number(points[i]?.[0]) || 0), arrow.y + (Number(points[i]?.[1]) || 0)];
  const half = Math.floor(points.length / 2);
  if (points.length % 2 === 1) return at(half);
  const a = at(half - 1);
  const b = at(half);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function label(work: Work, container: CanvasElement, words: string, at: [number, number]): CanvasElement {
  const size = labelSize(container, words);
  const el = textElement(work, words, { x: at[0] - size.w / 2, y: at[1] - size.h / 2, w: size.w, h: size.h }, {
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
  /** No free spot beside the thing it was to stand by: an arrow from the new thing to this one says they belong together. */
  tie?: Thing;
}

/** Beside a thing: this far from its edge. Anything within `BESIDE_MAX` still reads as standing by it. */
const BESIDE = 40;
const BESIDE_MAX = 120;

/** Other ways an agent writes a place ("next to", "beside", "under"): each is one of the six. */
const PLACE_WORDS: Record<string, Place> = {
  nextto: 'near', beside: 'near', besides: 'near', by: 'near', nearto: 'near', closeto: 'near',
  rightof: 'rightOf', right: 'rightOf', totherightof: 'rightOf',
  leftof: 'leftOf', left: 'leftOf', totheleftof: 'leftOf',
  under: 'below', beneath: 'below', underneath: 'below',
  over: 'above', ontopof: 'above',
  inside: 'in', within: 'in', into: 'in',
};

function withPlaces(op: CanvasOp): CanvasOp {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return op;
  let out = op;
  for (const key of Object.keys(op)) {
    const place = PLACE_WORDS[key.toLowerCase().replace(/[^a-z]/g, '')];
    if (!place || key === place || (PLACES as readonly string[]).includes(key)) continue;
    if (out === op) out = { ...op };
    delete out[key];
    if (out[place] === undefined) out[place] = op[key];
  }
  return out;
}

/** What stands on a spot, by name: the things there and the connectors that run through it. */
function blockersOf(work: Work, box: Box, ignore: Set<string>): string[] {
  const out: string[] = [];
  for (const t of thingsNow(work)) {
    if (t.kind === 'frame' || t.elementIds.some((id) => ignore.has(id))) continue;
    const hit =
      t.kind === 'arrow' || t.kind === 'line'
        ? connectorLines(work, new Set(work.scene.elements.filter((e) => !t.elementIds.includes(e.id)).map((e) => e.id))).some((line) => crosses(line, box))
        : boxesOverlap(t.box, box, 12);
    if (hit) out.push(`${t.kind} ${t.id}${t.words ? ` ${JSON.stringify(Array.from(t.words).slice(0, 30).join(''))}` : ''}`);
    if (out.length === 3) break;
  }
  return out;
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
  // Beside the thing: a small gap from its edge, on the side asked for (near: any side). A spot that is taken gives
  // way first by sliding along that side, while the two still face each other, and only then by stepping farther out.
  const sides: Place[] = place === 'near' ? ['rightOf', 'below', 'leftOf', 'above'] : [place];
  const sideWords: Record<string, string> = { rightOf: 'right of', leftOf: 'left of', above: 'above', below: 'below' };
  const at = (side: Place, d: number, slide: number): Box => {
    switch (side) {
      case 'rightOf':
        return { x: a.x + a.w + d, y: a.y + a.h / 2 - size.h / 2 + slide, w: size.w, h: size.h };
      case 'leftOf':
        return { x: a.x - d - size.w, y: a.y + a.h / 2 - size.h / 2 + slide, w: size.w, h: size.h };
      case 'above':
        return { x: a.x + a.w / 2 - size.w / 2 + slide, y: a.y - d - size.h, w: size.w, h: size.h };
      default:
        return { x: a.x + a.w / 2 - size.w / 2 + slide, y: a.y + a.h + d, w: size.w, h: size.h };
    }
  };
  const reach = (side: Place) => Math.max(0, (side === 'rightOf' || side === 'leftOf' ? a.h + size.h : a.w + size.w) / 2 - 20);
  const home = anchor.frame ? things.find((t) => t.id === anchor.frame) : undefined;
  const first = at(sides[0]!, BESIDE, 0);
  // Inside the thing's own frame first; then anywhere (the frame grows to hold it).
  for (const within of home ? [home.box, null] : [null]) {
    for (let d = BESIDE; d <= BESIDE + 40 * 40; d += 40) {
      // Farther out than beside is tried inside the frame only as far as the frame goes; the next pass has the rest.
      for (let slide = 0; slide <= Math.max(...sides.map(reach)); slide += 30) {
        for (const side of sides) {
          if (slide > reach(side)) continue;
          for (const sign of slide === 0 ? [1] : [1, -1]) {
            const box = at(side, d, slide * sign);
            if (within && !(box.x >= within.x + 12 && box.y >= within.y + 12 && box.x + box.w <= within.x + within.w - 12 && box.y + box.h <= within.y + within.h - 12)) continue;
            if (!isFree(box, taken, lines)) continue;
            const beside = d <= BESIDE_MAX;
            const blocked = d > BESIDE || slide > 0 ? blockersOf(work, first, ignore) : [];
            const why = blocked.length > 0 ? ` (${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} in the way)` : '';
            if (place === 'near') work.notes.push(`near put it ${sideWords[side]} ${anchor.id}${beside ? '' : `, ${Math.round(d)} away${why}`}; rightOf, leftOf, above or below picks a side`);
            else if (!beside) work.notes.push(`${sideWords[side]} ${anchor.id} but ${Math.round(d)} away${why}`);
            else if (slide > 0 || d > BESIDE) work.notes.push(`${sideWords[side]} ${anchor.id}, ${slide > 0 ? 'slid along it' : 'a little farther out'}${why}`);
            return { box, frame: home ? elementsOf(work, home)[0] : frameAt(work, box), ...(beside ? {} : { tie: anchor }) };
          }
        }
      }
    }
  }
  return { box: first, tie: anchor };
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

function route(arrow: CanvasElement, from: Box, to: Box, via?: [number, number]): Partial<CanvasElement> {
  const start = edgePoint(from, via ?? centerOf(to), 6);
  const end = edgePoint(to, via ?? centerOf(from), 6);
  const dx = Math.round(end[0] - start[0]);
  const dy = Math.round(end[1] - start[1]);
  const x = Math.round(start[0]);
  const y = Math.round(start[1]);
  if (!via) return { x, y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]] };
  const mx = Math.round(via[0]) - x;
  const my = Math.round(via[1]) - y;
  return { x, y, width: Math.max(0, mx, dx) - Math.min(0, mx, dx), height: Math.max(0, my, dy) - Math.min(0, my, dy), points: [[0, 0], [mx, my], [dx, dy]] };
}

/**
 * An arrow between two things, with room for its words. The editor draws an arrow's label on the arrow's middle,
 * wrapped by words to a width of its own choosing (at least 220), so between two things that stand close the label
 * would lie over them. Then the arrow bows out to one side, through the nearest free spot that holds the label: the
 * words sit beside the things, never on one.
 */
function routeLabelled(work: Work, arrow: CanvasElement, from: Box, to: Box, words: string): Partial<CanvasElement> {
  const straight = route(arrow, from, to);
  if (!words) return straight;
  const taken = obstacles(work, new Set([arrow.id]));
  // Does the label, as large as it will be on this route, lie clear of every thing when centred here?
  const free = (c: [number, number], on: Partial<CanvasElement>) => {
    const size = labelSize({ ...arrow, ...on } as CanvasElement, words);
    return !taken.some((o) => boxesOverlap(o, { x: c[0] - size.w / 2, y: c[1] - size.h / 2, w: size.w, h: size.h }, 8));
  };
  const mid = midOf({ ...arrow, ...straight } as CanvasElement);
  if (free(mid, straight)) return straight;
  const others = taken.filter((o) => !sameBox(o, from) && !sameBox(o, to));
  // Every spot around the middle, nearest first: the first where the label lies on nothing and the bow runs over nothing.
  const spots: [number, number][] = [];
  for (let dy = -600; dy <= 600; dy += 20) for (let dx = -600; dx <= 600; dx += 20) if (dx !== 0 || dy !== 0) spots.push([dx, dy]);
  spots.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  let fallback: Partial<CanvasElement> | undefined;
  for (const [dx, dy] of spots) {
    const via: [number, number] = [mid[0] + dx, mid[1] + dy];
    const bowed = route(arrow, from, to, via);
    if (!free(via, bowed)) continue;
    const p = bowed.points!;
    const out: Segment = [bowed.x! + p[0]![0]!, bowed.y! + p[0]![1]!, bowed.x! + p[1]![0]!, bowed.y! + p[1]![1]!];
    const back: Segment = [bowed.x! + p[1]![0]!, bowed.y! + p[1]![1]!, bowed.x! + p[2]![0]!, bowed.y! + p[2]![1]!];
    // The bow runs over no other thing, and does not double back through either of the two it joins.
    const clear = !others.some((o) => crosses(out, o, 4) || crosses(back, o, 4)) && !crosses(out, to, 0) && !crosses(back, from, 0);
    if (clear) return bowed;
    fallback ??= bowed;
  }
  return fallback ?? straight;
}

const sameBox = (a: Box, b: Box) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;

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
    const text = work.scene.elements.find((e) => !e.isDeleted && e.type === 'text' && e.containerId === arrow.id);
    touch(work, arrow, routeLabelled(work, arrow, fromBox, toBox, text ? wordsOf(text) : ''));
    if (text) {
      const [cx, cy] = midOf(arrow);
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

function text(value: unknown, field: string, required = true, max = 4000): string {
  if (value === undefined || value === null) {
    if (required) throw new RefError(`"${field}" is missing`);
    return '';
  }
  if (typeof value !== 'string') throw new RefError(`"${field}" is text`);
  if (value.length > 4000) throw new RefError(`"${field}" is longer than 4,000 characters`);
  // Characters nobody can see are not words (the joiners that hold an emoji or a script's letters together stay).
  const seen = seenWords(value);
  if (required && !seen.replace(/[\u200c\u200d]/g, '').trim()) throw new RefError(`"${field}" has no words in it`);
  if (Array.from(seen).length > max) throw new RefError(`"${field}" is longer than ${max} characters`);
  return seen;
}

function describe(work: Work, el: CanvasElement): string {
  const things = thingsNow(work);
  const thing = things.find((t) => t.elementIds.includes(el.id));
  return thing ? lineOf(thing, work.scene, things) : el.id;
}

/** Not beside what it was to stand by: a plain arrow from the new thing to that one, so it still reads as belonging to it. */
function tieTo(work: Work, el: CanvasElement, spot: Spot): void {
  if (!spot.tie) return;
  const target = thingsNow(work).find((t) => t.id === spot.tie!.id);
  const mine = thingsNow(work).find((t) => t.elementIds.includes(el.id));
  if (!target || !mine || target.kind === 'frame' || target.kind === 'arrow' || target.kind === 'line') return;
  const notes = work.notes;
  connect(work, { connect: mine.id, to: target.id });
  work.notes = notes;
  work.notes.push(`an arrow ties it to ${target.id}`);
}

function add(work: Work, given: CanvasOp, fallback?: Box): { line: string; box: Box } {
  const op = withPlaces(given);
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
    const title = text(op.text ?? op.title, 'text', false, FRAME_TITLE_MAX).replace(/\s+/g, ' ').trim();
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
    // Long words keep to a column: a text of a set width (autoResize off) is wrapped by the editor, on screen only.
    const column = lines.length > words.split('\n').length;
    const el = textElement(work, words, spot.box, { textAlign: 'left', verticalAlign: 'top', ...(column ? { autoResize: false } : {}), ...(color ? { strokeColor: color.stroke } : {}) });
    settle(work, [el], spot);
    tieTo(work, el, spot);
    return { line: `added ${describe(work, el)}`, box: spot.box };
  }
  // Long words get a wider thing, so a long note is a block and not a strip.
  const wide = Math.min(64, Math.max(kind === 'note' ? 22 : 20, Math.ceil(Math.sqrt(columns(words)) * 2.4)));
  const lines = wrap(words, wide);
  const inner = textSize(lines);
  const natural =
    kind === 'diamond'
      ? { w: Math.max(160, inner.w * 2 + 60), h: Math.max(90, inner.h * 2 + 70) }
      : kind === 'ellipse'
        ? { w: Math.max(150, Math.ceil(inner.w * 1.45) + 30), h: Math.max(80, Math.ceil(inner.h * 1.45) + 44) }
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
  tieTo(work, el, spot);
  // The kind word the agent used: a note is a yellow box, and it asked for a note.
  const line = describe(work, el);
  return { line: `added ${kind === 'note' ? line.replace(/^box /, 'note ') : line}`, box: spot.box };
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
  Object.assign(arrow, routeLabelled(work, arrow, from.box, to.box, words));
  for (const el of [a, b]) {
    if (el) touch(work, el, { boundElements: [...(el.boundElements ?? []), { id: arrow.id, type: 'arrow' }] });
  }
  if (a?.frameId && a.frameId === b?.frameId) arrow.frameId = a.frameId;
  if (words) label(work, arrow, words, midOf(arrow));
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
    if (thing.kind === 'frame') {
      if (Array.from(words).length > FRAME_TITLE_MAX) throw new RefError(`a frame's title is at most ${FRAME_TITLE_MAX} characters`);
      touch(work, main, { name: words.replace(/\s+/g, ' ').trim() });
    } else if (thing.kind === 'text') {
      const lines = wrap(words, 48);
      const size = textSize(lines);
      const column = lines.length > words.split('\n').length;
      touch(work, main, { text: words, originalText: words, fontFamily: fontFor(words), autoResize: !column, width: size.w, height: size.h });
    } else {
      const old = els.find((e) => e.type === 'text' && e.containerId === main.id);
      if (old) {
        if (main.type === 'arrow') {
          // New words may need more room than the old: the arrow is routed for them again.
          const byId = new Map(work.scene.elements.map((e) => [e.id, e]));
          const a = main.startBinding?.elementId ? byId.get(main.startBinding.elementId) : undefined;
          const b = main.endBinding?.elementId ? byId.get(main.endBinding.elementId) : undefined;
          if (a && b && !a.isDeleted && !b.isDeleted) touch(work, main, routeLabelled(work, main, boxOf(a), boxOf(b), words));
        }
        const size = labelSize(main, words);
        const [cx, cy] = main.type === 'arrow' ? midOf(main) : centerOf(boxOf(main));
        touch(work, old, { text: words, originalText: words, fontFamily: fontFor(words), width: size.w, height: size.h, x: Math.round(cx - size.w / 2), y: Math.round(cy - size.h / 2) });
        const room = main.type === 'diamond' ? size.h * 2 + 70 : main.type === 'ellipse' ? Math.ceil(size.h * 1.45) + 44 : size.h + 34;
        if (main.type !== 'arrow' && room > main.height) touch(work, main, { height: room });
      } else {
        label(work, main, words, main.type === 'arrow' ? midOf(main) : centerOf(boxOf(main)));
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

function move(work: Work, given: CanvasOp): string {
  const op = withPlaces(given);
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
  const title = text(op.title ?? op.text, 'title', false, FRAME_TITLE_MAX).replace(/\s+/g, ' ').trim();
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
  for (const raw of items as CanvasOp[]) {
    const item = withPlaces(raw);
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
  const listed = new Set<string>();
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
      if (errors.length <= 10) for (const thing of error.things) for (const id of thing.elementIds) listed.add(id);
    }
  });
  if (errors.length > 0) return { ok: false, scene, done: [], errors, touched: new Set(), added: new Set(), direct: new Set(), listed };
  // A frame added and then filled in the same call: its line says what it holds at the end, not the nothing it held when it was made.
  if (done.some((line) => line.startsWith('added frame '))) {
    const end = thingsOf(copy);
    for (const [i, line] of done.entries()) {
      const id = /^added frame (\S+) /.exec(line)?.[1];
      const frame = id ? end.find((t) => t.id === id && t.kind === 'frame') : undefined;
      // Its line as it is at the end (what it holds, the size it grew to); what the board decided stays after it.
      if (frame) done[i] = `added ${lineOf(frame, copy, end)}${/( \[[^\]]*\])$/.exec(line)?.[1] ?? ''}`;
    }
  }
  return { ok: true, scene: copy, done, errors, touched: work.touched, added: work.added, direct: new Set([...work.direct].filter((id) => work.original.has(id))) };
}
