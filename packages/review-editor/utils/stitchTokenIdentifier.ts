const FRAGMENT = /^[\w$]+$/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const MIN_SYMBOL_LENGTH = 2;

const KEYWORD_STOPLIST = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'import', 'export', 'from', 'class', 'new', 'type', 'interface', 'async',
  'await', 'pub', 'fn', 'def', 'self', 'this',
]);

function readCharOffset(element: Element | null): number | null {
  const raw = element?.getAttribute('data-char');
  if (raw == null) return null;
  const offset = Number.parseInt(raw, 10);
  return Number.isNaN(offset) ? null : offset;
}

export interface StitchedToken {
  symbol: string;
  charStart: number;
}

export function stitchTokenIdentifier(
  tokenElement: HTMLElement,
): StitchedToken | null {
  const charStart = readCharOffset(tokenElement);
  if (charStart == null) return null;

  const text = tokenElement.textContent ?? '';
  if (!FRAGMENT.test(text)) return null;

  let symbol = text;
  let start = charStart;
  let end = charStart + text.length;

  for (
    let sibling = tokenElement.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    const offset = readCharOffset(sibling);
    const siblingText = sibling.textContent ?? '';
    if (offset == null || !FRAGMENT.test(siblingText)) break;
    if (offset + siblingText.length !== start) break;
    symbol = siblingText + symbol;
    start = offset;
  }

  for (
    let sibling = tokenElement.nextElementSibling;
    sibling;
    sibling = sibling.nextElementSibling
  ) {
    const offset = readCharOffset(sibling);
    const siblingText = sibling.textContent ?? '';
    if (offset == null || !FRAGMENT.test(siblingText)) break;
    if (offset !== end) break;
    symbol += siblingText;
    end = offset + siblingText.length;
  }

  if (!IDENTIFIER.test(symbol)) return null;
  if (symbol.length < MIN_SYMBOL_LENGTH) return null;
  if (KEYWORD_STOPLIST.has(symbol)) return null;

  return { symbol, charStart: start };
}
