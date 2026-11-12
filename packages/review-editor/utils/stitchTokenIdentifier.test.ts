import { describe, expect, test } from 'bun:test';
import { stitchTokenIdentifier } from './stitchTokenIdentifier';

const hasDom = typeof document !== 'undefined';

function line(...tokens: string[]): HTMLElement[] {
  const host = document.createElement('div');
  let column = 0;
  const spans: HTMLElement[] = [];
  for (const token of tokens) {
    const span = document.createElement('span');
    span.setAttribute('data-char', String(column));
    span.textContent = token;
    host.appendChild(span);
    spans.push(span);
    column += token.length;
  }
  return spans;
}

describe.skipIf(!hasDom)('stitchTokenIdentifier', () => {
  test('joins adjacent fragments of one identifier', () => {
    const [, withFragment, retryFragment] = line('  ', 'with', 'Retry', '(fn)');
    expect(stitchTokenIdentifier(withFragment)).toEqual({ symbol: 'withRetry', charStart: 2 });
    expect(stitchTokenIdentifier(retryFragment)).toEqual({ symbol: 'withRetry', charStart: 2 });
  });

  test('stops at a gap in the char offsets', () => {
    const [first, second] = line('with', 'Retry');
    second.setAttribute('data-char', '9');
    expect(stitchTokenIdentifier(first)).toEqual({ symbol: 'with', charStart: 0 });
    expect(stitchTokenIdentifier(second)).toEqual({ symbol: 'Retry', charStart: 9 });
  });

  test('never joins across a dot: the segment is the searchable unit', () => {
    const [, , method] = line('gateway', '.', 'post');
    expect(stitchTokenIdentifier(method)).toEqual({ symbol: 'post', charStart: 8 });
  });

  test('never joins across whitespace', () => {
    const [, , second] = line('charge', ' ', 'amount');
    expect(stitchTokenIdentifier(second)).toEqual({ symbol: 'amount', charStart: 7 });
  });

  test('keywords, punctuation and one-character names never reach the wire', () => {
    const [keyword] = line('const', ' ', 'x');
    expect(stitchTokenIdentifier(keyword)).toBeNull();
    const [, , single] = line('const', ' ', 'x');
    expect(stitchTokenIdentifier(single)).toBeNull();
    const [punctuation] = line('=>');
    expect(stitchTokenIdentifier(punctuation)).toBeNull();
  });

  test('a run that is not a valid identifier is refused', () => {
    const [digits] = line('42');
    expect(stitchTokenIdentifier(digits)).toBeNull();
  });

  test('a span with no data-char is not a token', () => {
    const plain = document.createElement('span');
    plain.textContent = 'charge';
    expect(stitchTokenIdentifier(plain)).toBeNull();
  });
});
