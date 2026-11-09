/**
 * Next / previous change (⌥F5 / ⇧⌥F5, approved design record
 * "review-explorer", step 3): walks the runs of changed lines in the view on
 * screen. It reads what Pierre drew (`data-line-type="change-…"` rows inside
 * each `diffs-container`'s shadow root) and, for the Whole file view, the
 * lines its host lists in `data-change-lines`. A run is a block of changed
 * rows; in a split view the two sides of one block are one run.
 *
 * The view's reading position is a third of the way down its scroll box: a
 * jump puts the run's first row there, so the next press finds the run after.
 * Views that draw only what is near the screen (All files, a long diff) are
 * scrolled on until a run appears or the view ends.
 */

export type ChangeStep = 1 | -1;
export type ChangeStepResult = 'moved' | 'end';

interface Run {
  top: number;
  bottom: number;
}

const CHANGE_ROW = '[data-line-type="change-addition"], [data-line-type="change-deletion"]';

function pierreRoots(container: HTMLElement): ParentNode[] {
  const roots: ParentNode[] = [];
  for (const host of container.querySelectorAll('diffs-container')) {
    if (host.shadowRoot) roots.push(host.shadowRoot);
  }
  return roots;
}

function changeRows(container: HTMLElement): Element[] {
  const rows: Element[] = [];
  const whole = container.querySelectorAll<HTMLElement>('[data-change-lines]');
  for (const root of pierreRoots(container)) rows.push(...root.querySelectorAll(CHANGE_ROW));
  for (const host of whole) {
    const lines = (host.dataset.changeLines ?? '').split(',').map(Number).filter((n) => n > 0);
    const root = host.querySelector('diffs-container')?.shadowRoot;
    if (!root) continue;
    for (const line of lines) {
      const row = root.querySelector(`[data-line="${line}"]`);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/** Blocks of changed rows, top to bottom, in viewport coordinates. */
export function changeRuns(container: HTMLElement): Run[] {
  const rects = changeRows(container)
    .map((row) => row.getBoundingClientRect())
    .filter((rect) => rect.height > 0)
    .sort((a, b) => a.top - b.top);
  const runs: Run[] = [];
  for (const rect of rects) {
    const last = runs[runs.length - 1];
    if (last && rect.top <= last.bottom + 1) last.bottom = Math.max(last.bottom, rect.bottom);
    else runs.push({ top: rect.top, bottom: rect.bottom });
  }
  return runs;
}

function parentAcrossShadow(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** The scroll box the view's rows move in. */
export function changeScroller(container: HTMLElement): HTMLElement | null {
  const first = changeRows(container)[0] ?? container.querySelector('diffs-container');
  let node: Element | null = first ?? null;
  while (node && node !== container.parentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    node = parentAcrossShadow(node);
  }
  return null;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Moves the view to the next (1) or previous (-1) run. `edge` picks the first
 * or last run regardless of position (a file just opened). Answers `end` when
 * there is none that way, leaving the view where it was.
 */
export async function stepChange(
  container: HTMLElement,
  direction: ChangeStep,
  options: { edge?: 'first' | 'last'; maxScrolls?: number } = {},
): Promise<ChangeStepResult> {
  const scroller = changeScroller(container);
  // Everything fits on screen: nothing to move to in this view.
  if (!scroller) return 'end';
  const startTop = scroller.scrollTop;
  const anchorOf = () => {
    const box = scroller.getBoundingClientRect();
    return box.top + Math.min(scroller.clientHeight, box.height) / 3;
  };
  const moveTo = (run: Run) => {
    scroller.scrollTop += run.top - anchorOf();
  };
  if (options.edge) {
    scroller.scrollTop = options.edge === 'first' ? 0 : scroller.scrollHeight;
    await nextFrame();
    await nextFrame();
    const runs = changeRuns(container);
    const run = options.edge === 'first' ? runs[0] : runs[runs.length - 1];
    if (run) {
      moveTo(run);
      return 'moved';
    }
    if (options.edge === 'last') {
      scroller.scrollTop = startTop;
      return 'end';
    }
  }
  const maxScrolls = options.maxScrolls ?? 40;
  // Positions in the scroll box's content, so scrolling on never skips a run.
  const contentTop = (viewportTop: number) => viewportTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const threshold = contentTop(anchorOf());
  for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
    const runs = changeRuns(container);
    const target = direction === 1
      ? runs.find((run) => contentTop(run.top) > threshold + 2)
      : [...runs].reverse().find((run) => contentTop(run.top) < threshold - 2);
    if (target) {
      moveTo(target);
      return 'moved';
    }
    // Nothing drawn that way: scroll on (a view that draws what is near the
    // screen draws more), unless the view already ends there.
    const atEnd = direction === 1
      ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
      : scroller.scrollTop <= 0;
    if (atEnd) break;
    scroller.scrollTop += direction * Math.max(80, scroller.clientHeight * 0.8);
    await nextFrame();
    await nextFrame();
  }
  scroller.scrollTop = startTop;
  return 'end';
}
