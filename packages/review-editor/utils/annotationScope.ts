import type { CodeAnnotation, SelectedLineRange } from '@plannotator/ui/types';

export function annotationMatchesPrScope(
  a: CodeAnnotation,
  prUrl: string | undefined,
  prDiffScope: string | undefined,
): boolean {
  return (
    proseAnnotationMatchesPr(a, prUrl) &&
    (!a.diffScope || !prDiffScope || a.diffScope === prDiffScope)
  );
}

export function proseAnnotationMatchesPr(
  a: { prUrl?: string },
  prUrl: string | undefined,
): boolean {
  return !a.prUrl || !prUrl || a.prUrl === prUrl;
}

export function isFileScopedAnnotation(a: CodeAnnotation): boolean {
  return (a.scope ?? 'line') === 'file';
}

export function lineRangeForAnnotation(a: CodeAnnotation): SelectedLineRange {
  return {
    start: Math.min(a.lineStart, a.lineEnd),
    end: Math.max(a.lineStart, a.lineEnd),
    side: a.side === 'new' ? 'additions' : 'deletions',
  };
}
