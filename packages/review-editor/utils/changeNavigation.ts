import type { Hunk } from '@pierre/diffs';
import { getSearchRoots } from './reviewSearchHighlight';

export type ChangeSide = 'additions' | 'deletions';

export interface DiffChange {
  unifiedIndex: number;
  lineNumber: number;
  side: ChangeSide;
}

export type ChangeHunk = Pick<Hunk, 'additionStart' | 'deletionStart' | 'unifiedLineStart' | 'hunkContent'>;

export function listDiffChanges(hunks: readonly ChangeHunk[] | null | undefined): DiffChange[] {
  const changes: DiffChange[] = [];
  for (const hunk of hunks ?? []) {
    let unified = hunk.unifiedLineStart;
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent ?? []) {
      if (content.type === 'context') {
        unified += content.lines;
        oldLine += content.lines;
        newLine += content.lines;
        continue;
      }
      if (content.deletions + content.additions === 0) continue;
      changes.push(
        content.deletions > 0
          ? { unifiedIndex: unified, lineNumber: oldLine, side: 'deletions' }
          : { unifiedIndex: unified, lineNumber: newLine, side: 'additions' },
      );
      unified += content.deletions + content.additions;
      oldLine += content.deletions;
      newLine += content.additions;
    }
  }
  return changes;
}

export type ChangePlacement = 'before' | 'at' | 'after';

export function resolveChangeJump(
  placements: readonly ChangePlacement[],
  direction: 'next' | 'prev',
  current: number | null,
): number | null {
  if (placements.length === 0) return null;
  if (current != null && current >= 0 && current < placements.length) {
    const target = direction === 'next' ? current + 1 : current - 1;
    return target >= 0 && target < placements.length ? target : null;
  }
  if (direction === 'next') {
    const index = placements.indexOf('after');
    return index === -1 ? null : index;
  }
  const index = placements.lastIndexOf('before');
  return index === -1 ? null : index;
}

export function readingLineFor(
  view: { top: number; bottom: number },
  direction: 'next' | 'prev',
  scroll: { atTop: boolean; atBottom: boolean },
): number {
  if (direction === 'next' && scroll.atTop) return view.top - 1;
  if (direction === 'prev' && scroll.atBottom) return view.bottom + 1;
  return (view.top + view.bottom) / 2;
}

export function placementOf(
  rect: { top: number; height: number },
  readingLine: number,
): ChangePlacement {
  const middle = rect.top + rect.height / 2;
  const slack = Math.max(4, rect.height / 2);
  if (middle < readingLine - slack) return 'before';
  if (middle > readingLine + slack) return 'after';
  return 'at';
}

export function findChangeElement(root: ParentNode, change: DiffChange): HTMLElement | null {
  const selector = `[data-line-type^="change-"][data-line-index^="${change.unifiedIndex},"]`;
  for (const searchRoot of getSearchRoots(root)) {
    const el = searchRoot.querySelector?.(selector);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

export function renderedUnifiedRange(root: ParentNode): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const searchRoot of getSearchRoots(root)) {
    for (const el of searchRoot.querySelectorAll?.('[data-line-index]') ?? []) {
      const unified = Number.parseInt(el.getAttribute('data-line-index') ?? '', 10);
      if (!Number.isFinite(unified)) continue;
      if (unified < min) min = unified;
      if (unified > max) max = unified;
    }
  }
  return min === Infinity ? null : { min, max };
}

export function changeJumpDirection(event: KeyboardEvent): 'next' | 'prev' | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key !== 'n' && event.key !== 'N') return null;
  if (isTypingOrigin(event)) return null;
  return event.shiftKey ? 'prev' : 'next';
}

export function isTypingOrigin(event: KeyboardEvent): boolean {
  const origin = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
  if (!origin || typeof origin !== 'object') return false;
  const tag = origin.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || origin.isContentEditable === true;
}
