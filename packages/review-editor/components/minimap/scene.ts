import type { DiffLayoutItem, LineSide } from './layoutSource';
import { ROW_ADD, ROW_DEL, bodyHeight, rowAtOffset, rowForLine, rowOffset, type FileRowModel, type RowMetrics } from './rowModel';

export type MinimapKind = 'add' | 'del' | 'comment' | 'thread' | 'moved' | 'renamed' | 'reformatted' | (string & {});

export interface MinimapMark {
  itemId: string;
  kind: MinimapKind;
  side: LineSide;
  lineStart: number;
  lineEnd: number;
}

export interface MinimapFile {
  id: string;
  path: string;
  model: FileRowModel;
  viewed: boolean;
}

export interface PlacedFile {
  id: string;
  path: string;
  model: FileRowModel;
  viewed: boolean;
  collapsed: boolean;
  top: number;
  height: number;
  bodyTop: number;
  scale: number;
}

export interface MinimapLayout {
  contentHeight: number;
  files: PlacedFile[];
}

export interface Band {
  kind: MinimapKind;
  top: number;
  height: number;
  dim: boolean;
  weight?: number;
}

export const FILE_SEGMENT_MIN_PX = 3;

export function heaviness(lines: number, ceiling: number): number {
  if (lines <= 0) return 0;
  return Math.min(1, Math.log1p(lines) / Math.log1p(Math.max(ceiling, 1)));
}

export function placeFiles(items: readonly DiffLayoutItem[], files: ReadonlyMap<string, MinimapFile>, metrics: RowMetrics, contentHeight: number): MinimapLayout {
  const placed: PlacedFile[] = [];
  for (const item of items) {
    const file = files.get(item.id);
    if (!file) continue;
    const bodyTop = item.top + metrics.headerHeight;
    const modelBody = bodyHeight(file.model, metrics);
    const actualBody = item.height - metrics.headerHeight - (file.model.rows > 0 ? metrics.paddingBottom : 0);
    placed.push({
      id: item.id,
      path: file.path,
      model: file.model,
      viewed: file.viewed,
      collapsed: item.collapsed,
      top: item.top,
      height: item.height,
      bodyTop,
      scale: item.collapsed || modelBody <= 0 || actualBody <= 0 ? 0 : actualBody / modelBody,
    });
  }
  return { contentHeight, files: placed };
}

function rowBand(file: PlacedFile, kind: MinimapKind, start: number, end: number, metrics: RowMetrics): Band {
  const top = file.bodyTop + rowOffset(file.model, start, metrics) * file.scale;
  const bottom = file.bodyTop + rowOffset(file.model, end, metrics) * file.scale;
  return { kind, top, height: Math.max(0, bottom - top), dim: file.viewed };
}

export function changeBands(layout: MinimapLayout, metrics: RowMetrics, stripPxPerContent = Infinity): Band[] {
  const bands: Band[] = [];
  let ceiling = 20;
  for (const file of layout.files) ceiling = Math.max(ceiling, file.model.additions, file.model.deletions);
  for (const file of layout.files) {
    if (file.scale === 0) continue;
    if (file.height * stripPxPerContent < FILE_SEGMENT_MIN_PX) {
      for (const [kind, lines] of [['add', file.model.additions], ['del', file.model.deletions]] as const) {
        const weight = heaviness(lines, ceiling);
        if (weight > 0) bands.push({ kind, top: file.top, height: file.height, dim: file.viewed, weight });
      }
      continue;
    }
    const { flags, rows } = file.model;
    for (const [flag, kind] of [[ROW_ADD, 'add'], [ROW_DEL, 'del']] as const) {
      let start = -1;
      for (let r = 0; r <= rows; r++) {
        const on = r < rows && (flags[r] & flag) !== 0;
        if (on && start < 0) start = r;
        if (!on && start >= 0) {
          bands.push(rowBand(file, kind, start, r, metrics));
          start = -1;
        }
      }
    }
  }
  return bands;
}

