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

/**
 * The hover variant. Cmd+click resolves the token the user aimed at; hover has
 * no such aim, so it stitches the fragmented spans back into one identifier
 * first and declines (null) for anything that is not a symbol worth searching.
 */
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
