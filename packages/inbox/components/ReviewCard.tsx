import type { InboxGuideRef } from '@plannotator/core/inbox-types';
import { inboxReviewTitleLine, type InboxReviewVerdictRecord } from '@plannotator/core/inbox-review';
import { formatCount, plural, whenTime } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';

export interface ReviewOutcome {
  verdict: InboxReviewVerdictRecord;
  at: string;
}

export function reviewOutcomeWords(outcome: ReviewOutcome | null): string {
  if (!outcome) return 'Waiting on you';
  const { verdict, comments } = outcome.verdict;
  if (verdict === 'approved') return `Approved ${whenTime(outcome.at)}`;
  return comments > 0 ? `Changes requested · ${plural(comments, 'comment')}` : 'Changes requested';
}

export function ReviewCard({ guide, outcome, verdict = true, onOpen, onInReviews }: { guide: InboxGuideRef; outcome: ReviewOutcome | null; verdict?: boolean; onOpen: () => void; onInReviews?: () => void }) {
  const chapters = guide.chapters?.length ?? 0;
  return (
    <div className="ib-rvcard" data-review-card="" data-review-outcome={outcome?.verdict.verdict ?? 'waiting'}>
      <div className="ib-rvc-top">
        <span className="ib-rvc-kind">
          <Icon name="code" size={14} />
          {guide.walkthrough ? 'Walkthrough' : 'Review'}
        </span>
        {(verdict || outcome) && (
          <span className="ib-rvc-state" data-verdict={outcome?.verdict.verdict ?? undefined}>
            {outcome?.verdict.verdict === 'approved' && <Icon name="check" size={13} />}
            {reviewOutcomeWords(outcome)}
          </span>
        )}
      </div>
      <div className="ib-rvc-title">
        <bdi>{inboxReviewTitleLine(guide.title)}</bdi>
      </div>
      <div className="ib-rvc-meta">
        {plural(guide.files, 'file')}
        {!guide.walkthrough && (
          <>
            {' '}
            <span className="ib-add">+{formatCount(guide.additions)}</span> <span className="ib-del">-{formatCount(guide.deletions)}</span>
          </>
        )}
        {chapters > 0 && <> · {plural(chapters, 'chapter')}</>}
      </div>
      <div className="ib-rvc-foot">
        <button type="button" className={`ib-btn${outcome ? '' : ' ib-pri'}`} onClick={onOpen} data-review-start="">
          {guide.walkthrough ? 'Open walkthrough' : outcome ? 'Open review' : 'Start review'}
        </button>
        {onInReviews && (
          <button type="button" className="ib-rvc-link" onClick={onInReviews} data-review-in-reviews="">
            <Icon name="reviews" size={14} />
            In Reviews
          </button>
        )}
        {outcome && <span className="ib-rvc-note">Your verdict is in your reply below.</span>}
      </div>
    </div>
  );
}
