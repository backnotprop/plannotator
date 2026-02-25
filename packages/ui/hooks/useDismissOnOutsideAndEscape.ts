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

    const handlePointerDown = (event: PointerEvent) => {
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

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, ref, onDismiss]);
}
