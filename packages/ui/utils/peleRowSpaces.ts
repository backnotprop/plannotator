const SVG_NS = 'http://www.w3.org/2000/svg';
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/u;

/** Chinese and Japanese characters and their punctuation, which Pele wraps between (no word spaces). */
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]$/u;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/**
 * Whether Pele broke a label between two rows inside Chinese or Japanese
 * text, where the source has no space: the rows then read run together, as
 * Mermaid reads the same label.
 */
export function rowsJoinWithoutSpace(before: string, after: string): boolean {
  return CJK_END.test(before) && CJK_START.test(after);
}

/**
 * Pele draws a label wrapped over rows as one `tspan` per row, each placed on
 * its own, with nothing between them, so a screen reader and find-in-page
 * read "Detect installedagents". Before each row after the first this puts a
 * space in a `tspan` of its own, placed where that row starts: a chunk of
 * its own, so it moves no row and draws nothing. (A space left between the
 * rows would join the row before it and shift a centred row by half a space.)
 * Rows Pele broke inside Chinese or Japanese text get none.
 */
export function spaceWrappedRows(svg: Element): void {
  for (const text of Array.from(svg.querySelectorAll('text'))) {
    const rows = Array.from(text.children).filter((child) => child.localName === 'tspan' && child.hasAttribute('y'));
    for (const row of rows.slice(1)) {
      const x = row.getAttribute('x') ?? '';
      const y = row.getAttribute('y') ?? '';
      if (!NUMBER.test(x.trim()) || !NUMBER.test(y.trim())) continue;
      const before = row.previousSibling?.textContent ?? '';
      const after = row.textContent ?? '';
      if (/\s$/u.test(before) || /^\s/u.test(after) || rowsJoinWithoutSpace(before, after)) continue;
      const space = svg.ownerDocument.createElementNS(SVG_NS, 'tspan');
      space.setAttribute('x', x);
      space.setAttribute('y', y);
      space.textContent = ' ';
      text.insertBefore(space, row);
    }
  }
}
