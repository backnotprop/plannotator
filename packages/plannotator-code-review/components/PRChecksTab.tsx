import React, { useMemo } from 'react';
import type { PRContext, PRCheck } from '@plannotator/shared/pr-types';

interface PRChecksTabProps {
  context: PRContext;
}

const DECISION_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  APPROVED: { bg: 'bg-success/15', text: 'text-success', label: 'Approved' },
  CHANGES_REQUESTED: { bg: 'bg-destructive/15', text: 'text-destructive', label: 'Changes Requested' },
  REVIEW_REQUIRED: { bg: 'bg-yellow-500/15', text: 'text-yellow-500', label: 'Review Required' },
};

const MERGE_STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  CLEAN: { bg: 'bg-success/15', text: 'text-success', label: 'Ready to merge' },
  BLOCKED: { bg: 'bg-yellow-500/15', text: 'text-yellow-500', label: 'Blocked' },
  BEHIND: { bg: 'bg-yellow-500/15', text: 'text-yellow-500', label: 'Behind base branch' },
  DIRTY: { bg: 'bg-destructive/15', text: 'text-destructive', label: 'Has conflicts' },
  UNKNOWN: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'Unknown' },
};

function CheckIcon({ check }: { check: PRCheck }) {
  if (check.status !== 'COMPLETED') {
    // In progress or queued
    return (
      <svg className="w-3.5 h-3.5 text-yellow-500 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    );
  }

  if (check.conclusion === 'SUCCESS') {
    return (
      <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }

  if (check.conclusion === 'FAILURE' || check.conclusion === 'TIMED_OUT') {
    return (
      <svg className="w-3.5 h-3.5 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }

  if (check.conclusion === 'SKIPPED' || check.conclusion === 'NEUTRAL') {
    return (
      <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
      </svg>
    );
  }

  // Fallback
  return (
    <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

export const PRChecksTab: React.FC<PRChecksTabProps> = ({ context }) => {
  // Group checks by workflow
  const groupedChecks = useMemo(() => {
    const groups = new Map<string, PRCheck[]>();
    for (const check of context.checks) {
      const workflow = check.workflowName || 'Other';
      const existing = groups.get(workflow) || [];
      existing.push(check);
      groups.set(workflow, existing);
    }
    return groups;
  }, [context.checks]);

  const checkSummary = useMemo(() => {
    const total = context.checks.length;
    const passed = context.checks.filter(c => c.conclusion === 'SUCCESS').length;
    const failed = context.checks.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT').length;
    const pending = context.checks.filter(c => c.status !== 'COMPLETED').length;
    const skipped = context.checks.filter(c => c.conclusion === 'SKIPPED' || c.conclusion === 'NEUTRAL').length;
    return { total, passed, failed, pending, skipped };
  }, [context.checks]);

  const isMerged = context.state === 'MERGED';
  const isClosed = context.state === 'CLOSED';
  const decisionStyle = DECISION_STYLES[context.reviewDecision];
  const mergeStyle = isMerged
    ? { bg: 'bg-violet-500/15', text: 'text-violet-400', label: 'Merged' }
    : isClosed
      ? { bg: 'bg-destructive/15', text: 'text-destructive', label: 'Closed' }
      : MERGE_STATUS_STYLES[context.mergeStateStatus] ?? MERGE_STATUS_STYLES.UNKNOWN;
  const mergeableConflict = !isMerged && !isClosed && context.mergeable === 'CONFLICTING';

  return (
    <div className="px-8 py-4 space-y-4 max-w-2xl">
      {/* Merge readiness */}
      <div className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Merge Status
        </h3>

        <div className="space-y-1.5">
          {/* Review decision */}
          {decisionStyle && (
            <div className={`flex items-center gap-2 px-2 py-1.5 rounded ${decisionStyle.bg}`}>
              <span className={`text-xs font-medium ${decisionStyle.text}`}>
                {decisionStyle.label}
              </span>
            </div>
          )}

          {/* Merge state */}
          <div className={`flex items-center gap-2 px-2 py-1.5 rounded ${mergeStyle.bg}`}>
            <span className={`text-xs font-medium ${mergeStyle.text}`}>
              {mergeableConflict ? 'Has merge conflicts' : mergeStyle.label}
            </span>
          </div>
        </div>
      </div>

      {/* Check runs */}
      {context.checks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Checks
            </h3>
            <span className="text-[10px] font-mono text-muted-foreground">
              {checkSummary.passed}/{checkSummary.total} passed
              {checkSummary.failed > 0 && <span className="text-destructive ml-1">{checkSummary.failed} failed</span>}
              {checkSummary.pending > 0 && <span className="text-yellow-500 ml-1">{checkSummary.pending} pending</span>}
            </span>
          </div>

          <div className="space-y-4">
            {Array.from(groupedChecks.entries()).map(([workflow, checks]) => (
              <div key={workflow}>
                <div className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">{workflow}</div>
                <div className="space-y-1">
                  {checks.map((check, i) => (
                    <a
                      key={`${check.name}-${i}`}
                      href={check.detailsUrl || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/30 transition-colors group cursor-pointer"
                    >
                      <CheckIcon check={check} />
                      <span className="text-xs text-primary/70 truncate group-hover:text-primary group-hover:underline">
                        {check.name}
                      </span>
                      <svg className="w-3 h-3 text-muted-foreground/30 ml-auto flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {context.checks.length === 0 && !decisionStyle && (
        <div className="flex flex-col items-center justify-center h-24 text-center">
          <p className="text-xs text-muted-foreground">No checks configured.</p>
        </div>
      )}
    </div>
  );
};
