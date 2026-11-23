/**
 * Where the review's keys go in the Inbox (ReviewKeys.tsx): the files and changes as the reader draws them. The
 * Inbox mounts one review-editor viewer per file (GuideFileCard), so moving between files and changes is read off
 * the page: each file's shell (`data-guide-file-shell`, always in the page), its header's own buttons (collapse,
 * Viewed), and the change rows Pierre has drawn (`data-line-type="change-…"`, `data-line-index="u,s"`). The keys do
 * what those controls do, and a review without a control (no Viewed ticks) has nothing for its key to do.
 *
 * Production's own rules are reused: which change is next (`resolveChangeJump`), the line it is measured from
 * (`readingLineFor`) and where a change sits (`placementOf`), review-editor/utils/changeNavigation.ts.
 */
import { placementOf, readingLineFor, resolveChangeJump, type ChangePlacement } from '@plannotator/review-editor/utils/changeNavigation';
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
  const viewTop = view.top;
  let origin = atStart && files[0] && files[0].top < view.bottom ? 0 : -1;
  for (const [i, file] of files.entries()) {
    if (file.top > viewTop + AT_TOP) break;
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

/** The header's collapse arrow (FileHeader's `collapseToggle`, the first control of its path). */
export function collapseToggle(shell: HTMLElement): HTMLButtonElement | null {
  const first = headerOf(shell)?.firstElementChild;
  const button = first?.querySelector(':scope > button');
  return button instanceof HTMLButtonElement ? button : null;
}

/** Whether the file shows only its header: its arrow offers to expand (the review app's own title for it). */
export function isCollapsed(shell: HTMLElement): boolean {
  return collapseToggle(shell)?.title === 'Expand diff';
}

/** The header's Viewed button, where the review has Viewed ticks. */
export function viewedToggle(shell: HTMLElement): HTMLElement | null {
  const header = headerOf(shell);
  return header?.querySelector<HTMLElement>('[data-file-header-viewed]') ?? null;
}

export interface ChangeStart {
  /** The run's first unified row (Pierre's `data-line-index` "u,s"). */
  index: number;
  el: HTMLElement;
}

/** A row this near its file's top (the header, a separator, a few lines) can only open the file's first change. */
const NEAR_FILE_TOP = 160;

/**
 * The changes Pierre has drawn in a file, each by its first row: a run of consecutive `-` / `+` rows is one change,
 * as in the review app (changeNavigation.ts `listDiffChanges`). A mounted viewer draws only the rows near the view, so
 * the first drawn row can sit inside a run whose start is not drawn: it counts only at the top of its file.
 */
export function changeStarts(shell: HTMLElement): ChangeStart[] {
  // Each drawn row by its unified index, the row with its line type first (a gutter cell can carry the index alone).
  const isChange = (el: HTMLElement | undefined) => !!el?.getAttribute('data-line-type')?.startsWith('change-');
  const drawn = new Map<number, HTMLElement>();
  for (const el of queryDeep<HTMLElement>(shell, '[data-line-index]')) {
    const index = Number.parseInt(el.getAttribute('data-line-index') ?? '', 10);
    if (!Number.isFinite(index)) continue;
    const kept = drawn.get(index);
    if (!kept || (!kept.hasAttribute('data-line-type') && el.hasAttribute('data-line-type'))) drawn.set(index, el);
  }
  const first = Math.min(...drawn.keys());
  const top = shell.getBoundingClientRect().top;
  return [...drawn.entries()]
    .filter(([index, el]) => {
      if (!isChange(el)) return false;
      const before = drawn.get(index - 1);
      if (before) return !isChange(before);
      return index !== first || el.getBoundingClientRect().top - top < NEAR_FILE_TOP;
    })
    .sort(([a], [b]) => a - b)
    .map(([index, el]) => ({ index, el }));
}

export interface ChangeSpot extends ChangeStart {
  file: string;
}

/** The change a step lands on among the drawn ones, measured as the review app measures (null: none that way). */
export function pickChange(
  spots: readonly ChangeSpot[],
  direction: 'next' | 'prev',
  view: Span,
  scroll: { atTop: boolean; atBottom: boolean },
  cursor: { file: string; index: number } | null,
): ChangeSpot | null {
  const readingLine = readingLineFor(view, direction, scroll);
  const placements: ChangePlacement[] = spots.map((spot) => placementOf(spot.el.getBoundingClientRect(), readingLine));
  let current: number | null = null;
  if (cursor) {
    const at = spots.findIndex((spot) => spot.file === cursor.file && spot.index === cursor.index);
    const rect = at === -1 ? null : spots[at]!.el.getBoundingClientRect();
    if (rect && rect.bottom > view.top && rect.top < view.bottom) current = at;
  }
  const target = resolveChangeJump(placements, direction, current);
  return target == null ? null : spots[target]!;
}
