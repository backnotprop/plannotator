import type { KatexOptions } from 'katex';
import { loadDefaultMathRenderer } from './math-default-loader';

export interface MathRenderer {
  renderToString(tex: string, options?: KatexOptions): string;
}

export type MathRendererLoader = () => Promise<MathRenderer>;

export type MathRendererSource = 'plannotator-math-eager' | 'loader' | 'host';

let renderer: MathRenderer | null = null;
let rendererSource: MathRendererSource | null = null;
let loader: MathRendererLoader | null = null;
let pending: Promise<MathRenderer> | null = null;
let resetEpoch = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getMathRenderer(): MathRenderer | null {
  return renderer;
}

export function getMathRendererSource(): MathRendererSource | null {
  return rendererSource;
}

export function setMathRenderer(next: MathRenderer, source: MathRendererSource = 'host'): void {
  if (renderer === next) return;
  renderer = next;
  rendererSource = source;
  notify();
}

export function subscribeMathRenderer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setMathRendererLoader(next: MathRendererLoader | null): void {
  loader = next;
  pending = null;
}

export function getMathRendererLoader(): MathRendererLoader | null {
  return loader;
}

export function loadMathRenderer(): Promise<MathRenderer> {
  if (renderer) return Promise.resolve(renderer);
  if (!pending) {
    const epoch = resetEpoch;
    const attempt = (loader ? loader() : loadDefaultMathRenderer()).then(
      (loaded) => {
        if (epoch === resetEpoch) setMathRenderer(loaded, 'loader');
        return loaded;
      },
      (err: unknown) => {
        if (pending === attempt) pending = null;
        throw err;
      },
    );
    pending = attempt;
  }
  return pending;
}

export function resetMathRenderer(): void {
  renderer = null;
  rendererSource = null;
  pending = null;
  resetEpoch += 1;
  notify();
}

export const normalizeMathTex = (tex: string): string => tex.trim();

export function renderMathToHtml(
  tex: string,
  displayMode: boolean,
  activeRenderer: MathRenderer | null = renderer,
): string | null {
  if (!activeRenderer) return null;
  return activeRenderer.renderToString(tex, {
    displayMode,
    throwOnError: false,
    strict: 'warn',
    trust: false,
    output: 'html',
  });
}
