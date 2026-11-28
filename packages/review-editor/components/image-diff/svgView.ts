import { useSyncExternalStore } from 'react';

export type SvgView = 'image' | 'source';

export function isSvgPath(path: string | undefined | null): boolean {
  return !!path && /\.svg$/i.test(path);
}

const sourcePaths = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSvgView(path: string, view: SvgView): void {
  const had = sourcePaths.has(path);
  if (view === 'source' === had) return;
  if (view === 'source') sourcePaths.add(path);
  else sourcePaths.delete(path);
  version += 1;
  for (const listener of listeners) listener();
}

export function svgViewOf(path: string): SvgView {
  return sourcePaths.has(path) ? 'source' : 'image';
}

export function resetSvgViewsForTests(): void {
  sourcePaths.clear();
  version += 1;
}

export function useSvgView(path: string): SvgView {
  return useSyncExternalStore(subscribe, () => svgViewOf(path), () => svgViewOf(path));
}

export function useSvgViewVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}
