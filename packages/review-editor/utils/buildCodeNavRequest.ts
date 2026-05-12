import type { CodeNavRequest } from '@plannotator/shared/code-nav';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import { detectLanguage } from './detectLanguage';

export function buildCodeNavRequest(
  props: DiffTokenEventBaseProps,
  filePath: string,
): CodeNavRequest {
  return {
    symbol: props.tokenText,
    filePath,
    line: props.lineNumber,
    charStart: props.lineCharStart,
    side: props.side === 'additions' ? 'new' : 'old',
    language: detectLanguage(filePath),
  };
}
