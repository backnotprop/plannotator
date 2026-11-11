import type { CodeNavRequest } from '@plannotator/shared/code-nav';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import { detectLanguage } from './detectLanguage';
import { stitchTokenIdentifier } from './stitchTokenIdentifier';

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

export function buildTokenHoverRequest(
  props: DiffTokenEventBaseProps,
  filePath: string,
): CodeNavRequest | null {
  const stitched = stitchTokenIdentifier(props.tokenElement);
  if (!stitched) return null;
  return {
    ...buildCodeNavRequest(props, filePath),
    symbol: stitched.symbol,
    charStart: stitched.charStart,
  };
}
