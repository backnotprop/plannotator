/**
 * DOM work of a tab drag in one tab list. The view reads the edges of the
 * tabs once, when the drag starts, and then moves a drop marker with a
 * transform on each pointer move, so a move lays nothing out and renders
 * nothing.
 */

/** The left and right edges of a tab, relative to its tab list. */
export interface TabEdges {
  readonly left: number;
  readonly right: number;
}

const MARKER_CLASS = 'pierre-layout-tab-drop';

export const TABLIST_ATTRIBUTE = 'data-layout-tablist';
export const TAB_ATTRIBUTE = 'data-layout-tab';
export const TAB_CLOSE_ATTRIBUTE = 'data-layout-tab-close';

export function tabsOf(tablist: HTMLElement): HTMLElement[] {
  return Array.from(
    tablist.querySelectorAll<HTMLElement>(`[${TAB_ATTRIBUTE}]`)
  ).filter((tab) => tab.closest(`[${TABLIST_ATTRIBUTE}]`) === tablist);
}

/** The edges of each tab of a tab list, in order. */
export function readTabEdges(tablist: HTMLElement): TabEdges[] {
  const origin = tablist.getBoundingClientRect().left;
  return tabsOf(tablist).map((tab) => {
    const box = tab.getBoundingClientRect();
    return { left: box.left - origin, right: box.right - origin };
  });
}

/** Find a header's tab strip only when the pointer is inside it. */
export function tablistAt(
  host: HTMLElement,
  clientX: number,
  clientY: number
): HTMLElement | null {
  const tablist = host.querySelector<HTMLElement>(`[${TABLIST_ATTRIBUTE}]`);
  if (tablist === null) return null;
  const box = tablist.getBoundingClientRect();
  return clientX >= box.left &&
    clientX <= box.right &&
    clientY >= box.top &&
    clientY <= box.bottom
    ? tablist
    : null;
}

/** The place in a tab list of a drop before tab `boundary`, or after the last. */
export function boundaryOffset(
  edges: readonly TabEdges[],
  boundary: number
): number {
  if (edges.length === 0) return 0;
  return boundary === 0 ? edges[0].left : edges[boundary - 1].right;
}

/** Show the drop marker of a tab list at `offset` pixels from its left edge. */
export function showTabDrop(tablist: HTMLElement, offset: number): void {
  let marker = tablist.querySelector<HTMLElement>(`:scope > .${MARKER_CLASS}`);
  if (marker === null) {
    marker = document.createElement('span');
    marker.className = MARKER_CLASS;
    marker.setAttribute('aria-hidden', 'true');
    tablist.append(marker);
  }
  marker.style.transform = `translateX(${offset}px)`;
}

/** Remove the drop marker of a tab list. */
export function clearTabDrop(tablist: HTMLElement): void {
  tablist.querySelector(`:scope > .${MARKER_CLASS}`)?.remove();
}
