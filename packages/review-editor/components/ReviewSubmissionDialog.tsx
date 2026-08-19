import React, { useRef } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { PRReviewSubmissionPartial } from '@plannotator/shared/pr-types';
import { CopyButton } from './CopyButton';
import {
  exportReviewFeedback,
  formatCallFlowAnnotationTargets,
  formatConventionalPrefix,
} from '../utils/exportFeedback';
import { useCompactTouchLayout } from '@plannotator/ui/hooks/useIsMobile';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@plannotator/ui/components/ui/dialog';

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
  status: 'pending' | 'success' | 'partial' | 'failed' | 'blocked';
  error?: string;
  partial?: PRReviewSubmissionPartial;
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

/** Request body accepted by the review server's platform submission endpoint. */
export interface PRActionRequest {
  action: 'approve' | 'comment';
  body: string;
  fileComments: SubmissionTarget['fileComments'];
  targetPrUrl?: string;
}

type ReviewPlatform = 'github' | 'gitlab';

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
  recoveryPersistsRefresh: boolean;
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
      body += formatCallFlowAnnotationTargets(ann);
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

// The review-level body: file-scoped comments (prefixed with their path) plus
// general (review-wide) comments, which belong to no file. Both ride here so
// neither is dropped from a PR submission.
function buildFileScopedBody(annotations: CodeAnnotation[]): string {
  const parts: string[] = [];
  for (const a of annotations) {
    const scope = a.scope ?? 'line';
    const callFlowContext = formatCallFlowAnnotationTargets(a);
    if (scope === 'file' && (a.text || callFlowContext)) {
      parts.push(`**${a.filePath}:** ${a.text ?? ''}${callFlowContext}`.trim());
    } else if (scope === 'general' && (a.text || callFlowContext)) {
      parts.push(`${a.text ?? ''}${callFlowContext}`.trim());
    }
  }
  return parts.join('\n\n');
}

function buildFailedCommentsMarkdown(
  partial: PRReviewSubmissionPartial,
): string {
  return partial.failedFileComments
    .map(({ comment, error }) => [
      `### ${comment.path}:${comment.line}`,
      comment.body,
      '',
      `Posting error: ${error}`,
    ].join('\n'))
    .join('\n\n');
}

/**
 * Build the top-level review body without adding product attribution.
 * GitHub requires a body for COMMENT reviews, so an inline-only review gets a
 * neutral pointer. Approvals and GitLab discussions can remain bodyless.
 */
export function buildPlatformReviewBody(
  action: 'approve' | 'comment',
  platform: ReviewPlatform,
  generalComment: string | undefined,
  target: Pick<SubmissionTarget, 'fileComments' | 'fileScopedBody'>,
): string {
  const parts: string[] = [];
  if (generalComment?.trim()) parts.push(generalComment);
  if (target.fileScopedBody.trim()) parts.push(target.fileScopedBody);

  if (parts.length > 0) return parts.join('\n\n');
  if (action === 'comment' && platform === 'github' && target.fileComments.length > 0) {
    return 'See inline comments.';
  }
  return '';
}

/**
 * Build either the original platform request or the exact retry-safe subset
 * returned by the server after a partial GitLab submission.
 */
