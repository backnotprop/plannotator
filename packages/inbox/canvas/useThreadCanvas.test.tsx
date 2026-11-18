/**
 * The person's strokes survive the canvas changing elsewhere mid-edit (useThreadCanvas.ts, review H1). What
 * regresses: a stale save throws the person's change away and the open canvas is handed the server's scene over
 * their strokes; a read is fetched while a save is on its way; the open canvas is given a new scene while a stroke is
 * still going on.
 *
 * The server is stood in for (canvasApi): it refuses a save whose base is not its rev, as the store does (409
 * `stale_base`). Real timers: the save delay is the hook's own.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom).
 */
import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanvasElement } from '@plannotator/core/canvas-scene';

const hasDom = typeof document !== 'undefined';

const el = (id: string, version: number, part?: string): CanvasElement => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: version * 13, ...(part ? { customData: { part } } : {}) });
const stamp = (elements: readonly CanvasElement[] | undefined) => (elements ?? []).map((e) => `${e.id}@${e.version}`);

// The server, as the store keeps it.
let server = { rev: 1, elements: [] as CanvasElement[] };
let reads = 0;
const saves: { base: number; elements: CanvasElement[] }[] = [];

const wireOf = () => ({
  id: 't1',
  rev: server.rev,
  version: 1,
  agent_version: 1,
  board: '<div></div>',
  pins: {},
  deleted: [],
  scene: { elements: server.elements, files: {} },
  layout: null,
  versions: [],
  marks: [],
  picture: false,
});

type Hook = typeof import('./useThreadCanvas').useThreadCanvas;
let useThreadCanvas: Hook;
let canvasFrameArrived: typeof import('./frames').canvasFrameArrived;
let InboxApiError: typeof import('../apiError').InboxApiError;

beforeAll(async () => {
  if (!hasDom) return;
  ({ InboxApiError } = await import('../apiError'));
  mock.module('./client', () => ({
    canvasApi: {
      read: async () => {
        reads++;
        return structuredClone(wireOf());
      },
      save: async (_id: string, body: { base: number; elements: CanvasElement[] }) => {
        saves.push({ base: body.base, elements: structuredClone(body.elements) });
        if (body.base !== server.rev) throw new InboxApiError(409, 'stale_base', 'stale');
        server = { rev: server.rev + 1, elements: structuredClone(body.elements) };
        return { rev: server.rev, version: 2, deleted: [], marks: [] };
      },
      fileUrl: (_id: string, name: string) => name,
    },
  }));
  mock.module('./layout', () => ({ changedPartIds: () => [], keepCanvasPicture: async () => true, layOutPending: async () => {} }));
  ({ useThreadCanvas } = await import('./useThreadCanvas'));
  ({ canvasFrameArrived } = await import('./frames'));
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

let latest: ReturnType<Hook> | null = null;

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  function Probe() {
    latest = useThreadCanvas('t1', true);
    // The canvas's box, where the person's pointer goes down (activity.ts listens for it).
    return createElement('div', { className: 'pn-canvas', 'data-testid': 'canvas' });
  }
  act(() => root!.render(createElement(Probe)));
}

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const press = (type: 'pointerdown' | 'pointerup') => {
  const target = type === 'pointerdown' ? document.querySelector('[data-testid=canvas]')! : window;
  act(() => {
    target.dispatchEvent(new Event(type, { bubbles: true }));
  });
};

test.skipIf(!hasDom)('an agent patch that lands mid-stroke keeps the person’s stroke, saves it on the new scene, and reaches the open canvas only once the stroke ends', async () => {
  server = { rev: 1, elements: [el('a', 1, 'a')] };
  reads = 0;
  saves.length = 0;
  mount();
  await until(() => !!latest?.wire);
  const firstKey = latest!.sceneKey;
  expect(stamp(latest!.wire!.scene?.elements)).toEqual(['a@1']);

  // The person starts a stroke and draws.
  press('pointerdown');
  act(() => latest!.save({ elements: [el('a', 1, 'a'), el('ink', 1)], files: {}, uploads: {} }));

  // Meanwhile the agent's patch lands: part a changes, part b is new. Its frame arrives while the save waits.
  server = { rev: 2, elements: [el('a', 2, 'a'), el('b', 1, 'b')] };
  const readsBefore = reads;
  act(() => canvasFrameArrived(['t1']));
  expect(reads).toBe(readsBefore);

  // The stale save is refused, the canvas read again, and the stroke saved again on top of the agent's patch.
  await until(() => saves.length >= 2);
  expect(saves[0]).toMatchObject({ base: 1 });
  expect(saves[1]!.base).toBe(2);
  expect(stamp(saves[1]!.elements)).toEqual(['a@2', 'b@1', 'ink@1']);
  expect(server.rev).toBe(3);

  // The stroke goes on: still the person's, still not replaced.
  act(() => latest!.save({ elements: [el('a', 1, 'a'), el('ink', 2)], files: {}, uploads: {} }));
  await until(() => saves.length >= 3);
  expect(saves[2]!.base).toBe(3);
  expect(stamp(saves[2]!.elements)).toEqual(['a@2', 'b@1', 'ink@2']);
  // Pointer still down: the open canvas keeps what it has.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 700));
  });
  expect(latest!.sceneKey).toBe(firstKey);

  // The stroke ends: once idle, the open canvas is given the agent's patch with the stroke on it.
  press('pointerup');
  await until(() => latest!.sceneKey !== firstKey);
  expect(stamp(latest!.wire!.scene?.elements)).toEqual(['a@2', 'b@1', 'ink@2']);
  expect(saves.length).toBe(3);
});

test.skipIf(!hasDom)('a canvas changed elsewhere while the person is idle updates the open canvas at once, and a read is not fetched while a save waits', async () => {
  server = { rev: 1, elements: [el('a', 1, 'a')] };
  reads = 0;
  saves.length = 0;
  mount();
  await until(() => !!latest?.wire);
  const firstKey = latest!.sceneKey;

  server = { rev: 2, elements: [el('a', 3, 'a')] };
  act(() => canvasFrameArrived(['t1']));
  await until(() => latest!.sceneKey !== firstKey);
  expect(stamp(latest!.wire!.scene?.elements)).toEqual(['a@3']);

  // A save waiting: the frame is held, and read once the save lands.
  act(() => latest!.save({ elements: [el('a', 3, 'a'), el('ink', 1)], files: {}, uploads: {} }));
  const readsBefore = reads;
  act(() => canvasFrameArrived(['t1']));
  expect(reads).toBe(readsBefore);
  await until(() => saves.length === 1 && reads === readsBefore + 1);
  expect(saves[0]!.base).toBe(2);
});
