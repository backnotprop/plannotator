import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The frame's `cn`. tailwind-merge is told the `--frame-*` theme names, so
 * `text-frame-sm` counts as a font size (not a colour) and survives next to
 * `text-frame-muted-fg`, and `rounded-frame-*` / `shadow-frame-*` /
 * `h-frame-row` merge like their built-in neighbours.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["frame-2xs", "frame-xs", "frame-sm"],
      radius: ["frame-pane", "frame-structure", "frame-control", "frame-selection", "frame-floating", "frame-dialog"],
      shadow: ["frame-pane", "frame-float"],
      spacing: ["frame-row", "frame-control"],
      ease: ["frame-enter"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
