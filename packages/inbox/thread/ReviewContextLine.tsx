/**
 * The line over a thread opened from Reviews (ThreadPane's `reviewView`): what the review is of, and the way to its
 * PR's page ("See the pull request"). A thread started from a PR's page (Start a thread, `pulls/startThread.ts`) is that
 * PR's page itself, so it draws the PR's line instead (`PullContextLine`: title, branch, size, checks, then Guided
 * review, asked for in this thread or opened once it is in (`usePullThreadGuide`), The diff, and the PR on its forge).
 */
import type { InboxThread } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { forgeName } from '../pulls/labels';
import { pullUrl } from '../pulls/model';
import { PullContextLine } from '../pulls/PullContextLine';
import type { ReviewView } from '../pulls/reviewsModel';
import { usePullThreadGuide } from '../pulls/usePullThreadGuide';

export function ReviewContextLine({ view, thread, onOpenGuide }: { view: ReviewView; thread: InboxThread; onOpenGuide: (messageId: string) => void }) {
  if (view.pullLine) return <PullThreadLine line={view.pullLine} thread={thread} onOpenGuide={onOpenGuide} />;
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

/** A PR's thread: the PR's line, with Guided review (asked for here, or opened), The diff and the PR on its forge. */
function PullThreadLine({ line, thread, onOpenGuide }: { line: NonNullable<ReviewView['pullLine']>; thread: InboxThread; onOpenGuide: (messageId: string) => void }) {
  const guide = usePullThreadGuide(line, thread, onOpenGuide);
  const url = pullUrl(line.pull);
  return <PullContextLine pr={line.pull} onGuide={guide.onGuide} guideOnTheWay={guide.onTheWay} error={guide.error} onDiff={line.onDiff} forge={url ? { name: forgeName(line.stack), url } : null} />;
}
