/**
 * A Shape board's explicit "go to the forge" links still go to the forge with click to pin on (`utils/refCardClick`).
 * ShapeSurface hooks ref cards on its whole root, so these links sit inside the hooked region.
 *
 * What regresses: a plain click on the References list's "Open" for a PR reference, or on the PR link in a stack
 * tag's card, that opens a pinned card instead of following the link.
 *
 * Run with DOM_TESTS=1.
 */
import React, { act, useRef } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { shapeParts, type ShapeBoard, type ShapeStack } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import { useRefHoverCards } from '../RefHoverCard';
import { setRefCardTransport } from '../../utils/refCard';
import { setRefCardClick } from '../../utils/refCardClick';
import { RefList, RefsCtx, type RefsState } from './refs';
import type { ShapeHost, ShapeLoaded } from './types';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const PR = 'https://github.com/acme/widgets/pull/11';
const ID = 'shp_explicit_links_test';

function answer(number: number): ForgeRefCardResult {
  return {
    ok: true,
    fetchedAt: 0,
    data: {
      platform: 'github',
      kind: 'pull',
      repo: 'acme/widgets',
      number,
      url: `https://github.com/acme/widgets/pull/${number}`,
      title: `Pull ${number}`,
      state: 'open',
      author: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      closedAt: null,
      labels: [],
      assignees: [],
      comments: 0,
      body: 'A picker for widgets.',
      bodyCut: false,
      lastComment: null,
      linked: [],
    },
  };
}

const STACK: ShapeStack = {
  pulls: [
    { n: 11, title: 'The picker', url: PR, step: 1 },
    { n: 12, title: 'The search', step: 2 },
  ],
  changes: [
    { part: 'how-a', pr: 11, said: 'Draws the picker.', files: [{ path: 'src/picker.ts', additions: 4 }] },
    { part: 'how-b', pr: 12, said: 'Adds search.', files: [{ path: 'src/search.ts', additions: 9 }] },
  ],
};

const BOARD: ShapeBoard = {
  title: 'Widgets',
  claim: 'Built.',
  views: { how: { html: '<div data-mark="how-a">The picker</div><div data-mark="how-b">The search</div>' } },
  stack: STACK,
};

function fakeHost(b: ShapeBoard): ShapeHost {
  const at = '2026-11-07T10:00:00.000Z';
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: b.title, project: { name: 'widgets', root: '/work/widgets' }, session: null, thread: null, state: 'active', created: at, updated: at, latest: 1, drawing: null },
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
    readFile: async () => null,
  };
}

/** The hooked region, as a host's: cards only with data. */
function Region({ children }: { children: React.ReactNode }) {
  const own = useRef<HTMLDivElement | null>(null);
  const card = useRefHoverCards(own, { delayMs: 20, onlyWithData: true });
  return (
    <div>
      <div ref={own} data-region="">
        {children}
      </div>
      {card}
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** Clicks that reached the window un-prevented: the link would have navigated. Each is prevented here, so nothing does. */
let followed: string[];
const onWindowClick = (e: Event) => {
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (a && !e.defaultPrevented) followed.push(a.href);
  e.preventDefault();
};

const wait = (ms = 20) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function mount(tree: React.ReactNode) {
  container = document.createElement('div');
  container.style.width = '1200px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(tree));
}

async function click(el: Element): Promise<{ followed: boolean }> {
  const before = followed.length;
  let now = false;
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    now = followed.length > before;
  });
  return { followed: now };
}

const pinned = () => document.querySelector('[data-ref-card-pinned]');

/** A plain click on `a` follows its link and pins no card. */
async function expectFollows(a: HTMLAnchorElement | null) {
  expect(a).not.toBeNull();
  expect(a!.href).toBe(PR);
  expect((await click(a!)).followed).toBe(true);
  await wait(10);
  expect(pinned()).toBeNull();
  expect(followed).toEqual([PR]);
}

function drawing(): ShadowRoot | null {
  for (const host of document.querySelectorAll('*')) if (host.shadowRoot?.querySelector('[data-mark="how-a"]')) return host.shadowRoot;
  return null;
}

let unbridge: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());

beforeEach(() => {
  if (!hasDom) return;
  followed = [];
  setRefCardTransport(async (href) => answer(Number(href.split('/').pop())));
  setRefCardClick(true);
  window.addEventListener('click', onWindowClick);
});

afterEach(async () => {
  if (!hasDom) return;
  window.removeEventListener('click', onWindowClick);
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  setRefCardTransport(null);
  setRefCardClick(false);
});

describe.if(hasDom)("a board's explicit forge links follow on a plain click, with click to pin on", () => {
  test('the References list\'s "Open" for a PR reference', async () => {
    const refs: RefsState = {
      refs: [{ n: 1, kind: 'pr', title: 'The picker', target: PR }],
      hover: null,
      flash: null,
      onHover: () => {},
      onOpen: () => {},
    };
    await mount(
      <Region>
        <RefsCtx.Provider value={refs}>
          <RefList onShow={() => {}} canOpen={() => true} />
        </RefsCtx.Provider>
      </Region>,
    );
    await expectFollows(container!.querySelector<HTMLAnchorElement>('[data-region] a.shp-ref-open'));
  });

  test("the PR link in a stack tag's card (ShapeSurface's own hooked root)", async () => {
    await mount(<ShapeSurface host={fakeHost(BOARD)} id={ID} initialView="how" stackBadges />);
    for (let i = 0; i < 50 && !drawing(); i++) await wait();
    if (!drawing()) throw new Error('board never drew');
    await wait();
    const tag = drawing()!.querySelector<HTMLButtonElement>('[data-shp-stack-part="how-a"] [data-shp-stack-pr="11"]')!;
    await act(async () => tag.click());
    await wait();
    const card = document.querySelector<HTMLElement>('[data-shp-stack-card]');
    expect(card?.getAttribute('data-shp-stack-card')).toBe('how-a#11');
    // Inside ShapeSurface's root, where its RefHoverCards listens.
    expect(card!.closest('.shp-root')).not.toBeNull();
    await expectFollows(card!.querySelector<HTMLAnchorElement>('a.shp-stk-prlink'));
  });
});
