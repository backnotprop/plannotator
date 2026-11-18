/**
 * The window's background layout (layout.ts) never hammers a board it cannot lay out, and never keeps a stale one.
 * What regresses: a lift that throws is retried on every canvas frame in every window, the agent's CLI never hears why,
 * a layout computed before the person moved a part overwrites their move.
 *
 * The server and the lift are stood in for. DOM-gated (runs under DOM_TESTS=1 with --isolate, so the module stand-ins
 * stay in this file).
 */
import { beforeAll, beforeEach, expect, mock, test } from 'bun:test';

const hasDom = typeof document !== 'undefined';

let liftThrows: Error | null = null;
let lifts = 0;
let layoutAnswer: 'ok' | 'stale' = 'ok';
const failures: { id: string; version: number; error: string }[] = [];
const layouts: { rev: number; version: number }[] = [];
let wireRev = 7;

let layout: typeof import('./layout');

beforeAll(async () => {
  if (!hasDom) return;
  const { InboxApiError } = await import('../apiError');
  mock.module('./board/lift', () => ({
    liftBoard: async () => {
      lifts++;
      if (liftThrows) throw liftThrows;
      return { elements: [], files: {}, warnings: [], parts: {} };
    },
  }));
  mock.module('./board/picture', () => ({ canvasPicture: async () => null, blobDataUrl: async () => '', fileData: async () => null }));
  mock.module('./client', () => ({
    canvasApi: {
      pending: async () => ({ pending: [{ id: 't1', version: 2 }] }),
      read: async () => ({ id: 't1', rev: wireRev, board: '<div id="x"></div>', pins: {}, scene: { elements: [], files: {} }, layout: { version: 2, state: 'pending', warnings: [], at: '' } }),
      layout: async (_id: string, body: { rev: number; version: number }) => {
        layouts.push({ rev: body.rev, version: body.version });
        if (layoutAnswer === 'stale') throw new InboxApiError(409, 'stale_layout', 'stale');
        return { rev: body.rev + 1 };
      },
      layoutFailed: async (id: string, body: { version: number; error: string }) => {
        failures.push({ id, ...body });
        return { state: 'pending', attempts: failures.length };
      },
      fileUrl: (_id: string, name: string) => name,
    },
  }));
  layout = await import('./layout');
});

beforeEach(() => {
  if (!hasDom) return;
  layout.resetLayoutTries();
  liftThrows = null;
  lifts = 0;
  layoutAnswer = 'ok';
  failures.length = 0;
  layouts.length = 0;
  wireRev = 7;
});

test.skipIf(!hasDom)('a board the lift cannot lay out is reported once, and tried again at most once a minute, not on every frame', async () => {
  liftThrows = new Error('the board has 9000 nodes, over the 5000 the lift lays out');
  let now = 1_000_000;
  const clock = () => now;
  await layout.layOutPending(clock);
  expect(lifts).toBe(1);
  expect(failures).toEqual([{ id: 't1', version: 2, error: 'the board has 9000 nodes, over the 5000 the lift lays out' }]);

  // Frames keep coming (every save, every window): no new try within the minute.
  for (let i = 0; i < 5; i++) {
    now += 5_000;
    await layout.layOutPending(clock);
  }
  expect(lifts).toBe(1);

  // After the minute: tried again, still not reported twice.
  now += layout.LAYOUT_RETRY_MS;
  await layout.layOutPending(clock);
  expect(lifts).toBe(2);
  expect(failures.length).toBe(1);
});

test.skipIf(!hasDom)('the layout names the rev it read; a stale answer is dropped and the next frame lays it out again at once', async () => {
  layoutAnswer = 'stale';
  const now = 2_000_000;
  await layout.layOutPending(() => now);
  expect(layouts).toEqual([{ rev: 7, version: 2 }]);

  // The person's move landed (rev 8): the next frame lays it out again from there, with no wait.
  wireRev = 8;
  layoutAnswer = 'ok';
  await layout.layOutPending(() => now + 10);
  expect(layouts).toEqual([
    { rev: 7, version: 2 },
    { rev: 8, version: 2 },
  ]);
  expect(failures).toEqual([]);
});
