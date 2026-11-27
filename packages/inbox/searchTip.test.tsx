/**
 * The Search tip in the palette (search/searchTip.ts). What regresses: it shown twice on one page (a reopen, a
 * remount); it shown with no claim; it drawn after the palette's first paint (it then pushes rows down under a
 * finger), or drawn by a change while the palette is open; it taken away after a refused or a lost claim (the rows
 * jump back); this page holding back the other one-time things though the Inbox refused it; a pointer press on Got it
 * taking focus from the box, or a keyboard Got it not sending it back; Got it, Escape or a typed quote not taking it
 * away; the first Escape closing the palette under it; it shown while another one-time dialog showed on this load, or
 * when the window withholds it; under the box, placed against a closed dialog, or the results list not giving up its
 * height (the palette then runs past the window's bottom); its side either side of the breakpoint. Once per browser: it
 * shown again on a new page load of the same browser after a refused or a lost claim (a read-only data folder would
 * bring it back at every load), or storage that cannot be used throwing; a tab whose settings went stale (shown and
 * stamped on another device) not reading them again when shown or focused; placed from the palette's box scaled by
 * its entrance animation (the card then sits 2 px from the palette, not 16); under the box when the results list
 * would keep fewer than three rows (then not shown, not claimed, not kept: a roomier open shows it).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { default: SearchPalette } = (hasDom ? await import('./search/SearchPalette') : {}) as typeof import('./search/SearchPalette');
const tipModule = (hasDom ? await import('./search/searchTip') : {}) as typeof import('./search/searchTip');
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: { leaveMs: number; freshGapMs: number };
let savedRevealTimes: typeof reveal.REVEAL_TIMES;
let savedRect: typeof Element.prototype.getBoundingClientRect;
let savedSeen: string | null = null;
let savedStorage: { getItem: Storage['getItem']; setItem: Storage['setItem'] };
let savedHeight: PropertyDescriptor | undefined;
let savedWidth: PropertyDescriptor | undefined;
const OFFSETS = { offsetLeft: 'left', offsetTop: 'top', offsetWidth: 'width', offsetHeight: 'height' } as const;
let savedOffsets: Partial<Record<keyof typeof OFFSETS, PropertyDescriptor>> = {};
type Layout = { left?: number; top?: number; width?: number; height?: number };
/** Layout sizes (offset*) for the elements `of` names, as a browser lays them out; every other element 0. */
function layout(of: (el: HTMLElement) => Layout | null): void {
  for (const [name, key] of Object.entries(OFFSETS) as [keyof typeof OFFSETS, keyof Layout][]) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return of(this)?.[key] ?? 0; } });
  }
}
function windowHeight(px: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: px });
}
function windowWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
}
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
  tipModule.SEARCH_TIP_TIMES.freshGapMs = 0;
  savedRevealTimes = { ...reveal.REVEAL_TIMES };
  reveal.REVEAL_TIMES.claimRetryMs = 5;
  savedRect = Element.prototype.getBoundingClientRect;
  // Each case is a browser that has not drawn the tip yet.
  savedSeen = localStorage.getItem(tipModule.SEARCH_TIP_SEEN_KEY);
  localStorage.removeItem(tipModule.SEARCH_TIP_SEEN_KEY);
  savedStorage = { getItem: Storage.prototype.getItem, setItem: Storage.prototype.setItem };
  savedHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  savedWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  savedOffsets = {};
  for (const name of Object.keys(OFFSETS) as (keyof typeof OFFSETS)[]) {
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    if (own) savedOffsets[name] = own;
  }
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
  Storage.prototype.getItem = savedStorage.getItem;
  Storage.prototype.setItem = savedStorage.setItem;
  if (savedSeen === null) localStorage.removeItem(tipModule.SEARCH_TIP_SEEN_KEY);
  else localStorage.setItem(tipModule.SEARCH_TIP_SEEN_KEY, savedSeen);
  if (savedHeight) Object.defineProperty(window, 'innerHeight', savedHeight);
  else delete (window as { innerHeight?: number }).innerHeight;
  if (savedWidth) Object.defineProperty(window, 'innerWidth', savedWidth);
  else delete (window as { innerWidth?: number }).innerWidth;
  for (const name of Object.keys(OFFSETS) as (keyof typeof OFFSETS)[]) {
    const own = savedOffsets[name];
    if (own) Object.defineProperty(HTMLElement.prototype, name, own);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
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
  windowHeight(768);
  layout((el) => {
    const dialog = el.closest('dialog');
    if (!dialog?.open) return null;
    if (el === dialog) return { left: 172, top: 92, width: 680, height: 600 };
    if (el.matches('.ib-sp-inrow')) return { top: 0, width: 680, height: 49 };
    if (el.matches('[data-search-tip]')) return { width: 656, height: 124 };
    return null;
  });
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
    return tipModule.searchTipPlace({ phone, viewportWidth, dialog: { left, width: 680 }, row: { top: 0, height: 49 } });
  };
  test.skipIf(!hasDom)('1304 px and wider: beside, level with the box, 16 px from the palette\'s laid-out edge', () => {
    expect(at(1304)).toEqual({ side: 'right', left: 696, top: -1 });
    expect(at(1440)).toEqual({ side: 'right', left: 696, top: -1 });
  });
  test.skipIf(!hasDom)('narrower than 1304 px, or a phone at any width: under the box', () => {
    expect(at(1303)).toEqual({ side: 'below' });
    expect(at(1295)).toEqual({ side: 'below' });
    expect(at(1024)).toEqual({ side: 'below' });
    expect(at(1440, true)).toEqual({ side: 'below' });
  });
});

