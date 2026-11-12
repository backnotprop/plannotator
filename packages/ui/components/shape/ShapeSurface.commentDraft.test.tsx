import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeNote, type ShapeNoteInput } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_draft_test';
const BOARD: ShapeBoard = {
  title: 'Kettle',
  claim: 'Built.',
  views: { picture: { html: '<p data-mark="whistle">One whistle</p><p data-mark="lid">A loose lid</p>' } },
};

function loaded(): ShapeLoaded {
  const at = '2026-11-04T10:00:00.000Z';
  return {
    shape: {
      v: 1,
      id: ID,
      title: BOARD.title,
      project: { name: 'app', root: '/work/app' },
      session: null,
      thread: null,
      state: 'active',
      created: at,
      updated: at,
      latest: 1,
      drawing: null,
    },
    version: { ...BOARD, n: 1, at, base: null, through: null, by: null, parts: shapeParts(BOARD) },
    seen: 1,
    notes: [],
    session: { state: 'live', agent: 'Claude Code' },
  };
}

function fakeHost(sent: ShapeNoteInput[]): ShapeHost {
  const data = loaded();
  return {
    load: async () => data,
    version: async () => data.version,
    note: async (_id, input) => {
      sent.push(input);
      return { id: `n${sent.length}`, at: data.version.at, v: 1, view: input.view, part: input.part, quote: input.quote, kind: 'change', text: input.text, from: 'you', re: null, delivered: null } as ShapeNote;
    },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
}

let root: Root | null = null;
let unbridge: (() => void) | null = null;

beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const wait = () => act(() => new Promise((r) => setTimeout(r, 20)));

async function mount(host: ShapeHost): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host} id={ID} />));
  for (let i = 0; i < 50 && !mark('whistle'); i++) await wait();
  if (!mark('whistle')) throw new Error('board never drew');
  return el;
}

function mark(id: string): HTMLElement | null {
  for (const host of document.querySelectorAll('*')) {
    const found = host.shadowRoot?.querySelector<HTMLElement>(`[data-mark="${id}"]`);
    if (found) return found;
  }
  return null;
}

function textarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
}

async function pick(id: string): Promise<HTMLTextAreaElement> {
  await act(async () => { mark(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });
  const el = textarea();
  if (!el) throw new Error(`no composer for ${id}`);
  return el;
}

async function openWholeBoard(root: HTMLElement): Promise<HTMLTextAreaElement> {
  const button = root.querySelector<HTMLButtonElement>('button[title="Add global comment"]');
  if (!button) throw new Error('Global comment button missing');
  await act(async () => { button.click(); });
  const el = textarea();
  if (!el) throw new Error('no whole-board composer');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

describe.if(hasDom)('Shape board composer drafts', () => {
  test('a part keeps its words through Escape, per part; Change it clears them', async () => {
    const sent: ShapeNoteInput[] = [];
    await mount(fakeHost(sent));

    await type(await pick('whistle'), 'two whistles, not one');
    await press(textarea()!, 'Escape');
    expect(textarea()).toBeNull();

    const other = await pick('lid');
    expect(other.value).toBe('');
    await press(other, 'Escape');

    const back = await pick('whistle');
    expect(back.value).toBe('two whistles, not one');

    await press(back, 'Enter', { metaKey: true });
    await wait();
    expect(sent.map((n) => [n.part, n.text])).toEqual([['whistle', 'two whistles, not one']]);
    expect((await pick('whistle')).value).toBe('');
  });

  test('the whole board keeps its words through Escape', async () => {
    const root = await mount(fakeHost([]));

    await type(await openWholeBoard(root), 'make it smaller');
    await press(textarea()!, 'Escape');
    expect(textarea()).toBeNull();

    expect((await openWholeBoard(root)).value).toBe('make it smaller');
  });
});
