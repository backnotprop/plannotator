import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import type { CodeNavRequest } from '@plannotator/shared/code-nav';
import { buildCodeNavRequest, buildTokenHoverRequest } from './buildCodeNavRequest';

/**
 * Where F12 / ⇧F12 look (approved design record "review-explorer", step 3).
 * A diff has no caret, so the symbol is the token under the pointer, or, with
 * the pointer off every token, the last token clicked (a click on a token is
 * where a caret would be).
 */
export type TokenTargetKind = 'enter' | 'leave' | 'click';
export type TokenTargetHandler = (kind: TokenTargetKind, props: DiffTokenEventBaseProps, filePath: string) => void;

export interface TokenTargetTracker {
  report: TokenTargetHandler;
  current: () => CodeNavRequest | null;
  clear: () => void;
}

function requestFor(props: DiffTokenEventBaseProps, filePath: string): CodeNavRequest | null {
  // A stitched identifier when the token is part of one; else the token as
  // Cmd+click sends it, unless it is only punctuation.
  const stitched = buildTokenHoverRequest(props, filePath);
  if (stitched) return stitched;
  const plain = buildCodeNavRequest(props, filePath);
  return /[\p{L}\p{N}_$]/u.test(plain.symbol) ? { ...plain, symbol: plain.symbol.trim() } : null;
}

export function createTokenTargetTracker(): TokenTargetTracker {
  let pointed: CodeNavRequest | null = null;
  let clicked: CodeNavRequest | null = null;
  return {
    report(kind, props, filePath) {
      if (kind === 'leave') {
        pointed = null;
        return;
      }
      const request = requestFor(props, filePath);
      if (kind === 'enter') pointed = request;
      else clicked = request ?? clicked;
    },
    current: () => pointed ?? clicked,
    clear() {
      pointed = null;
      clicked = null;
    },
  };
}