export function markBands(layout: MinimapLayout, marks: readonly MinimapMark[], metrics: RowMetrics): Band[] {
  const byId = new Map(layout.files.map((file) => [file.id, file]));
  const bands: Band[] = [];
  for (const mark of marks) {
    const file = byId.get(mark.itemId);
    if (!file) continue;
    if (file.scale === 0) {
      bands.push({ kind: mark.kind, top: file.top, height: Math.max(1, file.height), dim: file.viewed });
      continue;
    }
    const first = rowForLine(file.model, mark.lineStart, mark.side);
    const last = rowForLine(file.model, mark.lineEnd, mark.side);
    if (first < 0 && last < 0) continue;
    const start = Math.max(0, first < 0 ? last : first);
    const end = Math.max(start, last) + 1;
    bands.push(rowBand(file, mark.kind, start, end, metrics));
  }
  return bands;
}

export type Coverage = Map<string, Float32Array>;

export function coverageKey(kind: MinimapKind, dim: boolean): string {
  return dim ? `${kind}:dim` : kind;
}

const DENSITY_KINDS = new Set(['add', 'del']);

function smooth(column: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return column;
  const out = new Float32Array(column.length);
  const width = radius * 2 + 1;
  let sum = 0;
  for (let i = -radius; i < column.length + radius; i++) {
    if (i + radius < column.length) sum += column[i + radius];
    if (i - radius - 1 >= 0) sum -= column[i - radius - 1];
    if (i >= 0 && i < column.length) out[i] = sum / width;
  }
  return out;
}

export function rasterize(bands: readonly Band[], contentHeight: number, bins: number, options: { smoothRadius?: number; minSegmentBins?: number } = {}): Coverage {
  const out: Coverage = new Map();
  if (contentHeight <= 0 || bins <= 0) return out;
  const k = bins / contentHeight;
  const lines = new Map<string, Float32Array>();
  const segments = new Map<string, Float32Array>();
  const column = (map: Map<string, Float32Array>, key: string) => {
    let found = map.get(key);
    if (!found) {
      found = new Float32Array(bins);
      map.set(key, found);
    }
    return found;
  };
  for (const band of bands) {
    const key = coverageKey(band.kind, band.dim);
    let a = Math.max(0, band.top * k);
    let b = Math.min(bins, Math.max(a + 1e-6, (band.top + band.height) * k));
    if (band.weight != null) {
      const min = options.minSegmentBins ?? 1;
      if (b - a < min) b = Math.min(bins, a + min);
      if (b - a < min) a = Math.max(0, b - min);
      const target = column(segments, key);
      for (let bin = Math.floor(a); bin < Math.ceil(b) && bin < bins; bin++) target[bin] = Math.max(target[bin], band.weight);
      continue;
    }
    const target = column(lines, key);
    for (let bin = Math.floor(a); bin < Math.ceil(b) && bin < bins; bin++) {
      target[bin] += Math.min(bin + 1, b) - Math.max(bin, a);
    }
  }
  for (const [key, values] of lines) out.set(key, DENSITY_KINDS.has(key.replace(/:dim$/, '')) ? smooth(values, options.smoothRadius ?? 0) : values);
  for (const [key, values] of segments) {
    const merged = column(out, key);
    for (let i = 0; i < bins; i++) merged[i] = Math.max(merged[i], values[i]);
  }
  return out;
}

export function fileBoundaries(layout: MinimapLayout): number[] {
  return layout.files.slice(1).map((file) => file.top);
}

export interface MinimapHit {
  file: PlacedFile;
  line: number | null;
  side: LineSide;
}

export function hitTest(layout: MinimapLayout, y: number, metrics: RowMetrics): MinimapHit | null {
  const files = layout.files;
  if (files.length === 0) return null;
  let lo = 0;
  let hi = files.length - 1;
  let index = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid].top <= y) {
      index = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const file = files[index];
  if (file.scale === 0 || y < file.bodyTop || file.model.rows === 0) return { file, line: null, side: 'new' };
  const row = rowAtOffset(file.model, (y - file.bodyTop) / file.scale, metrics);
  const newNo = file.model.newLine[row];
  const oldNo = file.model.oldLine[row];
  if (newNo > 0) return { file, line: newNo, side: 'new' };
  if (oldNo > 0) return { file, line: oldNo, side: 'old' };
  return { file, line: null, side: 'new' };
}

export function lineTop(layout: MinimapLayout, id: string, line: number, side: LineSide, metrics: RowMetrics): number | null {
  const file = layout.files.find((candidate) => candidate.id === id);
  if (!file || file.scale === 0) return null;
  const row = rowForLine(file.model, line, side);
  if (row < 0) return null;
  return file.bodyTop + rowOffset(file.model, row, metrics) * file.scale;
}
