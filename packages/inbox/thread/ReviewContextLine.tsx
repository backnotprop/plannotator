/**
 * The line over a thread opened from Reviews (ThreadPane's `reviewView`): what the review is of, and the way to its
 * PR's page ("See the pull request"). A thread started from a PR's page (Start a thread, `pulls/startThread.ts`) is that
 * PR's page itself, so it draws the PR's line instead (`PullContextLine`: title, branch, size, checks, then Guided
 * review once the agent sent one, and The diff).
 */
import type { InboxThread } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { PullContextLine } from '../pulls/PullContextLine';
import type { ReviewView } from '../pulls/reviewsModel';

export function ReviewContextLine({ view, thread, onOpenGuide }: { view: ReviewView; thread: Pick<InboxThread, 'messages'>; onOpenGuide: (messageId: string) => void }) {
  if (view.pullLine) {
    const guide = [...thread.messages].reverse().find((message) => !!message.guide);
    return <PullContextLine pr={view.pullLine.pull} onGuide={guide ? () => onOpenGuide(guide.id) : null} onDiff={view.pullLine.onDiff} />;
  }
  return (
    <div className="ib-rvctx" data-review-context="">
      <Icon name={view.kind === 'local' ? 'laptop' : 'pullRequest'} size={15} />
      <span dir="auto">{view.context}</span>
      {view.onOpenPull && (
        <button type="button" className="ib-rvctx-link" onClick={view.onOpenPull} data-review-open-pull="">
          See the pull request
        </button>
      )}
      {view.pullUrl && (
        <a className="ib-rvctx-link" href={view.pullUrl} target="_blank" rel="noreferrer noopener" data-review-pull-link="">
          See the pull request
        </a>
      )}
    </div>
  );
}
