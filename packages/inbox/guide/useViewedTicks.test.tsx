/**
 * A review's Viewed tick is never kept unconfirmed (useViewedTicks.ts): one whose save failed goes back at once; one
 * held for a machine that is away shows while it waits, goes back if it is refused there, and stays once delivered.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OutboxView } from '@plannotator/core/inbox-wire-models';

const hasDom = typeof document !== 'undefined';
const { useViewedTicks } = (hasDom ? await import('./useViewedTicks') : {}) as typeof import('./useViewedTicks');
const { InboxHeldError } = (hasDom ? await import('../api') : {}) as typeof import('../api');

const MESSAGE = 'msg_01K7REVIEW0000000000000001';
const FILE = 'src/routes.ts';
const KEY = 'key-1';

let root: Root | null = null;
let el: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
};

const entry = (state: OutboxView['state']): OutboxView =>
  ({ key: KEY, route: `messages/${MESSAGE}/guide/viewed`, state, queued_at: '2026-11-25T10:00:00.000Z', viewed: { path: FILE, viewed: true } }) as unknown as OutboxView;

let shown: string[] = [];
let toggle: (path: string) => void = () => {};
const errors: string[] = [];
function Pane({ outbox, save }: { outbox: ReadonlyMap<string, OutboxView>; save: (id: string, path: string, on: boolean) => Promise<{ viewed: string[] }> }) {
  ({ shown, toggle } = useViewedTicks(MESSAGE, [], outbox, (words) => errors.push(words), save));
  return null;
}

function mount(save: (id: string, path: string, on: boolean) => Promise<{ viewed: string[] }>) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  const draw = (outbox: ReadonlyMap<string, OutboxView>) => act(() => root!.render(<Pane outbox={outbox} save={save} />));
  draw(new Map());
  return draw;
}

test.skipIf(!hasDom)('a tick whose save failed goes back, and says why', async () => {
  errors.length = 0;
  mount(() => Promise.reject(new Error('Code review is off.')));
  act(() => toggle(FILE));
  await settle();
  expect(shown).toEqual([]);
  expect(errors).toEqual(['Code review is off.']);
});

test.skipIf(!hasDom)('a held tick shows while it waits and goes back when it is refused there', async () => {
  const draw = mount(() => Promise.reject(new InboxHeldError(entry('queued'), null)));
  act(() => toggle(FILE));
  draw(new Map([[KEY, entry('queued')]]));
  await settle();
  expect(shown).toEqual([FILE]);
  draw(new Map([[KEY, entry('refused')]]));
  await settle();
  expect(shown).toEqual([]);
});

test.skipIf(!hasDom)('a held tick delivered stays ticked', async () => {
  const draw = mount(() => Promise.reject(new InboxHeldError(entry('queued'), null)));
  act(() => toggle(FILE));
  draw(new Map([[KEY, entry('queued')]]));
  await settle();
  draw(new Map([[KEY, entry('delivered')]]));
  await settle();
  expect(shown).toEqual([FILE]);
});
