/**
 * An "On this computer" row's diff (OnThisComputer.tsx), beside the Reviews list (a phone: in its place): a branch's
 * whole diff against the default branch, or a folder's uncommitted changes, read now (`GET /api/inbox/reviews/local/diff`)
 * and drawn read only by the reader every review uses (`GuideReader`, its files). Nothing goes to any agent. Its bar's
 * "Review with an agent" opens New review on that same work, for the person to send or not. No new keyboard shortcuts.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import { inboxLocalWorkLabel, inboxReviewPatchSize, type InboxLocalDiffAnswer } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { GuideReaderPart, ReaderPart } from '../lazyParts';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { PullPaneBack } from './PullLaunchpad';
import { readLocalDiff } from './localWork';
import { usePhoneHeadFit } from '../headFit';
import { useInboxTextSize } from '../textSize';
import type { LocalOpen } from './localRoute';

const GuideReader = GuideReaderPart.Part;
/** A phone's bar keeps the work's name at least this room (headFit.ts): `‹ Reviews` gives way to its chevron first. */
const NAME_FLOOR_PX = 120;
const NO_TICKS: boolean[] = [];
const keepTicks = () => {};

export interface LocalDiffPaneProps {
  open: LocalOpen;
  projectName: string | null;
  phone: boolean;
  stacked: boolean;
  onClose: () => void;
  /** New review on this work (its branch, or the project's uncommitted changes). Absent: no button. */
  onReview?: (opener: HTMLElement) => void;
}

export function LocalDiffPane({ open, projectName, phone, stacked, onClose, onReview }: LocalDiffPaneProps) {
  const titleId = useId();
  const [read, setRead] = useState<{ diff: InboxLocalDiffAnswer | null; error: string | null }>({ diff: null, error: null });
  useEffect(() => {
    setRead({ diff: null, error: null });
    const controller = new AbortController();
    readLocalDiff(open.project, open.branch, controller.signal).then(
      (diff) => setRead({ diff, error: null }),
      (cause: unknown) => {
        if (!controller.signal.aborted) setRead({ diff: null, error: cause instanceof Error ? cause.message : 'The diff could not be read.' });
      },
    );
    return () => controller.abort();
  }, [open.project, open.branch]);
  const diff = read.diff;
  const label = diff ? inboxLocalWorkLabel(diff) : open.branch ?? 'Uncommitted changes';
  const snapshot = useMemo(
    () =>
      diff && diff.patch
        ? buildGuideSnapshot({
            guide: { title: inboxLocalWorkLabel(diff), intent: '', sections: [] },
            reviewed: [],
            review: { rawPatch: diff.patch, gitRef: diff.kind === 'branch' ? `${diff.base}...${diff.branch}` : 'HEAD', source: { kind: 'local', ...(diff.branch ? { branch: diff.branch } : {}) } },
            exportedAt: new Date(0).toISOString(),
          })
        : null,
    [diff],
  );
  const size = diff?.patch ? inboxReviewPatchSize(diff.patch) : null;
  // A phone's bar is the work's name: `‹ Reviews` gives it the room, and a long name wraps to a second line. Review
  // with an agent keeps its words, on two short lines and without the "+" that New review's button already is (the
  // product has no mark of its own for this action).
  const bar = useRef<HTMLDivElement>(null);
  usePhoneHeadFit(bar, phone, [stacked, label, useInboxTextSize()].join('|'));
  return (
    <section className="ib-pane ib-prpane ib-local-pane" aria-labelledby={titleId} data-local-diff={diff?.kind ?? (open.branch ? 'branch' : 'uncommitted')}>
      <div ref={bar} className="ib-pr-bar ib-lp-bar">
        <PullPaneBack phone={phone} stacked={stacked} onClose={onClose} />
        <span className="ib-lp-id" data-fit-subject={NAME_FLOOR_PX}>
          <Icon name={open.branch ? 'gitBranch' : 'laptop'} size={15} />
          <h2 id={titleId} className="ib-local-title" dir="auto" title={phone ? label : undefined} data-local-title="">
            {label}
          </h2>
        </span>
        {onReview &&
          (phone ? (
            <button type="button" className="ib-pr-ext ib-lp-review" onClick={(event) => onReview(event.currentTarget)} aria-label="Review with an agent" data-local-review="">
              <span aria-hidden="true">
                Review with
                <br />
                an agent
              </span>
            </button>
          ) : (
            <button type="button" className="ib-pr-ext" onClick={(event) => onReview(event.currentTarget)} data-local-review="">
              <Icon name="plus" size={15} />
              Review with an agent
            </button>
          ))}
        {!phone && !stacked && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close" data-local-close="">
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-pr-meta ib-local-meta" data-local-facts="">
        {projectName && <span dir="auto">{projectName}</span>}
        {/* A branch: its commits not on the default branch (Branch reviews' words), else what its diff is against. */}
        {diff?.kind === 'branch' && <span data-local-ahead="">{typeof diff.ahead === 'number' && diff.ahead > 0 ? `${plural(diff.ahead, 'commit')} not on ${diff.base}` : `against ${diff.base}`}</span>}
        {size && (
          <span>
            {plural(size.files, 'file')} <span className="ib-add">+{formatCount(size.additions)}</span> <span className="ib-del">−{formatCount(size.deletions)}</span>
          </span>
        )}
      </div>
      <div className="ib-local-body ib-gbody">
        {read.error && (
          <p className="ib-error" role="alert" data-local-error="">
            {read.error}
          </p>
        )}
        {!diff && !read.error && (
          <p className="ib-pr-empty" aria-busy="true">
            Reading the diff…
          </p>
        )}
        {diff && !snapshot && <p className="ib-pr-empty">No changes.</p>}
        {snapshot && diff && (
          <ReaderPart diff={diff.patch}>
            <GuideReader bare snapshot={snapshot} reviewed={NO_TICKS} onReviewedChange={keepTicks} chapterTicks={false} mode="files" />
          </ReaderPart>
        )}
      </div>
    </section>
  );
}
