/**
 * The Pull requests page, "the Sheet" (approval "inbox-pr-dashboard", the owner's answers of 2026-11-09): every open
 * pull request of the person's as number tiles, a section per repository, stacks as joined tiles. Plain functions:
 * the page draws what these say.
 *
 * - Needs you (`needsYou`) follows Critique's attention set: it is your turn. A review asked of you and not given yet
 *   (GitHub drops the request once you review), or your own PR where a reviewer asked for changes.
 * - The order inside a repository (`unitRank`, `orderUnits`): needs you first, waiting longest first; then a layer
 *   that holds up a stack; then changes requested; then ready to land; then the rest, newest first. The agent's risk
 *   rating breaks a tie inside a tier (High, then Medium).
 * - A stack of more than `FOLD_OVER` PRs is one strip (`foldsToStrip`); a shorter one keeps its joined tiles.
 */
import {
  INBOX_PULLS_MERGED_DAYS,
  inboxPullIsOpen,
  inboxPullLabel,
  inboxPullRepoKey,
  inboxPullStacks,
  type InboxPull,
  type InboxPullRiskLevel,
  type InboxPullStack,
  type InboxPullsAnswer,
} from '@plannotator/core/inbox-types';
import { repoLabels } from '../pulls/labels';
import { person, wordsText, type Words } from '../pulls/words';

/** A stack folds to one strip on the Sheet past this many PRs (the owner's answer, q-f1451f8d). */
export const FOLD_OVER = 8;
/** "Landed this week". */
export const WEEK_MS = 7 * 86_400_000;

export type NeedsYou = 'review' | 'changes';

/** Whether it is the person's turn on this PR, and why; null when it isn't. */
export function needsYou(pull: Pick<InboxPull, 'state' | 'mine' | 'requested' | 'review'>): NeedsYou | null {
  if (!inboxPullIsOpen(pull)) return null;
  if (pull.requested && !pull.mine) return 'review';
  if (pull.mine && pull.review === 'changes_requested') return 'changes';
  return null;
}

/** Approved (or no review needed), its checks passed or none ran, no conflict, not a draft: it can land. */
export function readyToLand(pull: Pick<InboxPull, 'state' | 'review' | 'checks' | 'conflicts'>): boolean {
  return pull.state === 'open' && pull.review === 'approved' && pull.checks !== 'failure' && pull.checks !== 'pending' && pull.conflicts !== true;
}

/**
 * The forge said this can merge as the list read it: open, not a draft, no conflict (GitHub `MERGEABLE`, GitLab no
 * conflicts), no review it still needs or changes asked, its checks not failing or running. Only then does the
 * popover offer Merge; the server asks the forge again before it merges.
 */
export function mergeOffered(pull: Pick<InboxPull, 'state' | 'review' | 'checks' | 'conflicts' | 'head_sha'>): boolean {
  return (
    pull.state === 'open' &&
    pull.conflicts === false &&
    pull.review !== 'changes_requested' &&
    pull.review !== 'review_required' &&
    pull.checks !== 'failure' &&
    pull.checks !== 'pending' &&
    !!pull.head_sha
  );
}

/** Open layers above this one in its stack wait on it: it holds the stack up. */
export function blocksStack(stack: Pick<InboxPullStack, 'layers' | 'parents'>, pull: InboxPull): boolean {
  if (!inboxPullIsOpen(pull)) return false;
  return stack.layers.some((layer) => layer.key !== pull.key && inboxPullIsOpen(layer) && stack.parents[layer.key] === pull.key);
}

/** The tiers, in the page's order. */
export const TIER = { needsYou: 0, blocking: 1, changes: 2, ready: 3, rest: 4 } as const;
export type Tier = (typeof TIER)[keyof typeof TIER];

/** One PR's tier inside its stack. */
export function pullTier(stack: Pick<InboxPullStack, 'layers' | 'parents'>, pull: InboxPull): Tier {
  if (needsYou(pull)) return TIER.needsYou;
  if (blocksStack(stack, pull)) return TIER.blocking;
  if (inboxPullIsOpen(pull) && pull.review === 'changes_requested') return TIER.changes;
  if (readyToLand(pull)) return TIER.ready;
  return TIER.rest;
}

const RISK_RANK: Record<InboxPullRiskLevel, number> = { high: 0, medium: 1, low: 2 };
export type RiskLevels = Readonly<Record<string, InboxPullRiskLevel>>;

/** Where a stack (one PR or several) sits in its repository: its best layer's tier, then risk, then time. */
export interface UnitRank {
  tier: Tier;
  /** 0 High, 1 Medium, 2 Low, 3 not rated. */
  risk: number;
  /** Needs you: the oldest update of a layer on you (it has waited longest); else the newest update of any layer. */
  at: string;
}

