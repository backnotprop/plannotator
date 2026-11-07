/**
 * A link that opens the review at a line (a Shape board's What's changed item or `file:line`, a part of a picture)
 * brings that line into view: its file opens, its lines are painted, and the review scrolls so the first painted line
 * sits in the upper part of the room the corner card leaves (approval "review-show-me", q-db7db55f: a link shows the code).
 *
 * The diff draws late (the reader is a lazy chunk, Pierre paints the rows in its shadow root, and the file boxes
 * above settle their heights), so this waits for the painted row to hold still, then scrolls the review's body.
 * The person scrolling, tapping or typing first takes the scroll back.
 */
import { useEffect, type RefObject } from 'react';

/** Room kept above the line for the file's sticky header. */
const TOP_ROOM = 72;
/** Where the line goes in the free room: this far down it. */
const PLACE_AT = 0.3;
const STILL_FRAMES = 8;
/** Frames with the file on the page but no painted row: the file is far, so take its box to the top to draw it. */
const SHELL_AFTER = 20;
const MAX_MS = 6_000;
const MAX_MOVES = 3;
const TAKE_OVER = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export interface LineTarget {
  path: string;
  token: number;
}

/** The file's box in the review. */
export function fileShellOf(body: ParentNode, path: string): HTMLElement | null {
  for (const el of body.querySelectorAll<HTMLElement>('[data-guide-file-shell]')) if (el.dataset.guideFileShell === path) return el;
  return null;
}

/** The painted rows' span on screen (Pierre paints them in each diff's shadow root), or null before they are drawn. */
export function paintedSpan(shell: Element): { top: number; bottom: number } | null {
  const roots: ParentNode[] = [shell];
  for (const host of shell.querySelectorAll('diffs-container')) if (host.shadowRoot) roots.push(host.shadowRoot);
  let top = Infinity;
  let bottom = -Infinity;
  for (const root of roots) {
    for (const row of root.querySelectorAll<HTMLElement>('[data-line][data-selected-line]')) {
      const rect = row.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
  }
  return top === Infinity ? null : { top, bottom };
}

/** The top of the corner card (unscaled: it grows in from the board), or null when there is none. */
export function coverTop(scope: ParentNode): number | null {
  const card = scope.querySelector<HTMLElement>('[data-show-me-corner]');
  if (!card) return null;
  const parent = card.offsetParent?.getBoundingClientRect();
  return parent && card.offsetHeight > 0 ? parent.top + card.offsetTop : card.getBoundingClientRect().top;
}

/**
 * How far to scroll so the lines sit clear of the top and of the card: 0 when they already do. Taller than the room,
 * their first line goes to the top of it.
 */
export function lineScrollBy(span: { top: number; bottom: number }, view: { top: number; bottom: number }, cover: number | null): number {
  const top = view.top + TOP_ROOM;
  const bottom = Math.max(top + 40, Math.min(view.bottom, cover ?? view.bottom) - 16);
  if (span.top >= top && span.bottom <= bottom) return 0;
  const room = bottom - top;
  const height = span.bottom - span.top;
  const wanted = height >= room ? top : top + Math.min(room * PLACE_AT, room - height);
  return Math.round(span.top - wanted);
}

/** Brings each new target's painted lines into view in `body` (the review's scroll). */
export function useLineInView(bodyRef: RefObject<HTMLElement | null>, target: LineTarget | null): void {
  useEffect(() => {
    const body = bodyRef.current;
    if (!target || !body) return;
    const startedAt = performance.now();
    let frame = 0;
    let lastTop = Number.NaN;
    let still = 0;
    let missing = 0;
    let moves = 0;
    let shellMoved = false;
    let done = false;
    const stop = () => {
      done = true;
      cancelAnimationFrame(frame);
      for (const type of TAKE_OVER) window.removeEventListener(type, stop, { capture: true });
    };
    const look = () => {
      if (done) return;
      if (!body.isConnected || performance.now() - startedAt > MAX_MS) return stop();
      const shell = fileShellOf(body, target.path);
      const span = shell ? paintedSpan(shell) : null;
      if (!span) {
        if (shell && !shellMoved && ++missing >= SHELL_AFTER) {
          shellMoved = true;
          shell.scrollIntoView({ block: 'start', behavior: 'instant' });
        }
        frame = requestAnimationFrame(look);
        return;
      }
      still = Math.abs(span.top - lastTop) < 0.5 ? still + 1 : 0;
      lastTop = span.top;
      if (still >= STILL_FRAMES) {
        const view = body.getBoundingClientRect();
        const by = lineScrollBy(span, view, coverTop(body.closest('[data-review-message]') ?? body.ownerDocument));
        if (by === 0 || moves >= MAX_MOVES) return stop();
        moves += 1;
        body.scrollTop += by;
        still = 0;
        lastTop = Number.NaN;
      }
      frame = requestAnimationFrame(look);
    };
    for (const type of TAKE_OVER) window.addEventListener(type, stop, { capture: true, passive: true });
    frame = requestAnimationFrame(look);
    return stop;
    // A new token is a new link; the path rides with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.token]);
}
