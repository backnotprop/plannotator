import { useEffect } from "react";

export function useDismissOnOutsideAndEscape({
  enabled,
  ref,
  onDismiss,
}: {
  enabled: boolean;
  ref: React.RefObject<HTMLElement>;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;

    const handleMouseDown = (event: MouseEvent) => {
      // Don't dismiss on multi-click (double-click, triple-click). These
      // are part of an active selection gesture — the web-highlighter
      // CREATE handler already cleans up any stale pending highlight when
      // a new selection commits.  Dismissing here triggers DOM mutations
      // (mark removal + text-node normalisation) that reset the browser's
      // click-count tracking and prevent the triple-click paragraph
      // selection from ever firing.
      // Note: we use mousedown (not pointerdown) because MouseEvent.detail
      // is spec-guaranteed to carry the click count, whereas the Pointer
      // Events spec says PointerEvent.detail SHOULD be 0.
      if (event.detail >= 2) return;

      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current && ref.current.contains(target)) {
        return;
      }
      onDismiss();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    document.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, ref, onDismiss]);
}
