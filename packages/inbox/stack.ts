/**
 * A window too narrow for two panes side by side, but not a phone (an iPad
 * in portrait, a narrow desktop window, a Stage Manager tile): the pane on
 * top covers the one under it, as on a phone, while the window keeps its
 * desktop chrome (the docked sidebar, the headers, the close buttons, the
 * desktop history). A thread covers the list when the list's narrowest
 * column (380 px) and the thread's narrowest readable pane (480 px, the room
 * #1854's resize edge always leaves it) do not both fit; an open file covers
 * the thread when the thread's 440 px column and a 480 px file do not.
 *
 * Wide windows never stack, so a desktop at 1280 px and over is drawn
 * exactly as before (the docked sidebar leaves the thread more than 480 px).
 */

import { useLayoutEffect, useState, type RefObject } from 'react';

/** The list column's narrowest width beside a thread (inbox.css `.ib-listcol.ib-resizable`). */
export const LIST_MIN_WIDTH = 380;
/** The thread pane's narrowest readable width beside the list (inbox.css `max-width: calc(100% - 480px)`). */
export const THREAD_MIN_WIDTH = 480;
/** The thread column beside an open file (inbox.css `.ib-pane.ib-withfile`). */
export const THREAD_BESIDE_FILE_WIDTH = 440;
/** An open file's narrowest readable width beside the thread. */
export const FILE_MIN_WIDTH = 480;

export interface Stack {
  /** A thread covers the list. */
  thread: boolean;
  /** An open file covers its thread. */
  file: boolean;
}

export const NO_STACK: Stack = { thread: false, file: false };

/**
 * Which panes cover which, for the room the list and thread share (`.ib-main`,
 * the window less the docked sidebar) and the window's width (an open file
 * closes the sidebar, so it shares the whole window with its thread).
 */
export function stackFor(mainWidth: number, windowWidth: number): Stack {
  return {
    thread: mainWidth > 0 && mainWidth < LIST_MIN_WIDTH + THREAD_MIN_WIDTH,
    file: windowWidth > 0 && windowWidth < THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH,
  };
}

function same(a: Stack, b: Stack): boolean {
  return a.thread === b.thread && a.file === b.file;
}

/**
 * The room the list and thread will share once the docked sidebar has
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

/**
 * The stack for the window (`.pn-inbox`), read before paint on every commit
 * (so a thread opened from its link, or a sidebar toggled, never draws
 * squeezed first) and on every resize: the window's, the sidebar's resize
 * edge. Off on a phone, which shows one screen at a time already (phone.ts).
 */
export function useStack(ref: RefObject<HTMLElement | null>, phone: boolean): Stack {
  const [stack, setStack] = useState<Stack>(NO_STACK);
  const measure = () => {
    const root = ref.current;
    const next = phone || !root ? NO_STACK : stackFor(mainWidthOf(root), root.getBoundingClientRect().width);
    setStack((current) => (same(current, next) ? current : next));
  };
  // Every commit: the sidebar's target state changes in the same commit as the route or the toggle.
  useLayoutEffect(measure);
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
    // `measure` reads the refs at call time; re-subscribing on every render is not needed.
  }, [ref, phone]);
  return stack;
}
