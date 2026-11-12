import type { InboxPullRiskJudgment, InboxPullRiskLevel, InboxPullStack, InboxReviewGroups, InboxReviewRow } from '@plannotator/core/inbox-types';
import { openLayers } from './model';

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
  }
}

export const riskFilterWords: Record<RiskFilterValue, string> = { all: 'All', high: 'High', medium: 'Medium and up' };
export const riskLevelWord: Record<InboxPullRiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export type RiskJudgments = Readonly<Record<string, InboxPullRiskJudgment>>;
export type RiskFailures = Readonly<Record<string, string>>;

export function stackRisk(stack: Pick<InboxPullStack, 'layers'>, judgments: RiskJudgments): (InboxPullRiskJudgment & { key: string }) | null {
  let top: (InboxPullRiskJudgment & { key: string }) | null = null;
  for (const layer of openLayers(stack)) {
    const judged = judgments[layer.key];
    if (judged && (!top || RANK[judged.level] > RANK[top.level])) top = { ...judged, key: layer.key };
  }
  if (top?.level === 'low' && openLayers(stack).some((layer) => !judgments[layer.key])) return null;
  return top;
}

export function stackRiskFailure(stack: Pick<InboxPullStack, 'layers'>, judgments: RiskJudgments, failed: RiskFailures): string | null {
  if (stackRisk(stack, judgments)) return null;
  for (const layer of openLayers(stack)) {
    const reason = failed[layer.key];
    if (reason) return reason;
  }
  return null;
}

const passes = (level: InboxPullRiskLevel | undefined, filter: RiskFilterValue) => filter === 'all' || (level !== undefined && (filter === 'high' ? level === 'high' : RANK[level] >= RANK.medium));

export function rowStack(row: Pick<InboxReviewRow, 'stacks'>): Pick<InboxPullStack, 'layers'> {
  return row.stacks.length === 1 ? row.stacks[0]! : { layers: row.stacks.flatMap((stack) => stack.layers) };
}

const rankOf = (row: InboxReviewRow, judgments: RiskJudgments) => {
  const found = stackRisk(rowStack(row), judgments)?.level;
  return found ? RANK[found] : -1;
};

export function filterReviewRows(
  rows: readonly InboxReviewRow[],
  filter: RiskFilterValue,
  judgments: RiskJudgments,
  failed: RiskFailures,
): { rows: readonly InboxReviewRow[]; notJudged: number; notRanked: InboxReviewRow[] } {
  if (filter === 'all') return { rows, notJudged: 0, notRanked: [] };
  const isFailed = (row: InboxReviewRow) => stackRiskFailure(rowStack(row), judgments, failed) !== null;
  const kept = (row: InboxReviewRow) => passes(stackRisk(rowStack(row), judgments)?.level, filter) || (filter !== 'high' && isFailed(row));
  const hidden = rows.filter((row) => !kept(row) && (isFailed(row) || openLayers(rowStack(row)).some((layer) => !judgments[layer.key])));
  return {
    rows: rows.filter(kept),
    notJudged: filter === 'high' ? 0 : hidden.length,
    notRanked: filter === 'high' ? hidden : [],
  };
}

export function riskOrder(groups: InboxReviewGroups, judgments: RiskJudgments): InboxReviewGroups {
  const sorted = (rows: readonly InboxReviewRow[]) =>
    rows
      .map((row, at) => ({ row, at, rank: rankOf(row, judgments) }))
      .sort((a, b) => b.rank - a.rank || a.at - b.at)
      .map(({ row }) => row);
  return { on_you: sorted(groups.on_you), agents: sorted(groups.agents), ready: sorted(groups.ready), waiting: sorted(groups.waiting), not_reviewed: sorted(groups.not_reviewed) };
}
