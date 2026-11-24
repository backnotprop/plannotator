/**
 * Branch reviews in the window (docs/agent-guides/inbox-files-and-guides.md, "Branch reviews"): an agent reported its
 * branch ready for review, and its thread is a Reviews row from then on. Everything here draws only what the server
 * sends while the person has Branch reviews on (`InboxReviewsAnswer.branch_reviews`, a row's `started.report`): off,
 * nothing here shows.
 */
import { inboxBranchPlaceWords, inboxBranchReachWords, type InboxBranchReportRow, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { post } from '../api';
import { inboxUrl, rememberMachine } from '../inboxUrl';
import { localReviewMessage } from '../compose/reviewBox';

/** A reported branch's row: what the agent reported. Null for every other row. */
export function branchReportOf(row: Pick<InboxReviewRow, 'started'> | null | undefined): InboxBranchReportRow | null {
  return row?.started?.kind === 'branch' ? (row.started.report ?? null) : null;
}

/** A linked machine's reported branch: its thread is that machine's, so it opens through the forward there. */
export function rememberFarBranches(answer: InboxReviewsAnswer): void {
  for (const row of answer.rows) {
    const report = branchReportOf(row);
    if (report?.machine) rememberMachine([report.thread_id], report.machine.id);
  }
}

/** A reported branch's row: "retry-jitter", "retry-jitter on Mac mini", "retry-jitter from a cloud agent". */
export function branchRowLead(report: InboxBranchReportRow): string {
  if (report.machine) return `${report.branch} on ${report.machine.name ?? 'another computer'}`;
  return report.place === 'cloud' ? `${report.branch} from a cloud agent` : report.branch;
}

/** "Local branch: retry-jitter, against main". */
export function branchContextWords(report: InboxBranchReportRow): string {
  return `${inboxBranchPlaceWords(report)}: ${report.branch}${report.base ? `, against ${report.base}` : ''}`;
}

/** What a reported branch's thread says under its messages, until a review is in. */
export interface BranchNote {
  report: InboxBranchReportRow;
  /** Why the code can't be opened here; null when it can. */
  reach: string | null;
  /** A review can be asked for: the commit is in a checkout on this computer, or the branch is on the linked machine it is on. */
  canAsk: boolean;
  /** Not ranked, and can be now: this computer's report only. */
  canRank: boolean;
}

export function branchNoteOf(report: InboxBranchReportRow): BranchNote {
  return { report, reach: inboxBranchReachWords(report), canAsk: report.reachable || !!report.machine, canRank: report.rankable === true && !report.machine };
}

/** The words of a reported branch's "Ask for a guided review": the New review box's request for the whole branch. */
export function branchAskWords(report: Pick<InboxBranchReportRow, 'branch' | 'base'>, projectName: string | null): string {
  return localReviewMessage({ changes: 'branch', project: projectName, branch: report.branch, base: report.base, words: '' });
}

/**
 * The person already asked for a review of this report: a message of theirs since it came, carrying the ask's
 * words. Read from the thread, so the ask stays asked when the thread is opened again (no second request).
 */
export function branchAskedAlready(
  messages: readonly { author?: { kind: string }; body?: string; created_at?: string }[],
  report: Pick<InboxBranchReportRow, 'branch' | 'base' | 'at'>,
  projectName: string | null,
): boolean {
  const lead = branchAskWords(report, projectName).split('\n\n')[0]!;
  return messages.some((message) => message.author?.kind === 'person' && !!message.created_at && message.created_at >= report.at && !!message.body?.includes(lead));
}

/**
 * Rank a reported branch now (its Rank action: a judgment lost to a restart, failed twice, or made under rules since
 * changed). `started`: false when nothing could start (risk off, the commit not here, or one under way already).
 */
export function rankBranch(threadId: string): Promise<{ started: boolean }> {
  return post<{ started: boolean }>(inboxUrl('/reviews/branches/rank'), { thread_id: threadId });
}
