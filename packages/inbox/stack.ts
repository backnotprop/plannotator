import { useLayoutEffect, useState, type DependencyList, type RefObject } from 'react';

export const LIST_MIN_WIDTH = 380;
export const THREAD_MIN_WIDTH = 480;
export const THREAD_BESIDE_FILE_WIDTH = 440;
export const FILE_MIN_WIDTH = 480;

export interface Stack {
  thread: boolean;
  file: boolean;
}

export const NO_STACK: Stack = { thread: false, file: false };

export function stackFor(mainWidth: number, windowWidth: number): Stack {
  return {
    thread: mainWidth > 0 && mainWidth < LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH,
    file: windowWidth > 0 && windowWidth < THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH,
  };
}

function same(a: Stack, b: Stack): boolean {
  return a.thread === b.thread && a.file === b.file;
}

/**
 * The room the list and its pane will share once the docked sidebar has
 * settled: the window less the sidebar's width when it is opening or open
 * (shell/sidebar.tsx: `.ib-sb[data-state]` is the target, `.ib-sb-inner`
 * holds the accepted width). Read from the target, not from `.ib-main` as it
 * animates, so closing a file (which reopens the sidebar) stacks at once
 * instead of drawing the thread squeezed beside the list for the spring.
 */
function mainWidthOf(root: HTMLElement): number {
  const sidebar = root.querySelector<HTMLElement>('.ib-sb');
  const open = sidebar?.dataset.state === 'expanded';
  const inner = open ? sidebar!.querySelector<HTMLElement>('.ib-sb-inner') : null;
  return root.getBoundingClientRect().width - (inner ? inner.getBoundingClientRect().width : 0);
}

export function paneGutters(el?: Element | null): number {
  if (typeof document === 'undefined') return 0;
  const root = el ?? document.querySelector('.pn-inbox');
  if (!root) return 0;
  const gutter = parseFloat(getComputedStyle(root).getPropertyValue('--ib-gutter'));
  return Number.isFinite(gutter) ? 3 * gutter : 0;
}

export function useStack(ref: RefObject<HTMLElement | null>, phone: boolean, deps: DependencyList): Stack {
  const [stack, setStack] = useState<Stack>(NO_STACK);
  const measure = () => {
    const root = ref.current;
    const gutters = paneGutters(root);
    const next = phone || !root ? NO_STACK : stackFor(mainWidthOf(root) - gutters, root.getBoundingClientRect().width - gutters);
    setStack((current) => (same(current, next) ? current : next));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [phone, ...deps]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (phone || !root) return;
    window.addEventListener('resize', measure);
    if (typeof ResizeObserver === 'undefined') return () => window.removeEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    const inner = root.querySelector('.ib-sb-inner');
    if (inner) observer.observe(inner);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, phone]);
  return stack;
}
