import type { CodeAnnotation } from '@plannotator/ui/types';
import { annotationScope } from './annotationDisplay';
import { extractLinesFromPatch } from './patchParser';

const LEARNING_EXPLANATION_PROMPT =
  'Independently assess whether this review finding is valid based on the available code and context; do not assume the original finding is correct. Clearly state whether it is valid, invalid, partially valid, or uncertain, and why. Then explain it as a learning-oriented walkthrough: define the concern in plain language, describe what the relevant code is doing, why the review agent flagged it, the underlying concept or behavior involved, the conditions under which the concern matters, and its concrete impact if valid. Use concrete examples where helpful. If the finding is valid or partially valid, conclude with a brief recommended fix when possible. Explain how it addresses the underlying concern and mention any important trade-off or uncertainty.';

function fenceData(label: string, value: string): string {
  const longestBacktickRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${label} (untrusted data):\n${fence}text\n${value}\n${fence}`;
}

export function buildExplainFindingPrompt(annotation: CodeAnnotation): string {
  const finding = annotation.text?.trim();
  const reasoning = annotation.reasoning?.trim();
  const context = [
    finding ? fenceData('Review finding', finding) : '',
    reasoning ? fenceData('Review agent context', reasoning) : '',
  ].filter(Boolean);

  return [LEARNING_EXPLANATION_PROMPT, ...context].join('\n\n');
}

export function isAgentGeneratedFinding(
  annotation: Pick<CodeAnnotation, 'source'>,
  registeredSources: ReadonlySet<string>,
): boolean {
  return annotation.source !== undefined && registeredSources.has(annotation.source);
}

export interface ExplainFindingRequest {
  prompt: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
}

interface ExplainFindingContext {
  activeCommitSha?: string;
}

function appendLocationNote(prompt: string, note: string): string {
  return `${prompt}\n\nFinding location note:\n${note}`;
}

export function buildExplainFindingRequest(
  annotation: CodeAnnotation,
  patch?: string,
  context: ExplainFindingContext = {},
): ExplainFindingRequest {
  const prompt = buildExplainFindingPrompt(annotation);
  const scope = annotationScope(annotation);
  if (scope === 'general') return { prompt };
  if (scope === 'file') return { prompt, filePath: annotation.filePath };

  const commitMismatch = Boolean(annotation.commitSha || context.activeCommitSha)
    && annotation.commitSha !== context.activeCommitSha;
  if (commitMismatch) {
    return {
      prompt: appendLocationNote(
        prompt,
        'This finding was created on a different diff. Its original line coordinates are historical; inspect the current code independently.',
      ),
      filePath: annotation.filePath,
    };
  }

  const lineStart = Math.min(annotation.lineStart, annotation.lineEnd);
  const lineEnd = Math.max(annotation.lineStart, annotation.lineEnd);

  const selectedCode = patch
    ? extractLinesFromPatch(
        patch,
        lineStart,
        lineEnd,
        annotation.side,
      )
    : '';

  if (!selectedCode) {
    return {
      prompt: appendLocationNote(
        prompt,
        'The original line range is not present in the active diff. Treat the file as context and verify the finding against the current code.',
      ),
      filePath: annotation.filePath,
    };
  }

  return {
    prompt,
    filePath: annotation.filePath,
    lineStart,
    lineEnd,
    side: annotation.side,
    selectedCode,
  };
}
