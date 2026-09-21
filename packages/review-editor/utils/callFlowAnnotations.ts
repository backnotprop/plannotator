import type { CallFlowAnnotationTarget, CodeAnnotationScope } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import { isLineRangeInPatch } from './patchParser';

/** Native annotation placement plus the complete normalized Call Flow target set. */
export interface CallFlowAnnotationPlacement {
  readonly scope: CodeAnnotationScope;
  readonly filePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly side: 'old' | 'new';
  readonly targets: readonly CallFlowAnnotationTarget[];
}

function hasSourceRange(target: CallFlowAnnotationTarget): target is CallFlowAnnotationTarget & {
  filePath: string;
  lineStart: number;
  lineEnd: number;
} {
  return Boolean(
    target.filePath
    && Number.isInteger(target.lineStart)
    && Number.isInteger(target.lineEnd)
    && (target.lineStart ?? 0) >= 1
    && (target.lineEnd ?? 0) >= (target.lineStart ?? 0),
  );
}

/**
 * Resolve a Call Flow selection onto the strongest native review anchor.
 *
 * An in-hunk source range becomes an inline comment. If none exists, the
 * first located step becomes a file comment; a fully structural selection is
 * review-scoped. Every selected target is retained in all three cases.
 */
export function resolveCallFlowAnnotationPlacement(
  targets: readonly CallFlowAnnotationTarget[],
  files: readonly DiffFile[],
): CallFlowAnnotationPlacement | null {
  if (targets.length === 0) return null;

  const normalizedTargets = targets.map((target) => {
    if (!target.filePath) return target;
    const file = files.find((candidate) => (
      candidate.path === target.filePath || candidate.oldPath === target.filePath
    ));
    return file ? { ...target, filePath: file.path } : target;
  });

  for (const target of normalizedTargets) {
    if (!hasSourceRange(target)) continue;
    const file = files.find((candidate) => candidate.path === target.filePath);
    if (!file) continue;
    if (!isLineRangeInPatch(file.patch, target.lineStart, target.lineEnd, target.side)) continue;
    return {
      scope: 'line',
      filePath: target.filePath,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
      side: target.side,
      targets: normalizedTargets,
    };
  }

  const located = normalizedTargets.find((target) => Boolean(target.filePath));
  if (located?.filePath) {
    return {
      scope: 'file',
      filePath: located.filePath,
      lineStart: 1,
      lineEnd: 1,
      side: located.side,
      targets: normalizedTargets,
    };
  }

  return {
    scope: 'general',
    filePath: '',
    lineStart: 0,
    lineEnd: 0,
    side: normalizedTargets[0].side,
    targets: normalizedTargets,
  };
}
