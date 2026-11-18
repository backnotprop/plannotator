/**
 * The one line a PR's thread shows over its messages (mock "V1, slim line"): the review thread's own context line
 * (`.ib-rvctx`) holding the PR's title, branch, size and checks, then the PR's other ways in as links: Guided review
 * and The diff. Drawn over an empty thread for the PR (Start a thread, `PullThreadStart`) and over the thread it
 * becomes (`ThreadPane`'s `reviewView.pullLine`), so the thread is the PR's page. It wraps on a narrow pane; the links
 * keep the line's end.
 */
import type { InboxPull } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { checksWords } from './model';

export function PullContextLine({ pr, onGuide, onDiff }: { pr: Pick<InboxPull, 'title' | 'head' | 'additions' | 'deletions' | 'checks'>; onGuide: (() => void) | null; onDiff: () => void }) {
  const checks = checksWords(pr);
  const dot = (
    <span className="ib-pctx-dot" aria-hidden="true">
      ·
    </span>
  );
  return (
    <div className="ib-rvctx ib-pctx" data-review-context="" data-pull-context="">
      <Icon name="pullRequest" size={15} />
      <span className="ib-pctx-t" dir="auto">
        {pr.title}
      </span>
      {dot}
      <code className="ib-lp-head ib-pctx-head">{pr.head}</code>
      {dot}
      <span className="ib-pctx-size">
        <span className="ib-add">+{formatCount(pr.additions)}</span> <span className="ib-del">−{formatCount(pr.deletions)}</span>
      </span>
      {checks && (
        <>
          {dot}
          <span className="ib-lp-checks" data-checks={pr.checks}>
            {checks}
          </span>
        </>
      )}
      <span className="ib-pctx-go">
        {onGuide && (
          <button type="button" className="ib-rvctx-link" onClick={onGuide} data-pull-context-go="guide">
            Guided review
          </button>
        )}
        <button type="button" className="ib-rvctx-link" onClick={onDiff} data-pull-context-go="diff">
          The diff
        </button>
      </span>
    </div>
  );
}
