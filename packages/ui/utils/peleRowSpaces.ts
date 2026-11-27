const SVG_NS = 'http://www.w3.org/2000/svg';
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/u;

/**
 * Pele draws a label wrapped over rows as one `tspan` per row, each placed on
 * its own, with nothing between them, so a screen reader and find-in-page
 * read "Detect installedagents". Before each row after the first this puts a
 * space in a `tspan` of its own, placed where that row starts: a chunk of
 * its own, so it moves no row and draws nothing. (A space left between the
 * rows would join the row before it and shift a centred row by half a space.)
 */
export function spaceWrappedRows(svg: Element): void {
  for (const text of Array.from(svg.querySelectorAll('text'))) {
    const rows = Array.from(text.children).filter((child) => child.localName === 'tspan' && child.hasAttribute('y'));
    for (const row of rows.slice(1)) {
      const x = row.getAttribute('x') ?? '';
      const y = row.getAttribute('y') ?? '';
      if (!NUMBER.test(x.trim()) || !NUMBER.test(y.trim())) continue;
      if (/\s$/u.test(row.previousSibling?.textContent ?? '') || /^\s/u.test(row.textContent ?? '')) continue;
      const space = svg.ownerDocument.createElementNS(SVG_NS, 'tspan');
      space.setAttribute('x', x);
      space.setAttribute('y', y);
      space.textContent = ' ';
      text.insertBefore(space, row);
    }
  }
}
