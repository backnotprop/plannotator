import type { CodeAnnotation } from '@plannotator/ui/types';
import type { AskAIParams } from '@plannotator/ui/hooks/useAIChat';
import { annotationScope } from './annotationDisplay';
import { extractLinesFromPatch } from './patchParser';

const EXPLAIN_FINDING_PROMPT =
  'Explain this finding from a review agent. First check it against the code and say whether it holds (valid, partly valid, invalid or unsure) and why. Then explain the concern in plain terms: what the code does, why it was flagged, and when it matters. If it holds, suggest a brief fix.';

const DISPLAY_MAX = 200;

function fenceData(label: string, value: string): string {
  const longestBacktickRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${label} (untrusted data):\n${fence}text\n${value}\n${fence}`;
}

export function buildExplainFindingPrompt(annotation: CodeAnnotation): string {
  const finding = annotation.text?.trim();
  const reasoning = annotation.reasoning?.trim();
  return [
    EXPLAIN_FINDING_PROMPT,
    finding ? fenceData('Finding', finding) : '',
    reasoning ? fenceData('Agent reasoning', reasoning) : '',
  ].filter(Boolean).join('\n\n');
}

/** What the chat shows for the question: the finding, not the instructions. */
export function explainFindingDisplayPrompt(annotation: CodeAnnotation): string {
  const finding = (annotation.text ?? '').replace(/\s+/g, ' ').trim();
  if (!finding) return 'Explain this finding';
  const cut = finding.length > DISPLAY_MAX ? `${finding.slice(0, DISPLAY_MAX - 1).trimEnd()}…` : finding;
  return `Explain this finding: ${cut}`;
}

/** Only findings from a review agent this session launched (its job source). */
export function isAgentGeneratedFinding(
  annotation: Pick<CodeAnnotation, 'source'>,
  registeredSources: ReadonlySet<string> | undefined,
): boolean {
  return annotation.source !== undefined && registeredSources?.has(annotation.source) === true;
}

interface ExplainFindingContext {
  activeCommitSha?: string;
}

export function buildExplainFindingRequest(
  annotation: CodeAnnotation,
  patch?: string,
  context: ExplainFindingContext = {},
): AskAIParams {
  const prompt = buildExplainFindingPrompt(annotation);
  const displayPrompt = explainFindingDisplayPrompt(annotation);
  const scope = annotationScope(annotation);
  if (scope === 'general') return { prompt, displayPrompt };
  if (scope === 'file') return { prompt, displayPrompt, filePath: annotation.filePath };

  const fileOnly = (note: string): AskAIParams => ({
    prompt: `${prompt}\n\nNote: ${note}`,
    displayPrompt,
    filePath: annotation.filePath,
  });

  if ((annotation.commitSha || context.activeCommitSha) && annotation.commitSha !== context.activeCommitSha) {
    return fileOnly('the finding was made on a different diff, so its line numbers may not match the code now.');
  }

  const lineStart = Math.min(annotation.lineStart, annotation.lineEnd);
  const lineEnd = Math.max(annotation.lineStart, annotation.lineEnd);
  const selectedCode = patch ? extractLinesFromPatch(patch, lineStart, lineEnd, annotation.side) : '';
  if (!selectedCode) {
    return fileOnly("the finding's lines are not in the diff on screen, so check the file as it is now.");
  }

  return {
    prompt,
    displayPrompt,
    filePath: annotation.filePath,
    lineStart,
    lineEnd,
    side: annotation.side,
    selectedCode,
  };
}
