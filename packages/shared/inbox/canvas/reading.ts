import { boxContains, boxGap, boxOf, boxesOverlap, centerOf, colorWord, farElements, live, unionBox, wordsOf, type Box, type CanvasElement, type CanvasScene } from './scene';

/**
 * The text reading of a canvas: one line per thing, each opening with an id an
 * agent can name it by. A model with no vision reads this instead of the
 * picture; one with vision reads both.
 *
 * A "thing" is what a person would point at, not an Excalidraw element: a box
 * with its words is one thing (two elements), and freehand strokes drawn near
 * each other are one "sketch" (a face is one thing, not eleven strokes), so
 * nobody has to group a drawing by hand for an agent to see it as one.
 */
export type ThingKind = 'frame' | 'box' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line' | 'picture' | 'sketch' | 'other';

export interface Thing {
  /** What an agent names it by: the shortest unique start of the element's id, or `sk-…` for a sketch. */
  id: string;
  kind: ThingKind;
  /** Its words: a box's label, a text, a frame's name, an arrow's label. */
  words: string;
  box: Box;
  /** The Excalidraw elements it is made of (a sketch: its strokes; a box: the shape and its label). */
  elementIds: string[];
  /** The frame it is in, as that frame's thing id. */
  frame?: string;
  /** Arrow and line ends, as thing ids. `~` in the reading marks an end that only points at a thing without being attached. */
  from?: { id: string; attached: boolean };
  to?: { id: string; attached: boolean };
  stroke: string;
  fill: string;
  strokes?: number;
  groups: string[];
  /** Nowhere near the rest of the drawing (scene.ts `farElements`): said in its line, left out of the drawing's size. */
  far?: boolean;
}

const SKETCH_GAP = 32;
const POINT_NEAR = 18;

const ID_LENGTH = 8;

/**
 * The id a thing is named by: the first 8 characters of its element's id, with anything but letters, digits, `_` and
 * `-` replaced (an imported file can hold any string as an id; it must not be able to break a line of the reading).
 * A fixed length, so a thing's id does not change when other things are added; two elements that share those 8
 * characters (about never) get as many more as tell them apart.
 */
function shortIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const clean = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');
  const sorted = [...ids].sort();
  const taken = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i]!;
    let n = Math.min(ID_LENGTH, id.length);
    const clash = (other: string | undefined) => other !== undefined && other !== id && clean(other.slice(0, n)) === clean(id.slice(0, n));
    while (n < id.length && (clash(sorted[i - 1]) || clash(sorted[i + 1]))) n++;
    let short = clean(id.slice(0, n)) || '_';
    while (taken.has(short)) short += '_';
    taken.add(short);
    out.set(id, short);
  }
  return out;
}

function kindOf(el: CanvasElement): ThingKind {
  switch (el.type) {
    case 'frame':
    case 'magicframe':
      return 'frame';
    case 'rectangle':
      return 'box';
    case 'ellipse':
      return 'ellipse';
    case 'diamond':
      return 'diamond';
    case 'text':
      return 'text';
    case 'arrow':
      return 'arrow';
    case 'line':
      return 'line';
    case 'image':
      return 'picture';
    default:
      return 'other';
  }
}

