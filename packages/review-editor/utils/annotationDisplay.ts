import type { CodeAnnotation, CodeAnnotationScope, DiffAnnotationMetadata } from '@plannotator/ui/types';

export function annotationScope(a: CodeAnnotation): CodeAnnotationScope {
  return a.scope ?? 'line';
}

export function copyLocationPrefix(
  a: CodeAnnotation,
  scope: CodeAnnotationScope = annotationScope(a),
): string {
  if (scope === 'general') return '';
  if (scope === 'file') return `${a.filePath}\n`;
  return `${a.filePath}:${a.lineStart}${a.lineEnd !== a.lineStart ? `-${a.lineEnd}` : ''}\n`;
}

export function commentCopyText(
  a: CodeAnnotation,
  scope: CodeAnnotationScope = annotationScope(a),
): string {
  return `${copyLocationPrefix(a, scope)}${a.text ?? ''}${a.reasoning ? `\n\nReasoning: ${a.reasoning}` : ''}`;
}

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
