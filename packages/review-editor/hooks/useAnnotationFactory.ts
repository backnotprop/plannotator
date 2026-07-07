import { useMemo, useCallback } from 'react';
import { getDisplayRepo } from '@plannotator/shared/pr-types';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { PRDiffScope } from '@plannotator/shared/pr-stack';
import type { CodeAnnotation } from '@plannotator/ui/types';

/** The active commit diff, if any — stamped onto annotations created while a
 *  commit:<sha> diff is on screen. Mirrors the PR fields: both exist so an
 *  in-place context switch (PR switch / diff-type switch) can't silently
 *  re-anchor old annotations to a diff they weren't made on. */
export interface CommitAnnotationContext {
  sha: string;
  subject?: string;
}

export function useAnnotationFactory(
  prMetadata: PRMetadata | null,
  diffScope?: PRDiffScope,
  commitContext?: CommitAnnotationContext | null,
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
  }), [prMetadata, diffScope, commitContext]);

  const withPRContext = useCallback(
    (annotation: CodeAnnotation): CodeAnnotation => ({ ...annotation, ...prContext }),
    [prContext],
  );

  return { withPRContext };
}
