/**
 * The review card (code review in the Inbox, approval
 * "inbox-code-review-direction", concept A take B): drawn in place of the
 * guided-review tile on an agent's message whose guide is a review, while the
 * person has Settings → Capabilities → Code review on. Off, the same message
 * shows today's tile and opens today's guide pane.
 *
 * It names the change (title, files, lines, the agent's chapters) and holds
 * one button: Start review, which opens the full-window review. Once the
 * person gave a verdict it shows the outcome ("Approved 3:31 PM",
 * "Changes requested · 3 comments") and the button reads Open review.
 */

import type { InboxGuideRef } from '@plannotator/core/inbox-types';
import type { InboxReviewVerdictRecord } from '@plannotator/core/inbox-review';
import { formatCount, plural, whenTime } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';

export interface ReviewOutcome {
  verdict: InboxReviewVerdictRecord;
  /** When the verdict reply was sent. */
  at: string;
}

/** The card's status words: who it waits on, or the verdict. */
export function reviewOutcomeWords(outcome: ReviewOutcome | null): string {
  if (!outcome) return 'Waiting on you';
  const { verdict, comments } = outcome.verdict;
  if (verdict === 'approved') return `Approved ${whenTime(outcome.at)}`;
  return comments > 0 ? `Changes requested · ${plural(comments, 'comment')}` : 'Changes requested';
}

export function ReviewCard({ guide, outcome, onOpen }: { guide: InboxGuideRef; outcome: ReviewOutcome | null; onOpen: () => void }) {
  const chapters = guide.chapters ?? [];
  return (
    <div className="ib-rvcard" data-review-card="" data-review-outcome={outcome?.verdict.verdict ?? 'waiting'}>
      <div className="ib-rvc-top">
        <span className="ib-rvc-kind">
          <Icon name="code" size={14} />
          Review
        </span>
        <span className="ib-rvc-state" data-verdict={outcome?.verdict.verdict ?? undefined}>
          {outcome?.verdict.verdict === 'approved' && <Icon name="check" size={13} />}
          {reviewOutcomeWords(outcome)}
        </span>
      </div>
      <div className="ib-rvc-title">
        <bdi>{guide.title}</bdi>
      </div>
      <div className="ib-rvc-meta">
        {plural(guide.files, 'file')} <span className="ib-add">+{formatCount(guide.additions)}</span> <span className="ib-del">-{formatCount(guide.deletions)}</span>
      </div>
      {chapters.length > 0 && (
        <ol className="ib-rvc-chapters">
          {chapters.map((title, index) => (
            <li key={`${title}:${index}`}>
              <span className="ib-rvc-n">{index + 1}</span>
              <span className="ib-rvc-ct">{title}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="ib-rvc-foot">
        <button type="button" className={`ib-btn${outcome ? '' : ' ib-pri'}`} onClick={onOpen} data-review-start="">
          {outcome ? 'Open review' : 'Start review'}
        </button>
        {outcome && <span className="ib-rvc-note">Your verdict is in your reply below.</span>}
      </div>
    </div>
  );
}
