import { useEffect } from 'react';
import { hasBlockingOverlay } from './useVimDocumentFocus';
import { isDocumentScrollViewport } from './useScrollViewport';

/**
 * The same dead state returns after the node the user last clicked is removed (a dismissed
 * first-run dialog) or when that click landed on chrome with nothing scrollable above it (the
 * header).
 */

const LINE_STEP_PX = 40;
/**
 * Page step as Chromium and WebKit compute it: the larger of 87.5% of the viewport
 * (kMinFractionToStepWhenPaging) and the viewport minus a 40px overlap
 * (kMaxOverlapBetweenPages).
 */
const PAGE_FRACTION = 0.875;
const PAGE_OVERLAP_PX = 40;

const OPEN_POPUP_SELECTOR = '[role="menu"], [role="listbox"]';

export type ScrollKeyAction =
  | { readonly kind: 'line'; readonly direction: 1 | -1 }
  | { readonly kind: 'page'; readonly direction: 1 | -1 }
  | { readonly kind: 'edge'; readonly edge: 'start' | 'end' };

/** The keydown fields the mapping reads (pure, so it runs without a DOM). */
export type ScrollKeyInput = Pick<
  KeyboardEvent,
  'key' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

export function scrollKeyAction(event: ScrollKeyInput): ScrollKeyAction | null {
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
 * Whether the browser already has a keyboard-scroll target: the last clicked node is still in
 * the page and sits inside a vertically scrollable element.
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
  const height = viewport.clientHeight;
  const page = Math.max(1, Math.round(Math.max(height * PAGE_FRACTION, height - PAGE_OVERLAP_PX)));
  viewport.scrollBy({ top: action.direction * page, behavior });
}

export interface UseScrollKeyRoutingOptions {
  readonly viewport: HTMLElement | null;
  readonly enabled: boolean;
}

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
