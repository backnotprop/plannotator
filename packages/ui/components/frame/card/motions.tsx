import type { ReactNode } from "react";

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

function cardTiming(element: Element, name: string, fallback: number) {
  const style = getComputedStyle(element);
  return {
    duration: cardDurationMs(style.getPropertyValue(name), fallback),
    easing: style.getPropertyValue("--frame-card-ease").trim() || "cubic-bezier(0.22, 1, 0.36, 1)",
  };
}

/**
 * `settle` for a batch of changes (a re-sort, new cards, cards leaving):
 * measures the direct children of `container` (pass each grid's list, for
 * example the `ref` of a `CardGrid`), runs the host's `mutate` once, then
 * slides each child that moved from its old place and brings each new one
 * down from just above, with `settle`'s duration and ease (FLIP). `mutate`
 * must leave the new order in the DOM when it returns (in React, wrap the
 * state change in `flushSync`). Under reduced motion, or with no container
 * (`null` or `undefined`), it only runs `mutate`. The card never re-sorts itself.
 */
export function settleBatch(container: HTMLElement | null | undefined, mutate: () => void): void {
  if (container === null || container === undefined || reducedMotion()) {
    mutate();
    return;
  }
  const first = new Map<Element, DOMRect>();
  for (const child of container.children) first.set(child, child.getBoundingClientRect());
  mutate();
  const { duration, easing } = cardTiming(container, "--frame-card-settle-duration", 320);
  const offset = cardDurationMs(getComputedStyle(container).getPropertyValue("--frame-card-settle-offset"), -4);
  for (const child of container.children) {
    if (typeof child.animate !== "function") continue;
    const before = first.get(child);
    if (before === undefined) {
      child.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], { duration, easing });
      continue;
    }
    const after = child.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (dx === 0 && dy === 0) continue;
    child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing });
  }
}

/**
 * `arrive` for one element the host just put inside a face (a line, a row):
 * it opens in place and is tinted for a moment where it landed. Only that
 * element animates; the card never moves. It opens to the element's own
 * height, before the face's scale, so it lands at full size. Under reduced
 * motion, or with no element (`null` or `undefined`), it does nothing.
 */
export function arrive(element: HTMLElement | null | undefined): void {
  if (element === null || element === undefined || reducedMotion() || typeof element.animate !== "function") return;
  const style = getComputedStyle(element);
  const ease = style.getPropertyValue("--frame-card-ease").trim() || "cubic-bezier(0.22, 1, 0.36, 1)";
  const open = cardDurationMs(style.getPropertyValue("--frame-card-arrive-open-duration"), 260);
  const fade = cardDurationMs(style.getPropertyValue("--frame-card-arrive-fade-duration"), 200);
  const delay = cardDurationMs(style.getPropertyValue("--frame-card-arrive-fade-delay"), 60);
  const tint = cardDurationMs(style.getPropertyValue("--frame-card-arrive-tint-duration"), 1600);
  const color = style.getPropertyValue("--frame-card-arrive-tint").trim() || "color-mix(in oklch, var(--primary) 18%, transparent)";
  const height = element.offsetHeight;
  element.animate([{ height: "0px", overflow: "hidden" }, { height: `${height}px`, overflow: "hidden" }], { duration: open, easing: ease });
  element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade, delay, easing: "ease-out", fill: "backwards" });
  element.animate([{ backgroundColor: color }, { backgroundColor: "transparent" }], { duration: tint, easing: "ease-out" });
}

/** `arrive`: wrap a line or row the agent just wrote into a face; it opens in place and is tinted for a moment. */
export function CardArrival({ children }: { readonly children: ReactNode }) {
  return (
    <div className={CARD_MOTIONS.arrive}>
      <div>
        <div className="frame-card-arrive-tint">{children}</div>
      </div>
    </div>
  );
}

