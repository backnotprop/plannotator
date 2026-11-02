import { useLayoutEffect, useState } from 'react';
import type { ZoomClear } from '@plannotator/ui/components/imageZoom';

/** Under this height a picture keeps the whole stage: floating things over it beat a sliver between them (a very short window). */
const MIN_CLEAR_HEIGHT = 120;

/** The rows a probe leaves at its parent's top and bottom; none when it fills the parent. */
export function readClearRows(probe: HTMLElement): ZoomClear | undefined {
  const top = probe.offsetTop;
  const height = probe.offsetHeight;
  const bottom = (probe.parentElement?.clientHeight ?? 0) - top - height;
  if ((top <= 0 && bottom <= 0) || height < MIN_CLEAR_HEIGHT) return undefined;
  return { top, bottom };
}

/**
 * The rows a picture keeps clear (approvals "inbox-option-card-phone" and
 * "inbox-option-card-lean"). The stylesheet knows what floats over the picture
 * (a phone's size bar, toolbar and option card, a desktop's option card, the
 * comment box, and whether Hide or a minimized comment box took them), so it
 * says so on `.ib-imgclear`, a hidden box that fills the stage everywhere else: give the box `probe`, and `clear` follows it.
 * The stage itself stays whole, so every row still takes the fingers.
 */
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
    // The stage and a row can change by the same amount, which leaves the box's own size as it was.
    if (el.parentElement) observer.observe(el.parentElement);
    return () => observer.disconnect();
  }, [el]);
  return { probe, clear };
}
