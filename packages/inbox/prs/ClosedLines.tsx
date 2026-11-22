/**
 * Under the board's bar, one quiet line per Close whose Undo the server still takes (approval
 * "inbox-pr-board-close-safe"): "Closed #2039 Fix the login retry. Undo", "Closed 3: #2050, #2041, #2039. Undo". It
 * stays past the toast, the picks and select mode, and goes when the window ends (closedUndo.ts). Said politely.
 */
import { inboxPullLabel } from '@plannotator/core/inbox-types';
import { closedNames } from './bulkClose';
import { useClosedBatches, type ClosedBatch } from './closedUndo';

export function ClosedLines({ onUndo }: { onUndo: (batch: ClosedBatch) => void }) {
  const batches = useClosedBatches();
  return (
    <div className="ib-prs-closedlines" aria-live="polite" data-pr-closed-lines="">
      {batches.map((batch) => (
        <p key={batch.id} className="ib-prs-closedline" data-pr-closed-line={batch.id}>
          <span className="ib-prs-cw">{words(batch)}</span>
          <button type="button" className="ib-prs-undo" onClick={() => onUndo(batch)} data-pr-closed-undo={batch.id}>
            Undo
          </button>
        </p>
      ))}
    </div>
  );
}

function words(batch: ClosedBatch) {
  if (batch.pulls.length === 1) {
    const pull = batch.pulls[0]!;
    return (
      <>
        <span className="ib-prs-cn">Closed {inboxPullLabel(pull)}</span>{' '}
        <span className="ib-prs-ct" dir="auto">
          {pull.title}
        </span>
        .
      </>
    );
  }
  const names = closedNames(batch.pulls, (key) => batch.repos[key] ?? key);
  return (
    <>
      <span className="ib-prs-cn">Closed {batch.pulls.length}:</span>{' '}
      {names.groups.map((group, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {group.repo && (
            <>
              <span className="ib-prs-rn" dir="auto" title={group.repo}>
                {group.repo}
              </span>{' '}
            </>
          )}
          {group.numbers.join(', ')}
        </span>
      ))}
      {names.more > 0 && ` and ${names.more} more`}.
    </>
  );
}
