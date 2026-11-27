/**
 * The Search tip in the palette (search/searchTip.ts). What regresses: it shown twice on one page (a reopen, a
 * remount); it shown with no claim; it drawn after the palette's first paint (it then pushes rows down under a
 * finger), or drawn by a change while the palette is open; it taken away after a refused or a lost claim (the rows
 * jump back); this page holding back the other one-time things though the Inbox refused it; a pointer press on Got it
 * taking focus from the box, or a keyboard Got it not sending it back; Got it, Escape or a typed quote not taking it
 * away; the first Escape closing the palette under it; it shown while another one-time dialog showed on this load, or
 * when the window withholds it; under the box, placed against a closed dialog, or the results list not giving up its
 * height (the palette then runs past the window's bottom); its side either side of the breakpoint.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { default: SearchPalette } = (hasDom ? await import('./search/SearchPalette') : {}) as typeof import('./search/SearchPalette');
const tipModule = (hasDom ? await import('./search/searchTip') : {}) as typeof import('./search/searchTip');
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: { leaveMs: number };
let savedRevealTimes: typeof reveal.REVEAL_TIMES;
let savedRect: typeof Element.prototype.getBoundingClientRect;
let claims: string[] = [];
/** The Inbox's answer to a claim: yes, no, a lost answer (the request fails), or held until `answerClaim` runs. */
let claimAnswer: 'show' | 'refuse' | 'lost' | 'hold' = 'show';
let answerClaim: ((show: boolean) => void) | null = null;
let closed: string[] = [];

const empty = { serverSession: 's', q: '', terms: [], took_ms: 1, indexing: false, threads: 5, totals: null, groups: null, recent: [], recent_searches: [] };

