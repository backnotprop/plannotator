import React from 'react';
import { cn } from '../lib/utils';

/**
 * The header "N/M answered" chip for documents with `:::question` blocks
 * (the approved Card mock): a progress ring and the count. It is a button:
 * a click jumps to the next open question. With no open question left it
 * still reads the progress but has nothing to jump to.
 */
export interface QuestionProgressChipProps {
  /** Answered or settled questions. */
  done: number;
  total: number;
  /** Whether a question is still open (not answered, settled or skipped). */
  hasOpen: boolean;
  onJump: () => void;
  className?: string;
}

const Ring: React.FC<{ done: number; total: number }> = ({ done, total }) => {
  const r = 6;
  const c = 2 * Math.PI * r;
  const f = total > 0 ? done / total : 0;
  const complete = total > 0 && done === total;
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="shrink-0">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border)" strokeWidth="2.2" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke={complete ? 'var(--success)' : 'var(--primary)'}
        strokeWidth="2.2"
        strokeDasharray={`${c * f} ${c}`}
        transform="rotate(-90 8 8)"
        strokeLinecap="round"
      />
    </svg>
  );
};

export const QuestionProgressChip: React.FC<QuestionProgressChipProps> = ({ done, total, hasOpen, onJump, className }) => {
  if (total <= 0) return null;
  const label = `${done} of ${total} question${total === 1 ? '' : 's'} answered.${hasOpen ? ' Go to next unanswered.' : ''}`;
  return (
    <button
      type="button"
      data-question-progress="true"
      onClick={onJump}
      aria-label={label}
      title={hasOpen ? 'Go to the next open question' : done >= total ? 'All questions answered' : 'No open questions'}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border border-border bg-card pl-[7px] pr-2.5 text-xs text-muted-foreground transition-colors',
        'hover:border-primary/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      <Ring done={done} total={total} />
      <span>
        <b className="font-semibold text-foreground">{done}/{total}</b>
        <span className="hidden md:inline"> answered</span>
      </span>
    </button>
  );
};
