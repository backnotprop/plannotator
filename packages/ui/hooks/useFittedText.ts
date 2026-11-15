import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { fitText, fontOf, naturalWidth, observeWidth, onFontsChanged, type FitKind } from '../utils/textFit';

export function useFittedText(ref: RefObject<HTMLElement | null>, text: string, kind: FitKind, fontKey?: string): { text: string; natural?: number } {
  const [state, setState] = useState<{ text: string; natural?: number }>({ text });
  const available = useRef(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const compute = (width: number) => {
      available.current = width;
      const font = fontOf(element, fontKey);
      const natural = naturalWidth(text, font);
      const next = fitText(kind, text, width, font);
      return (before: { text: string; natural?: number }) => (before.text === next && before.natural === natural ? before : { text: next, natural });
    };
    const whole = () => {
      const natural = naturalWidth(text, fontOf(element, fontKey));
      return (before: { text: string; natural?: number }) => (before.text === text && before.natural === natural ? before : { text, natural });
    };
    setState(available.current > 0 ? compute(available.current) : whole());
    const stop = observeWidth(element, (width) => {
      const update = compute(width);
      flushSync(() => setState(update));
    });
    const off = onFontsChanged(() => {
      setState(available.current > 0 ? compute(available.current) : whole());
    });
    return () => {
      stop();
      off();
    };
  }, [ref, text, kind, fontKey]);
  return state;
}
