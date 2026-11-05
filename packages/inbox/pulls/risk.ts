/**
 * PR risk ranking in the window (approval "code-review-launch-build", item 4): what a
 * row's mark says and what the filter keeps. A stack is one row, so it takes the
 * highest judgment of its open layers.
 */
import type { InboxPullGroups, InboxPullItem, InboxPullRiskJudgment, InboxPullRiskLevel, InboxPullStack } from '@plannotator/core/inbox-types';
import { openLayers, pullRows } from './model';

export type RiskFilterValue = 'all' | 'high' | 'medium';

const FILTER_KEY = 'plannotator-inbox-pr-risk-filter';
const RANK: Record<InboxPullRiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function readRiskFilter(): RiskFilterValue {
  try {
    const value = window.localStorage.getItem(FILTER_KEY);
    return value === 'high' || value === 'medium' ? value : 'all';
  } catch {
    return 'all';
  }
}

export function saveRiskFilter(value: RiskFilterValue): void {
  try {
    window.localStorage.setItem(FILTER_KEY, value);
  } catch {
    // Remembered for this window only.
  }
}

export const riskFilterWords: Record<RiskFilterValue, string> = { all: 'All', high: 'High', medium: 'Medium and up' };
export const riskLevelWord: Record<InboxPullRiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export type RiskJudgments = Readonly<Record<string, InboxPullRiskJudgment>>;

/**
 * The highest judgment among a stack's open layers, with the layer it is on; null when none has one.
 * Null too when the best it could say is Low with a layer not ranked: that layer could be anything.
 */
export function stackRisk(stack: Pick<InboxPullStack, 'layers'>, judgments: RiskJudgments): (InboxPullRiskJudgment & { key: string }) | null {
  let top: (InboxPullRiskJudgment & { key: string }) | null = null;
  for (const layer of openLayers(stack)) {
    const judged = judgments[layer.key];
    if (judged && (!top || RANK[judged.level] > RANK[top.level])) top = { ...judged, key: layer.key };
  }
  if (top?.level === 'low' && openLayers(stack).some((layer) => !judgments[layer.key])) return null;
  return top;
}

const passes = (level: InboxPullRiskLevel | undefined, filter: RiskFilterValue) => filter === 'all' || (level !== undefined && (filter === 'high' ? level === 'high' : RANK[level] >= RANK.medium));

/**
 * The rows the filter keeps, highest first within each group. A row with a layer not
 * ranked yet can't be said to be out of it for good: `notJudged` counts those it hid, so
 * a hidden row is never silent. With the filter off, the groups as they came, in their order.
 */
export function filterPullGroups(groups: InboxPullGroups, filter: RiskFilterValue, judgments: RiskJudgments): { groups: InboxPullGroups; notJudged: number } {
  if (filter === 'all') return { groups, notJudged: 0 };
  const level = (item: InboxPullItem) => stackRisk(item.stack, judgments)?.level;
  const keep = (items: readonly InboxPullItem[]) =>
    items
      .filter((item) => passes(level(item), filter))
      .map((item, at) => ({ item, at }))
      .sort((a, b) => RANK[level(b.item)!] - RANK[level(a.item)!] || a.at - b.at)
      .map(({ item }) => item);
  return {
    groups: { ...groups, on_you: keep(groups.on_you), ready: keep(groups.ready), waiting: keep(groups.waiting) },
    notJudged: pullRows(groups).filter((item) => !passes(level(item), filter) && openLayers(item.stack).some((layer) => !judgments[layer.key])).length,
  };
}
