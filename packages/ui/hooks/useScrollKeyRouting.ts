import { useEffect } from 'react';
import { hasBlockingOverlay } from './useVimDocumentFocus';
import { isDocumentScrollViewport } from './useScrollViewport';

/**
 * Scroll keys with no browser target (#1647).
 *
 * The desktop editor scrolls inside an element (`<main>`), not the window. On
 * load nothing is focused and the user has not clicked anywhere, so the
 * browser's keyboard-scroll starting point is the root scroller, which cannot
 * scroll: ArrowDown, PageDown and Space do nothing until the reader clicks into
 * the document. The same dead state returns after the node the user last
 * clicked is removed (a dismissed first-run dialog) or when that click landed
 * on chrome with nothing scrollable above it (the header).
 *
 * This hook fills exactly that gap and nothing else. It never moves focus, so
 * dialogs, popovers, screen readers and `:focus-visible` are untouched. It
 * only acts when all of these hold:
 *   - focus is neutral (body), so no control, input, editor or iframe owns
 *     the key;
 *   - no earlier listener consumed the key (`defaultPrevented`);
 *   - no modifier except Shift+Space (page up), and not mid-composition;
 *   - no dialog, modal overlay, popover, menu or listbox is open;
 *   - the browser has no scroll target of its own: the last pointerdown is
 *     absent, detached, or has no vertically scrollable ancestor. When it has
 *     one (a click in the document, the annotations panel, the sidebar), the
 *     native key scroll already works and is left alone.
 */

const LINE_STEP_PX = 40;
/** Chrome's paging fraction (kMinFractionToStepWhenPaging). */
const PAGE_FRACTION = 0.875;

const OPEN_POPUP_SELECTOR = '[role="menu"], [role="listbox"]';

export type ScrollKeyAction =
  | { readonly kind: 'line'; readonly direction: 1 | -1 }
  | { readonly kind: 'page'; readonly direction: 1 | -1 }
  | { readonly kind: 'edge'; readonly edge: 'start' | 'end' };

/** Map a keydown to the scroll it asks for, or null when it is not a plain scroll key. */
export function scrollKeyAction(event: KeyboardEvent): ScrollKeyAction | null {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  const isSpace = event.key === ' ' || event.key === 'Spacebar';
  if (isSpace) return { kind: 'page', direction: event.shiftKey ? -1 : 1 };
  if (event.shiftKey) return null;
  switch (event.key) {
    case 'ArrowDown': return { kind: 'line', direction: 1 };
    case 'ArrowUp': return { kind: 'line', direction: -1 };
    case 'PageDown': return { kind: 'page', direction: 1 };
    case 'PageUp': return { kind: 'page', direction: -1 };
    case 'Home': return { kind: 'edge', edge: 'start' };
    case 'End': return { kind: 'edge', edge: 'end' };
    default: return null;
  }
}

function canScrollVertically(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.scrollHeight <= element.clientHeight) return false;
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

/**
 * Whether the browser already has a keyboard-scroll target: the last clicked
 * node is still in the page and sits inside a vertically scrollable element.
 */
export function browserHasScrollTarget(lastPointerTarget: Node | null): boolean {
  if (!lastPointerTarget || !lastPointerTarget.isConnected) return false;
  const root = lastPointerTarget.ownerDocument?.documentElement ?? null;
  let node: Node | null = lastPointerTarget;
  while (node && node !== root) {
    if (node instanceof Element && canScrollVertically(node)) return true;
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return false;
}

function focusIsNeutral(event: KeyboardEvent): boolean {
  const doc = document;
  const active = doc.activeElement;
  if (active !== null && active !== doc.body && active !== doc.documentElement) return false;
  const origin = event.composedPath?.()[0] ?? event.target;
  return origin === doc.body || origin === doc.documentElement || origin === doc || origin === window;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function applyScroll(viewport: HTMLElement, action: ScrollKeyAction): void {
  if (action.kind === 'line') {
    viewport.scrollBy({ top: action.direction * LINE_STEP_PX, behavior: 'auto' });
    return;
  }
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
  if (action.kind === 'edge') {
    viewport.scrollTo({ top: action.edge === 'start' ? 0 : viewport.scrollHeight, behavior });
    return;
  }
  const page = Math.max(1, Math.round(viewport.clientHeight * PAGE_FRACTION));
  viewport.scrollBy({ top: action.direction * page, behavior });
}

export interface UseScrollKeyRoutingOptions {
  /** The element that scrolls the document. Page-scrolling viewports are ignored. */
  readonly viewport: HTMLElement | null;
  /** False where another owner has the keys (vim, iframe surfaces). */
  readonly enabled: boolean;
}

/** Route unowned scroll keys to the document viewport. See the module comment. */
export function useScrollKeyRouting({ viewport, enabled }: UseScrollKeyRoutingOptions): void {
  useEffect(() => {
    if (!enabled || !viewport || isDocumentScrollViewport(viewport)) return;

    let lastPointerTarget: Node | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      const origin = event.composedPath?.()[0] ?? event.target;
      lastPointerTarget = origin instanceof Node ? origin : null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = scrollKeyAction(event);
      if (!action) return;
      if (!viewport.isConnected || !focusIsNeutral(event)) return;
      if (hasBlockingOverlay() || document.querySelector(OPEN_POPUP_SELECTOR)) return;
      if (browserHasScrollTarget(lastPointerTarget)) return;
      event.preventDefault();
      applyScroll(viewport, action);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, viewport]);
}
