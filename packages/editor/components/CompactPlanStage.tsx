import React, { useEffect, useRef } from 'react';

interface CompactPlanStageProps {
  id: string;
  title: string;
  subtitle?: string;
  count?: number;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Full-visible-viewport shell for one transient compact Plan task.
 *
 * The shell intentionally has no entrance animation: these are frequent
 * review surfaces, and immediate replacement makes the foreground-state
 * change easier to understand on a small screen.
 */
export const CompactPlanStage: React.FC<CompactPlanStageProps> = ({
  id,
  title,
  subtitle,
  count,
  onClose,
  children,
}) => {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section
      id={id}
      data-pn-compact-plan-stage="true"
      // A transient task surface is never part of the printed document. Without
      // this, printing with Settings / Versions / Archive open on a touch device
      // puts the full-viewport overlay over the plan (print.css hides
      // [data-print-hide]).
      data-print-hide
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={handleKeyDown}
      className="pn-visible-viewport-stage z-[90] flex flex-col overflow-hidden bg-card text-foreground"
    >
      <header className="flex min-h-[52px] flex-shrink-0 items-center justify-between gap-3 border-b border-border/50 px-3">
        <div className="min-w-0 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
            {typeof count === 'number' && count > 0 && (
              <span className="flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[10px] font-medium tabular-nums text-primary">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </div>
          {subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          data-pn-touch-target="true"
          data-pn-touch-target-icon="true"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </section>
  );
};
