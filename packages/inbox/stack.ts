/**
 * A window too narrow for two panes side by side, but not a phone (an iPad
 * in portrait, a narrow desktop window, a Stage Manager tile): the pane on
 * top covers the one under it, as on a phone, while the window keeps its
 * desktop chrome (the docked sidebar, the headers, the desktop history of a
 * file or a decision).
 *
 * - A thread covers the list when the list's narrowest column (380 px) and a
 *   440 px thread (the column a thread keeps beside an open file) do not both
 *   fit. So an iPad on its side (1080 px) keeps the list beside a 468 px
 *   thread, as iPad Mail does, and an iPad upright (810 px) stacks.
 * - An open file covers its thread when the thread's 440 px column and a
 *   480 px file do not fit the window.
 * - An open decision covers the Decisions list when the list's 460 px column
 *   and a 380 px decision do not both fit.
 *
 * Wide windows never stack, so a desktop at 1280 px and over is drawn
 * exactly as before.
 */

import { useLayoutEffect, useState, type DependencyList, type RefObject } from 'react';

/** The list column's narrowest width beside a thread (inbox.css `.ib-listcol.ib-resizable`). */
export const LIST_MIN_WIDTH = 380;
/** The room #1854's resize edge leaves the thread beside the list (inbox.css `max-width: calc(100% - 480px)`); it never shrinks the list below 380 px for it. */
export const THREAD_MIN_WIDTH = 480;
/** The thread column beside an open file (inbox.css `.ib-pane.ib-withfile`), and the narrowest thread drawn beside the list. */
export const THREAD_BESIDE_FILE_WIDTH = 440;
/** An open file's narrowest readable width beside the thread. */
export const FILE_MIN_WIDTH = 480;
/** The Decisions list's column beside an open decision (inbox.css `.ib-dpage.ib-narrow`). */
export const DECISIONS_LIST_WIDTH = 460;
/** An open decision's narrowest pane beside the Decisions list. */
export const DECISION_MIN_WIDTH = 380;

export interface Stack {
  /** A thread covers the list. */
  thread: boolean;
  /** An open file covers its thread. */
  file: boolean;
  /** An open decision covers the Decisions list. */
  decision: boolean;
}

export const NO_STACK: Stack = { thread: false, file: false, decision: false };

/**
 * Which panes cover which, for the room the list and its pane share
 * (`.ib-main`, the window less the docked sidebar) and the window's width (an
 * open file closes the sidebar, so it shares the whole window with its thread).
 */
export function stackFor(mainWidth: number, windowWidth: number): Stack {
  return {
    thread: mainWidth > 0 && mainWidth < LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH,
    file: windowWidth > 0 && windowWidth < THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH,
    decision: mainWidth > 0 && mainWidth < DECISIONS_LIST_WIDTH + DECISION_MIN_WIDTH,
  };
}

function same(a: Stack, b: Stack): boolean {
  return a.thread === b.thread && a.file === b.file && a.decision === b.decision;
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

/**
 * The stack for the window (`.pn-inbox`). Read before paint whenever one of
 * `deps` changes (the caller passes what moves the sidebar's target: the
 * route, the sidebar's open state, an open file), so a thread opened from its
 * link, or a sidebar toggled, never draws squeezed first; a ResizeObserver
 * (the window, the sidebar's resize edge) handles everything else. Off on a
 * phone, which shows one screen at a time already (phone.ts).
 */
export function useStack(ref: RefObject<HTMLElement | null>, phone: boolean, deps: DependencyList): Stack {
  const [stack, setStack] = useState<Stack>(NO_STACK);
  const measure = () => {
    const root = ref.current;
    const next = phone || !root ? NO_STACK : stackFor(mainWidthOf(root), root.getBoundingClientRect().width);
    setStack((current) => (same(current, next) ? current : next));
  };
  // The caller's deps are what change the sidebar's target in the same commit.
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
    // `measure` reads the ref at call time; re-subscribing on every render is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, phone]);
  return stack;
}
