/**
 * Stack badges on a Shape board (approval "stack-show-me", addendum 2026-11-06: take C and the card).
 * DOM-gated: runs under DOM_TESTS=1 from tests/dom-test-list.txt.
 *
 * What regresses:
 *  - badges or the PR row on a board of one PR, or on a host that did not ask (`stackBadges`): Workspaces and every
 *    other board must stay as they were;
 *  - Follow an example dimming the whole badge layer, so the tags of the parts it lights fade with the rest;
 *  - a tag's card showing another PR's words, "Also changed here by" not switching it, or the file popup losing the
 *    way back to the card;
 *  - picking a PR in the row leaving its parts faded, or another PR's parts bright, or a second click not restoring;
 *  - "Read it in the review" opening the review anywhere but that PR's chapter, narrowed to the part's files.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeExampleStep, type ShapeStack } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeHost, ShapeLoaded, ShapeReviewAt, ShapeSurfaceReview } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_stack_test';

const HOW_HTML = '<div data-mark="how-a">Water heats</div><div data-mark="how-b"><b>It boils</b><p>and keeps boiling</p></div><div data-mark="how-off">Nobody hears</div>';

const STACK: ShapeStack = {
  pulls: [
    { n: 11, title: 'The water', url: 'https://github.com/acme/kettle/pull/11', step: 1 },
    { n: 12, title: 'The boil', step: 2 },
    { n: 13, title: 'The whistle', step: 3 },
  ],
  changes: [
    { part: 'how-a', pr: 11, said: 'Heats the water to 100.', files: [{ path: 'src/heat.ts', additions: 4 }] },
    { part: 'how-b', pr: 12, said: 'Lets it boil.', files: [{ path: 'src/boil.ts', additions: 9, deletions: 2 }, { path: 'src/pot.ts', additions: 1 }] },
    { part: 'how-b', pr: 13, said: 'Adds the whistle on top.', files: [{ path: 'src/whistle.ts', additions: 20 }] },
  ],
};

const step = (part: string): ShapeExampleStep => ({
  part,
  tag: `at ${part}`,
  text: `The kettle reaches ${part}`,
  inputs: [{ name: 'temp', value: '100', from: { path: 'src/kettle.ts', line: 3 } }],
  signature: 'heat(temp: number): boolean',
  checks: [{ code: 'temp >= BOIL', constant: '100', saw: '100', result: 'pass', decides: true }],
  output: { name: 'boiling', value: 'true', type: 'boolean' },
  code: { path: 'src/kettle.ts', line: 10 },
});

function board(stack?: ShapeStack, examples = false): ShapeBoard {
  return {
    title: 'Kettle',
    claim: 'Built.',
    views: {
      how: {
        html: HOW_HTML,
        ...(examples
          ? { examples: [{ name: 'It boils', title: 'You put the kettle on', steps: [step('how-a'), step('how-b')] }] }
          : {}),
      },
    },
    ...(stack ? { stack } : {}),
  };
}

function fakeHost(b: ShapeBoard): ShapeHost {
  const at = '2026-11-07T10:00:00.000Z';
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: b.title, project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: 'active', created: at, updated: at, latest: 1, drawing: null },
    version: { ...b, n: 1, at, base: null, through: null, by: null, parts: shapeParts(b) },
    seen: 1,
    notes: [],
    session: { state: 'live', agent: 'Claude Code' },
  };
  return {
    load: async () => data,
    version: async () => data.version,
    note: async () => {
      throw new Error('not in this test');
    },
    ask: async () => {
      throw new Error('not in this test');
    },
    seen: () => {},
    events: () => () => {},
    readFile: async () => 'export const BOIL = 100;\n',
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
  if (hasDom) document.body.innerHTML = '';
});

const wait = (ms = 20) => act(() => new Promise((r) => setTimeout(r, ms)));

function drawing(): ShadowRoot | null {
  for (const host of document.querySelectorAll('*')) if (host.shadowRoot?.querySelector('[data-mark="how-a"]')) return host.shadowRoot;
  return null;
}

async function mount(b: ShapeBoard, props: Partial<React.ComponentProps<typeof ShapeSurface>> = { stackBadges: true }) {
  const el = document.createElement('div');
  el.style.width = '1200px';
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={fakeHost(b)} id={ID} initialView="how" {...props} />));
  for (let i = 0; i < 50 && !drawing(); i++) await wait();
  if (!drawing()) throw new Error('board never drew');
  await wait();
}

const tags = () => [...(drawing()?.querySelectorAll<HTMLButtonElement>('.shp-stk-b') ?? [])];
const tag = (part: string, pr: number) => drawing()!.querySelector<HTMLButtonElement>(`[data-shp-stack-part="${part}"] [data-shp-stack-pr="${pr}"]`)!;
const card = () => document.querySelector<HTMLElement>('[data-shp-stack-card]');
async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await wait();
}

describe.if(hasDom)('Stack badges', () => {
  test('a stack shows a tag per PR on each part it changed, and the row; one PR or a host that did not ask shows none', async () => {
    await mount(board(STACK));
    expect(tags().map((t) => `${t.closest('[data-shp-stack-part]')!.getAttribute('data-shp-stack-part')}#${t.getAttribute('data-shp-stack-pr')}`)).toEqual(['how-a#11', 'how-b#12', 'how-b#13']);
    expect(tag('how-b', 12).getAttribute('data-c')).toBe('2');
    expect(tag('how-b', 12).getAttribute('aria-label')).toBe('Changed in #12: open its lines');
    expect(document.querySelector('[data-shp-stack-row]')?.textContent).toContain('Stack of 3');
    act(() => root!.unmount());
    document.body.innerHTML = '';

    await mount(board({ pulls: [STACK.pulls[0]!], changes: [STACK.changes[0]!] }));
    expect(tags()).toEqual([]);
    expect(document.querySelector('[data-shp-stack-row]')).toBeNull();
    act(() => root!.unmount());
    document.body.innerHTML = '';

    await mount(board(STACK), {});
    expect(tags()).toEqual([]);
    expect(document.querySelector('[data-shp-stack-row]')).toBeNull();
  });

  test("an example's dimming leaves the badge layer alone: a lit part's tags stay, a faded part's fade with it", async () => {
    const withOff: ShapeStack = { ...STACK, changes: [...STACK.changes, { part: 'how-off', pr: 11, said: 'Nobody.', files: [{ path: 'src/off.ts' }] }] };
    await mount(board(withOff, true));
    for (let i = 0; i < 50 && !document.querySelector('[data-follow]'); i++) await wait();
    await click([...document.querySelectorAll('button')].find((b) => [b.getAttribute('aria-label'), b.title, b.textContent?.trim()].includes('Follow an example')) ?? null);
    const d = drawing()!;
    expect(d.querySelector('[data-mark="how-off"]')!.hasAttribute('data-ex-dim')).toBe(true);
    const layer = d.querySelector('.shp-stk-layer')!;
    expect(layer.hasAttribute('data-ex-dim')).toBe(false);
    await wait(40);
    expect(d.querySelector('[data-shp-stack-part="how-a"]')!.classList.contains('dim')).toBe(false);
    expect(d.querySelector('[data-shp-stack-part="how-off"]')!.classList.contains('dim')).toBe(true);
  });

  test('a tag opens its card; "Also changed here by" switches it; a file opens with the way back', async () => {
    await mount(board(STACK));
    await click(tag('how-b', 13));
    expect(card()?.getAttribute('data-shp-stack-card')).toBe('how-b#13');
    expect(card()!.textContent).toContain('#13The whistle');
    expect(card()!.textContent).toContain('In It boils');
    expect(card()!.textContent).toContain('Adds the whistle on top.');
    expect(card()!.textContent).toContain('Also changed here by');
    expect(tag('how-b', 13).getAttribute('aria-expanded')).toBe('true');

    await click(card()!.querySelector('[data-shp-stack-switch="12"]'));
    expect(card()?.getAttribute('data-shp-stack-card')).toBe('how-b#12');
    expect(card()!.textContent).toContain('Lets it boil.');
    expect([...card()!.querySelectorAll('[data-shp-stack-file]')].map((r) => r.getAttribute('data-shp-stack-file'))).toEqual(['src/boil.ts', 'src/pot.ts']);
    expect(card()!.querySelector('[data-shp-stack-file="src/boil.ts"]')!.textContent).toContain('+9');

    await click(card()!.querySelector('[data-shp-stack-file="src/pot.ts"]'));
    for (let i = 0; i < 20 && !document.querySelector('[data-shp-stack-nav]'); i++) await wait();
    const nav = document.querySelector('[data-shp-stack-nav]')!;
    expect(nav.textContent).toContain('2 of 2 files');
    expect(card()).toBeNull();
    await click(nav.querySelector('.shp-stk-back'));
    expect(card()?.getAttribute('data-shp-stack-card')).toBe('how-b#12');

    // A second click on the open tag closes its card.
    await click(tag('how-b', 12));
    expect(card()).toBeNull();
  });

  test("picking a PR keeps its parts bright and fades the rest; a second click restores them", async () => {
    await mount(board(STACK));
    const pick = () => document.querySelector<HTMLButtonElement>('[data-shp-stack-pick="11"]')!;
    await click(pick());
    const d = drawing()!;
    expect(pick().getAttribute('aria-pressed')).toBe('true');
    expect(d.querySelector('[data-mark="how-a"]')!.classList.contains('shp-stk-out')).toBe(false);
    expect(d.querySelector('[data-mark="how-b"]')!.classList.contains('shp-stk-out')).toBe(true);
    expect(d.querySelector('[data-mark="how-off"]')!.classList.contains('shp-stk-out')).toBe(true);
    expect(tag('how-b', 12).classList.contains('off')).toBe(true);
    await click(pick());
    expect(d.querySelectorAll('.shp-stk-out').length).toBe(0);
    expect(tag('how-b', 12).classList.contains('off')).toBe(false);
  });

  test("Read it in the review opens that PR's chapter, narrowed to the part's files; with no review it is not offered", async () => {
    const opened: ShapeReviewAt[] = [];
    const review: ShapeSurfaceReview = { open: (at) => (opened.push(at), true) };
    await mount(board(STACK), { stackBadges: true, review });
    await click(tag('how-b', 12));
    await click(card()!.querySelector('[data-shp-stack-review]'));
    expect(opened).toEqual([{ step: 2, narrow: { part: 'It boils', pr: 12, title: 'The boil', colour: 2, files: ['src/boil.ts', 'src/pot.ts'] } }]);
    expect(card()).toBeNull();
    act(() => root!.unmount());
    document.body.innerHTML = '';

    await mount(board(STACK));
    await click(tag('how-a', 11));
    expect(card()!.querySelector('[data-shp-stack-review]')).toBeNull();
  });
});
