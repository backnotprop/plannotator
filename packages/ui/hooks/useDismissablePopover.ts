import { useEffect } from 'react';

/**
 * Outside-`pointerdown` + Escape dismissal for anchored popovers — the one
 * shared effect behind DecisionControl, ActionMenu, and ApproveDropdown.
 * (FloatingQuickLabelPicker deliberately keeps its own dismissal: it needs
 * deferred capture-phase registration so the click that opens it cannot
 * dismiss it, and its Escape shares a listener with the digit-select keys.)
 *
 * `dismissOnIframeFocus` is the explicit strategy for framed surfaces
 * (raw-HTML srcdoc, live-app proxy): a click inside the iframe never produces
 * a `pointerdown` in the parent document, but it does move focus into the
 * frame, which fires `blur` on the parent window. The check runs on the next
 * task because `document.activeElement` is not yet updated inside the blur
 * handler.
 */
export function useDismissablePopover({
  enabled,
  ref,
  onDismiss,
  dismissOnIframeFocus,
}: {
  enabled: boolean;
  ref: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
  dismissOnIframeFocus?: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current && ref.current.contains(target)) return;
      onDismiss();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Fail closed: an Escape that dismisses the popover is consumed here
      // (document bubbles before window), so the host apps' window-level
      // Escape ladders never also act on it — one Escape, one rung.
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };

    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const handleWindowBlur = () => {
      blurTimer = setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') onDismiss();
      }, 0);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    if (dismissOnIframeFocus) window.addEventListener('blur', handleWindowBlur);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      if (dismissOnIframeFocus) window.removeEventListener('blur', handleWindowBlur);
      if (blurTimer !== undefined) clearTimeout(blurTimer);
    };
  }, [enabled, ref, onDismiss, dismissOnIframeFocus]);
}
