/**
 * A click on an issue / PR link opens its card (the hover's card) and pins it, instead of going to the forge.
 *
 * What regresses: a plain click that still navigates (or a modified / middle click that no longer does); a pinned
 * card that closes when the pointer leaves, or never closes (Escape, a press outside, a second click); a click in
 * plan review / annotate / code review (`onlyWithData`) that dead-ends when there is no card to show; a ref in the
 * card's description that no longer opens its own card; the host's second link ("Open in Reviews") shown with no host
 * action, or missing with one; the hover changed.
 *
 * Run with DOM_TESTS=1.
 */
import React, { act, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { ForgeRef, ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { useRefHoverCards } from './RefHoverCard';
import { setRefCardTransport } from '../utils/refCard';
import { setRefCardAction } from '../utils/refCardAction';

const hasDom = typeof document !== 'undefined';
const PR = 'https://github.com/acme/widgets/pull/12';
const OTHER = 'https://github.com/acme/widgets/pull/14';
const UNKNOWN = 'https://github.com/acme/widgets/issues/99';

function answer(number: number, body = 'A picker for widgets.'): ForgeRefCardResult {
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
      body,
      bodyCut: false,
      lastComment: null,
      linked: [],
    },
  };
}

const NOT_FOUND: ForgeRefCardResult = { ok: false, error: 'not_found', fetchedAt: 0 } as ForgeRefCardResult;

/** The transport's answers by href; `held` hrefs wait until released. */
let answers: Map<string, ForgeRefCardResult | null>;
let asked: string[];
let held: Map<string, (r: ForgeRefCardResult | null) => void>;
let holdAll = false;

function Region({ onlyWithData }: { onlyWithData?: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const card = useRefHoverCards(root, { delayMs: 20, onlyWithData });
  return (
    <div>
      <div ref={root} data-region="">
        <p>
          See <a href={PR} target="_blank" rel="noopener noreferrer">#12</a>, <a href={UNKNOWN} target="_blank" rel="noopener noreferrer">#99</a> and{' '}
          <a href="https://example.com/x">a plain link</a>.
        </p>
      </div>
      <button type="button" data-outside="">outside</button>
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

const settle = (ms = 0) => act(async () => {
  await new Promise((r) => setTimeout(r, ms));
});

async function mount(onlyWithData = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<Region onlyWithData={onlyWithData} />));
  return container;
}

const link = (href: string) => container!.querySelector<HTMLAnchorElement>(`[data-region] a[href="${href}"]`)!;
const card = () => document.querySelector<HTMLElement>('[data-ref-card]');

/** A click; `followed`: it reached the window un-prevented, so the link would have opened. */
async function click(el: Element, init: MouseEventInit = {}): Promise<{ followed: boolean }> {
  const before = followed.length;
  let now = false;
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, ...init }));
    now = followed.length > before;
  });
  return { followed: now };
}

async function key(el: Element, k: string) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  if (!hasDom) return;
  answers = new Map([
    [PR, answer(12, `Stacked on [#14](${OTHER}).`)],
    [OTHER, answer(14)],
    [UNKNOWN, NOT_FOUND],
  ]);
  asked = [];
  held = new Map();
  holdAll = false;
  followed = [];
  setRefCardTransport(async (href) => {
    asked.push(href);
    if (holdAll) return new Promise((resolve) => held.set(href, resolve));
    return answers.get(href) ?? null;
  });
  setRefCardAction(null);
  window.addEventListener('click', onWindowClick);
});

afterEach(() => {
  if (!hasDom) return;
  window.removeEventListener('click', onWindowClick);
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  setRefCardTransport(null);
  setRefCardAction(null);
});