/** A box as getBoundingClientRect gives it. */
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

test.skipIf(!hasDom)('placed from the palette\'s laid-out size, not the box its entrance animation shrinks to 0.98 in the frame it is placed in', () => {
  // A 1440 px window: the palette is laid out at 380..1060. In the open's first frame its entrance has it at scale
  // 0.98 about its centre: 393.6..1046.4 on screen, 666.4 px wide. The card must end 16 px from 1060, at left 696.
  windowWidth(1440);
  windowHeight(900);
  layout((el) => {
    const dialog = el.closest('dialog');
    if (!dialog?.open) return null;
    if (el === dialog) return { left: 380, top: 108, width: 680, height: 690 };
    if (el.matches('.ib-sp-inrow')) return { top: 0, width: 680, height: 49 };
    return null;
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const dialog = this.closest('dialog');
    if (!dialog?.open) return rect(0, 0, 0, 0);
    if (this === dialog) return rect(393.6, 114.9, 666.4, 676.2);
    if (this.matches('.ib-sp-inrow')) return rect(393.6, 114.9, 666.4, 48);
    return rect(0, 0, 0, 0);
  } as typeof Element.prototype.getBoundingClientRect;
  act(() => root!.render(palette(true, true)));
  expect(card()!.getAttribute('data-side')).toBe('right');
  expect(card()!.style.left).toBe('696px');
  expect(card()!.style.top).toBe('-1px');
});

test.skipIf(!hasDom)('once per browser: after a refused claim, a new page load of this browser shows it no more', async () => {
  claimAnswer = 'refuse';
  await render(true);
  await settle();
  expect(shown()).toBe(true);
  // A new page load: the page's own memory is gone, the Inbox still reports it due (its stamp never landed).
  act(() => root!.unmount());
  tipModule.resetSearchTipForTests();
  root = createRoot(host!);
  await render(true);
  await settle();
  expect(shown()).toBe(false);
  expect(claims).toEqual(['search_tip']);
});

test.skipIf(!hasDom)('once per browser: after a lost answer, a new page load of this browser shows it no more', async () => {
  claimAnswer = 'lost';
  await render(true);
  await settle(80);
  expect(shown()).toBe(true);
  act(() => root!.unmount());
  tipModule.resetSearchTipForTests();
  root = createRoot(host!);
  await render(true);
  await settle(80);
  expect(shown()).toBe(false);
  expect(claims).toEqual(['search_tip', 'search_tip']);
});

test.skipIf(!hasDom)('storage that cannot be used (private mode, quota) throws nothing: it shows and is claimed as usual', async () => {
  // A browser that blocks site data throws on reaching localStorage at all.
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('denied', 'SecurityError');
    },
  });
  try {
    await render(true);
    await settle();
    expect(shown()).toBe(true);
    expect(claims).toEqual(['search_tip']);
  } finally {
    if (own) Object.defineProperty(globalThis, 'localStorage', own);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
  // One that reaches it but refuses every read and write (quota, private mode).
  Storage.prototype.getItem = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  Storage.prototype.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  // A new page load (the Inbox's yes above held this load's other one-time things back).
  act(() => root!.unmount());
  tipModule.resetSearchTipForTests();
  reveal.resetOneTimeDialogShownForTests();
  root = createRoot(host!);
  await render(true);
  await settle();
  expect(shown()).toBe(true);
  expect(claims).toEqual(['search_tip', 'search_tip']);
});

