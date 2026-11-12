import { useCallback, useEffect, useRef, useState } from 'react';

export const HOVER_PREVIEW_SHOW_DELAY_MS = 150;
export const HOVER_PREVIEW_HIDE_DELAY_MS = 200;

export interface HoverPreview<T> {
  preview: T | null;
  anchorRef: React.MutableRefObject<HTMLElement | null>;
  onEnter: () => void;
  onLeave: () => void;
  previewHandlers: { onMouseEnter: () => void; onMouseLeave: () => void };
  dismiss: () => void;
}

export function useHoverPreview<T>(load: () => Promise<T | null>, enabled = true): HoverPreview<T> {
  const [preview, setPreview] = useState<T | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const anchorRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const cancelShow = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
  }, []);
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => setPreview(null), HOVER_PREVIEW_HIDE_DELAY_MS);
  }, [cancelHide]);

  const onEnter = useCallback(() => {
    if (!enabled) return;
    cancelHide();
    if (previewRef.current || showTimerRef.current) return;
    const generation = generationRef.current;
    showTimerRef.current = setTimeout(async () => {
      showTimerRef.current = null;
      try {
        const data = await loadRef.current();
        if (data != null && generation === generationRef.current) setPreview(data);
      } catch {}
    }, HOVER_PREVIEW_SHOW_DELAY_MS);
  }, [enabled, cancelHide]);

  const onLeave = useCallback(() => {
    cancelShow();
    generationRef.current += 1;
    scheduleHide();
  }, [cancelShow, scheduleHide]);

  const dismiss = useCallback(() => {
    cancelShow();
    cancelHide();
    generationRef.current += 1;
    setPreview(null);
  }, [cancelShow, cancelHide]);

  useEffect(() => () => {
    cancelShow();
    cancelHide();
  }, [cancelShow, cancelHide]);

  return {
    preview,
    anchorRef,
    onEnter,
    onLeave,
    previewHandlers: { onMouseEnter: cancelHide, onMouseLeave: scheduleHide },
    dismiss,
  };
}