describe.if(hasDom)('a click on a ref link opens its card', () => {
  test('a plain click pins the card instead of following the link; a second click closes it', async () => {
    await mount();
    const a = link(PR);
    expect((await click(a)).followed).toBe(false);
    await settle();
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
    // A pinned card stays when the pointer leaves the link and the card.
    await act(async () => {
      a.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(400);
    expect(card()).not.toBeNull();
    await click(a);
    expect(card()).toBeNull();
    expect(followed).toEqual([]);
  });

  test('while its answer is on its way, the click shows the loading card (the Inbox), then the answer', async () => {
    holdAll = true;
    await mount();
    await click(link(PR));
    expect(card()?.querySelector('[data-ref-card-loading]')).not.toBeNull();
    await act(async () => held.get(PR)?.(answers.get(PR) ?? null));
    await settle();
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
  });

  for (const [name, init] of [
    ['Cmd-click', { metaKey: true }],
    ['Ctrl-click', { ctrlKey: true }],
    ['Shift-click', { shiftKey: true }],
    ['a middle click', { button: 1 }],
  ] as const) {
    test(`${name} still follows the link, with no card`, async () => {
      await mount();
      expect((await click(link(PR), init)).followed).toBe(true);
      expect(followed).toEqual([PR]);
      await settle();
      expect(card()).toBeNull();
      expect(asked).toEqual([]);
    });
  }

  test('Escape closes it and gives the focus back to the link; a press outside closes it too', async () => {
    await mount();
    const a = link(PR);
    await click(a);
    await settle();
    expect(card()).not.toBeNull();
    await key(a, 'Escape');
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(a);
    await click(a);
    await settle();
    expect(card()).not.toBeNull();
    await act(async () => {
      container!.querySelector('[data-outside]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    });
    expect(card()).toBeNull();
  });

  test('Enter (a click with no pointer) and Space on the focused link pin it the same way', async () => {
    await mount();
    const a = link(PR);
    a.focus();
    await click(a, { detail: 0 });
    await settle();
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
    expect(card()?.hasAttribute('data-ref-card-sheet')).toBe(false);
    await key(a, 'Escape');
    const space = await key(a, ' ');
    expect(space.defaultPrevented).toBe(true);
    await settle();
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
  });

  test('a tap on a touch screen shows the card as the sheet and does not follow the link', async () => {
    await mount();
    const a = link(PR);
    await act(async () => {
      a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    });
    expect((await click(a)).followed).toBe(false);
    await settle();
    expect(card()?.hasAttribute('data-ref-card-sheet')).toBe(true);
    expect(followed).toEqual([]);
  });

  test('the hover is unchanged: it opens after the delay, unpinned, and closes when the pointer leaves', async () => {
    await mount();
    const a = link(PR);
    await act(async () => {
      a.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(60);
    expect(card()).not.toBeNull();
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(false);
    await act(async () => {
      a.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(400);
    expect(card()).toBeNull();
  });

  test('a click on a hovered link pins the card it shows', async () => {
    await mount();
    const a = link(PR);
    await act(async () => {
      a.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(60);
    await click(a);
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
    expect(followed).toEqual([]);
  });

  test("a ref in the card's description opens its own card in place; a modified click on it only asks", async () => {
    await mount();
    await click(link(PR));
    await settle();
    const inBody = () => [...card()!.querySelectorAll<HTMLElement>('[data-ref-card-href]')].find((el) => el.textContent === '#14')!;
    await click(inBody(), { metaKey: true });
    expect(card()?.querySelector('[data-ref-card-confirm]')?.textContent).toContain(OTHER);
    await click(inBody());
    await settle();
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 14');
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
    expect(followed).toEqual([]);
  });

  test("the host's link shows only when the host gives one, left of Open on GitHub, and following it closes the card", async () => {
    await mount();
    await click(link(PR));
    await settle();
    expect(card()?.querySelector('[data-ref-card-action]')).toBeNull();
    await click(link(PR));

    const opened: number[] = [];
    const seen: ForgeRef[] = [];
    setRefCardAction((ref) => {
      seen.push(ref);
      return ref.number === 12 ? { label: 'Open in Reviews', open: () => opened.push(ref.number) } : null;
    });
    await click(link(PR));
    await settle();
    const action = card()!.querySelector<HTMLButtonElement>('[data-ref-card-action]')!;
    expect(action.textContent).toBe('Open in Reviews');
    // One row, the host's link right before the forge's.
    expect(action.nextElementSibling?.hasAttribute('data-ref-card-open')).toBe(true);
    await act(async () => action.click());
    expect(opened).toEqual([12]);
    expect(card()).toBeNull();

    // A ref the host has nothing for: the forge's link alone.
    await click(link(UNKNOWN));
    await settle();
    expect(card()?.querySelector('[data-ref-card-open]')).not.toBeNull();
    expect(card()?.querySelector('[data-ref-card-action]')).toBeNull();
    expect(seen.some((r) => r.number === 99)).toBe(true);
  });

  test('a link that is no ref is left alone', async () => {
    await mount();
    expect((await click(container!.querySelector('a[href="https://example.com/x"]')!)).followed).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe.if(hasDom)('a click where cards show only with data (plan review, annotate, code review)', () => {
  test('a ref known to have no card follows the link at once, as before', async () => {
    await mount(true);
    // A hover asked; the forge does not know it.
    await act(async () => {
      link(UNKNOWN).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(60);
    expect(card()).toBeNull();
    expect((await click(link(UNKNOWN))).followed).toBe(true);
    expect(card()).toBeNull();
  });

  test('a ref not asked yet: a quick "no card" answer follows the link, with no card drawn', async () => {
    await mount(true);
    expect((await click(link(UNKNOWN))).followed).toBe(false);
    await settle(10);
    expect(followed).toEqual([UNKNOWN]);
    expect(card()).toBeNull();
  });

  test('a ref not asked yet with a card: it opens pinned', async () => {
    await mount(true);
    await click(link(PR));
    await settle(10);
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
    expect(followed).toEqual([]);
  });

  test('a slow answer shows the loading card meanwhile, and a card once it comes', async () => {
    holdAll = true;
    await mount(true);
    await click(link(PR));
    expect(card()).toBeNull();
    await settle(200);
    expect(card()?.querySelector('[data-ref-card-loading]')).not.toBeNull();
    await act(async () => held.get(PR)?.(answers.get(PR) ?? null));
    await settle();
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
  });

  test('a known card opens at once on a click', async () => {
    await mount(true);
    await act(async () => {
      link(PR).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(60);
    await act(async () => {
      link(PR).dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(400);
    expect(card()).toBeNull();
    await click(link(PR));
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
  });
});
