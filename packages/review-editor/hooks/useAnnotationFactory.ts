import { useMemo, useCallback } from 'react';
import { getDisplayRepo } from '@plannotator/shared/pr-types';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { PRDiffScope } from '@plannotator/shared/pr-stack';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import { captureAnchorText } from '../utils/codeAnnotationAnchor';

/** The active commit diff, if any — stamped onto annotations created while a
 *  commit:<sha> diff is on screen. Mirrors the PR fields: both exist so an
 *  in-place context switch (PR switch / diff-type switch) can't silently
 *  re-anchor old annotations to a diff they weren't made on. */
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
  /** Current diff files. PR mode only: line comments record the text of the
   *  lines they anchor to (#1590), so a draft restored after the PR changed
   *  can tell which comments still point at the same code. */
  files?: readonly DiffFile[],
) {
  const prContext = useMemo(() => ({
    ...(prMetadata ? {
      prUrl: prMetadata.url,
      prNumber: prMetadata.platform === 'github' ? prMetadata.number : prMetadata.iid,
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
      const stamped = { ...annotation, ...prContext };
      if (!prMetadata || !files) return stamped;
      const anchorText = captureAnchorText(stamped, files);
      return anchorText === undefined ? stamped : { ...stamped, anchorText };
    },
    [prContext, prMetadata, files],
  );

  return { withPRContext };
}
