/**
 * Under the board's bar, one quiet line per Close whose Undo the server still takes (approval
 * "inbox-pr-board-close-safe"): "Closed #2039 Fix the login retry. Undo", "Closed 3: #2050, #2041, #2039. Undo". It
 * stays past the toast, the picks and select mode, and goes when the window ends (closedUndo.ts): its Undo at once, its
 * words once the pointer is off the board, so no row moves under it.
 *
 * Not a live region: the toast says the news once (App's announcer); each Undo is described by its line's words.
 */
import { useEffect, useId, useRef } from 'react';
import { inboxPullLabel } from '@plannotator/core/inbox-types';
import { closedNames } from './bulkClose';
import { dropEnded, useClosedBatches, type ClosedBatch } from './closedUndo';

export function ClosedLines({ onUndo }: { onUndo: (batch: ClosedBatch) => void }) {
  const batches = useClosedBatches();
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const ended = batches.some((b) => b.ended);
  useEffect(() => {
    const board = ref.current?.closest<HTMLElement>('[data-prs-page]');
    if (!ended || !board) return;
    if (!board.matches(':hover')) {
      dropEnded();
      return;
    }
    board.addEventListener('pointerleave', dropEnded);
    return () => board.removeEventListener('pointerleave', dropEnded);
  }, [ended]);
  return (
    <div ref={ref} className="ib-prs-closedlines" data-pr-closed-lines="">
      {batches.map((batch) => (
        <p key={batch.id} className="ib-prs-closedline" data-pr-closed-line={batch.id} data-ended={batch.ended ? '' : undefined}>
          <span className="ib-prs-cw" id={`${uid}-${batch.id}`}>
            {words(batch)}
          </span>
          {!batch.ended && (
            <button type="button" className="ib-prs-undo" onClick={() => onUndo(batch)} aria-describedby={`${uid}-${batch.id}`} data-pr-closed-undo={batch.id}>
              Undo
            </button>
          )}
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