function oneLine(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/** Every thing on the canvas, in reading order: each frame followed by what it holds, then the rest, top to bottom in rows. */
export function thingsOf(scene: CanvasScene): Thing[] {
  const els = live(scene);
  const byId = new Map(els.map((e) => [e.id, e]));
  const short = shortIds(els.map((e) => e.id));
  const alias = (id: string) => short.get(id) ?? id;

  // A label is part of the shape or arrow it is bound to.
  const labelOf = new Map<string, CanvasElement>();
  for (const e of els) {
    if (e.type === 'text' && e.containerId && byId.has(e.containerId)) labelOf.set(e.containerId, e);
  }

  const things: Thing[] = [];
  const thingOfElement = new Map<string, Thing>();
  const strokes: CanvasElement[] = [];

  for (const e of els) {
    if (e.type === 'freedraw') {
      strokes.push(e);
      continue;
    }
    if (e.type === 'text' && e.containerId && byId.has(e.containerId)) continue;
    const label = labelOf.get(e.id);
    const kind = kindOf(e);
    const thing: Thing = {
      id: alias(e.id),
      kind,
      // The words as written (`originalText`), never the line breaks the editor's wrapping drew them with.
      words: kind === 'frame' ? oneLine(e.name) : kind === 'text' ? oneLine(wordsOf(e)) : oneLine(wordsOf(label)),
      box: boxOf(e),
      elementIds: label ? [e.id, label.id] : [e.id],
      stroke: colorWord(e.strokeColor),
      fill: colorWord(e.backgroundColor),
      groups: (e.groupIds ?? []).slice(),
    };
    things.push(thing);
    thingOfElement.set(e.id, thing);
    if (label) thingOfElement.set(label.id, thing);
  }

  // Freehand strokes near each other are one sketch. Strokes in different frames never join.
  const parent = strokes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const boxes = strokes.map(boxOf);
  // Neighbours are found through a grid, so thousands of strokes cost about their number, not its square. A stroke
  // that spans very many cells (a line across the board) is compared with every other one instead.
  const CELL = 160;
  const grid = new Map<string, number[]>();
  const wide: number[] = [];
  const join = (i: number, j: number) => {
    if ((strokes[i]!.frameId ?? null) !== (strokes[j]!.frameId ?? null)) return;
    if (boxGap(boxes[i]!, boxes[j]!) <= SKETCH_GAP) parent[find(i)] = find(j);
  };
  for (let i = 0; i < strokes.length; i++) {
    const b = boxes[i]!;
    const x0 = Math.floor((b.x - SKETCH_GAP) / CELL), x1 = Math.floor((b.x + b.w + SKETCH_GAP) / CELL);
    const y0 = Math.floor((b.y - SKETCH_GAP) / CELL), y1 = Math.floor((b.y + b.h + SKETCH_GAP) / CELL);
    if (!Number.isFinite(x0 + x1 + y0 + y1) || (x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      for (let j = 0; j < i; j++) join(i, j);
      wide.push(i);
      continue;
    }
    for (const j of wide) join(i, j);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        const cell = grid.get(key);
        if (cell) {
          for (const j of cell) join(i, j);
          cell.push(i);
        } else grid.set(key, [i]);
      }
    }
  }
  const clusters = new Map<number, number[]>();
  strokes.forEach((_, i) => {
    const root = find(i);
    const members = clusters.get(root);
    if (members) members.push(i);
    else clusters.set(root, [i]);
  });
  for (const members of clusters.values()) {
    // Named by its first stroke in drawing order, so a stroke added to it later does not rename it.
    const ids = members.slice().sort((a, b) => a - b).map((i) => strokes[i]!.id);
    const colors = [...new Set(members.map((i) => colorWord(strokes[i]!.strokeColor)).filter(Boolean))];
    const thing: Thing = {
      id: `sk-${alias(ids[0]!)}`,
      kind: 'sketch',
      words: '',
      box: unionBox(members.map((i) => boxes[i]!)),
      elementIds: ids,
      stroke: colors.join(' and '),
      fill: '',
      strokes: members.length,
      groups: [],
    };
    things.push(thing);
    for (const id of ids) thingOfElement.set(id, thing);
  }

  const far = farElements(els);
  if (far.size > 0) for (const thing of things) if (thing.elementIds.every((id) => far.has(id)) || far.has(thing.elementIds[0]!)) thing.far = true;

  // Frames.
  for (const e of els) {
    const thing = thingOfElement.get(e.id);
    if (!thing || thing.frame) continue;
    const frame = e.frameId ? thingOfElement.get(e.frameId) : undefined;
    if (frame && frame !== thing) thing.frame = frame.id;
  }

  // Arrow and line ends: attached (bound), or only pointing at something.
  const targets = things.filter((t) => t.kind !== 'arrow' && t.kind !== 'line' && t.kind !== 'frame');
  const pointedAt = (x: number, y: number, self: Thing): Thing | undefined => {
    let best: Thing | undefined;
    let bestD = POINT_NEAR;
    for (const t of targets) {
      if (t === self) continue;
      const d = boxGap({ x, y, w: 0, h: 0 }, t.box);
      if (d < bestD || (d === bestD && best && t.box.w * t.box.h < best.box.w * best.box.h)) {
        best = t;
        bestD = d;
      }
    }
    return best;
  };
  for (const e of els) {
    if (e.type !== 'arrow' && e.type !== 'line') continue;
    const thing = thingOfElement.get(e.id)!;
    const points = e.points ?? [];
    const end = (binding: CanvasElement['startBinding'], point: number[] | undefined) => {
      const bound = binding?.elementId ? thingOfElement.get(binding.elementId) : undefined;
      if (bound) return { id: bound.id, attached: true };
      if (!point || e.type === 'line') return undefined;
      const near = pointedAt(e.x + (Number(point[0]) || 0), e.y + (Number(point[1]) || 0), thing);
      return near ? { id: near.id, attached: false } : undefined;
    };
    thing.from = end(e.startBinding, points[0]);
    thing.to = end(e.endBinding, points[points.length - 1]);
  }

  // Reading order.
  const rowOrder = (a: Thing, b: Thing) => {
    const rowA = Math.round(a.box.y / 80);
    const rowB = Math.round(b.box.y / 80);
    return rowA - rowB || a.box.x - b.box.x || a.id.localeCompare(b.id);
  };
  const frames = things.filter((t) => t.kind === 'frame').sort(rowOrder);
  const ordered: Thing[] = [];
  for (const frame of frames) {
    ordered.push(frame, ...things.filter((t) => t.frame === frame.id).sort(rowOrder));
  }
  ordered.push(...things.filter((t) => t.kind !== 'frame' && !t.frame).sort(rowOrder));
  return ordered;
}

