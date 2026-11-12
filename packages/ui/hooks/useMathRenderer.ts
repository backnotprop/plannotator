import { useEffect, useSyncExternalStore } from 'react';
import {
  getMathRenderer,
  loadMathRenderer,
  subscribeMathRenderer,
  type MathRenderer,
} from '../utils/math';

export function useMathRenderer(): MathRenderer | null {
  const renderer = useSyncExternalStore(subscribeMathRenderer, getMathRenderer, getMathRenderer);

  useEffect(() => {
    if (renderer) return;
    loadMathRenderer().catch(() => {
    });
  }, [renderer]);

  return renderer;
}
