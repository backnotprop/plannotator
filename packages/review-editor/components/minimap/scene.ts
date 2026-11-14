import type { DiffLayoutItem, LineSide } from './layoutSource';
import { ROW_ADD, ROW_DEL, bodyHeight, rowAtOffset, rowForLine, rowOffset, type FileRowModel, type RowMetrics } from './rowModel';

export type MinimapKind = 'add' | 'del' | 'comment' | (string & {});

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

export function changeBands(layout: MinimapLayout, metrics: RowMetrics): Band[] {
  const bands: Band[] = [];
  for (const file of layout.files) {
    if (file.scale === 0) continue;
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

export function rasterize(bands: readonly Band[], contentHeight: number, bins: number): Coverage {
  const out: Coverage = new Map();
  if (contentHeight <= 0 || bins <= 0) return out;
  const k = bins / contentHeight;
  for (const band of bands) {
    const key = coverageKey(band.kind, band.dim);
    let column = out.get(key);
    if (!column) {
      column = new Float32Array(bins);
      out.set(key, column);
    }
    const a = Math.max(0, band.top * k);
    const b = Math.min(bins, Math.max(a + 1e-6, (band.top + band.height) * k));
    for (let bin = Math.floor(a); bin < Math.ceil(b) && bin < bins; bin++) {
      column[bin] += Math.min(bin + 1, b) - Math.max(bin, a);
    }
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
