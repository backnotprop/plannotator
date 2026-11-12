import { useLayoutEffect, useState } from 'react';
import type { ZoomClear } from '@plannotator/ui/components/imageZoom';

const MIN_CLEAR_HEIGHT = 120;

export function readClearRows(probe: HTMLElement): ZoomClear | undefined {
  const top = probe.offsetTop;
  const height = probe.offsetHeight;
  const bottom = (probe.parentElement?.clientHeight ?? 0) - top - height;
  if ((top <= 0 && bottom <= 0) || height < MIN_CLEAR_HEIGHT) return undefined;
  return { top, bottom };
}

export function useClearRows(): { probe: (el: HTMLElement | null) => void; clear: ZoomClear | undefined } {
  const [el, probe] = useState<HTMLElement | null>(null);
  const [clear, setClear] = useState<ZoomClear | undefined>(undefined);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const next = readClearRows(el);
      setClear((was) => (was?.top === next?.top && was?.bottom === next?.bottom ? was : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    if (el.parentElement) observer.observe(el.parentElement);
    return () => observer.disconnect();
  }, [el]);
  return { probe, clear };
}