const round = (n: number) => String(Math.round(n));
const place = (b: Box) => `at ${round(b.x)},${round(b.y)} ${round(b.w)}x${round(b.h)}`;
/** How many characters of a thing's words a line of the reading holds; a read of named things (`things`) holds them all. */
export const WORDS_SHOWN = 90;
const WORDS_ALL = 4000;
const quote = (words: string, max = WORDS_SHOWN) => {
  // Cut between characters, never inside one (an emoji is two units of a string).
  const letters = words.length > max ? Array.from(words) : null;
  return JSON.stringify(letters && letters.length > max ? `${letters.slice(0, max - 1).join('')}…` : words);
};

function look(t: Thing): string {
  const parts: string[] = [];
  if (t.stroke && t.stroke !== 'black') parts.push(t.stroke);
  if (t.fill && t.kind !== 'sketch' && t.fill !== t.stroke) parts.push(`filled ${t.fill}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

const SPOTS = [
  ['top left', 'top', 'top right'],
  ['left', 'middle', 'right'],
  ['bottom left', 'bottom', 'bottom right'],
];

function spot(inner: Box, outer: Box): string {
  const [cx, cy] = centerOf(inner);
  const col = outer.w < 1 ? 1 : Math.min(2, Math.max(0, Math.floor(((cx - outer.x) / outer.w) * 3)));
  const row = outer.h < 1 ? 1 : Math.min(2, Math.max(0, Math.floor(((cy - outer.y) / outer.h) * 3)));
  return SPOTS[row]![col]!;
}

interface StrokeShape {
  /** "dot", "closed loop", "flat line", "upright line", "slanted line", "curve", "squiggle". */
  kind: string;
  /** The stroke in plain words, with its size and where in the sketch it is. */
  words: string;
  /** Which ninth of the sketch it is in ("top left" … "bottom right"). */
  where: string;
}

/** One freehand stroke in plain words: a dot, a closed loop, a straight line, or which way a curve opens. */
function strokeShape(el: CanvasElement, cluster: Box, own = false): StrokeShape {
  const points = el.points ?? [];
  const box = boxOf(el);
  const diag = Math.hypot(box.w, box.h);
  const clusterDiag = Math.hypot(cluster.w, cluster.h) || 1;
  const where = spot(box, cluster);
  // Among a few strokes, one that is tiny beside the drawing is a dot (an eye in a face). Among very many (`own`),
  // each is judged by its own shape: hatching is short lines, not three thousand dots.
  if (points.length < 2 || diag < (own ? 6 : Math.max(6, clusterDiag * 0.04))) return { kind: 'dot', words: `a dot at the ${where}`, where };
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]![0]! - points[i - 1]![0]!, points[i]![1]! - points[i - 1]![1]!);
  const chord = Math.hypot(last[0]! - first[0]!, last[1]! - first[1]!);
  const size = diag > clusterDiag * 0.6 ? 'large' : diag < clusterDiag * 0.25 ? 'small' : 'medium';
  const whole = boxContains({ x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 }, cluster) || diag > clusterDiag * 0.85;
  const span = whole ? 'around the whole sketch' : `at the ${where}`;
  if (chord < diag * 0.25 && length > diag * 1.8) {
    return { kind: 'closed loop', words: `a ${size} closed loop ${span}`, where };
  }
  if (length < chord * 1.12) {
    const flat = Math.abs(last[0]! - first[0]!) >= Math.abs(last[1]! - first[1]!) * 2;
    const tall = Math.abs(last[1]! - first[1]!) >= Math.abs(last[0]! - first[0]!) * 2;
    const lean = flat ? 'flat' : tall ? 'upright' : 'slanted';
    return { kind: `${lean} line`, words: `a ${size} ${lean} line ${span}`, where };
  }
  // A curve: which side of the line between its ends does its middle fall on?
  const mid = points[Math.floor(points.length / 2)]!;
  const mx = (first[0]! + last[0]!) / 2;
  const my = (first[1]! + last[1]!) / 2;
  const flatish = Math.abs(last[0]! - first[0]!) >= Math.abs(last[1]! - first[1]!);
  if (length > chord * 2.6) return { kind: 'squiggle', words: `a ${size} squiggle ${span}`, where };
  const bend = flatish ? (mid[1]! > my ? 'ends up, like a smile' : 'ends down, like an arch') : mid[0]! > mx ? 'bulging right' : 'bulging left';
  return { kind: 'curve', words: `a ${size} curve (${bend}) ${span}`, where };
}

const MANY_STROKES = 12;
const plural = (kind: string, n: number) => (n === 1 ? kind : kind === 'squiggle' ? 'squiggles' : `${kind}s`);

/**
 * A sketch of very many strokes (hatching, handwriting, a page of scribbles), said as what it is made of and where
 * the strokes gather: how many of each kind, which parts of the sketch hold the most, and the few largest strokes.
 * Listing eight strokes of three thousand and "2992 more" tells a reader nothing.
 */
function manyStrokesWords(strokes: CanvasElement[], box: Box): string {
  const shapes = strokes.map((s) => strokeShape(s, box, true));
  const kinds = new Map<string, number>();
  const places = new Map<string, number>();
  for (const shape of shapes) {
    kinds.set(shape.kind, (kinds.get(shape.kind) ?? 0) + 1);
    places.set(shape.where, (places.get(shape.where) ?? 0) + 1);
  }
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1];
  const made = [...kinds].sort(byCount).slice(0, 5).map(([kind, n]) => `${n} ${plural(kind, n)}`);
  // Where they gather: each ninth of the sketch against an even spread.
  const even = strokes.length / 9;
  const dense = [...places].filter(([, n]) => n > even * 1.6).sort(byCount);
  const bare = SPOTS.flat().filter((name) => (places.get(name) ?? 0) < even * 0.25);
  const share = (n: number) => `${Math.round((n / strokes.length) * 100)}%`;
  const where =
    dense.length === 0 && bare.length === 0
      ? 'spread evenly over the sketch'
      : [dense.length > 0 ? `most at the ${dense.slice(0, 3).map(([name, n]) => `${name} (${share(n)})`).join(', ')}` : '', bare.length > 0 && bare.length <= 5 ? `few or none at the ${bare.join(', ')}` : ''].filter(Boolean).join('; ') || 'gathered in parts of the sketch';
  const largest = strokes
    .map((s, i) => ({ area: boxOf(s).w * boxOf(s).h, words: shapes[i]!.words }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 3)
    .map((s) => s.words);
  const middle = (values: number[]) => Math.round(values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0);
  const typical = `${middle(strokes.map((s) => boxOf(s).w))}x${middle(strokes.map((s) => boxOf(s).h))}`;
  return `${made.join(', ')}, typically ${typical}; ${where}; the largest: ${largest.join('; ')}`;
}

function sketchWords(t: Thing, scene: CanvasScene, things: Thing[]): string {
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const strokes = t.elementIds.map((id) => byId.get(id)).filter((e): e is CanvasElement => !!e);
  let parts: string[];
  if (strokes.length > MANY_STROKES) parts = [manyStrokesWords(strokes, t.box)];
  else {
    const ranked = strokes.slice().sort((a, b) => {
      const A = boxOf(a);
      const B = boxOf(b);
      return B.w * B.h - A.w * A.h;
    });
    const shown = ranked.map((s) => strokeShape(s, t.box).words);
    const counts = new Map<string, number>();
    for (const w of shown) counts.set(w, (counts.get(w) ?? 0) + 1);
    parts = [...counts].map(([w, n]) => (n > 1 ? `${n}x ${w.replace(/^an? /, '')}` : w));
  }
  // What the sketch is drawn on, or next to.
  let on = '';
  let best: Thing | undefined;
  let bestD = 60;
  for (const other of things) {
    if (other === t || other.kind === 'frame' || other.kind === 'arrow' || other.kind === 'line') continue;
    if (boxesOverlap(other.box, t.box)) {
      const [cx, cy] = centerOf(t.box);
      const inside = cx >= other.box.x && cx <= other.box.x + other.box.w && cy >= other.box.y && cy <= other.box.y + other.box.h;
      on = ` ${inside ? 'on' : 'over part of'} ${other.id}`;
      best = undefined;
      break;
    }
    const d = boxGap(other.box, t.box);
    if (d < bestD) {
      best = other;
      bestD = d;
    }
  }
  if (best) on = ` next to ${best.id}`;
  return `${t.strokes} freehand stroke${t.strokes === 1 ? '' : 's'}${on}: ${parts.join('; ')}`;
}

/** One line for a thing, without its indent. `full`: all of its words, however long (a read of named things). */
export function lineOf(t: Thing, scene: CanvasScene, things: Thing[], full = false): string {
  const end = (e: Thing['from']) => (e ? `${e.attached ? '' : '~'}${e.id}` : '(open)');
  const max = full ? WORDS_ALL : WORDS_SHOWN;
  const far = t.far ? ' (far from the rest; not counted in the size)' : '';
  switch (t.kind) {
    case 'frame': {
      const holds = things.filter((o) => o.frame === t.id).length;
      return `frame ${t.id} ${quote(t.words || 'untitled', max)} ${place(t.box)}, holds ${holds}${far}`;
    }
    case 'arrow':
    case 'line': {
      const ends = t.kind === 'arrow' || t.from || t.to ? ` ${end(t.from)} -> ${end(t.to)}` : '';
      const loose = !t.from && !t.to ? ` ${place(t.box)}` : '';
      return `${t.kind} ${t.id}${ends}${t.words ? ` ${quote(t.words, max)}` : ''}${loose}${look(t)}${far}`;
    }
    case 'sketch':
      return `sketch ${t.id} ${place(t.box)}${look(t)}: ${sketchWords(t, scene, things)}${far}`;
    case 'picture':
      return `picture ${t.id} ${place(t.box)}${far}`;
    default:
      return `${t.kind} ${t.id}${t.words ? ` ${quote(t.words, max)}` : ''} ${place(t.box)}${look(t)}${far}`;
  }
}

export interface ReadOptions {
  /** Only this frame and what it holds (a frame's thing id). */
  frame?: string;
  /** Only these things (thing ids). */
  only?: Set<string>;
  /** Start after this thing id (the next page of a long reading). */
  after?: string;
  /** At most this many lines. */
  limit?: number;
  /** Every thing's words whole (a read of named things), not cut at `WORDS_SHOWN`. */
  full?: boolean;
}

export interface Reading {
  lines: string[];
  /** How many things the filter matched in all. */
  total: number;
  /** The id of the last thing shown when lines were left out. */
  cutAfter?: string;
  /** `after` named a thing that is not there (removed, or renamed since): the reading starts from the top, and says so. */
  afterMissing?: boolean;
  /** The things whose lines are in `lines`. */
  shown: Thing[];
  /** Where the chosen things are, without those far from the rest. */
  box: Box;
  /** The things shown whose words were cut (their ids): a read of exactly those gives them whole. */
  cutWords: string[];
}

export function readThings(scene: CanvasScene, things: Thing[], options: ReadOptions = {}): Reading {
  let chosen = things;
  if (options.frame) chosen = chosen.filter((t) => t.id === options.frame || t.frame === options.frame);
  if (options.only) chosen = chosen.filter((t) => options.only!.has(t.id));
  const total = chosen.length;
  const near = chosen.filter((t) => !t.far);
  const box = unionBox((near.length > 0 ? near : chosen).map((t) => t.box));
  let start = 0;
  let afterMissing = false;
  if (options.after) {
    const at = chosen.findIndex((t) => t.id === options.after);
    if (at >= 0) start = at + 1;
    else afterMissing = true;
  }
  const limit = Math.max(1, options.limit ?? 150);
  const page = chosen.slice(start, start + limit);
  const lines = page.map((t) => `${t.frame && chosen.some((o) => o.id === t.frame) ? '  ' : ''}${lineOf(t, scene, things, options.full)}`);
  const cutWords = options.full ? [] : page.filter((t) => Array.from(t.words).length > WORDS_SHOWN).map((t) => t.id);

  // Groups a person made, named once after the things (only when the whole reading is shown).
  if (start === 0 && page.length === chosen.length) {
    const groups = new Map<string, string[]>();
    for (const t of chosen) {
      const outer = t.groups[t.groups.length - 1];
      if (outer) groups.set(outer, [...(groups.get(outer) ?? []), t.id]);
    }
    for (const members of groups.values()) {
      if (members.length > 1) lines.push(`group: ${members.join(', ')}`);
    }
  }
  return { lines, total, cutAfter: start + limit < chosen.length ? page[page.length - 1]?.id : undefined, box, shown: page, cutWords, ...(afterMissing ? { afterMissing } : {}) };
}

/** What a canvas holds in a few words: "12 things: 5 boxes, 4 arrows, 2 texts, 1 sketch". */
export function countWords(things: Thing[]): string {
  if (things.length === 0) return 'empty';
  const counts = new Map<string, number>();
  for (const t of things) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
  const plural: Record<string, string> = { box: 'boxes', sketch: 'sketches' };
  const parts = [...counts].map(([kind, n]) => `${n} ${n === 1 ? kind : plural[kind] ?? `${kind}s`}`);
  return `${things.length} thing${things.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