beforeEach(() => {
  if (!hasDom) return;
  claims = [];
  claimAnswer = 'show';
  answerClaim = null;
  closed = [];
  savedTimes = { ...tipModule.SEARCH_TIP_TIMES };
  tipModule.SEARCH_TIP_TIMES.leaveMs = 0;
  savedRevealTimes = { ...reveal.REVEAL_TIMES };
  reveal.REVEAL_TIMES.claimRetryMs = 5;
  savedRect = Element.prototype.getBoundingClientRect;
  tipModule.resetSearchTipForTests();
  reveal.resetOneTimeDialogShownForTests();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    if (url.pathname === '/api/inbox/reveal') {
      claims.push((JSON.parse(String(init?.body ?? '{}')) as { id: string }).id);
      if (claimAnswer === 'lost') throw new TypeError('Failed to fetch');
      const answer = (show: boolean) => new Response(JSON.stringify({ show, reveal: { next: null }, board: { on: false }, steps: { on: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (claimAnswer === 'hold') return new Promise<Response>((done) => (answerClaim = (show) => done(answer(show))));
      return answer(claimAnswer === 'show');
    }
    return new Response(JSON.stringify(empty), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = savedFetch;
  Object.assign(tipModule.SEARCH_TIP_TIMES, savedTimes);
  Object.assign(reveal.REVEAL_TIMES, savedRevealTimes);
  Element.prototype.getBoundingClientRect = savedRect;
  tipModule.resetSearchTipForTests();
  reveal.resetOneTimeDialogShownForTests();
});

const palette = (open: boolean, searchTip: boolean) => (
  <SearchPalette open={open} phone={false} currentProject={null} projects={[]} searchTip={searchTip} onClose={(reason) => closed.push(reason)} onOpenResult={() => {}} />
);
async function render(open: boolean, searchTip = true): Promise<void> {
  await act(async () => {
    root!.render(palette(open, searchTip));
  });
}
async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
const input = () => host!.querySelector<HTMLInputElement>('[role="combobox"]')!;
const card = () => host!.querySelector<HTMLElement>('[data-search-tip]');
/** Whether the card is drawn (a boolean, so a failure prints no DOM node). */
const shown = () => card() !== null;
async function type(value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const escape = async () => {
  await act(async () => {
    (document.activeElement ?? input()).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
};

test.skipIf(!hasDom)('shows at the open, claimed once, focus stays in the box; never again on this page, not after a reopen or a remount', async () => {
  await render(true);
  await settle();
  expect(shown()).toBe(true);
  expect(card()!.textContent).toContain(tipModule.SEARCH_TIP_WORDS.line);
  expect(claims).toEqual(['search_tip']);
  expect(document.activeElement === input()).toBe(true);
  expect(input().getAttribute('aria-describedby')).toBe(card()!.querySelector('p')!.id);
  expect(host!.querySelector('[data-search-live]')!.textContent).toBe(tipModule.SEARCH_TIP_SAID);
  // Closing the palette after it was seen ends it.
  await render(false);
  await settle();
  expect(shown()).toBe(false);
  await render(true);
  await settle();
  expect(shown()).toBe(false);
  // A remount (the palette's part loaded again) asks for nothing either.
  act(() => root!.unmount());
  root = createRoot(host!);
  await render(true);
  await settle();
  expect(shown()).toBe(false);
  expect(claims).toEqual(['search_tip']);
});

test.skipIf(!hasDom)('it is in the palette in the commit that opens it, above the results, so no row is drawn first and then pushed down', () => {
  act(() => root!.render(palette(true, true)));
  // No timer has run: the open's own commit.
  expect(shown()).toBe(true);
  const list = host!.querySelector('[role="listbox"]')!;
  expect(!!(card()!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

test.skipIf(!hasDom)('a change while the palette is open draws nothing: the Inbox reporting it due only after the open waits for the next open', async () => {
  await render(true, false);
  await settle();
  await render(true, true);
  await settle(60);
  expect(shown()).toBe(false);
  expect(claims).toEqual([]);
  await render(false, true);
  await render(true, true);
  await settle();
  expect(shown()).toBe(true);
  expect(claims).toEqual(['search_tip']);
});

test.skipIf(!hasDom)('a refused claim leaves it up for this open (no jump), holds nothing back, and this page asks no more', async () => {
  claimAnswer = 'refuse';
  await render(true);
  await settle();
  expect(claims).toEqual(['search_tip']);
  expect(shown()).toBe(true);
  // Nothing was shown as far as the Inbox knows: the other one-time things of this tab are not held back for the gap.
  expect(reveal.oneTimeDialogShownThisLoad()).toBe(false);
  expect(host!.querySelector('[data-search-live]')!.textContent).toBe('');
  await render(false);
  await render(true);
  await settle();
  expect(shown()).toBe(false);
  expect(claims).toEqual(['search_tip']);
});

test.skipIf(!hasDom)('the other one-time things hold back only once the Inbox says yes, not while its answer is on its way', async () => {
  claimAnswer = 'hold';
  await render(true);
  await settle();
  expect(shown()).toBe(true);
  expect(reveal.oneTimeDialogShownThisLoad()).toBe(false);
  await act(async () => answerClaim!(true));
  await settle();
  expect(reveal.oneTimeDialogShownThisLoad()).toBe(true);
  expect(shown()).toBe(true);
});

test.skipIf(!hasDom)('a lost answer (the claim and its retry fail) leaves it up for this open, as the Launch tip does, and holds nothing back', async () => {
  claimAnswer = 'lost';
  await render(true);
  await settle(80);
  expect(claims).toEqual(['search_tip', 'search_tip']);
  expect(shown()).toBe(true);
  expect(reveal.oneTimeDialogShownThisLoad()).toBe(false);
});

test.skipIf(!hasDom)('a pointer press on Got it never takes focus from the box; from the keyboard it sends focus back there; either way it goes', async () => {
  await render(true);
  await settle();
  const ok = card()!.querySelector<HTMLButtonElement>('[data-search-tip-ok]')!;
  // A browser moves focus to a button on its press unless the press is cancelled.
  for (const type of ['pointerdown', 'mousedown']) {
    const press = new MouseEvent(type, { bubbles: true, cancelable: true });
    ok.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  }
  await act(async () => {
    ok.focus();
    ok.click();
  });
  await settle();
  expect(shown()).toBe(false);
  expect(closed).toEqual([]);
  expect(document.activeElement === input()).toBe(true);
});

test.skipIf(!hasDom)('the first Escape closes only the tip; the next closes the palette', async () => {
  await render(true);
  await settle();
  await escape();
  await settle();
  expect(shown()).toBe(false);
  expect(closed).toEqual([]);
  await escape();
  expect(closed).toEqual(['dismissed']);
});

test.skipIf(!hasDom)('typing goes on under it; a quote mark typed takes it away', async () => {
  await render(true);
  await settle();
  await type('file viewer');
  await settle();
  expect(shown()).toBe(true);
  expect(input().value).toBe('file viewer');
  await type('“file viewer');
  await settle();
  expect(shown()).toBe(false);
  expect(closed).toEqual([]);
});

test.skipIf(!hasDom)('not shown, and not claimed, while another one-time dialog showed on this load or the window withholds it', async () => {
  reveal.noteOneTimeDialogShown();
  await render(true);
  await settle();
  expect(shown()).toBe(false);
  expect(claims).toEqual([]);
  await render(false);
  reveal.resetOneTimeDialogShownForTests();
  // The window withholds it (App: the tour, the first-run screen, another dialog or tip claimed or up).
  await render(true, false);
  await settle();
  expect(shown()).toBe(false);
  expect(claims).toEqual([]);
});

test.skipIf(!hasDom)('under the box (a window narrower than the breakpoint): placed against the open dialog, and the results list gives up the card\'s measured height until it goes', () => {
  // A 1024 px window: the 680 px palette leaves 172 px at its right, short of the card and its gaps. Nothing is
  // measured while the dialog is closed (a closed dialog has no box), as in a browser.
  const zero = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const dialog = this.closest('dialog');
    if (!dialog?.open) return zero as DOMRect;
    if (this === dialog) return box(172, 92, 680, 600) as DOMRect;
    if (this.matches('.ib-sp-inrow')) return box(172, 92, 680, 49) as DOMRect;
    if (this.matches('[data-search-tip]')) return box(184, 151, 656, 124) as DOMRect;
    return zero as DOMRect;
  } as typeof Element.prototype.getBoundingClientRect;
  act(() => root!.render(palette(true, true)));
  const dialog = host!.querySelector('dialog')!;
  expect(card()!.getAttribute('data-side')).toBe('below');
  expect(dialog.style.getPropertyValue('--ib-sp-tip-h')).toBe('124px');
  act(() => card()!.querySelector<HTMLButtonElement>('[data-search-tip-ok]')!.click());
  return settle().then(() => {
    expect(shown()).toBe(false);
    expect(dialog.style.getPropertyValue('--ib-sp-tip-h')).toBe('');
  });
});

describe('searchTipPlace: beside the palette from the width where the card and its gaps fit at its right, else under the box', () => {
  // The palette is 680 px wide and centred: the room at its right is (width - 680) / 2; the card needs 284 + 16 + 12.
  const at = (viewportWidth: number, phone = false) => {
    const left = (viewportWidth - 680) / 2;
    const dialog = { left, right: left + 680, top: 100, bottom: 700, width: 680, height: 600 };
    const row = { left, right: left + 680, top: 100, bottom: 149, width: 680, height: 49 };
    return tipModule.searchTipPlace({ phone, viewportWidth, dialog, row });
  };
  test.skipIf(!hasDom)('1304 px and wider: beside, level with the box', () => {
    expect(at(1304)).toEqual({ side: 'right', left: 696, top: -1 });
    expect(at(1440).side).toBe('right');
  });
  test.skipIf(!hasDom)('narrower than 1304 px, or a phone at any width: under the box', () => {
    expect(at(1303)).toEqual({ side: 'below' });
    expect(at(1024)).toEqual({ side: 'below' });
    expect(at(1440, true)).toEqual({ side: 'below' });
  });
});
