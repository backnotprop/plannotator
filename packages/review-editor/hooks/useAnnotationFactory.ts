import { useMemo, useCallback } from 'react';
import { getDisplayRepo, getPRNumber } from '@plannotator/shared/pr-types';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { PRDiffScope } from '@plannotator/shared/pr-stack';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import { captureAnchor } from '@plannotator/ui/utils/codeAnnotationAnchor';

export interface CommitAnnotationContext {
  sha: string;
  subject?: string;
}

export interface GitButlerAnnotationContext {
  diffType: string;
  label?: string;
  base?: string;
  snapshotId?: string;
}

export function useAnnotationFactory(
  prMetadata: PRMetadata | null,
  diffScope?: PRDiffScope,
  commitContext?: CommitAnnotationContext | null,
  gitButlerContext?: GitButlerAnnotationContext | null,
  files?: readonly DiffFile[],
  snapshotId?: string,
  localReviewTarget?: string | null,
) {
  const prContext = useMemo(() => ({
    ...(prMetadata ? {
      prUrl: prMetadata.url,
      prNumber: getPRNumber(prMetadata),
      prTitle: prMetadata.title,
      prRepo: getDisplayRepo(prMetadata),
      ...(diffScope ? { diffScope } : {}),
    } : {}),
    ...(commitContext ? {
      commitSha: commitContext.sha,
      ...(commitContext.subject ? { commitSubject: commitContext.subject } : {}),
    } : {}),
    ...(gitButlerContext ? {
      gitButlerDiffType: gitButlerContext.diffType,
      ...(gitButlerContext.label ? { gitButlerDiffLabel: gitButlerContext.label } : {}),
      ...(gitButlerContext.base ? { gitButlerBase: gitButlerContext.base } : {}),
      ...(gitButlerContext.snapshotId ? { gitButlerSnapshotId: gitButlerContext.snapshotId } : {}),
    } : {}),
  }), [prMetadata, diffScope, commitContext, gitButlerContext]);

  const withPRContext = useCallback(
    (annotation: CodeAnnotation): CodeAnnotation => {
      const stamped = { ...annotation, ...prContext, ...(localReviewTarget ? { localReviewTarget } : {}) };
      if ((!prMetadata && !localReviewTarget) || !files || (stamped.scope ?? 'line') !== 'line') return stamped;
      return {
        ...stamped,
        ...captureAnchor(stamped, files),
        ...(snapshotId ? { anchorSnapshot: snapshotId } : {}),
      };
    },
    [prContext, prMetadata, files, snapshotId, localReviewTarget],
  );

  return { withPRContext };
}
