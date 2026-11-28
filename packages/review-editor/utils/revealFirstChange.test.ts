import { expect, test } from 'bun:test';
import { revealFirstChange } from './revealFirstChange';

type Box = { left: number; right: number };

function column(scrollWidth: number, clientWidth: number, codeBox: Box, markBox: Box | null) {
  const code = {
    scrollLeft: 0,
    scrollWidth,
    clientWidth,
    getBoundingClientRect: () => codeBox,
    querySelector: () => (markBox ? { getBoundingClientRect: () => markBox } : null),
  };
  return code;
}

function host(columns: ReturnType<typeof column>[]) {
  return { shadowRoot: { querySelectorAll: () => columns } } as unknown as HTMLElement;
}

test('a change far right on a long line is scrolled into view the first time its file is drawn', () => {
  const far = column(30_000, 500, { left: 100, right: 600 }, { left: 100 + 26_000, right: 100 + 26_010 });
  expect(revealFirstChange(host([far]))).toBe(true);
  expect(far.scrollLeft).toBe(26_000 - 48);
});

test('a change that starts on screen but runs past the right edge keeps the column at its left edge', () => {
  // A whole new long line: its change starts a few characters in and ends far past the pane.
  const wide = column(900, 590, { left: 850, right: 1440 }, { left: 915, right: 1665 });
  expect(revealFirstChange(host([wide]))).toBe(false);
  expect(wide.scrollLeft).toBe(0);
});

test('a change that starts at the very right edge is still brought into view', () => {
  const edge = column(2_000, 500, { left: 100, right: 600 }, { left: 590, right: 700 });
  expect(revealFirstChange(host([edge]))).toBe(true);
  expect(edge.scrollLeft).toBe(590 - 100 - 48);
});

test('a change already on screen, a column with nothing to scroll, or one the reader already scrolled is left alone', () => {
  const visible = column(30_000, 500, { left: 100, right: 600 }, { left: 300, right: 310 });
  const short = column(400, 500, { left: 100, right: 600 }, { left: 900, right: 910 });
  const scrolled = column(30_000, 500, { left: 100, right: 600 }, { left: 9_000, right: 9_010 });
  scrolled.scrollLeft = 120;
  expect(revealFirstChange(host([visible, short, scrolled]))).toBe(false);
  expect([visible.scrollLeft, short.scrollLeft, scrolled.scrollLeft]).toEqual([0, 0, 120]);
});
