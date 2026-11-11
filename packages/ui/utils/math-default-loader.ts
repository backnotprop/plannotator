import type { MathRenderer } from './math';

export function loadDefaultMathRenderer(): Promise<MathRenderer> {
  return import('katex').then((m) => m.default);
}
