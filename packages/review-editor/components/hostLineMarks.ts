/**
 * A host's mark at the right edge of a line of the diff (the Inbox's PR page: the risk bars, approval
 * "review-risk-bars"). Drawn by the line itself, as CSS inside the file's shadow root (Pierre's `unsafeCSS`), so it
 * never covers code:
 *
 * - The mark is a box `LINE_MARK_WIDTH` wide and one line tall at the column's right edge, filled with the line's own
 *   background (`inherit`: added, removed, selected, as the line is), the host's `paint` on top.
 * - Wrapped lines (`data-overflow="wrap"`): the line keeps that much room free at its end, so its text wraps before
 *   the mark; the mark sits on the line's first row.
 * - Lines that scroll sideways (`data-overflow="scroll"`): the mark follows the line's text and sticks to the column's
 *   visible right edge (`position: sticky` between `--diffs-column-width` minus its width and 0), so on that line the
 *   code ends where the mark begins, like the column's own edge; the mark adds its width to the line, so scrolled all
 *   the way, the line's last character sits clear of it.
 *
 * Split and unified views, old and new sides: the selectors find the line by its number on its side.
 */

export interface HostLineMark {
  filePath: string;
  side: 'old' | 'new';
  line: number;
  /** What a screen reader says for the mark. */
  label: string;
  /**
   * The mark's look: CSS declarations for its box (`LINE_MARK_WIDTH` × one line), backgrounds only (`background-image`,
   * `-size`, `-position`); its fill under them is the line's.
   */
  paint: string;
}

export const NO_HOST_LINE_MARKS: readonly HostLineMark[] = [];

/** The mark's width in px: the room the line keeps free at its right edge. */
export const LINE_MARK_WIDTH = 24;

/** The line on its side, in both views (split: its column; unified: an old line is a removed one or context's other number). */
function lineSelectors(side: 'old' | 'new', line: number): string[] {
  const n = Math.trunc(line);
  return side === 'new'
    ? [`[data-additions] [data-line="${n}"]`, `[data-unified] [data-line="${n}"]:not([data-line-type="change-deletion"])`]
    : [`[data-deletions] [data-line="${n}"]`, `[data-unified] [data-line-type="change-deletion"][data-line="${n}"]`, `[data-unified] [data-alt-line="${n}"]`];
}

const cssString = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r]/g, ' ')}"`;

/** The CSS for one file's marks (`marks` already that file's). Empty with none. */
export function hostLineMarksCss(marks: readonly HostLineMark[]): string {
  const w = `${LINE_MARK_WIDTH}px`;
  return marks
    .map((mark) => {
      const lines = lineSelectors(mark.side, mark.line);
      const inMode = (mode: 'scroll' | 'wrap', after = '') => lines.map((sel) => `[data-overflow="${mode}"] ${sel}${after}`).join(',\n');
      const content = `content: ""; content: "" / ${cssString(mark.label)};`;
      const box = `width: ${w}; height: 1lh; box-sizing: border-box; background-color: inherit; background-repeat: no-repeat; ${mark.paint}`;
      return `
${inMode('scroll')} { padding-inline-end: 0; }
${inMode('scroll', '::after')} { ${content} display: inline-block; vertical-align: top; position: sticky; right: 0; left: calc(var(--diffs-column-width) - ${w}); ${box} }
${inMode('wrap')} { padding-inline-end: ${w}; }
${inMode('wrap', '::after')} { ${content} position: absolute; top: 0; right: 0; ${box} }`;
    })
    .join('\n');
}
