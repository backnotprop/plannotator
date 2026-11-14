export interface Size {
  width: number;
  height: number;
}

export type ImageZoom = 'fit' | 'actual';

export const SIDE_BY_SIDE_GAP = 16;
export const SIDE_BY_SIDE_MIN_WIDTH = 480;

export interface StageLayout {
  scale: number;
  stage: Size;
  old: Size | null;
  new: Size | null;
  offsetX: number;
  pixelated: boolean;
}

export function snapToDevice(value: number, dpr: number): number {
  const ratio = dpr > 0 ? dpr : 1;
  return Math.round(value * ratio) / ratio;
}

export function floorToDevice(value: number, dpr: number): number {
  const ratio = dpr > 0 ? dpr : 1;
  return Math.floor(value * ratio + 1e-6) / ratio;
}

export function unionCanvas(a: Size | null, b: Size | null): Size {
  return {
    width: Math.max(a?.width ?? 0, b?.width ?? 0),
    height: Math.max(a?.height ?? 0, b?.height ?? 0),
  };
}

export function fitScale(canvas: Size, available: Size): number {
  if (canvas.width <= 0 || canvas.height <= 0 || available.width <= 0 || available.height <= 0) return 1;
  return Math.min(1, available.width / canvas.width, available.height / canvas.height);
}

export function sideBySideColumns(canvas: Size, width: number): boolean {
  if (width <= 0 || canvas.width <= 0) return false;
  return width >= SIDE_BY_SIDE_MIN_WIDTH || canvas.width * 2 + SIDE_BY_SIDE_GAP <= width;
}

export function sideBySidePaneWidth(width: number, columns: boolean): number {
  return columns ? Math.floor((width - SIDE_BY_SIDE_GAP) / 2) : width;
}

export function stageLayout(options: {
  old: Size | null;
  new: Size | null;
  available: Size;
  zoom: ImageZoom;
  dpr: number;
}): StageLayout {
  const canvas = unionCanvas(options.old, options.new);
  const scale = options.zoom === 'actual' ? 1 : fitScale(canvas, options.available);
  const size = (s: Size | null): Size | null =>
    s ? { width: floorToDevice(s.width * scale, options.dpr), height: floorToDevice(s.height * scale, options.dpr) } : null;
  const stage = size(canvas)!;
  return { scale, stage, old: size(options.old), new: size(options.new), offsetX: 0, pixelated: scale > 1 };
}

export function swipeClipX(position: number, stageWidth: number, dpr: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  return snapToDevice(clamped * stageWidth, dpr);
}

export function stepSwipe(position: number, key: string, shift: boolean): number | null {
  const step = shift ? 0.1 : 0.01;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, position - step);
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(1, position + step);
  if (key === 'Home') return 0;
  if (key === 'End') return 1;
  if (key === 'PageDown') return Math.max(0, position - 0.1);
  if (key === 'PageUp') return Math.min(1, position + 0.1);
  return null;
}
