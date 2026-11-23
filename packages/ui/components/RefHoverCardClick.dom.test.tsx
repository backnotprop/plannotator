/**
 * A click on an issue / PR link opens its card (the hover's card) and pins it, instead of going to the forge.
 *
 * What regresses: a plain click on a ref written in prose that still navigates (or a modified / middle click that no
 * longer does); a click on any other link (an "Open on GitHub" button, a comment's permalink) that stops navigating; a
 * click on a ref known to have no card that dead-ends; a pinned card that closes when the pointer leaves, that a hover
 * or focus elsewhere replaces, or that never closes (Escape, a press outside, a second click); a held Space or a
 * double-click that closes it; the ref telling a screen reader nothing; a host that did not turn click to pin on
 * getting it; a ref in the card's description that no longer opens its own card; the host's second link ("Open in
 * Reviews") shown with no host action, or missing with one, or kept after the host's list dropped it; the hover changed.
 *
 * Run with DOM_TESTS=1.
 */
import React, { act, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { ForgeRef, ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { useRefHoverCards } from './RefHoverCard';
import { setRefCardTransport } from '../utils/refCard';
import { refreshRefCardAction, setRefCardAction } from '../utils/refCardAction';
import { REF_CARD_PROSE_ATTR, refUrlIsWhole, setRefCardClick } from '../utils/refCardClick';

const hasDom = typeof document !== 'undefined';
const PR = 'https://github.com/acme/widgets/pull/12';
const OTHER = 'https://github.com/acme/widgets/pull/14';
const UNKNOWN = 'https://github.com/acme/widgets/issues/99';
const SIGNED_OUT = 'https://gitlab.example.com/g/p/-/issues/3';
const SIGNED_OUT_TOO = 'https://gitlab.example.com/g/p/-/merge_requests/4';
const PERMALINKS = [
  'https://github.com/acme/widgets/pull/12#discussion_r1234',
  'https://github.com/acme/widgets/pull/12/files',
  'https://github.com/acme/widgets/issues/5#issuecomment-99',
];
/** The prose renderer's mark (InlineMarkdown): only these links pin on a click. */
const prose = { [REF_CARD_PROSE_ATTR]: '' };

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
const SIGNED_OUT_ANSWER: ForgeRefCardResult = { ok: false, error: 'signed_out', fetchedAt: 0 } as ForgeRefCardResult;

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
          See <a href={PR} target="_blank" rel="noopener noreferrer" {...prose}>#12</a>, <a href={OTHER} target="_blank" rel="noopener noreferrer" {...prose}>#14</a>,{' '}
          <a href={UNKNOWN} target="_blank" rel="noopener noreferrer" {...prose}>#99</a>, <a href={SIGNED_OUT} {...prose}>g/p#3</a>,{' '}
          <a href={SIGNED_OUT_TOO} {...prose}>g/p!4</a> and <a href="https://example.com/x">a plain link</a>.
        </p>
        {PERMALINKS.map((href) => (
          <a key={href} href={href} target="_blank" rel="noopener noreferrer" {...prose}>
            {href}
          </a>
        ))}
        {/* An explicit "go to the forge" link, as code review's "Open PR ↗": no mark. */}
        <a href={PR} target="_blank" rel="noopener noreferrer" data-explicit="">
          Open PR ↗
        </a>
      </div>
      <button type="button" data-outside="">outside</button>
      {card}
    </div>
  );
}

/** A second region with its own controller (another message). */
function TwoRegions() {
  const first = useRef<HTMLDivElement | null>(null);
  const second = useRef<HTMLDivElement | null>(null);
  const a = useRefHoverCards(first, { delayMs: 20 });
  const b = useRefHoverCards(second, { delayMs: 20 });
  return (
    <div>
      <div ref={first} data-region="">
        <a href={PR} {...prose}>#12</a>
      </div>
      <div ref={second} data-second="">
        <a href={OTHER} {...prose}>#14</a>
      </div>
      {a}
      {b}
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

async function mount(onlyWithData = false, tree: React.ReactNode = <Region onlyWithData={onlyWithData} />) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(tree));
  return container;
}

