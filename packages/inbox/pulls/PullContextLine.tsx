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

/** Said while a guided review asked for in the thread is on its way (the launchpad's own words). */
export const PULL_GUIDE_ON_THE_WAY = 'Guided review on the way';

export function PullContextLine({
  pr,
  onGuide,
  onDiff,
  guideOnTheWay = false,
  forge = null,
  error = null,
}: {
  pr: Pick<InboxPull, 'title' | 'head' | 'additions' | 'deletions' | 'checks'>;
  onGuide: (() => void) | null;
  onDiff: () => void;
  /** A guided review asked for and not in yet: said in place of the Guided review link. */
  guideOnTheWay?: boolean;
  /** The PR on its forge (the thread's line; the empty thread has the bar's Open on GitHub). */
  forge?: { name: string; url: string } | null;
  /** A Guided review request that did not go. */
  error?: string | null;
}) {
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
        {guideOnTheWay ? (
          <span className="ib-pctx-asked" data-pull-context-guide="asked">
            {PULL_GUIDE_ON_THE_WAY}
          </span>
        ) : (
          onGuide && (
            <button type="button" className="ib-rvctx-link" onClick={onGuide} data-pull-context-go="guide">
              Guided review
            </button>
          )
        )}
        <button type="button" className="ib-rvctx-link" onClick={onDiff} data-pull-context-go="diff">
          The diff
        </button>
        {forge && (
          <a className="ib-rvctx-link" href={forge.url} target="_blank" rel="noreferrer noopener" data-pull-context-go="forge">
            Open on {forge.name}
          </a>
        )}
      </span>
      {error && (
        <span className="ib-pctx-err" role="alert" data-pull-context-error="">
          {error}
        </span>
      )}
    </div>
  );
}
