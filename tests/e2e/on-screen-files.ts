import { expect, type Locator } from '@playwright/test';

export const blankOnScreen = (scroller: Locator): Promise<string[]> =>
  scroller.evaluate((el) => {
    const drawsLines = (root: ParentNode): boolean =>
      root.querySelector('[data-line-type]') !== null
      || [...root.querySelectorAll('*')].some((child) => child.shadowRoot !== null && drawsLines(child.shadowRoot));
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>('[data-guide-file-shell]')]
      .filter((shell) => {
        const rect = shell.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom && !drawsLines(shell);
      })
      .map((shell) => shell.dataset.guideFileShell ?? '');
  });

export async function expectNoBlankFiles(scroller: Locator, step = 300): Promise<void> {
  const { scrollHeight, clientHeight } = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(scrollHeight, 'the review must be taller than its window for this to prove anything').toBeGreaterThan(clientHeight);
  for (let top = 0; top < scrollHeight - clientHeight + step; top += step) {
    await scroller.evaluate((el, y) => {
      el.scrollTop = y;
    }, top);
    await expect.poll(() => blankOnScreen(scroller), { message: `blank files at scrollTop ${top}`, timeout: 4_000 }).toEqual([]);
  }
}
