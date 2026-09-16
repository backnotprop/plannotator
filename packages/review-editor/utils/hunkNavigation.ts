import { getSearchRoots } from './reviewSearchHighlight';

export interface HunkLineTarget {
  lineNumber: number;
  side?: 'additions' | 'deletions';
}

export interface HunkLike {
  additionStart?: number;
  deletionStart?: number;
  additionCount?: number;
  deletionCount?: number;
  additionLines?: number;
  deletionLines?: number;
}

/**
 * Resolves the primary line number and side to query for a given diff hunk.
 * Prioritizes additionStart for hunks containing additions or context;
 * falls back to deletionStart for pure deletions.
 */
export function getHunkTargetLine(hunk: HunkLike): HunkLineTarget {
  if ((hunk.additionLines ?? 0) > 0 || (hunk.additionCount ?? 0) > 0) {
    if (hunk.additionStart && hunk.additionStart > 0) {
      return { lineNumber: hunk.additionStart, side: 'additions' };
    }
  }
  if (hunk.deletionStart && hunk.deletionStart > 0) {
    return { lineNumber: hunk.deletionStart, side: 'deletions' };
  }
  return { lineNumber: hunk.additionStart || hunk.deletionStart || 1 };
}

/**
 * Pure index resolution: given sorted vertical hunk start positions, current viewport
 * scrollTop, and jump direction, returns the 0-based index of the target hunk.
 *
 * An epsilon threshold (default 2px) covers subpixel settling only (~2px):
 * positions within 2px of a hunk top count as ON it, anything further counts
 * as genuinely before/inside.
 *
 * Returns null if no valid target exists (before first hunk on prev, past last hunk on next,
 * or empty list).
 */
export function resolveTargetHunkIndex(
  hunkStarts: readonly number[],
  scrollTop: number,
  direction: 'next' | 'prev',
  threshold = 2,
): number | null {
  if (hunkStarts.length === 0) return null;

  if (direction === 'next') {
    for (let i = 0; i < hunkStarts.length; i++) {
      if (hunkStarts[i] > scrollTop + threshold) {
        return i;
      }
    }
    return null;
  }

  // direction === 'prev'
  for (let i = hunkStarts.length - 1; i >= 0; i--) {
    if (hunkStarts[i] < scrollTop - threshold) {
      return i;
    }
  }
  return null;
}

/**
 * Queries shadow roots inside the container for the element matching a hunk target line.
 */
export function findHunkLineElement(
  container: HTMLElement,
  target: HunkLineTarget,
): HTMLElement | null {
  const roots = getSearchRoots(container);
  const { lineNumber, side } = target;
  for (const root of roots) {
    if (side) {
      const sided = (root as ParentNode).querySelector?.(
        `[data-line="${lineNumber}"][data-${side}]`,
      );
      if (sided instanceof HTMLElement) return sided;
    }
    const anyLine = (root as ParentNode).querySelector?.(`[data-line="${lineNumber}"]`);
    if (anyLine instanceof HTMLElement) return anyLine;
  }
  return null;
}

/**
 * Returns the vertical position of an element in the scroll container's scrollTop coordinate space.
 */
export function getElementScrollTop(
  scrollContainer: HTMLElement,
  target: HTMLElement,
): number {
  const containerRect = scrollContainer.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return scrollContainer.scrollTop + (targetRect.top - containerRect.top);
}

/**
 * Smoothly scrolls the target hunk element into view at the top of the viewport.
 */
export function scrollToHunkElement(target: HTMLElement): void {
  target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
}
