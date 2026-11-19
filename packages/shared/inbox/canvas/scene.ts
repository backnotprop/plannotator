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

export const CANVAS_SOURCE = 'https://plannotator.ai';

export function emptyScene(): CanvasScene {
  return { type: 'excalidraw', version: 2, source: CANVAS_SOURCE, elements: [], appState: {}, files: {} };
}

/** A scene from anything: a wrong shape gives an empty scene, never a throw. */
export function asScene(value: unknown): CanvasScene {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const elements = Array.isArray(v.elements) ? v.elements.filter(isElement) : [];
  const appState = v.appState && typeof v.appState === 'object' && !Array.isArray(v.appState) ? (v.appState as Record<string, unknown>) : {};
  const files = v.files && typeof v.files === 'object' && !Array.isArray(v.files) ? (v.files as Record<string, unknown>) : {};
  return { type: 'excalidraw', version: 2, source: typeof v.source === 'string' ? v.source : CANVAS_SOURCE, elements, appState, files };
}

function isElement(value: unknown): value is CanvasElement {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 200 &&
    typeof e.type === 'string' &&
    Number.isFinite(e.x) && Number.isFinite(e.y) &&
    Number.isFinite(e.width) && Number.isFinite(e.height)
  );
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