export function buildPRActionRequest(
  action: 'approve' | 'comment',
  body: string,
  target: SubmissionTarget,
): PRActionRequest {
  if (target.status === 'partial' && !target.partial) {
    throw new Error('Partial review target is missing its server-authorized retry');
  }
  const retry = target.partial?.retry;
  return {
    action: retry?.action ?? action,
    body: retry ? '' : body,
    fileComments: retry?.fileComments ?? target.fileComments,
    ...(target.prUrl ? { targetPrUrl: target.prUrl } : {}),
  };
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
    // Exclude the "" sentinel path of general (review-level) comments so they
    // don't inflate the file count.
    const uniqueFiles = new Set(annotations.map(a => a.filePath).filter(p => p.length > 0));

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
  recoveryPersistsRefresh,
  mrLabel,
  platformLabel,
}: ReviewSubmissionDialogProps) {
  const isCompactTouchLayout = useCompactTouchLayout();
  const generalCommentRef = useRef<HTMLTextAreaElement>(null);
  if (!isOpen) return null;

  const isApprove = action === 'approve';
  const totalOrphans = submission.orphans.reduce((n, g) => n + g.annotations.length, 0);
  const hasTargets = submission.targets.length > 0;
  const allSucceeded = hasTargets && submission.targets.every(t => t.status === 'success');
  const hasFailed = submission.targets.some(t => t.status === 'failed');
  const hasPartial = submission.targets.some(t => t.status === 'partial');
  const hasBlocked = submission.targets.some(t => t.status === 'blocked');
  const bodyLocked = hasPartial || hasBlocked;

  return (
    <Dialog
      open={isOpen}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onCancel();
      }}
    >
      <DialogContent
        hideClose
        initialFocus={isCompactTouchLayout || bodyLocked ? false : () => generalCommentRef.current}
        backdropClassName="bg-background/80 backdrop-blur-sm"
        className="!max-h-full max-w-md rounded-xl bg-card p-0 text-foreground shadow-2xl transition-none"
      >
        <div className="min-h-0 overflow-y-auto p-4 sm:p-6">
        <DialogTitle className="font-semibold mb-1">
          {isApprove ? `Approve ${mrLabel}` : 'Post Review Comments'}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground mb-3">
          {isApprove
            ? 'Add a general comment to the approval (optional).'
            : 'Review what will be posted.'}
        </DialogDescription>

        {/* General comment */}
        <textarea
          ref={generalCommentRef}
          data-pn-mobile-editable
          value={generalComment}
          onChange={e => onGeneralCommentChange(e.target.value)}
          placeholder="Leave a comment..."
          rows={3}
          disabled={bodyLocked}
          aria-describedby={bodyLocked ? 'review-general-comment-lock' : undefined}
          className="w-full rounded-md border border-border bg-background text-sm px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
        />
        {bodyLocked && (
          <div id="review-general-comment-lock" className="mt-1 mb-3 text-xs text-warning">
            {hasBlocked
              ? `General comment locked because ${platformLabel} may already have received it. Automatic retry is blocked until you inspect the ${mrLabel}.`
              : 'General comment locked because it may already be posted. Safe retry never resends it.'}
          </div>
        )}
        {!bodyLocked && <div className="mb-3" />}

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
                    ) : target.status === 'partial' ? (
                      <svg className="w-4 h-4 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.6l-7.4 13A2 2 0 004.7 19h14.6a2 2 0 001.8-2.4l-7.4-13a2 2 0 00-3.4 0z" />
                      </svg>
                    ) : target.status === 'failed' ? (
                      <svg className="w-4 h-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : target.status === 'blocked' ? (
                      <svg className="w-4 h-4 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.6l-7.4 13A2 2 0 004.7 19h14.6a2 2 0 001.8-2.4l-7.4-13a2 2 0 00-3.4 0z" />
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
                    {(target.status === 'failed' || target.status === 'partial') && target.error && (
                      <div className="text-xs text-destructive mt-0.5">{target.error}</div>
                    )}
                    {target.status === 'partial' && target.partial && (
                      <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs">
                        <div className="font-medium text-warning">
                          Review partially posted
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          This attempt posted {target.partial.postedFileCommentCount} inline comment{target.partial.postedFileCommentCount === 1 ? '' : 's'}{target.partial.reviewBodyPosted ? ' and the general comment' : ''}.
                        </div>
                        {target.partial.failedFileComments.length > 0 && (
                          <>
                            <div className="mt-1 text-muted-foreground">
                              {target.partial.failedFileComments.length} inline comment{target.partial.failedFileComments.length === 1 ? '' : 's'} failed:
                            </div>
                            <ul className="mt-1 space-y-1">
                              {target.partial.failedFileComments.map(({ comment, error }) => (
                                <li key={`${comment.path}:${comment.line}:${comment.body}`} className="min-w-0">
                                  <div className="font-mono break-all">{comment.path}:{comment.line}</div>
                                  <div className="truncate text-foreground" title={comment.body}>{comment.body}</div>
                                  <div className="break-words text-destructive">{error}</div>
                                </li>
                              ))}
                            </ul>
                            <CopyButton
                              text={buildFailedCommentsMarkdown(target.partial)}
                              variant="inline"
                              label="Copy failed comments"
                              className="mt-1"
                            />
                          </>
                        )}
                        {target.partial.approval === 'failed' && (
                          <div className="mt-1 text-destructive">
                            {target.partial.approvalError ?? `Failed to approve ${mrLabel}.`}
                          </div>
                        )}
                        <div className="mt-1 text-muted-foreground">
                          {target.partial.retry.fileComments.length > 0
                            ? `Retry sends only the ${target.partial.retry.fileComments.length} unposted inline comment${target.partial.retry.fileComments.length === 1 ? '' : 's'}; posted comments and the general note are not sent again.`
                            : `Retry only repeats the ${mrLabel} approval; posted comments and the general note are not sent again.`}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          {recoveryPersistsRefresh
                            ? 'You can close and reopen this dialog or refresh this tab; Plannotator keeps this narrowed retry in tab-scoped recovery storage.'
                            : 'You can close and reopen this dialog on this page. Keep the page open because tab-scoped refresh recovery is unavailable.'}
                        </div>
                        {target.partial.recoveryFile && (
                          <div className="mt-1 text-muted-foreground">
                            Recovery copy: <code className="break-all text-foreground">{target.partial.recoveryFile}</code>
                          </div>
                        )}
                      </div>
                    )}
                    {target.status === 'blocked' && (
                      <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs">
                        <div className="font-medium text-warning">Automatic retry blocked</div>
                        <div className="mt-1 break-words text-muted-foreground">
                          {target.error ?? `The ${mrLabel} may already contain part of this review. Inspect it before starting another submission.`}
                        </div>
                        {target.partial && target.partial.failedFileComments.length > 0 && (
                          <CopyButton
                            text={buildFailedCommentsMarkdown(target.partial)}
                            variant="inline"
                            label="Copy last known unposted comments"
                            className="mt-1"
                          />
                        )}
                        {target.partial?.recoveryFile && (
                          <div className="mt-1 text-muted-foreground">
                            Last recovery copy: <code className="break-all text-foreground">{target.partial.recoveryFile}</code>
                          </div>
                        )}
                        <div className="mt-1 text-muted-foreground">
                          {recoveryPersistsRefresh
                            ? 'Closing and reopening this dialog, or refreshing this tab, keeps the block in tab-scoped recovery storage.'
                            : 'Closing the dialog keeps this block on the current page. Keep the page open because tab-scoped refresh recovery is unavailable.'}
                        </div>
                      </div>
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
        <label data-pn-touch-target className="flex items-center gap-2 text-sm text-muted-foreground mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={platformOpenPR}
            onChange={e => onPlatformOpenPRChange(e.target.checked)}
            className="rounded border-border"
          />
          View on {platformLabel} after submitting
        </label>

        {/* Actions */}
        <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 border-t border-border/50 bg-card px-4 pb-4 pt-3 sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6">
          <button
            data-pn-touch-target
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-md text-sm font-medium bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            {hasPartial || hasBlocked ? 'Close' : 'Cancel'}
          </button>
          <button
            data-pn-touch-target
            onClick={onConfirm}
            disabled={isSubmitting || hasBlocked || (!hasTargets && !isApprove && !generalComment.trim()) || allSucceeded}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-opacity ${
              isSubmitting || hasBlocked || (!hasTargets && !isApprove && !generalComment.trim()) || allSucceeded
                ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
                : isApprove
                  ? 'bg-success text-success-foreground hover:opacity-90'
                  : 'bg-primary text-primary-foreground hover:opacity-90'
            }`}
          >
            {isSubmitting
              ? 'Posting...'
              : hasBlocked
                ? 'Retry blocked'
              : hasPartial
                ? 'Retry Unposted'
                : hasFailed
                  ? 'Retry Failed'
                  : isApprove
                    ? 'Approve'
                    : 'Post Comments'}
          </button>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
