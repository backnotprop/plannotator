/**
 * The Search tip in the palette (search/searchTip.ts). What regresses: it shown twice on one page (a reopen, a
 * remount); it shown with no claim, or kept after a refused one; it taking focus from the box; Got it, Escape or a
 * typed quote not taking it away; the first Escape closing the palette under it; it shown while another one-time
 * dialog showed on this load, or when the window withholds it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { default: SearchPalette } = (hasDom ? await import('./search/SearchPalette') : {}) as typeof import('./search/SearchPalette');
const tipModule = (hasDom ? await import('./search/searchTip') : {}) as typeof import('./search/searchTip');
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: { delayMs: number; leaveMs: number };
let claims: string[] = [];
let claimShows = true;
let closed: string[] = [];

const empty = { serverSession: 's', q: '', terms: [], took_ms: 1, indexing: false, threads: 5, totals: null, groups: null, recent: [], recent_searches: [] };

beforeEach(() => {
  if (!hasDom) return;
  claims = [];
  claimShows = true;
  closed = [];
  savedTimes = { ...tipModule.SEARCH_TIP_TIMES };
  tipModule.SEARCH_TIP_TIMES.delayMs = 0;
  tipModule.SEARCH_TIP_TIMES.leaveMs = 0;
  tipModule.resetSearchTipForTests();
  reveal.resetOneTimeDialogShownForTests();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    if (url.pathname === '/api/inbox/reveal') {
      claims.push((JSON.parse(String(init?.body ?? '{}')) as { id: string }).id);
      return new Response(JSON.stringify({ show: claimShows, reveal: { next: null }, board: { on: false }, steps: { on: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  tipModule.resetSearchTipForTests();
  reveal.resetOneTimeDialogShownForTests();
});

async function render(open: boolean, searchTip = true): Promise<void> {
  await act(async () => {
    root!.render(
      <SearchPalette
        open={open}
        phone={false}
        currentProject={null}
        projects={[]}
        searchTip={searchTip}
        onClose={(reason) => closed.push(reason)}
        onOpenResult={() => {}}
      />,
    );
  });
}
async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
const input = () => host!.querySelector<HTMLInputElement>('[role="combobox"]')!;
const card = () => host!.querySelector<HTMLElement>('[data-search-tip]');
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
  expect(card()).not.toBeNull();
  expect(card()!.textContent).toContain(tipModule.SEARCH_TIP_WORDS.line);
  expect(claims).toEqual(['search_tip']);
  expect(document.activeElement).toBe(input());
  expect(input().getAttribute('aria-describedby')).toBe(card()!.querySelector('p')!.id);
  // Closing the palette after it was seen ends it.
  await render(false);
  await settle();
  expect(card()).toBeNull();
  await render(true);
  await settle();
  expect(card()).toBeNull();
  // A remount (the palette's part loaded again) asks for nothing either.
  act(() => root!.unmount());
  root = createRoot(host!);
  await render(true);
  await settle();
  expect(card()).toBeNull();
  expect(claims).toEqual(['search_tip']);
});

test.skipIf(!hasDom)('Got it takes it away and keeps focus in the box', async () => {
  await render(true);
  await settle();
  await act(async () => {
    card()!.querySelector<HTMLButtonElement>('[data-search-tip-ok]')!.click();
  });
  await settle();
  expect(card()).toBeNull();
  expect(closed).toEqual([]);
  expect(document.activeElement).toBe(input());
});

test.skipIf(!hasDom)('the first Escape closes only the tip; the next closes the palette', async () => {
  await render(true);
  await settle();
  await escape();
  await settle();
  expect(card()).toBeNull();
  expect(closed).toEqual([]);
  await escape();
  expect(closed).toEqual(['dismissed']);
});

test.skipIf(!hasDom)('typing goes on under it; a quote mark typed takes it away', async () => {
  await render(true);
  await settle();
  await type('file viewer');
  await settle();
  expect(card()).not.toBeNull();
  expect(input().value).toBe('file viewer');
  await type('“file viewer');
  await settle();
  expect(card()).toBeNull();
  expect(closed).toEqual([]);
});

test.skipIf(!hasDom)('a quote typed before it shows keeps it away for that open, unclaimed', async () => {
  tipModule.SEARCH_TIP_TIMES.delayMs = 60;
  await render(true);
  await type('"rate');
  await settle(120);
  expect(card()).toBeNull();
  expect(claims).toEqual([]);
});

test.skipIf(!hasDom)('a refused claim (another window showed it, or a dialog\'s gap) takes it away at once', async () => {
  claimShows = false;
  await render(true);
  await settle();
  expect(claims).toEqual(['search_tip']);
  expect(card()).toBeNull();
});

test.skipIf(!hasDom)('not shown, and not claimed, while another one-time dialog showed on this load or the window withholds it', async () => {
  reveal.noteOneTimeDialogShown();
  await render(true);
  await settle();
  expect(card()).toBeNull();
  expect(claims).toEqual([]);
  await render(false);
  reveal.resetOneTimeDialogShownForTests();
  // The window withholds it (App: the tour, the first-run screen, another dialog or tip claimed or up).
  await render(true, false);
  await settle();
  expect(card()).toBeNull();
  expect(claims).toEqual([]);
});

test.skipIf(!hasDom)('once shown, the other one-time things hold back for the gap', async () => {
  await render(true);
  await settle();
  expect(card()).not.toBeNull();
  expect(reveal.oneTimeDialogShownThisLoad()).toBe(true);
});