test.skipIf(!hasDom)('a tab shown again or focused reads the settings again: shown and stamped elsewhere, it is not drawn at the next open', async () => {
  let reads = 0;
  // The window: its settings say due until a read says the tip was stamped (another device showed it).
  function Window(props: { open: boolean }) {
    const [due, setDue] = useState(true);
    tipModule.useSearchTipFresh(due, () => {
      reads += 1;
      setDue(false);
    });
    return <SearchPalette open={props.open} phone={false} currentProject={null} projects={[]} searchTip={due} onClose={() => {}} onOpenResult={() => {}} />;
  }
  await act(async () => root!.render(<Window open={false} />));
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(reads).toBe(1);
  await act(async () => root!.render(<Window open />));
  await settle();
  expect(shown()).toBe(false);
  expect(claims).toEqual([]);
  // Not offered any more: a focus reads nothing.
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(reads).toBe(1);
});

test.skipIf(!hasDom)('a focus reads the settings again too, while it is offered', async () => {
  let reads = 0;
  function Host() {
    tipModule.useSearchTipFresh(true, () => (reads += 1));
    return null;
  }
  await act(async () => root!.render(<Host />));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(reads).toBe(1);
});

test.skipIf(!hasDom)('under the box, a window too short to keep three result rows below it: not shown, not claimed, not kept; a taller window\'s open shows it', async () => {
  // A 1024 px window (the card goes under the box), 400 px tall: the list keeps min(560, 352 - 160 - 124) = 68 px,
  // under three 34 px rows.
  windowHeight(400);
  layout((el) => {
    const dialog = el.closest('dialog');
    if (!dialog?.open) return null;
    if (el === dialog) return { left: 172, top: 48, width: 680, height: 300 };
    if (el.matches('.ib-sp-inrow')) return { top: 0, width: 680, height: 49 };
    if (el.matches('[data-search-tip]')) return { width: 656, height: 124 };
    if (el.matches('.ib-sp-row')) return { height: 34 };
    return null;
  });
  await render(true);
  await settle();
  expect(shown()).toBe(false);
  expect(claims).toEqual([]);
  expect(localStorage.getItem(tipModule.SEARCH_TIP_SEEN_KEY)).toBe(null);
  expect(host!.querySelector('dialog')!.style.getPropertyValue('--ib-sp-tip-h')).toBe('');
  await render(false);
  windowHeight(800);
  await render(true);
  await settle();
  expect(shown()).toBe(true);
  expect(claims).toEqual(['search_tip']);
  expect(localStorage.getItem(tipModule.SEARCH_TIP_SEEN_KEY)).toBe('1');
});

describe('searchTipFits: under the box only with three result rows of room left', () => {
  const below = { side: 'below' } as const;
  test.skipIf(!hasDom)('a desktop: the list\'s cap less the card, against three measured rows', () => {
    // 720 px tall: min(560, 633.6 - 160 - 140) = 333.6 px.
    expect(tipModule.searchTipFits({ place: below, phone: false, viewportHeight: 720, cardHeight: 140, listHeight: 0, rowHeight: 50 })).toBe(true);
    // 480 px tall: 422.4 - 160 - 140 = 122.4 px, under three 50 px rows.
    expect(tipModule.searchTipFits({ place: below, phone: false, viewportHeight: 480, cardHeight: 140, listHeight: 0, rowHeight: 50 })).toBe(false);
  });
  test.skipIf(!hasDom)('a phone: the list\'s own height with the card in place', () => {
    expect(tipModule.searchTipFits({ place: below, phone: true, viewportHeight: 480, cardHeight: 150, listHeight: 120, rowHeight: 56 })).toBe(false);
    expect(tipModule.searchTipFits({ place: below, phone: true, viewportHeight: 844, cardHeight: 150, listHeight: 480, rowHeight: 56 })).toBe(true);
    // No row to measure yet: a phone row's least height (56 px).
    expect(tipModule.searchTipFits({ place: below, phone: true, viewportHeight: 480, cardHeight: 150, listHeight: 160, rowHeight: 0 })).toBe(false);
  });
  test.skipIf(!hasDom)('beside the palette it takes no room from the list', () => {
    expect(tipModule.searchTipFits({ place: { side: 'right', left: 696, top: -1 }, phone: false, viewportHeight: 300, cardHeight: 140, listHeight: 0, rowHeight: 50 })).toBe(true);
  });
});
