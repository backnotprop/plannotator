import type { CommentAskAIContext } from '@plannotator/ui/components/CommentPopover';
import type { AIQuestion } from '@plannotator/ui/types';

export function askScopeFromContext(
  context: CommentAskAIContext | undefined,
  options: { documentPath: string; sourceConverted: boolean },
): AIQuestion['scope'] {
  if (!context) return undefined;
  return {
    kind: context.kind,
    label: context.label,
    text: context.text,
    sourcePath: context.sourcePath ?? options.documentPath,
    ...(context.detail ? { detail: context.detail } : {}),
    ...(context.lineStart != null && !options.sourceConverted
      ? { lineStart: context.lineStart, lineEnd: context.lineEnd ?? context.lineStart }
      : {}),
  };
}
