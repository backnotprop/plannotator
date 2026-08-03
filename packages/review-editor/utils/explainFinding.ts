import type { CodeAnnotation } from '@plannotator/ui/types';
import { extractLinesFromPatch } from './patchParser';

const LEARNING_EXPLANATION_PROMPT =
  'Independently assess whether this review finding is valid based on the available code and context; do not assume the original finding is correct. Clearly state whether it is valid, invalid, partially valid, or uncertain, and why. Then explain it as a learning-oriented walkthrough: define the concern in plain language, describe what the relevant code is doing, why the review agent flagged it, the underlying concept or behavior involved, the conditions under which the concern matters, and its concrete impact if valid. Use concrete examples where helpful. If the finding is valid or partially valid, conclude with a brief recommended fix when possible. Explain how it addresses the underlying concern and mention any important trade-off or uncertainty.';

export function buildExplainFindingPrompt(annotation: CodeAnnotation): string {
  const finding = annotation.text?.trim();
  const reasoning = annotation.reasoning?.trim();
  const context = [
    finding ? `Review finding:\n${finding}` : '',
    reasoning ? `Review agent context:\n${reasoning}` : '',
  ].filter(Boolean);

  return [LEARNING_EXPLANATION_PROMPT, ...context].join('\n\n');
}

export function isAgentGeneratedFinding(annotation: Pick<CodeAnnotation, 'source'>): boolean {
  return annotation.source?.startsWith('agent-') === true;
}

export interface ExplainFindingRequest {
  prompt: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
}

export function buildExplainFindingRequest(
  annotation: CodeAnnotation,
  patch?: string,
): ExplainFindingRequest {
  const prompt = buildExplainFindingPrompt(annotation);
  const scope = annotation.scope ?? 'line';
  if (scope === 'general') return { prompt };
  if (scope === 'file') return { prompt, filePath: annotation.filePath };

  const selectedCode = patch
    ? extractLinesFromPatch(
        patch,
        annotation.lineStart,
        annotation.lineEnd,
        annotation.side,
      )
    : '';

  return {
    prompt,
    filePath: annotation.filePath,
    lineStart: annotation.lineStart,
    lineEnd: annotation.lineEnd,
    side: annotation.side,
    ...(selectedCode && { selectedCode }),
  };
}
