/**
 * A review's Viewed tick is never kept unconfirmed (useViewedTicks.ts): one whose save failed goes back at once; one
 * held for a machine that is away shows while it waits, goes back if it is refused there, and stays once delivered.
 * The kept list is taken whenever it changes (a reload, a second window); an older answer never undoes a newer tick;
 * an old review's answers never reach the next one.
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

/** Another window's (or this one's before a reload) held tick: only the outbox has it. */
const far = (key: string, path: string, on: boolean, state: OutboxView['state'], id = MESSAGE): OutboxView =>
  ({ key, route: `messages/${id}/guide/viewed`, state, queued_at: '2026-11-25T10:00:00.000Z', viewed: { path, viewed: on } }) as unknown as OutboxView;

type Save = (id: string, path: string, on: boolean) => Promise<{ viewed: string[] }>;
type Props = { id: string; kept: readonly string[]; outbox: ReadonlyMap<string, OutboxView>; save: Save };

let shown: string[] = [];
let toggle: (path: string) => void = () => {};
const errors: string[] = [];
function Pane({ id, kept, outbox, save }: Props) {
  ({ shown, toggle } = useViewedTicks(id, kept, outbox, (words) => errors.push(words), save));
  return null;
}

/** Draws the pane; `draw(outbox)` redraws with a new outbox, `draw.with({...})` with any new props. */
function mount(save: Save) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  let props: Props = { id: MESSAGE, kept: [], outbox: new Map(), save };
  const redraw = (next: Partial<Props>) => {
    props = { ...props, ...next };
    act(() => root!.render(<Pane {...props} />));
  };
  const draw = Object.assign((outbox: ReadonlyMap<string, OutboxView>) => redraw({ outbox }), { with: redraw });
  redraw({});
  return draw;
}

/** Each save waits until the test answers it. */
function answers() {
  const calls: { id: string; path: string; on: boolean; ok: (viewed: string[]) => Promise<void>; fail: (cause: unknown) => Promise<void> }[] = [];
  const save: Save = (id, path, on) =>
    new Promise((resolve, reject) => {
      calls.push({ id, path, on, ok: (viewed) => (resolve({ viewed }), settle()), fail: (cause) => (reject(cause), settle()) });
    });
  return { calls, save };
}

test.skipIf(!hasDom)('after a reload mid-hold, the tick stays once it is delivered, before and after the kept list catches up', async () => {
  const draw = mount(() => Promise.resolve({ viewed: [] }));
  draw(new Map([['far-1', far('far-1', FILE, true, 'queued')]]));
  await settle();
  expect(shown).toEqual([FILE]);
  draw(new Map([['far-1', far('far-1', FILE, true, 'delivered')]]));
  await settle();
  expect(shown).toEqual([FILE]);
  draw.with({ kept: [FILE] });
  await settle();
  expect(shown).toEqual([FILE]);
});

test.skipIf(!hasDom)("a second window shows another window's tick, and its untick, when the kept list changes", async () => {
  const draw = mount(() => Promise.resolve({ viewed: [] }));
  draw.with({ kept: [FILE] });
  await settle();
  expect(shown).toEqual([FILE]);
  draw.with({ kept: [] });
  await settle();
  expect(shown).toEqual([]);
});

test.skipIf(!hasDom)("an older tick's answer never undoes a newer toggle of the same file, in either order", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const { calls, save } = answers();
    mount(save);
    act(() => toggle(FILE));
    act(() => toggle(FILE));
    expect(calls.map((c) => c.on)).toEqual([true, false]);
    const said = [[FILE], []];
    await calls[order[0]!]!.ok(said[order[0]!]!);
    expect(shown).toEqual([]);
    await calls[order[1]!]!.ok(said[order[1]!]!);
    expect(shown).toEqual([]);
    act(() => root?.unmount());
  }
});

test.skipIf(!hasDom)("an older tick's answer never undoes a newer tick of another file", async () => {
  const { calls, save } = answers();
  mount(save);
  act(() => toggle('src/a.ts'));
  act(() => toggle('src/b.ts'));
  await calls[1]!.ok(['src/a.ts', 'src/b.ts']);
  await calls[0]!.ok(['src/a.ts']);
  expect([...shown].sort()).toEqual(['src/a.ts', 'src/b.ts']);
});

test.skipIf(!hasDom)("switching reviews mid-save: the old review's answer, failure or held refusal never touches the new one", async () => {
  errors.length = 0;
  const { calls, save } = answers();
  const draw = mount(save);
  act(() => toggle(FILE));
  act(() => toggle('src/held.ts'));
  act(() => toggle('src/fails.ts'));
  await calls[1]!.fail(new InboxHeldError(far('held-1', 'src/held.ts', true, 'queued'), null));
  draw.with({ id: 'msg_01K7REVIEW0000000000000002', kept: [FILE, 'src/held.ts', 'src/fails.ts'] });
  await calls[0]!.ok([]);
  await calls[2]!.fail(new Error('Code review is off.'));
  draw(new Map([['held-1', far('held-1', 'src/held.ts', true, 'refused')]]));
  await settle();
  expect(shown).toEqual([FILE, 'src/held.ts', 'src/fails.ts']);
  expect(errors).toEqual([]);
});

test.skipIf(!hasDom)('a held tick whose entry leaves the outbox unseen (the stream dropped while it delivered) follows the kept list after', async () => {
  const draw = mount(() => Promise.reject(new InboxHeldError(entry('queued'), null)));
  act(() => toggle(FILE));
  draw(new Map([[KEY, entry('queued')]]));
  await settle();
  expect(shown).toEqual([FILE]);
  draw(new Map());
  draw.with({ kept: [FILE] });
  await settle();
  expect(shown).toEqual([FILE]);
  draw.with({ kept: [] });
  await settle();
  expect(shown).toEqual([]);
});

test.skipIf(!hasDom)('a failed tick goes back to what the Inbox keeps now, with a change from elsewhere made meanwhile', async () => {
  errors.length = 0;
  const { calls, save } = answers();
  const draw = mount(save);
  act(() => toggle(FILE));
  draw.with({ kept: ['src/b.ts'] });
  await settle();
  expect([...shown].sort()).toEqual(['src/b.ts', FILE].sort());
  await calls[0]!.fail(new Error('Code review is off.'));
  expect(shown).toEqual(['src/b.ts']);
  expect(errors).toEqual(['Code review is off.']);
});

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
