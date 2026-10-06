import type { CommentAskAIContext } from '@plannotator/ui/components/CommentPopover';
import type { AIQuestion } from '@plannotator/ui/types';

/**
 * The Ask AI question scope for a composer's context. One mapping for both
 * Ask AI paths (the agent terminal, and the side chat / Ask this session).
 *
 * A selection's source lines ride only when they name lines of the file the
 * agent reads: a converted HTML/URL source renders converted markdown, whose
 * lines do not exist in the original, so it sends none (#1731).
 */
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
