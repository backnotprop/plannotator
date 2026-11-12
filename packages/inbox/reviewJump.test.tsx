import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ReviewJump, chapterInView, fileInView, jumpPlace, jumpProgress } = (hasDom ? await import('./components/ReviewJump') : {}) as typeof import('./components/ReviewJump');

const CHAPTERS = [
  { title: 'The schedule', reviewed: true },
  { title: 'The worker', reviewed: false },
];
const FILES = [
  { path: 'src/a.ts', additions: 3, deletions: 1, viewed: true },
  { path: 'src/a.test.ts', additions: 29, deletions: 0, viewed: false },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

function scroller(attr: string, tops: [string, number][]): HTMLElement {
  const body = document.createElement('div');
  body.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  for (const [value, top] of tops) {
    const el = document.createElement('div');
    el.setAttribute(attr, value);
    el.getBoundingClientRect = () => ({ top }) as DOMRect;
    body.appendChild(el);
  }
  return body;
}

test.skipIf(!hasDom)('the chapter in view: the Overview above the first, and a card past the chapters leaves the last chapter named', () => {
  const at = (first: number, second: number, extra: number) =>
    chapterInView(scroller('data-guide-section', [['0', first], ['1', second], ['2', extra]]), 2);
  expect(at(500, 900, 1400)).toBeNull();
  expect(at(10, 500, 900)).toBe(0);
  expect(at(-900, 10, 500)).toBe(1);
  expect(at(-1900, -900, 10)).toBe(1);
});

test.skipIf(!hasDom)('the file in view is the one drawn there, by its path: the review draws code before tests, whatever the patch order', () => {
  const body = scroller('data-guide-file-shell', [['src/z.ts', -400], ['src/a.test.ts', 10], ['src/m.ts', 900]]);
  expect(fileInView(body)).toBe('src/a.test.ts');
  expect(fileInView(scroller('data-guide-file-shell', [['src/z.ts', 300]]))).toBeNull();
});

test.skipIf(!hasDom)('the button says where the person is, in the approved words', () => {
  const walk = { mode: 'walkthrough' as const, chapters: CHAPTERS, files: FILES };
  expect(jumpPlace({ ...walk, current: null })).toEqual({ lead: '', name: 'Overview', done: false });
  expect(jumpPlace({ ...walk, current: 1 })).toEqual({ lead: '2 of 2', name: 'The worker', done: false });
  expect(jumpPlace({ ...walk, current: 0 }).done).toBe(true);
  const all = { mode: 'files' as const, chapters: CHAPTERS, files: FILES };
  expect(jumpPlace({ ...all, current: 0 })).toEqual({ lead: '1 of 2', name: 'a.ts', done: true });
  expect(jumpPlace({ ...all, files: [], current: 0 })).toEqual({ lead: '', name: '0 files', done: false });
});

test.skipIf(!hasDom)('the count the rail gave: chapters reviewed, or files viewed', () => {
  expect(jumpProgress({ mode: 'walkthrough', chapters: CHAPTERS, files: FILES })).toBe('1 of 2 chapters reviewed');
  expect(jumpProgress({ mode: 'files', chapters: CHAPTERS, files: FILES })).toBe('1 of 2 files viewed');
});

async function open(props: Partial<Parameters<typeof ReviewJump>[0]> = {}) {
  const picked: (string | number | null)[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<ReviewJump mode="walkthrough" chapters={CHAPTERS} files={FILES} current={1} onChapter={(index) => picked.push(index)} onFile={(path) => picked.push(path)} {...props} />);
  });
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-review-jump]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return picked;
}

test.skipIf(!hasDom)('the menu holds the Overview, each chapter with its tick, and the count; a row goes there', async () => {
  const picked = await open();
  const menu = document.querySelector<HTMLElement>('[data-review-jump-menu]')!;
  const rows = [...menu.querySelectorAll<HTMLElement>('[data-review-jump-row]')];
  expect(rows.map((row) => row.dataset.reviewJumpRow)).toEqual(['overview', '0', '1']);
  expect(rows[1]!.getAttribute('aria-label')).toContain('reviewed');
  expect(rows[1]!.querySelector('[data-done]')).not.toBeNull();
  expect(rows[2]!.querySelector('[data-done]')).toBeNull();
  expect(rows.map((row) => row.hasAttribute('data-on'))).toEqual([false, false, true]);
  expect(menu.querySelector('[data-review-progress]')?.textContent).toBe('1 of 2 chapters reviewed');
  await act(async () => rows[0]!.click());
  expect(picked).toEqual([null]);
});

test.skipIf(!hasDom)('in All files the menu lists the files with their counts and ticks, and a row goes to the file', async () => {
  const picked = await open({ mode: 'files', current: 1 });
  const menu = document.querySelector<HTMLElement>('[data-review-jump-menu]')!;
  const rows = [...menu.querySelectorAll<HTMLElement>('[data-review-jump-row]')];
  expect(rows.map((row) => row.dataset.reviewJumpRow)).toEqual(['src/a.ts', 'src/a.test.ts']);
  expect(rows[0]!.querySelector('[data-done]')).not.toBeNull();
  expect(rows[0]!.textContent).toContain('+3');
  expect(rows[0]!.textContent).toContain('-1');
  expect(rows[1]!.textContent).not.toContain('-0');
  expect(menu.querySelector('[data-review-progress]')?.textContent).toBe('1 of 2 files viewed');
  await act(async () => rows[1]!.click());
  expect(picked).toEqual(['src/a.test.ts']);
});

test.skipIf(!hasDom)('with no Viewed ticks to give (a guide, or Code review off): All files lists the files with no tick and no "files viewed" count', async () => {
  await open({ mode: 'files', current: 0, files: FILES.map((file) => ({ ...file, viewed: false })), viewedTicks: false });
  const menu = document.querySelector<HTMLElement>('[data-review-jump-menu]')!;
  expect(menu.querySelectorAll('[data-review-jump-row]').length).toBe(2);
  expect(menu.querySelector('[data-done]') === null).toBe(true);
  expect(menu.querySelector('[data-review-progress]') === null).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  await open({ viewedTicks: false });
  expect(document.querySelector('[data-review-progress]')?.textContent).toBe('1 of 2 chapters reviewed');
});

test.skipIf(!hasDom)("Escape in the menu closes the menu and is marked used: the window's own rung, back to the thread, leaves the review open", async () => {
  await open();
  const menu = document.querySelector<HTMLElement>('[data-review-jump-menu]')!;
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => {
    menu.dispatchEvent(escape);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(host!.querySelector('[data-review-jump]')?.getAttribute('aria-expanded')).toBe('false');
  expect(escape.defaultPrevented).toBe(true);
});
