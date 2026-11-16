import { useEffect, useState, type ReactNode } from "react";

/** The card's motions by name; the rules and their timings are in motions.css. */
export const CARD_MOTIONS = {
  arrive: "frame-card-arrive",
  breathe: "frame-card-breathe",
  settle: "frame-card-settle",
  fan: "frame-card-fan",
  open: "frame-card-open",
} as const;

export type CardMotion = keyof typeof CARD_MOTIONS;

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function cardDurationMs(value: string, fallback: number): number {
  const text = value.trim();
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return fallback;
  return text.endsWith("ms") ? number : text.endsWith("s") ? number * 1000 : number;
}

/**
 * Re-sort without a jump (FLIP). Call it with the list element before the
 * order changes, and call what it returns once the new order is in the DOM
 * (a layout effect): each child that moved slides from its old place, with
 * `settle`'s duration and ease. Under reduced motion the returned call does nothing.
 */
export function flipReorder(container: HTMLElement): () => void {
  const first = new Map<Element, DOMRect>();
  for (const child of container.children) first.set(child, child.getBoundingClientRect());
  return () => {
    if (reducedMotion()) return;
    const style = getComputedStyle(container);
    const duration = cardDurationMs(style.getPropertyValue("--frame-card-settle-duration"), 320);
    const easing = style.getPropertyValue("--frame-card-ease").trim() || "cubic-bezier(0.22, 1, 0.36, 1)";
    for (const child of container.children) {
      const before = first.get(child);
      if (before === undefined || typeof child.animate !== "function") continue;
      const after = child.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx === 0 && dy === 0) continue;
      child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing });
    }
  };
}

/** `arrive`: wrap a line or row the agent just wrote into a face; it opens in place and is tinted for a moment. */
export function CardArrival({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") {
      setOpen(true);
      return;
    }
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={CARD_MOTIONS.arrive} data-open={open ? "" : undefined}>
      <div>
        <div className="frame-card-arrive-tint">{children}</div>
      </div>
    </div>
  );
}

