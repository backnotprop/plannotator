import React from 'react';
import { PlanDiffBadge } from './plan-diff/PlanDiffBadge';
import type { PlanDiffStats } from '../utils/planDiffEngine';
import { hostnameOrFallback } from '@plannotator/core/project';
import { basenameFromPath } from '@plannotator/core/source-save';
import { OpenInAppButton } from './OpenInAppButton';
import { HostTitle } from './HostTitle';
import { useConfigValue } from '../config';
import { repoLabel } from '../utils/repoLabel';

export interface LinkedDocBadgeInfo {
  filepath: string;
  onBack?: () => void;
  label?: string;
  backLabel?: string;
  variant?: 'breadcrumb' | 'folder-file';
}

export interface DocBadgesProps {
  layout: 'column' | 'row' | 'header';
  repoInfo?: { display: string; branch?: string } | null;
  planDiffStats?: PlanDiffStats | null;
  isPlanDiffActive?: boolean;
  hasPreviousVersion?: boolean;
  onPlanDiffToggle?: () => void;
  planDiffBaselineLabel?: string;
  planDiffBaselineTooltip?: string;
  showDemoBadge?: boolean;
  archiveInfo?: { status: 'approved' | 'denied' | 'unknown'; timestamp: string; title: string } | null;
  linkedDocInfo?: LinkedDocBadgeInfo | null;
  sourceInfo?: string;
  openInAppPath?: string | null;
}

export const DocBadges: React.FC<DocBadgesProps> = ({
  layout,
  repoInfo,
  planDiffStats,
  isPlanDiffActive,
  hasPreviousVersion,
  onPlanDiffToggle,
  planDiffBaselineLabel,
  planDiffBaselineTooltip,
  showDemoBadge,
  archiveInfo,
  linkedDocInfo,
  sourceInfo,
  openInAppPath,
}) => {
  const hideRepoOwner = useConfigValue('hideRepoOwner');
  const isRow = layout === 'row';
  const isHorizontal = layout !== 'column';
  const canOpenInApp =
    !!openInAppPath && !/^https?:\/\//i.test(openInAppPath);
  // Never shrinks: a file name chip beside it gives up its width first.
  const openInButton = canOpenInApp ? (
    <span className="flex flex-shrink-0">
      <OpenInAppButton filePath={openInAppPath} base={null} />
    </span>
  ) : null;

  const anything = isRow
    ? (hasPreviousVersion && planDiffStats) || (archiveInfo && !linkedDocInfo)
    : repoInfo || hasPreviousVersion || showDemoBadge || linkedDocInfo || archiveInfo || sourceInfo || canOpenInApp;
  if (!anything) return null;

  const outerClass = isHorizontal
    ? `flex flex-row items-center gap-1.5 text-[9px] text-muted-foreground/70 font-mono ${layout === 'header' ? 'flex-wrap' : ''}`
    : 'flex flex-col items-start gap-1 text-[9px] text-muted-foreground/50 font-mono';

  return (
    <div className={outerClass}>
      {repoInfo && !linkedDocInfo && !isRow && (
        <div className="flex min-w-0 max-w-full items-center gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <HostTitle title={repoInfo.display} cut>
              <span
                className={`truncate px-1.5 py-0.5 bg-muted/50 rounded ${
                  repoInfo.branch ? 'flex-shrink-0 max-w-[calc(100%_-_4.5em_-_0.375rem)]' : 'min-w-0'
                }`}
              >
                {repoLabel(repoInfo.display, hideRepoOwner)}
              </span>
            </HostTitle>
            {repoInfo.branch && (
              <HostTitle title={repoInfo.branch} cut>
                <span className="min-w-[4.5em] px-1.5 py-0.5 bg-muted/30 rounded flex items-center gap-1 overflow-hidden">
                  <svg className="w-2.5 h-2.5 flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                  </svg>
                  <span className="truncate">{repoInfo.branch}</span>
                </span>
              </HostTitle>
            )}
          </div>
          {canOpenInApp && !sourceInfo && openInButton}
        </div>
      )}

      {!isRow && canOpenInApp && !repoInfo && !sourceInfo && !linkedDocInfo && openInButton}

      {sourceInfo && !linkedDocInfo && !isRow && (
        <div className="flex items-center gap-1">
          <span
            className="px-1.5 py-0.5 bg-muted/30 rounded truncate max-w-[200px]"
            title={sourceInfo}
          >
            {/^https?:\/\//i.test(sourceInfo)
              ? hostnameOrFallback(sourceInfo)
              : sourceInfo}
          </span>
          {openInButton}
        </div>
      )}

      {onPlanDiffToggle && (
        <PlanDiffBadge
          stats={planDiffStats ?? null}
          isActive={isPlanDiffActive ?? false}
          onToggle={onPlanDiffToggle}
          hasPreviousVersion={hasPreviousVersion ?? false}
          baselineLabel={planDiffBaselineLabel}
          baselineTooltip={planDiffBaselineTooltip}
        />
      )}

      {!isRow && showDemoBadge && !linkedDocInfo && (
        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/15 text-amber-600 dark:text-amber-400">
          Demo
        </span>
      )}

      {archiveInfo && !linkedDocInfo && (
        <div className="flex items-center gap-1.5">
          <span
            className={`px-1.5 py-0.5 rounded ${
              archiveInfo.status === 'approved'
                ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                : archiveInfo.status === 'denied'
                  ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                  : 'bg-muted/50 text-muted-foreground'
            }`}
          >
            {archiveInfo.status === 'approved'
              ? 'Approved'
              : archiveInfo.status === 'denied'
                ? 'Denied'
                : 'Unknown'}
          </span>
          {archiveInfo.timestamp && (
            <span
              className="px-1.5 py-0.5 bg-muted/50 rounded"
              title={archiveInfo.timestamp}
            >
              {new Date(archiveInfo.timestamp).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}{' '}
              {new Date(archiveInfo.timestamp).toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      )}

      {!isRow && linkedDocInfo && (
        linkedDocInfo.variant === 'folder-file' ? (
          <div className="flex min-w-0 max-w-full items-center gap-2">
            {linkedDocInfo.onBack && (
              <button
                type="button"
                onClick={linkedDocInfo.onBack}
                className="rounded-sm text-[9px] font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Close
              </button>
            )}
            <HostTitle title={linkedDocInfo.filepath}>
              <span className="min-w-0 truncate rounded bg-muted/50 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                {basenameFromPath(linkedDocInfo.filepath)}
              </span>
            </HostTitle>
            {openInButton}
          </div>
        ) : (
          <div className="flex min-w-0 max-w-full items-center gap-1.5">
            <button
              onClick={linkedDocInfo.onBack}
              className="px-1.5 py-0.5 bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors flex flex-shrink-0 items-center gap-1"
            >
              <svg
                className="w-2.5 h-2.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
                />
              </svg>
              {linkedDocInfo.backLabel || 'plan'}
            </button>
            <span className="px-1.5 py-0.5 bg-primary/10 text-primary/80 rounded flex-shrink-0">
              {linkedDocInfo.label || 'Linked File'}
            </span>
            <HostTitle title={linkedDocInfo.filepath}>
              <span className="min-w-0 px-1.5 py-0.5 bg-muted/50 text-muted-foreground rounded truncate">
                {basenameFromPath(linkedDocInfo.filepath)}
              </span>
            </HostTitle>
            {openInButton}
          </div>
        )
      )}
    </div>
  );
};
