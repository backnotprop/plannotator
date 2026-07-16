import type { CodeAnnotation, CodeAnnotationScope, DiffAnnotationMetadata } from '@plannotator/ui/types';

/** A code annotation's scope, defaulting to 'line' for older/external data. */
export function annotationScope(a: CodeAnnotation): CodeAnnotationScope {
  return a.scope ?? 'line';
}

/**
 * The location prefix for an annotation's copied text. General comments belong
 * to no file, so they carry no prefix; file comments carry just the path; line
 * comments carry path + line range. Never emits the "" / 0 sentinels that stand
 * in for "no file / no line" on file and general comments.
 */
export function copyLocationPrefix(
  a: CodeAnnotation,
  scope: CodeAnnotationScope = annotationScope(a),
): string {
  if (scope === 'general') return '';
  if (scope === 'file') return `${a.filePath}\n`;
  return `${a.filePath}:${a.lineStart}${a.lineEnd !== a.lineStart ? `-${a.lineEnd}` : ''}\n`;
}

/**
 * The full clipboard text for a comment: location prefix + body + reasoning.
 * Shared by every comment card's copy action so they produce identical,
 * self-describing text.
 */
export function commentCopyText(
  a: CodeAnnotation,
  scope: CodeAnnotationScope = annotationScope(a),
): string {
  return `${copyLocationPrefix(a, scope)}${a.text ?? ''}${a.reasoning ? `\n\nReasoning: ${a.reasoning}` : ''}`;
}

/**
 * Project a line-scoped CodeAnnotation into the @pierre/diffs line-annotation
 * metadata the inline card renders. Single source of truth so the all-files and
 * single-file diff surfaces stay in lockstep (and so the per-file refresh
 * signature can't drift from what's actually rendered). Whenever a field is
 * added here, mirror it into the signature builders that gate updateItem().
 */
export function lineAnnotationMetadata(ann: CodeAnnotation): DiffAnnotationMetadata {
  return {
    annotationId: ann.id,
    type: ann.type,
    text: ann.text,
    suggestedCode: ann.suggestedCode,
    originalCode: ann.originalCode,
    author: ann.author,
    severity: ann.severity,
    reasoning: ann.reasoning,
    conventionalLabel: ann.conventionalLabel,
    decorations: ann.decorations,
    createdAt: ann.createdAt,
    reviewProfileLabel: ann.reviewProfileLabel,
    source: ann.source,
    copyText: ann.text ? commentCopyText(ann) : undefined,
  };
}
