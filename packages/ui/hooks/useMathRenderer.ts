import { useEffect, useSyncExternalStore } from 'react';
import {
  getMathRenderer,
  loadMathRenderer,
  subscribeMathRenderer,
  type MathRenderer,
} from '../utils/math';

/**
 * The registered math renderer, read synchronously during render.
 *
 * With the slot filled before mount (Plannotator: `utils/math-eager`) this
 * returns KaTeX on the first render and the effect below is a no-op, so the
 * typeset HTML is in the first commit. With the slot empty it returns `null`,
 * kicks off `loadMathRenderer()` from an effect, and the subscription
 * re-renders the caller once the renderer lands. A rejected load is left to
 * the loader's retry contract; the caller keeps showing the TeX placeholder.
 */
export function useMathRenderer(): MathRenderer | null {
  const renderer = useSyncExternalStore(subscribeMathRenderer, getMathRenderer, getMathRenderer);

  useEffect(() => {
    if (renderer) return;
    loadMathRenderer().catch(() => {
      /* placeholder stays; the next mount retries */
    });
  }, [renderer]);

  return renderer;
}
