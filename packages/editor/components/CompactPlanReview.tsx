import React from 'react';
import type { CompactPlanAction } from '@plannotator/ui/components/PlanHeaderMenu';

type CompactPlanDecisionActionId = Extract<
  CompactPlanAction['id'],
  'exit' | 'feedback' | 'approve' | 'copy' | 'done'
>;

/** An incumbent session decision that may be presented by compact Review. */
export type CompactPlanReviewAction = Omit<CompactPlanAction, 'id'> & {
  id: CompactPlanDecisionActionId;
};

interface CompactPlanCompletionProps {
  feedbackSummary: string;
  onOpenReview: () => void;
  maxWidth: number;
}

/** End-of-document handoff into the compact review decision surface. */
export const CompactPlanCompletion: React.FC<CompactPlanCompletionProps> = ({
  feedbackSummary,
  onOpenReview,
  maxWidth,
}) => (
  <section
    data-pn-compact-plan-completion="true"
    className="mt-10 w-full px-2 pt-2"
    style={{ maxWidth, paddingBottom: 'calc(1.25rem + var(--pn-safe-bottom))' }}
    aria-labelledby="pn-compact-plan-completion-title"
  >
    <div className="flex flex-col gap-4 border-t border-border/60 pt-6">
      <div>
        <h2 id="pn-compact-plan-completion-title" className="text-base font-semibold tracking-tight text-foreground">
          Ready to finish?
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{feedbackSummary}</p>
      </div>
      <button
        id="pn-compact-plan-review-trigger"
        type="button"
        data-pn-touch-target="true"
        onClick={onOpenReview}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl bg-primary px-4 py-3 text-left text-sm font-semibold text-primary-foreground outline-none transition-opacity active:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        <span>Review and finish</span>
        <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  </section>
);

interface CompactPlanReviewProps {
  feedbackSummary: string;
  actions: CompactPlanReviewAction[];
  primaryActionId?: CompactPlanReviewAction['id'];
  onOpenAnnotations: () => void;
  onOpenAI?: () => void;
}

/** Compact review summary and the incumbent session decision actions. */
export const CompactPlanReview: React.FC<CompactPlanReviewProps> = ({
  feedbackSummary,
  actions,
  primaryActionId,
  onOpenAnnotations,
  onOpenAI,
}) => {
  const orderedActions = [...actions].sort((left, right) => {
    if (left.id === primaryActionId) return -1;
    if (right.id === primaryActionId) return 1;
    if (left.id === 'exit') return 1;
    if (right.id === 'exit') return -1;
    return 0;
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <section aria-labelledby="pn-compact-review-summary-title">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Feedback</p>
          <h2 id="pn-compact-review-summary-title" className="mt-2 text-xl font-semibold tracking-tight text-foreground">
            {feedbackSummary}
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-2 min-[460px]:grid-cols-2">
            <button
              type="button"
              data-pn-touch-target="true"
              onClick={onOpenAnnotations}
              className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-background/40 px-4 py-3 text-left text-sm font-medium text-foreground outline-none transition-colors active:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <span>Review annotations</span>
              <CommentIcon />
            </button>
            {onOpenAI && (
              <button
                type="button"
                data-pn-touch-target="true"
                onClick={onOpenAI}
                className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-background/40 px-4 py-3 text-left text-sm font-medium text-foreground outline-none transition-colors active:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span>Ask AI</span>
                <SparklesIcon />
              </button>
            )}
          </div>
        </section>

        <section aria-labelledby="pn-compact-review-decision-title">
          <h2 id="pn-compact-review-decision-title" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Decision
          </h2>
          <div className="mt-2 flex flex-col gap-2">
            {orderedActions.map((action) => {
              const primary = action.id === primaryActionId;
              const quiet = action.id === 'exit';
              return (
                <button
                  key={action.id}
                  type="button"
                  data-pn-touch-target="true"
                  data-pn-compact-review-action={action.id}
                  onClick={action.onSelect}
                  disabled={action.disabled}
                  className={`flex min-h-11 w-full items-center justify-between gap-4 rounded-xl px-4 py-3 text-left outline-none transition-opacity active:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-ring/60 ${
                    primary
                      ? 'bg-primary text-primary-foreground'
                      : quiet
                        ? 'border border-transparent text-muted-foreground'
                        : 'border border-border bg-background/40 text-foreground'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{action.label}</span>
                    {action.subtitle && (
                      <span className={`mt-0.5 block text-xs leading-snug ${primary ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>
                        {action.subtitle}
                      </span>
                    )}
                  </span>
                  <ActionIcon kind={action.id} />
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};

const CommentIcon = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
  </svg>
);

const SparklesIcon = () => (
  <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3zM18.5 13l.8 2.7L22 16.5l-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7zM5 13l.7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7L5 13z" />
  </svg>
);

const ActionIcon = ({ kind }: { kind: CompactPlanReviewAction['id'] }) => {
  if (kind === 'approve' || kind === 'done') {
    return (
      <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (kind === 'feedback') return <CommentIcon />;
  return (
    <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
};
