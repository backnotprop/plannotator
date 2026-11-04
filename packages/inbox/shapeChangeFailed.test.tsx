/**
 * A Change it the host did not take (a Shapes server that restarted and keeps refusing, Shape turned off, a server
 * that is gone) must not swallow the person's words: the same box opens again with them and says why. What
 * regresses: the box closing on submit and the text vanishing with no message.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShapeStore } from '../shared/shape/store';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import type { ShapeNote } from '@plannotator/core/shape';

const hasDom = typeof document !== 'undefined';
const surface = (hasDom ? await import('@plannotator/ui/components/shape/ShapeSurface') : {}) as typeof import('@plannotator/ui/components/shape/ShapeSurface');

let root: Root | null = null;
const dirs: string[] = [];
const restore: Array<() => void> = [];
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const undo of restore.splice(0)) undo();
  document.body.innerHTML = '';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function board(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-change-failed-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="k">One whistle</p>' } } }, project: { root: dir, name: 'relay' }, session: { id: 'ses_a', host: 'claude-code' } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'live', agent: 'Claude Code' } };
}

const wait = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
};

/** The board, desktop-wide (happy-dom lays nothing out, so every width reads 0, a phone's). */
async function mount(note: ShapeHost['note']): Promise<HTMLElement> {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
  restore.push(() => (width ? Object.defineProperty(HTMLElement.prototype, 'clientWidth', width) : delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth));
  const loaded = board();
  const host: ShapeHost = {
    load: async () => loaded,
    version: async () => loaded.version,
    note,
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<surface.ShapeSurface host={host} id={loaded.shape.id} />));
  await wait(() => !!globalComment(el));
  return el;
}

const globalComment = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>('.shp-head-side button')].find((b) => b.textContent?.trim() === 'Global comment') ?? null;

/** Open the board's global comment, type, and press Change it. */
async function changeIt(el: HTMLElement, words: string) {
  act(() => globalComment(el)!.click());
  await wait(() => !!document.querySelector('[data-comment-popover] textarea'));
  const box = document.querySelector('[data-comment-popover] textarea') as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(box, words);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = [...document.querySelectorAll('[data-comment-popover] button')].find((b) => b.textContent?.trim() === 'Change it') as HTMLButtonElement;
  await act(async () => submit.click());
}

test.skipIf(!hasDom)('a Change it the host refused: the box opens again with the words and an alert', async () => {
  const el = await mount(async () => { throw new Error('HTTP 409'); });
  await changeIt(el, 'Two whistles');
  await wait(() => !!document.querySelector('[data-comment-popover-error]'));
  const alert = document.querySelector('[data-comment-popover-error]')!;
  expect(alert.getAttribute('role')).toBe('alert');
  expect(alert.textContent).toBe(surface.SHAPE_CHANGE_NOT_SENT);
  expect((document.querySelector('[data-comment-popover] textarea') as HTMLTextAreaElement).value).toBe('Two whistles');
});

test.skipIf(!hasDom)('a Change it the host took: the box closes, with no alert', async () => {
  const sent: string[] = [];
  const el = await mount(async (_id, input) => {
    sent.push(input.text);
    return { id: 'shn_1', kind: 'change', v: 1, text: input.text, from: 'you', at: new Date().toISOString(), view: null, part: null, quote: null } as unknown as ShapeNote;
  });
  await changeIt(el, 'Two whistles');
  await wait(() => sent.length > 0 && !document.querySelector('[data-comment-popover]'));
  expect(sent).toEqual(['Two whistles']);
  expect(document.querySelector('[data-comment-popover]')).toBeNull();
  expect(document.querySelector('[data-comment-popover-error]')).toBeNull();
});
