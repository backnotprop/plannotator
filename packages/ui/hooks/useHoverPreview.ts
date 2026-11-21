import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the pointer rests on an anchor before the preview is fetched. */
export const HOVER_PREVIEW_SHOW_DELAY_MS = 150;
/** How long a preview stays after the pointer leaves, so it can move into the preview. */
export const HOVER_PREVIEW_HIDE_DELAY_MS = 200;

export interface HoverPreview<T> {
  /** The loaded preview while it is open, else null. */
  preview: T | null;
  /** Attach to the anchor element; the preview positions against it. */
  anchorRef: React.MutableRefObject<HTMLElement | null>;
  /** Pointer or focus arrives on the anchor: load after the show delay. */
  onEnter: () => void;
  /** Pointer or focus leaves the anchor: close after the hide delay. */
  onLeave: () => void;
  /** Spread onto the preview so moving into it keeps it open. */
  previewHandlers: { onMouseEnter: () => void; onMouseLeave: () => void };
  /** Close at once (a click, a scroll). */
  dismiss: () => void;
}

/**
 * Dwell-then-load hover for a floating preview: the timing shared by the
 * code-file link preview (InlineMarkdown) and Call Flow's source locations.
 * Nothing loads before the pointer rests for `HOVER_PREVIEW_SHOW_DELAY_MS`; a
 * load that resolves after the pointer left is dropped. `load` resolving
 * null means "nothing to show".
 */
export function useHoverPreview<T>(load: () => Promise<T | null>, enabled = true): HoverPreview<T> {
  const [preview, setPreview] = useState<T | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const anchorRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every leave so a load still in flight cannot open a stale preview.
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