export function unitRank(stack: InboxPullStack, risk: RiskLevels = {}): UnitRank {
  const open = stack.layers.filter(inboxPullIsOpen);
  const layers = open.length > 0 ? open : stack.layers;
  const tier = Math.min(...layers.map((l) => pullTier(stack, l))) as Tier;
  const inTier = layers.filter((l) => pullTier(stack, l) === tier);
  const levels = inTier.map((l) => (risk[l.key] ? RISK_RANK[risk[l.key]!] : 3));
  const times = inTier.map((l) => l.updated_at).sort();
  return { tier, risk: Math.min(...levels), at: tier === TIER.needsYou ? times[0]! : times[times.length - 1]! };
}

/** The page's order: tier, then risk (High first), then waiting longest (needs you) or newest (the rest), then number. */
export function compareRanks(a: UnitRank, b: UnitRank): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.risk !== b.risk) return a.risk - b.risk;
  if (a.at !== b.at) return a.tier === TIER.needsYou ? (a.at < b.at ? -1 : 1) : a.at < b.at ? 1 : -1;
  return 0;
}

export function orderUnits(stacks: readonly InboxPullStack[], risk: RiskLevels = {}): InboxPullStack[] {
  const ranked = stacks.map((stack) => ({ stack, rank: unitRank(stack, risk), top: Math.max(...stack.layers.map((l) => l.number)) }));
  return ranked.sort((a, b) => compareRanks(a.rank, b.rank) || b.top - a.top).map((r) => r.stack);
}

/** More than `FOLD_OVER` PRs in one stack: one strip on the Sheet. */
export function foldsToStrip(stack: Pick<InboxPullStack, 'layers'>): boolean {
  return stack.layers.length > FOLD_OVER;
}

/** A stack has more than one layer (a single PR is a stack of one in core's terms, a plain tile here). */
export function isStack(stack: Pick<InboxPullStack, 'layers'>): boolean {
  return stack.layers.length > 1;
}

/**
 * The filter field: every word must be in the title, the author, the repository or the number (`#412`, `!61`, `412`).
 * Empty: everything matches.
 */
