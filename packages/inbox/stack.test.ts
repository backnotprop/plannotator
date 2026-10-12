/**
 * When a pane covers the one under it in a window too narrow for both
 * (stack.ts). The failures these catch: a wide desktop window starting to
 * stack (it must be drawn as before), a narrow one squeezing the thread
 * again, and the widths here drifting from the columns inbox.css draws.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_MIN_WIDTH, LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, THREAD_MIN_WIDTH, stackFor } from './stack';

// The docked sidebar's default width.
const SIDEBAR = 232;

test('a wide window never stacks: the list beside the thread, the file beside the thread', () => {
  for (const width of [1280, 1440, 1920]) expect(stackFor(width - SIDEBAR, width)).toEqual({ thread: false, file: false });
  // Just wide enough: the thread keeps 480 px beside the 380 px list.
  expect(stackFor(1100 - SIDEBAR, 1100)).toEqual({ thread: false, file: false });
});

test('an iPad in portrait and a 900 px window: the thread covers the list, a file covers the thread', () => {
  expect(stackFor(810 - SIDEBAR, 810)).toEqual({ thread: true, file: true });
  expect(stackFor(900 - SIDEBAR, 900)).toEqual({ thread: true, file: true });
  // With the sidebar collapsed a 900 px window has room for the list beside the thread.
  expect(stackFor(900, 900).thread).toBe(false);
});

test('the edges: stacking starts exactly where a pane would get less than its minimum', () => {
  expect(stackFor(LIST_MIN_WIDTH + THREAD_MIN_WIDTH, 2000).thread).toBe(false);
  expect(stackFor(LIST_MIN_WIDTH + THREAD_MIN_WIDTH - 1, 2000).thread).toBe(true);
  expect(stackFor(2000, THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH).file).toBe(false);
  expect(stackFor(2000, THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH - 1).file).toBe(true);
  // Not measured yet (0): nothing stacks.
  expect(stackFor(0, 0)).toEqual({ thread: false, file: false });
});

test('the widths are the ones inbox.css draws the columns at', () => {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  expect(css).toContain(`.ib-listcol.ib-resizable { position: relative; min-width: ${LIST_MIN_WIDTH}px; max-width: calc(100% - ${THREAD_MIN_WIDTH}px); }`);
  expect(css).toContain(`.ib-pane.ib-withfile { flex: none; width: ${THREAD_BESIDE_FILE_WIDTH}px;`);
});
