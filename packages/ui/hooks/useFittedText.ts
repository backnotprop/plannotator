import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { fitText, fontOf, observeWidth, onFontsChanged, type FitKind } from '../utils/textFit';

export function useFittedText(ref: RefObject<HTMLElement | null>, text: string, kind: FitKind, fontKey?: string): string {
  const [fitted, setFitted] = useState(text);
  const available = useRef(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const compute = (width: number) => {
      available.current = width;
      return fitText(kind, text, width, fontOf(element, fontKey));
    };
    setFitted(available.current > 0 ? compute(available.current) : text);
    const stop = observeWidth(element, (width) => {
      const next = compute(width);
      flushSync(() => setFitted(next));
    });
    const off = onFontsChanged(() => {
      if (available.current > 0) setFitted(compute(available.current));
    });
    return () => {
      stop();
      off();
    };
  }, [ref, text, kind, fontKey]);
  return fitted;
}
