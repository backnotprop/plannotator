import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with Tailwind-aware conflict resolution.
 * `clsx` handles conditionals/arrays; `twMerge` dedupes conflicting utilities
 * (so a later `bg-*` wins over an earlier one, etc.).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
