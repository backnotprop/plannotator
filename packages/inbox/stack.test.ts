import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_MIN_WIDTH, LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, THREAD_MIN_WIDTH, paneGutters, stackFor } from './stack';

const SIDEBAR = 232;
const NONE = { thread: false, file: false };

test('a wide window never stacks: the list beside the thread, the file beside the thread', () => {
  for (const width of [1280, 1440, 1920]) expect(stackFor(width - SIDEBAR, width)).toEqual(NONE);
});

test('an iPad on its side (1080) keeps the list beside a 468 px thread, as iPad Mail does', () => {
  expect(stackFor(1080 - SIDEBAR, 1080)).toEqual(NONE);
  expect(stackFor(1100 - SIDEBAR, 1100)).toEqual(NONE);
});

test('an iPad upright and a 900 px window: the thread covers the list, a file covers the thread', () => {
  expect(stackFor(810 - SIDEBAR, 810)).toEqual({ thread: true, file: true });
  expect(stackFor(900 - SIDEBAR, 900)).toEqual({ thread: true, file: true });
  expect(stackFor(1000 - SIDEBAR, 1000)).toEqual({ thread: true, file: false });
  expect(stackFor(900, 900).thread).toBe(false);
});

test('the edges: stacking starts exactly where a pane would get less than its minimum', () => {
  expect(stackFor(LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH, 2000).thread).toBe(false);
  expect(stackFor(LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH - 1, 2000).thread).toBe(true);
  expect(stackFor(2000, THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH).file).toBe(false);
  expect(stackFor(2000, THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH - 1).file).toBe(true);
  expect(stackFor(0, 0)).toEqual(NONE);
});

test('the widths are the ones inbox.css draws the columns at', () => {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  expect(css).toContain(`.ib-listcol.ib-resizable { position: relative; min-width: ${LIST_MIN_WIDTH}px; max-width: calc(100% - ${THREAD_MIN_WIDTH}px - var(--ib-gutter)); }`);
  expect(css).toContain(`.ib-pane.ib-withfile { flex: none; width: ${THREAD_BESIDE_FILE_WIDTH}px;`);
});

test('paneGutters: three gutters from --ib-gutter (Soft panes on), none when it is 0px or missing', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { document: Object.getOwnPropertyDescriptor(g, 'document'), getComputedStyle: Object.getOwnPropertyDescriptor(g, 'getComputedStyle') };
  const root = {};
  let gutter = '';
  try {
    Object.defineProperty(g, 'document', { configurable: true, writable: true, value: { querySelector: (sel: string) => (sel === '.pn-inbox' ? root : null) } });
    Object.defineProperty(g, 'getComputedStyle', { configurable: true, writable: true, value: (el: unknown) => ({ getPropertyValue: (name: string) => (el === root && name === '--ib-gutter' ? gutter : '') }) });
    gutter = ' 8px';
    expect(paneGutters()).toBe(24);
    expect(paneGutters(root as Element)).toBe(24);
    gutter = '0px';
    expect(paneGutters()).toBe(0);
    gutter = '';
    expect(paneGutters()).toBe(0);
    Object.defineProperty(g, 'document', { configurable: true, writable: true, value: { querySelector: () => null } });
    expect(paneGutters()).toBe(0);
  } finally {
    for (const [key, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, key, d);
      else delete g[key];
    }
  }
});
