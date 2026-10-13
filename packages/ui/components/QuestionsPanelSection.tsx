import React from 'react';
import { cn } from '../lib/utils';
import { questionProgress, type QuestionPanelRow } from '../utils/questionAnswers';

/**
 * The annotations panel's Questions section (the approved Card mock): a
 * header with the progress count, a thin progress bar, and one row per
 * `:::question` block with its answer or "Not answered yet" and an
 * Open / answered state. A row whose question is no longer in the document
 * carries the Unanchored chip; its answer still exports.
 */
const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" className="text-success">
    <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const StateTag: React.FC<{ row: QuestionPanelRow }> = ({ row }) => {
  if (row.orphaned) {
    return (
      <span
        data-annotation-unanchored="true"
        className="whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-medium bg-muted text-muted-foreground"
        title="This question is no longer in the document. The answer is still sent."
      >
        Unanchored
      </span>
    );
  }
  if (row.status === 'answered' || row.status === 'settled') {
    return (
      <span className="inline-flex" title={row.status === 'settled' ? 'Settled' : 'Answered'}>
        <CheckIcon />
        <span className="sr-only">{row.status === 'settled' ? 'Settled' : 'Answered'}</span>
      </span>
    );
  }
  if (row.status === 'skipped') {
    return <span className="whitespace-nowrap rounded bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">Skipped</span>;
  }
  return (
    <span className="whitespace-nowrap rounded border border-dashed border-border px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
      Open
    </span>
  );
};

export interface QuestionsPanelSectionProps {
  rows: readonly QuestionPanelRow[];
  onSelect?: (row: QuestionPanelRow) => void;
  /** Remove an orphaned answer (its card is gone, so the panel is the only
   *  place to drop it). Absent: no remove control. */
  onRemoveOrphan?: (row: QuestionPanelRow) => void;
}

export const QuestionsPanelSection: React.FC<QuestionsPanelSectionProps> = ({ rows, onSelect, onRemoveOrphan }) => {
  const { done, total } = questionProgress(rows);
  const complete = total > 0 && done === total;
  return (
    <section data-questions-panel="true" aria-label="Questions" className="mb-2">
      <div className="mx-0.5 mb-2 mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        <span className="flex-1">Questions</span>
        {total > 0 && <span className="tabular-nums">{done}/{total}</span>}
      </div>
      {total > 0 && (
        <div className="mx-0.5 mb-2.5 h-1 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
          <i
            className={cn('block h-full rounded-sm', complete ? 'bg-success' : 'bg-primary')}
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
      )}
      <div className="flex flex-col">
        {rows.map((row) => {
          const ok = !row.orphaned && (row.status === 'answered' || row.status === 'settled');
          const summary = row.answerText ?? 'Not answered yet';
          const clickable = !!onSelect && !row.orphaned;
          const body = (
            <>
              <span className={cn('font-mono text-[10.5px] font-semibold leading-[1.6]', ok ? 'text-success' : 'text-muted-foreground')}>
                {row.number ? `Q${row.number}` : 'Q'}
              </span>
              <span className="min-w-0 text-[12.5px] leading-[1.4] text-foreground">{row.prompt}</span>
              <StateTag row={row} />
              <span className={cn('col-start-2 col-end-4 text-xs', row.answerText && row.status !== 'skipped' ? 'text-foreground' : 'text-muted-foreground')}>
                {summary}
                {row.hasNote ? ' · has note' : ''}
              </span>
            </>
          );
          const rowClass = 'grid w-full grid-cols-[auto_1fr_auto] items-start gap-x-2 gap-y-0.5 rounded-[7px] px-2 py-2 text-left';
          return clickable ? (
            <button
              key={row.key}
              type="button"
              data-question-row={row.key}
              data-question-row-status={row.status}
              onClick={() => onSelect!(row)}
              className={cn(rowClass, 'cursor-pointer transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring')}
            >
              {body}
            </button>
          ) : (
            <div key={row.key} data-question-row={row.key} data-question-row-status={row.status} className={rowClass}>
              {body}
              {row.orphaned && onRemoveOrphan && (
                <button
                  type="button"
                  onClick={() => onRemoveOrphan(row)}
                  className="col-start-2 col-end-4 justify-self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                >
                  Remove answer
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
