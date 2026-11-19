import { boxContains, boxGap, boxOf, boxesOverlap, centerOf, colorWord, live, unionBox, type Box, type CanvasElement, type CanvasScene } from './scene';

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
}

const SKETCH_GAP = 32;
const POINT_NEAR = 18;

function shortIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = [...ids].sort();
  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i]!;
    let n = Math.min(4, id.length);
    const clash = (other: string | undefined) => other !== undefined && other !== id && other.slice(0, n) === id.slice(0, n);
    while (n < id.length && (clash(sorted[i - 1]) || clash(sorted[i + 1]))) n++;
    out.set(id, id.slice(0, n));
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
      words: kind === 'frame' ? oneLine(e.name) : kind === 'text' ? oneLine(e.text) : oneLine(label?.text),
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
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const boxes = strokes.map(boxOf);
  for (let i = 0; i < strokes.length; i++) {
    for (let j = i + 1; j < strokes.length; j++) {
      if ((strokes[i]!.frameId ?? null) !== (strokes[j]!.frameId ?? null)) continue;
      if (boxGap(boxes[i]!, boxes[j]!) <= SKETCH_GAP) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, number[]>();
  strokes.forEach((_, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), i]);
  });
  for (const members of clusters.values()) {
    const ids = members.map((i) => strokes[i]!.id).sort();
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
const quote = (words: string, max = 90) => JSON.stringify(words.length > max ? `${words.slice(0, max - 1)}…` : words);

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

/** One freehand stroke in plain words: a dot, a closed loop, a straight line, or which way a curve opens. */
function strokeWords(el: CanvasElement, cluster: Box): string {
  const points = el.points ?? [];
  const box = boxOf(el);
  const diag = Math.hypot(box.w, box.h);
  const clusterDiag = Math.hypot(cluster.w, cluster.h) || 1;
  const where = spot(box, cluster);
  if (points.length < 2 || diag < Math.max(6, clusterDiag * 0.04)) return `a dot at the ${where}`;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]![0]! - points[i - 1]![0]!, points[i]![1]! - points[i - 1]![1]!);
  const chord = Math.hypot(last[0]! - first[0]!, last[1]! - first[1]!);
  const size = diag > clusterDiag * 0.6 ? 'large' : diag < clusterDiag * 0.25 ? 'small' : 'medium';
  const whole = boxContains({ x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 }, cluster) || diag > clusterDiag * 0.85;
  const span = whole ? 'around the whole sketch' : `at the ${where}`;
  if (chord < diag * 0.25 && length > diag * 1.8) {
    return `a ${size} closed loop ${span}`;
  }
  if (length < chord * 1.12) {
    const flat = Math.abs(last[0]! - first[0]!) >= Math.abs(last[1]! - first[1]!) * 2;
    const tall = Math.abs(last[1]! - first[1]!) >= Math.abs(last[0]! - first[0]!) * 2;
    return `a ${size} ${flat ? 'flat' : tall ? 'upright' : 'slanted'} line ${span}`;
  }
  // A curve: which side of the line between its ends does its middle fall on?
  const mid = points[Math.floor(points.length / 2)]!;
  const mx = (first[0]! + last[0]!) / 2;
  const my = (first[1]! + last[1]!) / 2;
  const flatish = Math.abs(last[0]! - first[0]!) >= Math.abs(last[1]! - first[1]!);
  if (length > chord * 2.6) return `a ${size} squiggle ${span}`;
  const bend = flatish ? (mid[1]! > my ? 'ends up, like a smile' : 'ends down, like an arch') : mid[0]! > mx ? 'bulging right' : 'bulging left';
  return `a ${size} curve (${bend}) ${span}`;
}

function sketchWords(t: Thing, scene: CanvasScene, things: Thing[]): string {
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const strokes = t.elementIds.map((id) => byId.get(id)).filter((e): e is CanvasElement => !!e);
  const ranked = strokes.slice().sort((a, b) => {
    const A = boxOf(a);
    const B = boxOf(b);
    return B.w * B.h - A.w * A.h;
  });
  const shown = ranked.slice(0, 8).map((s) => strokeWords(s, t.box));
  const counts = new Map<string, number>();
  for (const w of shown) counts.set(w, (counts.get(w) ?? 0) + 1);
  const parts = [...counts].map(([w, n]) => (n > 1 ? `${n}x ${w.replace(/^an? /, '')}` : w));
  if (ranked.length > 8) parts.push(`${ranked.length - 8} more`);
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

/** One line for a thing, without its indent. */
export function lineOf(t: Thing, scene: CanvasScene, things: Thing[]): string {
  const end = (e: Thing['from']) => (e ? `${e.attached ? '' : '~'}${e.id}` : '(open)');
  switch (t.kind) {
    case 'frame': {
      const holds = things.filter((o) => o.frame === t.id).length;
      return `frame ${t.id} ${quote(t.words || 'untitled')} ${place(t.box)}, holds ${holds}`;
    }
    case 'arrow':
    case 'line': {
      const ends = t.kind === 'arrow' || t.from || t.to ? ` ${end(t.from)} -> ${end(t.to)}` : '';
      const loose = !t.from && !t.to ? ` ${place(t.box)}` : '';
      return `${t.kind} ${t.id}${ends}${t.words ? ` ${quote(t.words)}` : ''}${loose}${look(t)}`;
    }
    case 'sketch':
      return `sketch ${t.id} ${place(t.box)}${look(t)}: ${sketchWords(t, scene, things)}`;
    case 'picture':
      return `picture ${t.id} ${place(t.box)}`;
    default:
      return `${t.kind} ${t.id}${t.words ? ` ${quote(t.words)}` : ''} ${place(t.box)}${look(t)}`;
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
}

export interface Reading {
  lines: string[];
  /** How many things the filter matched in all. */
  total: number;
  /** The id of the last thing shown when lines were left out. */
  cutAfter?: string;
  box: Box;
}

export function readThings(scene: CanvasScene, things: Thing[], options: ReadOptions = {}): Reading {
  let chosen = things;
  if (options.frame) chosen = chosen.filter((t) => t.id === options.frame || t.frame === options.frame);
  if (options.only) chosen = chosen.filter((t) => options.only!.has(t.id));
  const total = chosen.length;
  const box = unionBox(chosen.map((t) => t.box));
  let start = 0;
  if (options.after) {
    const at = chosen.findIndex((t) => t.id === options.after);
    if (at >= 0) start = at + 1;
  }
  const limit = Math.max(1, options.limit ?? 150);
  const page = chosen.slice(start, start + limit);
  const lines = page.map((t) => `${t.frame && chosen.some((o) => o.id === t.frame) ? '  ' : ''}${lineOf(t, scene, things)}`);

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
  return { lines, total, cutAfter: start + limit < chosen.length ? page[page.length - 1]?.id : undefined, box };
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
