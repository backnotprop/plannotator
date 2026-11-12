import { useEffect, useState } from 'react';

export function subscribePrintMedia(setPrinting: (printing: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onBeforePrint = () => setPrinting(true);
  const onAfterPrint = () => setPrinting(false);
  const onVisibilityChange = () => {
    if (!document.hidden) setPrinting(false);
  };

  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', onAfterPrint);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const query = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
  const onMediaChange = (event: MediaQueryListEvent) => setPrinting(event.matches);
  query?.addEventListener?.('change', onMediaChange);
  if (query?.matches) setPrinting(true);

  return () => {
    window.removeEventListener('beforeprint', onBeforePrint);
    window.removeEventListener('afterprint', onAfterPrint);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    query?.removeEventListener?.('change', onMediaChange);
  };
}

export function usePrintMedia(callbacks?: { onEnter?: () => void; onExit?: () => void }): boolean {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    let active = false;
    return subscribePrintMedia((next) => {
      if (next === active) return;
      active = next;
      if (next) callbacks?.onEnter?.();
      else callbacks?.onExit?.();
      setPrinting(next);
    });
  }, []);

  return printing;
}
