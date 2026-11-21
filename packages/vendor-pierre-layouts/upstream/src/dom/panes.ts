import { computeLayout } from '../geometry';
import type { LayoutGeometry, LayoutNode } from '../types';
import { flipAnimations } from './flip';

/**
 * DOM operations on pane hosts. The view writes these attributes and moves
 * the focus itself, outside its renders, for two reasons: a render of every
 * pane host for a state that only some hosts change would cost more, and some
 * changes must happen in a set order, for example `inert` in the same style
 * update as `content-visibility`.
 */

/**
 * The event that a pane host receives when its content stops or starts
 * rendering. `detail.hidden` is true when the zoom animation of another pane
 * ends, when the pane is hidden, or when another tab of its stack becomes
 * active, and false before the pane shows again.
 */
export const PANE_VISIBILITY_EVENT = 'pierre-layout-visibility';
export type PaneVisibilityEvent = CustomEvent<{ hidden: boolean }>;

/**
 * The pane hosts of a layout root. They are children of the root, so this
 * does not walk the pane content, as a query of the subtree would.
 */
export function paneHosts(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute('data-layout-pane')
  );
}

function notify(host: HTMLElement, hidden: boolean): void {
  host.dispatchEvent(
    new CustomEvent(PANE_VISIBILITY_EVENT, { detail: { hidden } })
  );
}

/**
 * Hide each pane host that the zoomed pane covers, or show every host when
 * `zoomedPane` is null. A style rule gives a hidden host
 * `content-visibility: hidden`. Each host whose state changes receives
 * `PANE_VISIBILITY_EVENT`.
 */
export function setCoveredHidden(
  root: HTMLElement,
  zoomedPane: string | null
): void {
  for (const host of paneHosts(root)) {
    // A pane that does not show does not render whatever the zoom.
    if (host.getAttribute('data-pane-hidden') === 'true') continue;
    const hidden =
      zoomedPane !== null &&
      host.getAttribute('data-layout-pane') !== zoomedPane;
    if ((host.getAttribute('data-hidden') === 'true') === hidden) continue;
    // `inert` is inherited, so on a pane whose content renders it lays out
    // all of that content again (about 200 ms for 15 panes of real content).
    // It changes with `content-visibility` in one style update, so the
    // content does not render for either change.
    if (hidden) {
      host.setAttribute('data-hidden', 'true');
      host.inert = true;
    } else {
      host.inert = false;
      host.removeAttribute('data-hidden');
    }
    notify(host, hidden);
  }
}

/**
 * Hide the covered panes when the running zoom animation ends. `isCurrent`
 * tells whether that zoom still holds: a tree change during the zoom cancels
 * its animations, and a new zoom change replaces it.
 */
export function hideCoveredAfterAnimation(
  root: HTMLElement,
  zoomedPane: string,
  isCurrent: () => boolean
): void {
  void Promise.allSettled(
    flipAnimations(root).map((animation) => animation.finished)
  ).then(() => {
    if (isCurrent()) setCoveredHidden(root, zoomedPane);
  });
}

/**
 * Send `PANE_VISIBILITY_EVENT` to each pane that stopped or started showing:
 * `store.setHidden` hid or showed it, or its tab became inactive or active.
 */
export function notifyHidden(
  root: HTMLElement,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>
): void {
  for (const host of paneHosts(root)) {
    const id = host.getAttribute('data-layout-pane') ?? '';
    if (after.has(id) !== before.has(id)) notify(host, after.has(id));
  }
}

/**
 * Make the content of each collapsed pane inert, and the content of the
 * other panes not. A style rule gives that content `content-visibility:
 * hidden` (`data-collapsed` on the host).
 */
export function setCollapsedContent(
  root: HTMLElement,
  collapsed: ReadonlySet<string>
): void {
  for (const host of paneHosts(root)) {
    const content = host.querySelector<HTMLElement>(
      ':scope > .pierre-layout-pane-inner > .pierre-layout-content'
    );
    const inert = collapsed.has(host.getAttribute('data-layout-pane') ?? '');
    if (content !== null && content.inert !== inert) content.inert = inert;
  }
}

/** Find a pane host among the layout's direct children. */
export function hostOf(root: HTMLElement, id: string): HTMLElement | undefined {
  return paneHosts(root).find(
    (host) => host.getAttribute('data-layout-pane') === id
  );
}

/** Focus a pane host. */
export function focusPane(root: HTMLElement, id: string): void {
  hostOf(root, id)?.focus();
}

/** Focus the tab of a pane in the header of the pane's own host. */
export function focusTab(root: HTMLElement, id: string): void {
  hostOf(root, id)
    ?.querySelector<HTMLElement>(
      `[data-layout-tab="${CSS.escape(id)}"][aria-selected="true"]`
    )
    ?.focus();
}

/** Capture the focused pane before a zoom can hide it and move focus to body. */
export function focusOwner(root: HTMLElement): string | null {
  const active = document.activeElement;
  if (active === null || !root.contains(active)) return null;
  const host = paneHosts(root).find((pane) => pane.contains(active));
  return host?.getAttribute('data-layout-pane') ?? '';
}

/** Move focus out of a covered pane without taking focus from outside the layout. */
export function focusZoomedPane(
  root: HTMLElement,
  id: string,
  owner: string | null
): void {
  if (owner === null || owner === id) return;
  const active = document.activeElement;
  if (active !== null && active !== document.body && !root.contains(active))
    return;
  if (focusOwner(root) !== id) focusPane(root, id);
}

/**
 * The separators that a pointer or key on a separator or a corner resizes.
 * Corners that sit at the same point join their separators, so that one drag
 * moves all the separators that meet there.
 */
export function separatorIdsAt(
  root: HTMLElement,
  target: HTMLElement,
  ids: readonly string[],
  corners: readonly { id: string; separatorIds: readonly string[] }[]
): Set<string> {
  const touching = new Set(ids);
  if (!target.classList.contains('pierre-layout-corner')) return touching;
  const bounds = target.getBoundingClientRect();
  for (const corner of root.querySelectorAll<HTMLElement>(
    ':scope > [data-layout-corner]'
  )) {
    const other = corner.getBoundingClientRect();
    if (Math.abs(bounds.x - other.x) < 1 && Math.abs(bounds.y - other.y) < 1) {
      const spec = corners.find(({ id }) => id === corner.dataset.layoutCorner);
      for (const id of spec?.separatorIds ?? []) touching.add(id);
    }
  }
  return touching;
}

/** Pixel geometry at the root's current size, for a gesture that starts. */
export function readPixelGeometry(
  root: HTMLElement,
  tree: LayoutNode,
  gap: number
): LayoutGeometry {
  const bounds = root.getBoundingClientRect();
  return computeLayout(tree, bounds.width, bounds.height, gap);
}
