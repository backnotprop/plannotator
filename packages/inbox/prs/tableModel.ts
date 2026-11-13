/**
 * The board's Table (approval "inbox-pr-board-bulk"): the same PRs as the grid, as rows under one row per repository.
 * Plain functions: the layout's address, the Checks words, and the sort.
 *
 * - The layout is kept per window: `&layout=table` in the page's address (`#prs`), as Open | Merged is. Grid is the
 *   default and writes nothing, so every older address still reads as it did.
 * - A sort works inside each repository and moves a stack as one block, so its layers stay together in landing order.
 *   With no sort the order is the board's (`sheetModel`).
 */
import { inboxPullIsOpen, inboxPullLabel, type InboxPull, type InboxPullChecks, type InboxPullStack } from '@plannotator/core/inbox-types';
import { checksLabel } from './ChecksMark';
import { needsYou, statusWords, type RiskLevels } from './sheetModel';

export type SheetLayout = 'grid' | 'table';

/** The address's `layout` value: only `table` is the table. */
export function sheetLayoutOf(value: string | null | undefined): SheetLayout {
  return value === 'table' ? 'table' : 'grid';
}

/** What the address carries for a layout: nothing for Grid. */
export function sheetLayoutHash(layout: SheetLayout | undefined): string {
  return layout === 'table' ? '&layout=table' : '';
}

/** A tile's or a row's name for a screen reader: its number, title, and what stands out. */
export function pullWords(pull: InboxPull): string {
  const you = needsYou(pull);
  return [inboxPullLabel(pull), pull.title, pull.state === 'draft' ? 'draft' : pull.state === 'merged' ? 'merged' : null, you === 'review' ? 'needs your review' : you === 'changes' ? 'changes requested' : null, checksLabel(pull.checks)]
    .filter(Boolean)
    .join(', ');
}

/** The Checks column's word. */
export function checksWord(checks: InboxPullChecks | null): 'Passed' | 'Running' | 'Failing' | null {
  return checks === 'success' ? 'Passed' : checks === 'pending' ? 'Running' : checks === 'failure' ? 'Failing' : null;
}

export type SortKey = 'number' | 'title' | 'author' | 'state' | 'checks' | 'risk' | 'updated' | 'size';
export interface TableSort {
  key: SortKey;
  /** 1 as first clicked; -1 reversed. */
  dir: 1 | -1;
}

/** A header's click: a new column sorts its first way; the same column again reverses. */
export function nextSort(was: TableSort | null, key: SortKey): TableSort {
  return was?.key === key ? { key, dir: was.dir === 1 ? -1 : 1 } : { key, dir: 1 };
}

const CHECKS_RANK: Record<InboxPullChecks, number> = { failure: 0, pending: 1, success: 2 };
const RISK_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * One PR's value for a column, compared ascending on the first click. The first click puts what needs a look first
 * where that has a meaning: failing checks, High risk, the newest update.
 */
function sortValue(pull: InboxPull, key: SortKey, now: number, risk: RiskLevels): number | string {
  switch (key) {
    case 'number':
      return pull.number;
    case 'title':
      return pull.title.toLowerCase();
    case 'author':
      return pull.mine ? '' : (pull.author ?? '￿').toLowerCase();
    case 'state':
      return statusWords(pull, now).toLowerCase();
    case 'checks':
      return pull.checks ? CHECKS_RANK[pull.checks] : 3;
    case 'risk':
      return risk[pull.key] ? RISK_RANK[risk[pull.key]!] : 3;
    case 'updated':
      return -Date.parse(pull.updated_at);
    case 'size':
      return pull.additions + pull.deletions;
  }
}

/** The layer a stack sorts by: the next to land (its lowest open layer), else its first. */
export function leadLayer(stack: Pick<InboxPullStack, 'layers'>): InboxPull {
  return stack.layers.find(inboxPullIsOpen) ?? stack.layers[0]!;
}

/** A repository's stacks in a column's order; equal values keep the board's order. */
export function sortUnits<T extends Pick<InboxPullStack, 'layers'>>(units: readonly T[], sort: TableSort | null, now: number, risk: RiskLevels = {}): T[] {
  if (!sort) return [...units];
  const keyed = units.map((unit, at) => ({ unit, at, value: sortValue(leadLayer(unit), sort.key, now, risk) }));
  keyed.sort((a, b) => {
    const order = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : String(a.value).localeCompare(String(b.value));
    return order * sort.dir || a.at - b.at;
  });
  return keyed.map((k) => k.unit);
}