const link = (href: string) => container!.querySelector<HTMLAnchorElement>(`[data-region] a[href="${href}"][${REF_CARD_PROSE_ATTR}]`)!;
const hover = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  });
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
    [PR, answer(12, `Stacked on ${OTHER} and [the other one](${OTHER}).`)],
    [OTHER, answer(14)],
    [UNKNOWN, NOT_FOUND],
    [SIGNED_OUT, SIGNED_OUT_ANSWER],
    [SIGNED_OUT_TOO, SIGNED_OUT_ANSWER],
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
  setRefCardClick(true);
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
  setRefCardClick(false);
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
    const inBody = () => [...card()!.querySelectorAll<HTMLElement>('[data-ref-card-href]')].find((el) => el.textContent === OTHER)!;
    await click(inBody(), { metaKey: true });
    expect(card()?.querySelector('[data-ref-card-confirm]')?.textContent).toContain(OTHER);
    // A labelled link is not a ref written in the text: it asks first, as every other link does.
    const labelled = [...card()!.querySelectorAll<HTMLElement>('[data-ref-card-href]')].find((el) => el.textContent === 'the other one')!;
    await click(labelled);
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
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

  test('a ref not asked yet: the loading card at once, its Open on GitHub the link; no card: the quiet failure, and the next click follows the link', async () => {
    await mount(true);
    holdAll = true;
    expect((await click(link(UNKNOWN))).followed).toBe(false);
    // Never a dead click: the card is there at once, its link a real one (no delayed programmatic click).
    expect(card()?.querySelector('[data-ref-card-loading]')).not.toBeNull();
    expect(card()?.querySelector<HTMLAnchorElement>('[data-ref-card-open]')?.href).toBe(UNKNOWN);
    await act(async () => held.get(UNKNOWN)?.(NOT_FOUND));
    await settle(10);
    expect(followed).toEqual([]);
    expect(card()?.querySelector('[data-ref-card-error]')).not.toBeNull();
    expect(card()?.querySelector<HTMLAnchorElement>('[data-ref-card-open]')?.href).toBe(UNKNOWN);
    // Now known to have none: the click is the link's, at once.
    expect((await click(link(UNKNOWN))).followed).toBe(true);
    expect(card()).toBeNull();
  });

  test('a press asks at once: a ref with no card answered by the click follows the link, no card drawn', async () => {
    await mount(true);
    await act(async () => {
      link(UNKNOWN).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
    });
    expect(asked).toEqual([UNKNOWN]);
    await settle();
    expect((await click(link(UNKNOWN))).followed).toBe(true);
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

describe.if(hasDom)('which links a click pins', () => {
  test('an explicit "go to the forge" link (no prose mark) follows on a plain click; its hover is unchanged', async () => {
    await mount();
    const explicit = container!.querySelector<HTMLAnchorElement>('[data-explicit]')!;
    expect((await click(explicit)).followed).toBe(true);
    await settle();
    expect(card()).toBeNull();
    await hover(explicit);
    await settle(60);
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(false);
  });

  test('a permalink to a comment or a tab of the PR follows on a plain click, as before', async () => {
    await mount();
    for (const href of PERMALINKS) {
      expect((await click(link(href))).followed).toBe(true);
      await settle();
      expect(card()).toBeNull();
    }
    expect(followed).toEqual(PERMALINKS);
  });

  test('refUrlIsWhole: the page itself, not a sub-path or a fragment', () => {
    expect(refUrlIsWhole(PR)).toBe(true);
    expect(refUrlIsWhole(`${PR}/`)).toBe(true);
    expect(refUrlIsWhole(`${PR}?notification_referrer_id=1`)).toBe(true);
    expect(refUrlIsWhole('https://gitlab.com/g/sub/p/-/merge_requests/7')).toBe(true);
    for (const href of [...PERMALINKS, 'https://gitlab.com/g/p/-/merge_requests/7/diffs', 'https://bitbucket.org/w/r/pull-requests/3/overview']) expect(refUrlIsWhole(href)).toBe(false);
  });

  test('a host that did not turn click to pin on: a plain click follows a ref as before (a tap still shows the sheet)', async () => {
    setRefCardClick(false);
    await mount();
    expect((await click(link(PR))).followed).toBe(true);
    await settle();
    expect(card()).toBeNull();
    // Space is the page's (it scrolls), as before.
    expect((await key(link(PR), ' ')).defaultPrevented).toBe(false);
    await act(async () => {
      link(PR).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    });
    expect((await click(link(PR))).followed).toBe(false);
    await settle();
    expect(card()?.hasAttribute('data-ref-card-sheet')).toBe(true);
  });
});

describe.if(hasDom)('a ref with no card follows its link', () => {
  test('a hover card that shows a failure: the click follows the link', async () => {
    await mount();
    await hover(link(UNKNOWN));
    await settle(60);
    expect(card()?.querySelector('[data-ref-card-error]')).not.toBeNull();
    expect((await click(link(UNKNOWN))).followed).toBe(true);
    expect(card()).toBeNull();
  });

  test('signed out of a host: another ref on that host follows at once, never asked', async () => {
    await mount();
    await click(link(SIGNED_OUT));
    await settle();
    expect(card()?.querySelector('[data-ref-card-error]')).not.toBeNull();
    await act(async () => {
      container!.querySelector('[data-outside]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    });
    asked = [];
    expect((await click(link(SIGNED_OUT_TOO))).followed).toBe(true);
    expect(card()).toBeNull();
    expect(asked).toEqual([]);
    // Another host is not affected.
    expect((await click(link(PR))).followed).toBe(false);
  });
});

describe.if(hasDom)('a pinned card stays pinned', () => {
  test('a hover or a focus on another ref opens nothing; a click there moves the pin', async () => {
    await mount();
    await click(link(PR));
    await settle();
    await hover(link(OTHER));
    await settle(60);
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
    await act(async () => {
      link(OTHER).dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
      link(PR).dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    });
    await settle(400);
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
    await click(link(OTHER));
    await settle();
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 14');
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
  });

  test("another region's hover does not replace it either", async () => {
    await mount(false, <TwoRegions />);
    await click(container!.querySelector(`[data-region] a[href="${PR}"]`)!);
    await settle();
    await hover(container!.querySelector(`[data-second] a[href="${OTHER}"]`)!);
    await settle(60);
    expect(document.querySelectorAll('[data-ref-card]').length).toBe(1);
    expect(card()?.querySelector('[data-ref-card-title]')?.textContent).toContain('Pull 12');
  });

  test('a held Space does not close it; a double-click leaves it open', async () => {
    await mount();
    const a = link(PR);
    a.focus();
    await key(a, ' ');
    await settle();
    expect(card()).not.toBeNull();
    const repeat = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ', repeat: true });
    await act(async () => {
      a.dispatchEvent(repeat);
    });
    expect(repeat.defaultPrevented).toBe(true);
    expect(card()).not.toBeNull();
    await key(a, 'Escape');
    expect(card()).toBeNull();
    await click(a, { detail: 1 });
    await click(a, { detail: 2 });
    await settle();
    expect(card()?.hasAttribute('data-ref-card-pinned')).toBe(true);
    expect(followed).toEqual([]);
  });
});

describe.if(hasDom)('a screen reader', () => {
  test('the ref says it opens a dialog, expanded while it is open, and names it', async () => {
    await mount();
    const a = link(PR);
    // The renderer sets the first two (InlineMarkdown); the controller keeps them true to the card.
    a.setAttribute('aria-haspopup', 'dialog');
    a.setAttribute('aria-expanded', 'false');
    await click(a);
    await settle();
    expect(a.getAttribute('aria-expanded')).toBe('true');
    expect(a.getAttribute('aria-controls')).toBe(card()!.id);
    expect(card()!.getAttribute('aria-label')).toContain('Pull 12');
    await click(a);
    expect(a.getAttribute('aria-expanded')).toBe('false');
    expect(a.hasAttribute('aria-controls')).toBe(false);
  });

  test('a pin by the keyboard moves the focus into the card; Escape gives it back to the ref', async () => {
    holdAll = true;
    await mount();
    const a = link(PR);
    a.focus();
    await click(a, { detail: 0 });
    await settle();
    expect(card()!.contains(document.activeElement)).toBe(true);
    // The answer redraws the card: the focus stays in it.
    await act(async () => held.get(PR)?.(answers.get(PR) ?? null));
    await settle();
    expect(card()?.querySelector('[data-ref-card-title]')).not.toBeNull();
    expect(card()!.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, 'Escape');
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(a);
  });

  test('a pin by the pointer leaves the focus where it was', async () => {
    await mount();
    await click(link(PR));
    await settle();
    expect(card()!.contains(document.activeElement)).toBe(false);
  });
});

describe.if(hasDom)("the host's link is asked when it is followed", () => {
  test('a PR the host stops listing loses its link; one gone between draw and press opens the forge instead', async () => {
    let listed = true;
    const opened: string[] = [];
    setRefCardAction((ref) => (listed && ref.number === 12 ? { label: 'Open in Reviews', open: () => opened.push('reviews') } : null));
    await mount();
    await click(link(PR));
    await settle();
    expect(card()?.querySelector('[data-ref-card-action]')).not.toBeNull();
    // Gone from the list, and the host said so: the link goes.
    listed = false;
    await act(async () => refreshRefCardAction());
    expect(card()?.querySelector('[data-ref-card-action]')).toBeNull();
    listed = true;
    await act(async () => refreshRefCardAction());
    const action = card()!.querySelector<HTMLButtonElement>('[data-ref-card-action]')!;
    // Gone again, and the host has not said so yet: the press opens the forge's page, never nothing.
    listed = false;
    const windowOpen = window.open;
    const tabs: string[] = [];
    window.open = ((url?: string | URL) => {
      tabs.push(String(url));
      return null;
    }) as typeof window.open;
    try {
      await act(async () => action.click());
    } finally {
      window.open = windowOpen;
    }
    expect(opened).toEqual([]);
    expect(tabs).toEqual([PR]);
    expect(card()).toBeNull();
  });
});
