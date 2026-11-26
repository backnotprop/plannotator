/**
 * A thread's canvas is one Excalidraw scene: Excalidraw's own JSON, stored as
 * it is (a `.excalidraw` file opens it anywhere). These are the fields of it
 * that the Inbox reads and writes without the editor: the server and an
 * agent's calls never load Excalidraw.
 */
export interface CanvasElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  isDeleted?: boolean;
  version?: number;
  versionNonce?: number;
  updated?: number;
  groupIds?: string[];
  frameId?: string | null;
  boundElements?: { id: string; type: string }[] | null;
  text?: string;
  originalText?: string;
  containerId?: string | null;
  points?: number[][];
  startBinding?: { elementId: string; focus?: number; gap?: number } | null;
  endBinding?: { elementId: string; focus?: number; gap?: number } | null;
  strokeColor?: string;
  backgroundColor?: string;
  name?: string | null;
  fileId?: string | null;
  customData?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CanvasScene {
  type: 'excalidraw';
  version: 2;
  source: string;
  elements: CanvasElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/**
 * What an element looks like to a reader, as one short string: where it is, its size, words, colours, what it is tied
 * to, whether it is gone. Two states with the same look are the same to a person and to an agent; the editor's
 * re-stamping (a version bump with nothing changed, a label's measured width) does not change it. This is what
 * "shown" and "unchanged since" are judged by, never a revision count or a log.
 */
export function lookOf(el: CanvasElement): string {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
  // A label's own place and size follow its container and its measured text: not part of its look.
  const bound = el.type === 'text' && !!el.containerId;
  const points = el.points ?? [];
  const last = points[points.length - 1];
  const parts = [
    el.type,
    el.isDeleted ? 'x' : '',
    bound ? '' : `${n(el.x)},${n(el.y)}`,
    bound || el.type === 'text' ? '' : `${n(el.width)}x${n(el.height)}`,
    typeof el.text === 'string' ? el.originalText ?? el.text : '',
    typeof el.name === 'string' ? el.name : '',
    el.strokeColor ?? '',
    el.backgroundColor ?? '',
    el.frameId ?? '',
    el.containerId ?? '',
    el.startBinding?.elementId ?? '',
    el.endBinding?.elementId ?? '',
    typeof el.fileId === 'string' ? el.fileId : '',
    points.length ? `${points.length}:${n(last?.[0])},${n(last?.[1])}` : '',
  ];
  // FNV-1a, so the record stays small whatever the words are.
  let h = 0x811c9dc5;
  const text = parts.join('\u0001');
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export const CANVAS_SOURCE = 'https://plannotator.ai';

export function emptyScene(): CanvasScene {
  return { type: 'excalidraw', version: 2, source: CANVAS_SOURCE, elements: [], appState: {}, files: {} };
}

/** A scene from anything: a wrong shape gives an empty scene, never a throw. */
export function asScene(value: unknown): CanvasScene {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const elements = Array.isArray(v.elements) ? v.elements.map(asElement).filter((e): e is CanvasElement => e !== null) : [];
  const appState = v.appState && typeof v.appState === 'object' && !Array.isArray(v.appState) ? (v.appState as Record<string, unknown>) : {};
  const files = v.files && typeof v.files === 'object' && !Array.isArray(v.files) ? (v.files as Record<string, unknown>) : {};
  return { type: 'excalidraw', version: 2, source: typeof v.source === 'string' ? v.source : CANVAS_SOURCE, elements, appState, files };
}

/**
 * An element from anywhere (a file a person opened can hold anything). One with an id and a type is kept, and its
 * place and size are made numbers: a number written as text is that number, anything else is 0. The editor keeps such
 * an element too, so dropping it here would leave the window holding a thing the Inbox does not.
 */
function asElement(value: unknown): CanvasElement | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 200 || typeof e.type !== 'string') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
  if (Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.width) && Number.isFinite(e.height)) return e as CanvasElement;
  return { ...e, x: n(e.x), y: n(e.y), width: n(e.width), height: n(e.height) } as CanvasElement;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where an element is, as an upright box (a line's points are relative to its x and y). */
export function boxOf(el: CanvasElement): Box {
  if (el.points && el.points.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of el.points) {
      const px = Number(p[0]) || 0;
      const py = Number(p[1]) || 0;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    return { x: el.x + minX, y: el.y + minY, w: maxX - minX, h: maxY - minY };
  }
  const w = Math.abs(el.width);
  const h = Math.abs(el.height);
  return { x: el.width < 0 ? el.x - w : el.x, y: el.height < 0 ? el.y - h : el.y, w, h };
}

export function unionBox(boxes: Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The gap between two boxes: 0 when they touch or overlap. */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

export function boxContains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function centerOf(b: Box): [number, number] {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

export function live(scene: CanvasScene): CanvasElement[] {
  return scene.elements.filter((e) => !e.isDeleted);
}

/**
 * A text element's words as they were written. Excalidraw keeps them in `originalText`; its `text` is the same words
 * with the line breaks its own wrapping put in to draw them (a label wraps to its box). Reading, naming and comparing
 * go by the words, never by how they happen to be broken on screen.
 */
export function wordsOf(el: CanvasElement | undefined | null): string {
  if (!el) return '';
  if (typeof el.originalText === 'string' && el.originalText !== '') return el.originalText;
  return typeof el.text === 'string' ? el.text : '';
}

/** How far from the rest of a drawing a thing may be, and how large, before it is taken for a mistake in a file. */
export const FAR_REACH = 250_000;
const FAR_SIZE = 20_000;

/**
 * The elements that are nowhere near the rest: farther than `FAR_REACH` from the middle one, or larger than that. A
 * file can hold a box a billion pixels away; counted in, the drawing reads as a billion pixels wide and the editor
 * stops drawing. A drawing of one thing has no "rest", so nothing in it is far.
 */
export function farElements(elements: readonly CanvasElement[]): Set<string> {
  const out = new Set<string>();
  const shown = elements.filter((e) => !e.isDeleted);
  if (shown.length === 0) return out;
  const boxes = shown.map(boxOf);
  const mid = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]!;
  const cx = mid(boxes.map((b) => b.x + b.w / 2));
  const cy = mid(boxes.map((b) => b.y + b.h / 2));
  shown.forEach((el, i) => {
    const b = boxes[i]!;
    const off = Math.max(Math.abs(b.x + b.w / 2 - cx), Math.abs(b.y + b.h / 2 - cy));
    if (!(off <= FAR_REACH) || !(b.w <= FAR_REACH) || !(b.h <= FAR_REACH)) out.add(el.id);
  });
  return out;
}

/**
 * Far-off elements brought beside the rest of the drawing (the window does this to a file a person opens). Those that
 * sit together stay together; one too large is made a size that can be drawn. `moved`: the ids that changed (the
 * caller gives them a new version).
 */
export function tameFar(elements: readonly CanvasElement[]): { elements: CanvasElement[]; moved: string[] } {
  const far = farElements(elements);
  if (far.size === 0) return { elements: elements.slice(), moved: [] };
  const near = elements.filter((e) => !e.isDeleted && !far.has(e.id));
  const ground = unionBox(near.map(boxOf));
  const strays = elements.filter((e) => far.has(e.id));
  // Too large to draw: made a size that can be, before it is placed.
  const sized = new Map<string, CanvasElement>();
  for (const el of strays) {
    const b = boxOf(el);
    const k = Math.min(1, FAR_SIZE / Math.max(b.w, b.h, 1));
    sized.set(el.id, k === 1 ? el : { ...el, width: el.width * k, height: el.height * k, ...(el.points ? { points: el.points.map((p) => p.map((v) => (Number(v) || 0) * k)) } : {}) });
  }
  const all = unionBox([...sized.values()].map(boxOf));
  const together = all.w <= FAR_SIZE && all.h <= FAR_SIZE;
  // Where each goes: beside the rest, in the arrangement they had when they sit together, else one after another.
  const delta = new Map<string, [number, number]>();
  let n = 0;
  for (const stray of sized.values()) {
    if (stray.type === 'text' && stray.containerId && sized.has(stray.containerId)) continue;
    const b = boxOf(stray);
    const home = together ? { x: ground.x + ground.w + 120 + (b.x - all.x), y: ground.y + (b.y - all.y) } : { x: ground.x + ground.w + 120 + n * 40, y: ground.y + n++ * 40 };
    delta.set(stray.id, [home.x - b.x, home.y - b.y]);
  }
  const out = elements.map((el) => {
    const stray = sized.get(el.id);
    if (!stray) return el;
    // A label goes where its shape goes.
    const [dx, dy] = delta.get(stray.id) ?? delta.get(String(stray.containerId)) ?? [0, 0];
    return { ...stray, x: Math.round(stray.x + dx), y: Math.round(stray.y + dy) };
  });
  return { elements: out, moved: [...far] };
}

/**
 * How a picture of a part of the canvas is cut so it can be read. One picture is at most `max` pixels on its long
 * side; a strip many times longer than it is wide (a tall screenshot) would come out a sliver, so it is cut along its
 * length into pieces that each show it at a readable size, in order (top to bottom, or left to right).
 */
export function pictureTiles(box: Box, max = 2400, most = 8): Box[] {
  const long = Math.max(box.w, box.h);
  const short = Math.max(1, Math.min(box.w, box.h));
  if (long <= max || long / short < 3) return [box];
  const count = Math.min(most, Math.ceil(long / max));
  const step = long / count;
  const lap = Math.min(40, step / 10);
  const tiles: Box[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.max(0, i * step - lap);
    const to = Math.min(long, (i + 1) * step + lap);
    tiles.push(box.h >= box.w ? { x: box.x, y: box.y + from, w: box.w, h: to - from } : { x: box.x + from, y: box.y, w: to - from, h: box.h });
  }
  return tiles;
}

const PALETTE: [string, [number, number, number]][] = [
  ['black', [30, 30, 30]],
  ['gray', [134, 142, 150]],
  ['red', [224, 49, 49]],
  ['pink', [194, 37, 92]],
  ['violet', [103, 65, 217]],
  ['blue', [25, 113, 194]],
  ['teal', [12, 133, 153]],
  ['green', [47, 158, 68]],
  ['yellow', [240, 140, 0]],
  ['orange', [232, 89, 12]],
  ['white', [255, 255, 255]],
];

/** What an agent may call a colour, and the Excalidraw stroke and fill it means. */
export const COLOR_NAMES: Record<string, { stroke: string; fill: string }> = {
  black: { stroke: '#1e1e1e', fill: '#e9ecef' },
  gray: { stroke: '#868e96', fill: '#e9ecef' },
  red: { stroke: '#e03131', fill: '#ffc9c9' },
  pink: { stroke: '#c2255c', fill: '#fcc2d7' },
  violet: { stroke: '#6741d9', fill: '#d0bfff' },
  blue: { stroke: '#1971c2', fill: '#a5d8ff' },
  teal: { stroke: '#0c8599', fill: '#99e9f2' },
  green: { stroke: '#2f9e44', fill: '#b2f2bb' },
  yellow: { stroke: '#f08c00', fill: '#ffec99' },
  orange: { stroke: '#e8590c', fill: '#ffd8a8' },
};

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** The nearest plain colour word for a stroke or fill, or '' for none (transparent). */
export function colorWord(color: unknown): string {
  if (typeof color !== 'string' || !color || color === 'transparent') return '';
  const rgb = parseHex(color);
  // Anything but a hex colour or a plain colour word is not repeated: a file can hold any string here.
  if (!rgb) return /^[a-z]{3,20}$/.test(color) ? color : '';
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  // A pale tint is named by its hue: Excalidraw's fills are tints of its strokes.
  if (max - min < 24) return max > 248 ? 'white' : max < 70 ? 'black' : 'gray';
  let best = '';
  let bestD = Infinity;
  const [h1, s1] = hueSat(rgb);
  for (const [name, c] of PALETTE) {
    if (name === 'black' || name === 'gray' || name === 'white') continue;
    const [h2] = hueSat(c);
    const dh = Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2));
    const d = dh + (s1 < 0.08 ? 400 : 0);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

function hueSat([r, g, b]: [number, number, number]): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return [0, 0];
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, d / max];
}
