import { useEffect, useRef } from 'react';

interface ModalFocusLifecycleOptions {
  dismissOnEscape?: boolean;
  fallbackFocusId?: string;
}

/**
 * Gives legacy custom modal shells the minimum keyboard lifecycle provided by
 * the shared dialog primitive: Escape dismissal and focus restoration. New
 * dialogs should still prefer the shared Base UI wrapper.
 */
export function useModalFocusLifecycle(
  active: boolean,
  onClose: () => void,
  {
    dismissOnEscape = true,
    fallbackFocusId,
  }: ModalFocusLifecycleOptions = {},
): void {
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const fallbackFocusIdRef = useRef(fallbackFocusId);
  const dismissOnEscapeRef = useRef(dismissOnEscape);
  onCloseRef.current = onClose;
  fallbackFocusIdRef.current = fallbackFocusId;
  dismissOnEscapeRef.current = dismissOnEscape;
  if (!active) {
    restoreFocusRef.current = null;
  } else if (restoreFocusRef.current === null && typeof document !== 'undefined') {
    const activeElement = document.activeElement;
    restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
  }

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = restoreFocusRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!dismissOnEscapeRef.current || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const fallbackId = fallbackFocusIdRef.current;
      const fallback = fallbackId ? document.getElementById(fallbackId) : null;
      const focusTarget = fallback ?? (previouslyFocused?.isConnected ? previouslyFocused : null);
      if (!focusTarget) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
      });
    };
  }, [active]);
}
