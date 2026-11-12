/**
 * What regresses: a part holding a reference bubble ("7") quoting the bubble's number glued to
 * its words ("One whistle7").
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeNote, type ShapeNoteInput } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_quote_test';
const BOARD: ShapeBoard = {
  title: 'Kettle',
  claim: 'Built.',
  views: { picture: { html: '<p data-mark="whistle">One whistle<span data-ref="7"></span></p>' } },
  refs: [{ n: 7, kind: 'link', title: 'The whistle spec', target: 'https://example.com/whistle' }],
};

function fakeHost(sent: ShapeNoteInput[]): ShapeHost {
  const at = '2026-11-04T10:00:00.000Z';
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: BOARD.title, project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: 'active', created: at, updated: at, latest: 1, drawing: null },
    version: { ...BOARD, n: 1, at, base: null, through: null, by: null, parts: shapeParts(BOARD) },
    seen: 1,
    notes: [],
    session: { state: 'live', agent: 'Claude Code' },
  };
  return {
    load: async () => data,
    version: async () => data.version,
    note: async (_id, input) => {
      sent.push(input);
      return { id: `n${sent.length}`, at, v: 1, view: input.view, part: input.part, quote: input.quote, kind: 'change', text: input.text, from: 'you', re: null, delivered: null } as ShapeNote;
    },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
}

let root: Root | null = null;
let unbridge: (() => void) | null = null;

// happy-dom cannot host DOMPurify as it stands; without the bridge the drawing comes out empty.
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

function mark(id: string): HTMLElement | null {
  for (const host of document.querySelectorAll('*')) {
    const found = host.shadowRoot?.querySelector<HTMLElement>(`[data-mark="${id}"]`);
    if (found) return found;
  }
  return null;
}

describe.if(hasDom)('Shape comment popover quote', () => {
  test("a part's quote leaves out its reference bubble's number", async () => {
    const sent: ShapeNoteInput[] = [];
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => root!.render(<ShapeSurface host={fakeHost(sent)} id={ID} />));
    for (let i = 0; i < 50 && !mark('whistle')?.querySelector('.shp-rb'); i++) await wait();
    const part = mark('whistle');
    expect(part?.querySelector('.shp-rb')?.textContent).toBe('7');

    await act(async () => { part!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });
    const popover = document.querySelector<HTMLElement>('[data-comment-popover]');
    expect(popover?.textContent).toContain('“One whistle”');

    const box = popover!.querySelector<HTMLTextAreaElement>('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(box, 'louder');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    });
    await wait();
    expect(sent.map((n) => [n.part, n.quote])).toEqual([['whistle', 'One whistle']]);
    expect(mark('whistle')?.querySelector<HTMLElement>('.shp-rb')?.style.display).toBe('');
  });
});