export function matchesQuery(pull: Pick<InboxPull, 'title' | 'author' | 'repo' | 'number' | 'platform'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${pull.title}\n${pull.author ?? ''}\n${pull.repo}`.toLowerCase();
  const label = inboxPullLabel(pull).toLowerCase();
  return words.every((word) => {
    if (/^[#!]?\d+$/.test(word)) return String(pull.number) === word.replace(/^[#!]/, '') || label === word;
    return hay.includes(word);
  });
}

/** One repository's section. */
export interface SheetSection {
  key: string;
  host: string;
  repo: string;
  /** Its short name, as long as it needs to be told apart ("ledger", "platform/ledger"). */
  label: string;
  /** None of the Inbox's projects is a clone of it. */
  outside: boolean;
  /** Open stacks (one PR or several), in the page's order. */
  units: InboxPullStack[];
  open: number;
  needYou: number;
  landedWeek: number;
}

export interface SheetHead {
  open: number;
  repos: number;
  needYou: number;
  failing: number;
  landedWeek: number;
}

export interface SheetModel {
  head: SheetHead;
  sections: SheetSection[];
}

const isMergedWithin = (pull: InboxPull, now: number, ms: number) => pull.state === 'merged' && !!pull.merged_at && now - Date.parse(pull.merged_at) <= ms;

/** The Open view: a section per repository with an open PR, the repositories with the most on you first. */
export function sheetModel(answer: Pick<InboxPullsAnswer, 'pulls' | 'projects'>, now: number, risk: RiskLevels = {}): SheetModel {
  const stacks = inboxPullStacks(answer.pulls).filter((stack) => stack.layers.some(inboxPullIsOpen));
  const byRepo = new Map<string, InboxPullStack[]>();
  for (const stack of stacks) {
    const key = inboxPullRepoKey(stack.host, stack.repo);
    byRepo.set(key, [...(byRepo.get(key) ?? []), stack]);
  }
  const labels = repoLabels(stacks);
  const sections: SheetSection[] = [...byRepo.entries()].map(([key, units]) => {
    const pulls = units.flatMap((u) => u.layers);
    const open = pulls.filter(inboxPullIsOpen);
    const merged = answer.pulls.filter((p) => inboxPullRepoKey(p.host, p.repo) === key && isMergedWithin(p, now, WEEK_MS));
    return {
      key,
      host: units[0]!.host,
      repo: units[0]!.repo,
      label: labels.get(key) ?? units[0]!.repo,
      outside: !(answer.projects[key]?.length),
      units: orderUnits(units, risk),
      open: open.length,
      needYou: open.filter((p) => needsYou(p)).length,
      landedWeek: new Set(merged.map((p) => p.key)).size,
    };
  });
  sections.sort((a, b) => b.needYou - a.needYou || b.open - a.open || a.label.localeCompare(b.label));
  const open = answer.pulls.filter(inboxPullIsOpen);
  const unique = <T extends InboxPull>(list: T[]) => new Set(list.map((p) => p.key)).size;
  return {
    head: {
      open: unique(open),
      repos: sections.length,
      needYou: unique(open.filter((p) => needsYou(p))),
      failing: unique(open.filter((p) => p.checks === 'failure')),
      landedWeek: unique(answer.pulls.filter((p) => isMergedWithin(p, now, WEEK_MS))),
    },
    sections,
  };
}

/** One repository in the Merged view: its PRs merged in the last `INBOX_PULLS_MERGED_DAYS` days, the latest first. */
export interface MergedSection {
  key: string;
  label: string;
  pulls: InboxPull[];
}

/** The Merged view, and the repositories with open PRs and nothing merged ("Nothing merged in …"). */
export function mergedModel(answer: Pick<InboxPullsAnswer, 'pulls'>, now: number): { sections: MergedSection[]; quiet: string[] } {
  const seen = new Set<string>();
  const merged = answer.pulls.filter((p) => isMergedWithin(p, now, INBOX_PULLS_MERGED_DAYS * 86_400_000) && !seen.has(p.key) && (seen.add(p.key), true));
  const labels = repoLabels(answer.pulls);
  const byRepo = new Map<string, InboxPull[]>();
  for (const pull of merged.sort((a, b) => (a.merged_at! < b.merged_at! ? 1 : -1))) {
    const key = inboxPullRepoKey(pull.host, pull.repo);
    byRepo.set(key, [...(byRepo.get(key) ?? []), pull]);
  }
  const sections = [...byRepo.entries()].map(([key, pulls]) => ({ key, label: labels.get(key) ?? pulls[0]!.repo, pulls }));
  const quiet = [...new Set(answer.pulls.filter(inboxPullIsOpen).map((p) => inboxPullRepoKey(p.host, p.repo)))].filter((key) => !byRepo.has(key)).map((key) => labels.get(key) ?? key);
  return { sections, quiet };
}

/** A stack's open layers on you, failing, and open at all: the strip's and the stack view's words. */
export function stackCounts(stack: Pick<InboxPullStack, 'layers'>): { open: number; merged: number; needYou: number; failing: number } {
  const open = stack.layers.filter(inboxPullIsOpen);
  return {
    open: open.length,
    merged: stack.layers.filter((l) => l.state === 'merged').length,
    needYou: open.filter((l) => needsYou(l)).length,
    failing: open.filter((l) => l.checks === 'failure').length,
  };
}

/** A PR's state in a word or two, as the popover and the stack view say it. */
export function statusWords(pull: InboxPull, now: number): string {
  return wordsText(statusParts(pull, now));
}

/** `statusWords` in parts: "Waits on " then the reviewer, drawn with their face (`words.ts`). */
export function statusParts(pull: InboxPull, now: number): Words {
  const said = statusLine(pull, now);
  return typeof said === 'string' ? [said] : said;
}

function statusLine(pull: InboxPull, now: number): string | Words {
  if (pull.state === 'merged') return pull.merged_at ? `Merged ${agoWords(pull.merged_at, now)}` : 'Merged';
  if (pull.state === 'closed') return 'Closed';
  const you = needsYou(pull);
  if (pull.state === 'draft') return you === 'review' ? 'Draft · waits on your review' : 'Draft';
  if (you === 'review') return 'Waits on your review';
  if (you === 'changes') return 'Changes requested';
  if (pull.checks === 'failure') return 'Checks failing';
  if (pull.conflicts === true) return 'Conflicts with its base';
  if (pull.review === 'changes_requested') return 'Changes requested';
  if (readyToLand(pull)) return 'Approved · ready to land';
  if (pull.review === 'approved') return pull.checks === 'pending' ? 'Approved · checks running' : 'Approved';
  if (pull.checks === 'pending') return 'Checks running';
  if (pull.reviewers.length > 0) return ['Waits on ', person(pull.reviewers[0]!), ...(pull.reviewers.length > 1 ? [` and ${pull.reviewers.length - 1} more`] : [])];
  return 'Waiting on review';
}

/** "today", "2 days ago", "3 weeks ago". */
export function agoWords(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** "5d", "2w", "3mo": the stack view's Updated column. */
export function ageShort(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return 'today';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** The forge's closed search for the person, per host the list read ("Closed on GitHub ↗"). */
export function closedLinks(hosts: readonly { host: string; cli: 'gh' | 'glab' }[]): { host: string; label: string; url: string }[] {
  return hosts.map(({ host, cli }) => {
    const gitlab = cli === 'glab';
    const name = host === 'github.com' ? 'GitHub' : host === 'gitlab.com' ? 'GitLab' : host;
    const url = gitlab
      ? `https://${host}/dashboard/merge_requests?state=closed`
      : `https://${host}/pulls?q=${encodeURIComponent('is:pr is:closed involves:@me sort:updated-desc')}`;
    return { host, label: `Closed on ${name}`, url };
  });
}

/** The stack's layers in the stack view's order: the top of the stack first, the base branch below the last. */
export function topFirst(stack: Pick<InboxPullStack, 'layers'>): InboxPull[] {
  return [...stack.layers].reverse();
}
