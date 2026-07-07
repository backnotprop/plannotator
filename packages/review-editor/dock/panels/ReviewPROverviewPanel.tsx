import React, { useEffect, useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { PRContext } from '@plannotator/shared/pr-types';
import { useReviewState } from '../ReviewStateContext';
import { PRSummaryTab } from '../../components/PRSummaryTab';
import { PRCommentsTab } from '../../components/PRCommentsTab';
import { PRChecksTab } from '../../components/PRChecksTab';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { getMRLabel } from '@plannotator/shared/pr-types';

/**
 * Combined PR overview — one dock panel that shows the PR summary, checks, and
 * comments together instead of three separate tabs. The left column is the PR
 * summary (description) with the checks embedded at the bottom as a collapsed
 * disclosure; the right column is the full-height comments timeline.
 *
 * Reuses the existing PRSummaryTab / PRChecksTab / PRCommentsTab components and
 * the single shared live PR context state from ReviewStateContext.
 */

/** Region label header shared by the panel's regions, with an optional right-aligned action. */
function RegionHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/30 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span>{children}</span>
      {action}
    </div>
  );
}

/**
 * Collapsed-by-default checks summary embedded at the bottom of the description.
 * The header carries a colored progress label (red failing / amber pending /
 * green passing) so status is visible without expanding; clicking reveals the
 * full checks + merge-status breakdown.
 */
function ChecksDisclosure({ context }: { context: PRContext }) {
  const [open, setOpen] = useState(false);

  const s = useMemo(() => {
    const total = context.checks.length;
    const passed = context.checks.filter((c) => c.conclusion === 'SUCCESS').length;
    const failed = context.checks.filter((c) => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT').length;
    const pending = context.checks.filter((c) => c.status !== 'COMPLETED').length;
    return { total, passed, failed, pending };
  }, [context.checks]);

  const tone =
    s.failed > 0 ? { dot: 'bg-destructive', text: 'text-destructive' }
    : s.pending > 0 ? { dot: 'bg-warning', text: 'text-warning' }
    : s.total > 0 ? { dot: 'bg-success', text: 'text-success' }
    : { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' };

  const label =
    s.total === 0 ? 'No checks'
    : s.failed > 0 ? `${s.failed} failing · ${s.passed}/${s.total} passed`
    : s.pending > 0 ? `${s.pending} pending · ${s.passed}/${s.total} passed`
    : `${s.passed}/${s.total} passed`;

  return (
    <div className="mt-4 border-t border-border/30 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left hover:opacity-80 transition-opacity"
      >
        <svg className={`w-3 h-3 shrink-0 text-muted-foreground/50 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Checks</span>
        <span className={`text-[10px] font-mono ${tone.text}`}>{label}</span>
      </button>
      {open && (
        <div className="mt-2">
          <PRChecksTab context={context} bare />
        </div>
      )}
    </div>
  );
}

export const ReviewPROverviewPanel: React.FC<IDockviewPanelProps> = () => {
  const {
    prMetadata,
    prContext,
    isPRContextLoading,
    prContextError,
    fetchPRContext,
    platformUser,
  } = useReviewState();

  useEffect(() => {
    if (!prContext && !prContextError && !isPRContextLoading) fetchPRContext();
  }, [prContext, prContextError, isPRContextLoading, fetchPRContext]);

  if (!prMetadata) {
    return <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No PR metadata</div>;
  }

  if (isPRContextLoading && !prContext) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading PR…
      </div>
    );
  }

  if (prContextError && !prContext) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-destructive text-sm">{prContextError}</div>
        <button
          type="button"
          onClick={fetchPRContext}
          className="px-2.5 py-1 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!prContext) return null;

  return (
    <div className="h-full flex flex-col gap-2 p-3 bg-background">
      {prContextError && (
        <div className="shrink-0 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          PR context may be stale: {prContextError}
        </div>
      )}
      {/* Stack vertically on small screens, side-by-side from md up. */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3">
        {/* Left column — Summary (description) with checks embedded at the bottom. */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col rounded-lg border border-border/30 bg-surface-0 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
          <RegionHeader
            action={
              <a
                href={prMetadata.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 normal-case tracking-normal font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Open {getMRLabel(prMetadata)}
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            }
          >
            Summary
          </RegionHeader>
          <OverlayScrollArea className="flex-1 min-h-0 scroll-fade">
            <PRSummaryTab context={prContext} metadata={prMetadata} />
            <div className="px-8 pb-4 max-w-2xl">
              <ChecksDisclosure context={prContext} />
            </div>
          </OverlayScrollArea>
        </section>

        {/* Right column — Comments (full height; owns its own scroll). */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col rounded-lg border border-border/30 bg-surface-0 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
          <RegionHeader>Comments</RegionHeader>
          <div className="flex-1 min-h-0">
            <PRCommentsTab context={prContext} platformUser={platformUser} />
          </div>
        </section>
      </div>
    </div>
  );
};
