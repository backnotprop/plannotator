/**
 * The host's line marks (hostLineMarks.ts) land on the named line on its side, in split and unified views, wrapped or
 * scrolling. What regresses: an old-side mark on the new line of the same number (or the other way), a unified view
 * missing a removed line or a context line's old number, a mark on any other line, or a line that keeps no room.
 */
import { describe, expect, test } from 'bun:test';
import { hostLineMarksCss, LINE_MARK_WIDTH, type HostLineMark } from './hostLineMarks';

const hasDom = typeof document !== 'undefined';

const mark = (side: 'old' | 'new', line: number): HostLineMark => ({ filePath: 'a.ts', side, line, label: 'High "risk"', paint: 'background-image: none;' });

/** Each rule of the CSS: its selectors and its body. */
function rules(css: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ selectors: sel!.split(',\n').map((s) => s.trim()), body: body! }));
}

type Row = { line: number; alt?: number; type: string };

/** A file's diff as Pierre draws it: `pre[data-overflow]`, one `[data-code]` per column, a `[data-line]` per row. */
function diff(overflow: 'scroll' | 'wrap', columns: Record<'deletions' | 'additions' | 'unified', Row[] | undefined>) {
  const pre = document.createElement('pre');
  pre.setAttribute('data-overflow', overflow);
  for (const [name, rows] of Object.entries(columns)) {
    if (!rows) continue;
    const code = document.createElement('code');
    code.setAttribute('data-code', '');
    code.setAttribute(`data-${name}`, '');
    for (const row of rows) {
      const line = document.createElement('div');
      line.setAttribute('data-line', String(row.line));
      if (row.alt !== undefined) line.setAttribute('data-alt-line', String(row.alt));
      line.setAttribute('data-line-type', row.type);
      line.dataset.id = `${name}:${row.type}:${row.line}`;
      code.appendChild(line);
    }
    pre.appendChild(code);
  }
  return pre;
}

/** The lines the marks' CSS draws a mark on (its `::after` rules). */
function hits(pre: HTMLElement, marks: HostLineMark[]) {
  const all = rules(hostLineMarksCss(marks));
  const marked = [...pre.querySelectorAll<HTMLElement>('[data-line]')]
    .filter((line) => all.some((rule) => rule.selectors.some((s) => s.endsWith('::after') && line.matches(s.replace(/::after$/, '')))))
    .map((line) => line.dataset.id);
  return { marked };
}

// New 10 context (old 9), new 11 added, old 10 removed, new 12 context (old 11).
const SPLIT = {
  deletions: [{ line: 9, alt: 10, type: 'context' }, { line: 10, type: 'change-deletion' }, { line: 11, alt: 12, type: 'context' }],
  additions: [{ line: 10, alt: 9, type: 'context' }, { line: 11, type: 'change-addition' }, { line: 12, alt: 11, type: 'context' }],
  unified: undefined,
};
const UNIFIED = {
  deletions: undefined,
  additions: undefined,
  unified: [{ line: 10, alt: 9, type: 'context' }, { line: 10, type: 'change-deletion' }, { line: 11, type: 'change-addition' }, { line: 12, alt: 11, type: 'context' }],
};

describe.skipIf(!hasDom)('host line marks', () => {
  for (const overflow of ['scroll', 'wrap'] as const) {
    test(`split, ${overflow}: the named line on its side, nothing else`, () => {
      const pre = diff(overflow, SPLIT);
      expect(hits(pre, [mark('old', 10)]).marked).toEqual(['deletions:change-deletion:10']);
      expect(hits(pre, [mark('new', 10)]).marked).toEqual(['additions:context:10']);
      expect(hits(pre, [mark('new', 11), mark('old', 11)]).marked).toEqual(['deletions:context:11', 'additions:change-addition:11']);
    });

    test(`unified, ${overflow}: a removed line and a context line's old number are the old side`, () => {
      const pre = diff(overflow, UNIFIED);
      expect(hits(pre, [mark('old', 10)]).marked).toEqual(['unified:change-deletion:10']);
      expect(hits(pre, [mark('new', 10)]).marked).toEqual(['unified:context:10']);
      expect(hits(pre, [mark('old', 9)]).marked).toEqual(['unified:context:10']);
      expect(hits(pre, [mark('new', 11)]).marked).toEqual(['unified:change-addition:11']);
      expect(hits(pre, [mark('old', 11)]).marked).toEqual(['unified:context:12']);
    });
  }

  test('wrapped, the marked line keeps the mark’s width free at its end; the label is one string', () => {
    const css = rules(hostLineMarksCss([mark('new', 11)]));
    const body = (mode: string, after: boolean) => css.find((rule) => rule.selectors[0]!.startsWith(`[data-overflow="${mode}"]`) && rule.selectors[0]!.endsWith('::after') === after)!.body;
    expect(body('wrap', false)).toContain(`padding-inline-end: ${LINE_MARK_WIDTH}px`);
    // The label is read as one string, whatever it holds.
    expect(body('scroll', true)).toContain('content: "" / "High \\"risk\\"";');
    expect(hostLineMarksCss([])).toBe('');
  });
});
