import React from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { CopyButton } from './CopyButton';
import { exportReviewFeedback, formatConventionalPrefix } from '../utils/exportFeedback';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmissionTarget {
  prUrl: string;
  prNumber: number;
  prTitle: string;
  prRepo: string;
  fileComments: Array<{
    path: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    body: string;
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
  }>;
  fileScopedBody: string;
  fileCount: number;
  annotationCount: number;
  status: 'pending' | 'success' | 'failed';
  error?: string;
}

export interface OrphanedFindings {
  reason: 'full-stack' | 'unmapped';
  annotations: CodeAnnotation[];
  markdown: string;
}

export interface ReviewSubmission {
  targets: SubmissionTarget[];
  orphans: OrphanedFindings[];
}

interface ReviewSubmissionDialogProps {
  isOpen: boolean;
  action: 'approve' | 'comment';
  submission: ReviewSubmission;
  generalComment: string;
  onGeneralCommentChange: (value: string) => void;
  platformOpenPR: boolean;
  onPlatformOpenPRChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  mrLabel: string;
  platformLabel: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAnnotationFileComments(
  annotations: CodeAnnotation[],
): SubmissionTarget['fileComments'] {
  return annotations
    .filter(a => (a.scope ?? 'line') === 'line')
    .map(ann => {
      const ccPrefix = formatConventionalPrefix(ann.conventionalLabel, ann.decorations);
      let body = ccPrefix + (ann.text ?? '');
      if (ann.suggestedCode) {
        body += `\n\n\`\`\`suggestion\n${ann.suggestedCode}\n\`\`\``;
      }
      const side = (ann.side === 'old' ? 'LEFT' : 'RIGHT') as 'LEFT' | 'RIGHT';
      const isMultiLine = ann.lineStart != null && ann.lineEnd != null && ann.lineStart !== ann.lineEnd;
      return {
        path: ann.filePath,
        line: ann.lineEnd ?? ann.lineStart,
        side,
        body: body.trim(),
        ...(isMultiLine && { start_line: ann.lineStart, start_side: side }),
      };
    })
    .filter(c => c.body.length > 0);
}

function buildFileScopedBody(annotations: CodeAnnotation[]): string {
  return annotations
    .filter(a => a.scope === 'file')
    .map(a => a.text ? `**${a.filePath}:** ${a.text}` : '')
    .filter(Boolean)
    .join('\n\n');
}

export function buildReviewSubmission(
  allAnnotations: CodeAnnotation[],
  editorAnnotations: Array<{ filePath: string; lineStart: number; lineEnd: number; comment?: string; selectedText?: string }>,
  currentPrUrl: string | undefined,
  currentDiffPaths: Set<string>,
  currentPrMeta?: { number: number; title: string; repo: string },
): ReviewSubmission {
  const targets: SubmissionTarget[] = [];
  const orphanAnnotations: { reason: 'full-stack' | 'unmapped'; ann: CodeAnnotation }[] = [];

  // Separate postable (layer) from orphaned (full-stack)
  const layerAnnotations: CodeAnnotation[] = [];
  for (const ann of allAnnotations) {
    if (ann.diffScope === 'full-stack') {
      orphanAnnotations.push({ reason: 'full-stack', ann });
    } else {
      layerAnnotations.push(ann);
    }
  }

  // Group layer annotations by prUrl
  const byPR = new Map<string, CodeAnnotation[]>();
  const hasMultiplePRs = new Set(layerAnnotations.map(a => a.prUrl).filter(Boolean)).size > 1;

  for (const ann of layerAnnotations) {
    const key = ann.prUrl ?? currentPrUrl ?? '_current';
    if (!ann.prUrl && hasMultiplePRs) {
      orphanAnnotations.push({ reason: 'unmapped', ann });
      continue;
    }
    const group = byPR.get(key) || [];
    group.push(ann);
    byPR.set(key, group);
  }

  // Build editor file comments (always attached to the current PR)
  const editorFileComments: SubmissionTarget['fileComments'] = [];
  const editorFiles = new Set<string>();
  if (editorAnnotations.length > 0) {
    for (const ea of editorAnnotations) {
      if (!currentDiffPaths.has(ea.filePath)) continue;
      const body = ea.comment
        ? `> ${ea.selectedText}\n\n${ea.comment}`
        : `> ${ea.selectedText}`;
      if (!body.trim()) continue;
      const isMultiLine = ea.lineStart !== ea.lineEnd;
      editorFileComments.push({
        path: ea.filePath,
        line: ea.lineEnd,
        side: 'RIGHT' as const,
        body,
        ...(isMultiLine && { start_line: ea.lineStart, start_side: 'RIGHT' as const }),
      });
      editorFiles.add(ea.filePath);
    }
  }

  // Build targets from PR groups
  const currentKey = currentPrUrl ?? '_current';
  let editorCommentsAttached = false;

  for (const [prUrl, annotations] of byPR) {
    const sample = annotations[0];
    const fileComments = buildAnnotationFileComments(annotations);
    const fileScopedBody = buildFileScopedBody(annotations);
    const uniqueFiles = new Set(annotations.map(a => a.filePath));

    if (prUrl === currentKey && editorFileComments.length > 0) {
      fileComments.push(...editorFileComments);
      for (const f of editorFiles) uniqueFiles.add(f);
      editorCommentsAttached = true;
    }

    targets.push({
      prUrl: prUrl === '_current' ? (currentPrUrl ?? '') : prUrl,
      prNumber: sample.prNumber ?? 0,
      prTitle: sample.prTitle ?? '',
      prRepo: sample.prRepo ?? '',
      fileComments,
      fileScopedBody,
      fileCount: uniqueFiles.size,
      annotationCount: annotations.length,
      status: 'pending',
    });
  }

  // Editor-only case: no regular annotations but has editor annotations
  if (!editorCommentsAttached && editorFileComments.length > 0) {
    targets.push({
      prUrl: currentPrUrl ?? '',
      prNumber: currentPrMeta?.number ?? 0,
      prTitle: currentPrMeta?.title ?? '',
      prRepo: currentPrMeta?.repo ?? '',
      fileComments: editorFileComments,
      fileScopedBody: '',
      fileCount: editorFiles.size,
      annotationCount: 0,
      status: 'pending',
    });
  }

  // Build orphan groups
  const orphans: OrphanedFindings[] = [];
  const fullStackOrphans = orphanAnnotations.filter(o => o.reason === 'full-stack').map(o => o.ann);
  const unmappedOrphans = orphanAnnotations.filter(o => o.reason === 'unmapped').map(o => o.ann);

  if (fullStackOrphans.length > 0) {
    orphans.push({
      reason: 'full-stack',
      annotations: fullStackOrphans,
      markdown: exportReviewFeedback(fullStackOrphans),
    });
  }
  if (unmappedOrphans.length > 0) {
    orphans.push({
      reason: 'unmapped',
      annotations: unmappedOrphans,
      markdown: exportReviewFeedback(unmappedOrphans),
    });
  }

  return { targets, orphans };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReviewSubmissionDialog({
  isOpen,
  action,
  submission,
  generalComment,
  onGeneralCommentChange,
  platformOpenPR,
  onPlatformOpenPRChange,
  onConfirm,
  onCancel,
  isSubmitting,
  mrLabel,
  platformLabel,
}: ReviewSubmissionDialogProps) {
  if (!isOpen) return null;

  const isApprove = action === 'approve';
  const totalOrphans = submission.orphans.reduce((n, g) => n + g.annotations.length, 0);
  const hasTargets = submission.targets.length > 0;
  const allSucceeded = hasTargets && submission.targets.every(t => t.status === 'success');
  const hasFailed = submission.targets.some(t => t.status === 'failed');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl p-6">
        <h3 className="font-semibold mb-1">
          {isApprove ? `Approve ${mrLabel}` : 'Post Review Comments'}
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          {isApprove
            ? 'Add a general comment to the approval (optional).'
            : 'Review what will be posted.'}
        </p>

        {/* General comment */}
        <textarea
          autoFocus
          value={generalComment}
          onChange={e => onGeneralCommentChange(e.target.value)}
          placeholder="Leave a comment..."
          rows={3}
          className="w-full rounded-md border border-border bg-background text-sm px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary mb-3"
        />

        {/* Targets */}
        {submission.targets.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Posting to
            </div>
            <div className="space-y-1.5">
              {submission.targets.map(target => (
                <div
                  key={target.prUrl}
                  className="flex items-start gap-2 text-sm"
                >
                  <span className="mt-0.5 shrink-0">
                    {target.status === 'success' ? (
                      <svg className="w-4 h-4 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : target.status === 'failed' ? (
                      <svg className="w-4 h-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <circle cx="12" cy="12" r="10" />
                      </svg>
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {target.prRepo}#{target.prNumber}{target.prTitle ? ` — ${target.prTitle}` : ''}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {target.annotationCount} comment{target.annotationCount !== 1 ? 's' : ''} across {target.fileCount} file{target.fileCount !== 1 ? 's' : ''}
                    </div>
                    {target.status === 'failed' && target.error && (
                      <div className="text-xs text-destructive mt-0.5">{target.error}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Orphaned annotations */}
        {totalOrphans > 0 && (
          <div className="mb-3 p-3 rounded-md bg-warning/10 border border-warning/20">
            <div className="text-xs font-medium text-warning uppercase tracking-wide mb-1">
              Cannot post inline ({totalOrphans})
            </div>
            {submission.orphans.map(group => (
              <div key={group.reason} className="text-xs text-muted-foreground mb-2">
                {group.reason === 'full-stack'
                  ? `${group.annotations.length} finding${group.annotations.length !== 1 ? 's' : ''} from full-stack view — line numbers don't map to a single ${mrLabel}'s diff.`
                  : `${group.annotations.length} annotation${group.annotations.length !== 1 ? 's' : ''} not attributed to a specific ${mrLabel}.`}
              </div>
            ))}
            <div className="flex gap-2">
              {submission.orphans.map(group => (
                <CopyButton
                  key={group.reason}
                  text={group.markdown}
                  variant="inline"
                  label={submission.orphans.length > 1
                    ? `Copy ${group.reason === 'full-stack' ? 'full-stack' : 'unmapped'}`
                    : 'Copy as Markdown'}
                />
              ))}
            </div>
          </div>
        )}

        {/* Open PR checkbox */}
        <label className="flex items-center gap-2 text-sm text-muted-foreground mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={platformOpenPR}
            onChange={e => onPlatformOpenPRChange(e.target.checked)}
            className="rounded border-border"
          />
          View on {platformLabel} after submitting
        </label>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-md text-sm font-medium bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isSubmitting || (!hasTargets && !isApprove && !generalComment.trim()) || allSucceeded}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-opacity ${
              isSubmitting || (!hasTargets && !isApprove && !generalComment.trim()) || allSucceeded
                ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                : isApprove
                  ? 'bg-success text-success-foreground hover:opacity-90'
                  : 'bg-primary text-primary-foreground hover:opacity-90'
            }`}
          >
            {isSubmitting
              ? 'Posting...'
              : hasFailed
                ? 'Retry Failed'
                : isApprove
                  ? 'Approve'
                  : 'Post Comments'}
          </button>
        </div>
      </div>
    </div>
  );
}
