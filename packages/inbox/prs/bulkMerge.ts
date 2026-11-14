/**
 * Bulk Merge on the Pull requests board (approval "inbox-pr-board-bulk": "merge the green ones and tell me about the
 * rest", a confirm before merging). Which of the picked PRs merge and why each of the others doesn't, in the words the
 * bar and the report show. Pure: SheetPage asks it, the tests table it.
 *
 * Green is the popover's own rule (`mergeOffered`) plus one for stacks: only the layer that lands next merges, since a
 * layer above another open layer would merge into that layer's branch, not its stack's base. The server still asks the
 * forge again, per PR, before it merges (`mergePull`).
 */
import { inboxPullIsOpen, inboxPullLabel, type InboxPull, type InboxPullStack } from '@plannotator/core/inbox-types';
import { forgeName } from '../pulls/labels';
import { leadLayer } from './tableModel';

/** Why a picked PR can't merge now, the words after "can't merge now: "; null when it can. */
export function cantMergeWhy(pull: InboxPull, stack: Pick<InboxPullStack, 'layers'> | null): string | null {
  if (pull.state === 'draft') return 'it is a draft';
  if (!inboxPullIsOpen(pull)) return null;
  const lead = stack ? leadLayer(stack) : pull;
  if (lead.key !== pull.key) return `it lands after ${inboxPullLabel(lead)}`;
  if (pull.conflicts === true) return 'it conflicts with its base branch';
  if (pull.conflicts !== false) return `${forgeName(pull)} hasn’t said yet whether it conflicts`;
  if (pull.review === 'changes_requested') return 'a reviewer asked for changes';
  if (pull.review === 'review_required') return 'it still needs a review';
  if (pull.checks === 'failure') return 'its checks are failing';
  if (pull.checks === 'pending') return 'its checks are still running';
  if (!pull.head_sha) return 'its head commit isn’t known';
  return null;
}

export interface MergePlan {
  /** The green ones, in the order given. */
  merge: InboxPull[];
  /** The rest, each with why. */
  skip: { pull: InboxPull; why: string }[];
}

/** The picked PRs (in the order on screen) split into what merges and what stays, each with its reason. */
export function mergePlan(picked: readonly InboxPull[], stackOf: (key: string) => Pick<InboxPullStack, 'layers'> | null): MergePlan {
  const plan: MergePlan = { merge: [], skip: [] };
  for (const pull of picked) {
    if (pull.state !== 'open' && pull.state !== 'draft') continue;
    const why = cantMergeWhy(pull, stackOf(pull.key));
    if (why) plan.skip.push({ pull, why });
    else plan.merge.push(pull);
  }
  return plan;
}

/** "#1190 can't merge now: its checks are failing." */
export function cantMergeLine(pull: InboxPull, why: string): string {
  return `${inboxPullLabel(pull)} can’t merge now: ${why}.`;
}

/** The bar's hint before Merge is pressed, or null when every pick can merge. */
export function mergeHint(plan: MergePlan): string | null {
  if (plan.skip.length === 0) return null;
  if (plan.merge.length > 0) return `${plan.skip.length} can’t merge now; ${plan.skip.length === 1 ? 'it stays' : 'they stay'} selected.`;
  if (plan.skip.length === 1) return cantMergeLine(plan.skip[0]!.pull, plan.skip[0]!.why);
  return 'None of these can merge now.';
}

/** The confirm's words: the second click (a tap on a phone) merges this many, and a merge can't be taken back. */
export function confirmWords(count: number, phone: boolean): string {
  return phone
    ? `Tap again to merge ${count}. A merge can’t be undone.`
    : `Click again to merge ${count} ${count === 1 ? 'pull request' : 'pull requests'}. A merge can’t be undone.`;
}

/** A refusal in the forge's (or the Inbox's) own words, after the PR's number. */
export function refusedLine(pull: InboxPull, message: string): string {
  return `${inboxPullLabel(pull)} ${message}`;
}

/** A pick that was left out: "#1190 Not merged: its checks are failing." */
export function notMergedLine(pull: InboxPull, why: string): string {
  return `${inboxPullLabel(pull)} Not merged: ${why}.`;
}
