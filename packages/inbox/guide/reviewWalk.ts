/**
 * Where the review's keys go in the Inbox (ReviewKeys.tsx): the files and changes as the reader draws them. The
 * Inbox mounts one review-editor viewer per file (GuideFileCard), so moving between files is read off the page: each
 * file's shell (`data-guide-file-shell`, always in the page) and its header's own controls (the collapse arrow's
 * `data-file-collapse-toggle`, Viewed). The keys do what those controls do, and a review without a control (no Viewed
 * ticks) has nothing for its key to do.
 *
 * The changes are production's: every change of each file from its patch (`listDiffChanges`), found among the drawn
 * rows (`findChangeElement`, `renderedUnifiedRange`), placed (`placementOf`, from `readingLineFor`) and picked
 * (`resolveChangeJump`) as AllFilesCodeView's `jumpChange` does, review-editor/utils/changeNavigation.ts.
 */
import {
  findChangeElement,
  placementOf,
  renderedUnifiedRange,
  type ChangePlacement,
  type DiffChange,
} from '@plannotator/review-editor/utils/changeNavigation';
import { getSearchRoots } from '@plannotator/review-editor/utils/reviewSearchHighlight';

export const FILE_SHELL = '[data-guide-file-shell]';
/** A file whose top is this near the top of the view (its `scroll-mt-4`, 16 px, and some) is the one being read. */
export const AT_TOP = 24;

export interface Span {
  top: number;
  bottom: number;
}

/** The element the review scrolls in: its nearest scrolling ancestor, else the page. */
export function scrollerOf(el: Element): HTMLElement {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** The part of the window the review's scroller shows. */
export function viewOf(scroller: HTMLElement): Span {
  if (scroller === document.scrollingElement || scroller === document.documentElement) return { top: 0, bottom: window.innerHeight };
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/** The review's files in the order drawn, a folded chapter's left out. */
export function fileShells(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FILE_SHELL)].filter((shell) => !shell.closest('[hidden]'));
}

/**
 * The file the steps count from: the last whose top has reached the top of the view; -1 above the first. With the
 * view at its start (`atStart`) the first file counts as reached once it is in view: what is drawn above it (a guided
 * review's chapter title and overview) keeps it from ever reaching the top, and J must go on to the next.
 */
export function stepOrigin(files: readonly Span[], view: Span, atStart = false): number {
  // Where a jump leaves a file is not exactly the top: its scroll margin and its card's edge (30 px in a guided
  // review's chapter). A file whose top is in the top quarter of the view is the one being read.
  const reading = view.top + Math.max(AT_TOP, (view.bottom - view.top) / 4);
  let origin = atStart && files[0] && files[0].top < view.bottom ? 0 : -1;
  for (const [i, file] of files.entries()) {
    if (file.top > reading) break;
    origin = i;
  }
  return origin;
}

/** The file a file key acts on (X, Z, V): the top-most one on screen; -1 with none. */
export function activeFile(files: readonly Span[], view: Span): number {
  return files.findIndex((file) => file.bottom > view.top + AT_TOP && file.top < view.bottom);
}

export type FileStep = 'next' | 'prev' | 'first' | 'last';

/** Where a file key goes from `origin` among `count` files, clamped at the ends as the review app's are; null: nowhere. */
export function fileStep(step: FileStep, origin: number, count: number): number | null {
  if (count === 0) return null;
  if (step === 'first') return 0;
  if (step === 'last') return count - 1;
  if (step === 'next') return origin < 0 ? 0 : Math.min(origin + 1, count - 1);
  return origin < 0 ? null : Math.max(origin - 1, 0);
}

/**
 * Z: the collapsed file to open again, as the review app picks it (AllFilesCodeView): the nearest at or above the
 * file being read, else the first. Null with none collapsed.
 */
export function reopenTarget(collapsed: readonly boolean[], current: number): number | null {
  let first: number | null = null;
  let nearest: number | null = null;
  for (const [i, folded] of collapsed.entries()) {
    if (!folded) continue;
    first ??= i;
    if (i <= current) nearest = i;
  }
  return nearest ?? first;
}

/** Elements in `root` and every shadow root under it (Pierre draws its rows in shadow DOM). */
function queryDeep<T extends Element>(root: ParentNode, selector: string): T[] {
  return getSearchRoots(root).flatMap((searchRoot) => [...(searchRoot.querySelectorAll?.(selector) ?? [])] as T[]);
}

/** The file's header (the review app's FileHeader), once its viewer is mounted. */
function headerOf(shell: HTMLElement): HTMLElement | null {
  return queryDeep<HTMLElement>(shell, '[data-file-header-path]')[0] ?? null;
}

/** The header's collapse arrow (AllFilesCodeView's `collapseToggle`), once the file's viewer is mounted. */
export function collapseToggle(shell: HTMLElement): HTMLButtonElement | null {
  const button = queryDeep<HTMLElement>(shell, '[data-file-collapse-toggle]')[0];
  return button instanceof HTMLButtonElement ? button : null;
}

/** Whether the file shows only its header, as its arrow says. */
export function isCollapsed(shell: HTMLElement): boolean {
  return collapseToggle(shell)?.dataset.fileCollapseToggle === 'collapsed';
}

/** The header's Viewed button, where the review has Viewed ticks. */
export function viewedToggle(shell: HTMLElement): HTMLElement | null {
  const header = headerOf(shell);
  return header?.querySelector<HTMLElement>('[data-file-header-viewed]') ?? null;
}

export interface ChangeSpot {
  shell: HTMLElement;
  change: DiffChange;
  /** Its first row, where drawn. */
  el: HTMLElement | null;
  placement: ChangePlacement;
}

/**
 * Every change of the review's open files, in page order, placed against the reading line as production places them
 * (AllFilesCodeView `jumpChange`): a drawn row by where it is; a row of a drawn file outside its drawn rows by its
 * index; a file not drawn yet by where its box is. A collapsed file's changes are not on the page: none.
 */
export function changeSpots(shells: readonly HTMLElement[], changesOf: (shell: HTMLElement) => readonly DiffChange[], readingLine: number): ChangeSpot[] {
  const spots: ChangeSpot[] = [];
  for (const shell of shells) {
    if (isCollapsed(shell)) continue;
    const changes = changesOf(shell);
    if (changes.length === 0) continue;
    const rows = renderedUnifiedRange(shell);
    const box = shell.getBoundingClientRect();
    for (const change of changes) {
      const el = rows ? findChangeElement(shell, change) : null;
      const placement: ChangePlacement = el
        ? placementOf(el.getBoundingClientRect(), readingLine)
        : rows
          ? change.unifiedIndex < rows.min ? 'before' : 'after'
          : box.bottom <= readingLine ? 'before' : 'after';
      spots.push({ shell, change, el, placement });
    }
  }
  return spots;
}
