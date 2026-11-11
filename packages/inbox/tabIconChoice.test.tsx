/**
 * The tab icon dialog in a DOM ("Which favicon do you prefer?"; the owner, 2026-11-09: "Ship it as shown"): the page's
 * moment (tabIconChoice.ts `useTabIconChoice`, on the line's `useLineReveal`) driving the dialog
 * (components/TabIconChoice.tsx) and this tab's real icon link (tabCount.ts `useTabCount`, faviconChoice.ts), as App
 * wires them.
 *
 * What regresses: the dialog opening without the line (`reveal.next` not `tab_icon`), before the page is 15 s old, over
 * something typed or open, or going around the line's claim; the dialog waiting for a thread read and left, for the
 * line's 60 s, or for a page left still (the owner, 2026-11-10: "Fifteen seconds after the inbox opens"); a choice
 * saving anything (it only shows on this tab); the primary button not following the pick, or not saving the pick
 * through Settings' own write (`POST /api/inbox/settings { favicon }`), Keep Glass included; Escape or a click outside
 * saving anything, sending a Not now, or leaving the tried icon on the tab; the dialog showing again on the same load;
 * a pick made in Settings on this page before the moment not dropping it; a Not now button appearing.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { useTabIconChoice } = (hasDom ? await import('./tabIconChoice') : {}) as typeof import('./tabIconChoice');
const { TabIconChoice } = (hasDom ? await import('./components/TabIconChoice') : {}) as typeof import('./components/TabIconChoice');
const favicon = (hasDom ? await import('./faviconChoice') : {}) as typeof import('./faviconChoice');
const { useTabCount } = (hasDom ? await import('./tabCount') : {}) as typeof import('./tabCount');
const core = (hasDom ? await import('@plannotator/core/favicon') : {}) as typeof import('@plannotator/core/favicon');

const TIMES = { pageAgeMs: 400, readMs: 5_000, settledMs: 40, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };
const LOADED = '/favicon.ico';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let stamped = false;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  // The dialog's own page age is `soonPageAgeMs` (15 s in the product, shrunk here); the line's 60 s is set out of reach,
  // so a dialog that still waited for it would never open in these tests.
  Object.assign(reveal.REVEAL_TIMES, TIMES, { soonPageAgeMs: TIMES.pageAgeMs, pageAgeMs: 600_000 });
  favicon.resetInboxFaviconForTests();
  document.head.innerHTML = `<link rel="icon" href="${LOADED}">`;
  savedFetch = globalThis.fetch;
  posts = [];
  stamped = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if ((init?.method ?? 'GET') === 'POST') posts.push({ path, body });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/api/inbox/reveal')) {
      const show = !stamped;
      stamped = true;
      return ok({ show, reveal: { next: null }, board: { on: false } });
    }
    if (path.endsWith('/api/inbox/settings') && init?.method === 'POST') return ok({ favicon: body.favicon });
    return new Response(JSON.stringify({ error: 'not in this test' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  favicon.resetInboxFaviconForTests();
  globalThis.fetch = savedFetch;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal'));
const saves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings'));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="tab-icon-choice"]');
const tabIcon = () => document.head.querySelector('link[rel="icon"]')?.getAttribute('href');
const choose = (id: string) => act(() => dialog()!.querySelector<HTMLInputElement>(`input[value="${id}"]`)!.click());
const primary = () => dialog()!.querySelector<HTMLButtonElement>('[data-tab-icon-use]')!;

interface State {
  due: boolean;
  held: boolean;
  thread: string | null;
}

/** The line has it next; the person is reading a thread. */
const READING: State = { due: true, held: false, thread: 'thr_a' };

function Harness({ state }: { state: State }) {
  useTabCount(0, favicon.useInboxFaviconHref(), favicon.useInboxFaviconBadgeHref());
  const current = favicon.useInboxFavicon();
  const choice = useTabIconChoice({
    due: state.due,
    blocked: false,
    listLoaded: true,
    firstRun: false,
    thread: state.thread,
    rows: [],
    clear: true,
    place: state.thread ?? '',
    heldBack: () => state.held,
    toast: false,
  });
  return (
    <>
      <main className="ib-main">
        <h1>Inbox</h1>
      </main>
      {choice.stage === 'open' && (
        <TabIconChoice
          phone={false}
          current={current ?? 'glass'}
          title="(2) Plannotator Inbox"
          onUse={(style) => {
            void favicon.chooseFavicon(style);
            choice.close();
          }}
          onDismiss={choice.close}
        />
      )}
    </>
  );
}

function mount(state: State) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness state={state} />);
  });
  return (next: Partial<State>) => {
    state = { ...state, ...next };
    act(() => root!.render(<Harness state={state} />));
  };
}

/** The page 15 s old (shrunk), a thread open: the dialog opens by itself. */
async function opened() {
  const set = mount(READING);
  await until(() => dialog() !== null);
  expect(dialog()).not.toBeNull();
  return set;
}

describe.skipIf(!hasDom)('the tab icon dialog', () => {
  test('15 s into the page, with no thread left and no stillness: never while the page is younger; something typed makes it wait, not give up', async () => {
    const set = mount({ ...READING, held: true });
    // A person looking around: the pointer never rests, the whole time.
    const moving = setInterval(() => window.dispatchEvent(new Event('pointermove')), 15);
    try {
      await wait(TIMES.pageAgeMs / 2);
      expect(claims()).toHaveLength(0);
      expect(dialog()).toBeNull();
      // Old enough now, but something is typed: it waits (several moments come and go).
      await wait(TIMES.pageAgeMs + TIMES.settledMs * 6);
      expect(claims()).toHaveLength(0);
      set({ held: false });
      await until(() => dialog() !== null);
      expect(dialog()).not.toBeNull();
      expect(claims().map((c) => c.body)).toEqual([{ id: 'tab_icon', key: expect.any(String) }]);
      expect(saves()).toHaveLength(0);
    } finally {
      clearInterval(moving);
    }
  });

  test('a hidden tab is no moment: it opens once the tab is in front', async () => {
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      mount(READING);
      await wait(TIMES.pageAgeMs + TIMES.settledMs * 6);
      expect(claims()).toHaveLength(0);
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      await until(() => dialog() !== null);
      expect(claims()).toHaveLength(1);
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
  });

  test('not next for this load: never claimed, never shown', async () => {
    const set = mount({ ...READING, due: false });
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: null });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('a favicon picked in Settings on this page before the moment: dropped, no claim', async () => {
    const set = mount(READING);
    await act(() => favicon.chooseFavicon('yellow'));
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: null });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('a choice shows on this tab only; the one button follows the pick and saves it as Settings does', async () => {
    await opened();
    const d = dialog()!;
    // Glass is in use (nothing chosen yet): tagged, and the button keeps it. One button: no Not now.
    expect(d.querySelector('[data-tab-icon-choice="glass"] .ib-lvc-inuse')).not.toBeNull();
    expect(d.querySelectorAll('[data-tab-icon-choice] .ib-lvc-inuse')).toHaveLength(1);
    expect(d.querySelectorAll('button')).toHaveLength(1);
    // The owner's labels, pinned on purpose.
    expect(primary().textContent).toBe('Keep Glass');
    expect(tabIcon()).toBe(LOADED);

    // Three choices in Settings' order; P is gone.
    expect([...d.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.value)).toEqual(['glass', 'yellow', 'totman']);
    choose('yellow');
    expect(primary().textContent).toBe('Use Yellow');
    expect(tabIcon()).toBe(core.faviconDataUrl('yellow'));
    choose('totman');
    expect(primary().textContent).toBe('Use Face');
    expect(tabIcon()).toBe(core.faviconDataUrl('totman'));
    // Back to the one in use: the tab shows the icon it loaded with.
    choose('glass');
    expect(primary().textContent).toBe('Keep Glass');
    expect(tabIcon()).toBe(LOADED);
    expect(saves()).toHaveLength(0);

    choose('totman');
    act(() => primary().click());
    expect(dialog()).toBeNull();
    await until(() => saves().length === 1);
    expect(saves().map((s) => s.body)).toEqual([{ favicon: 'totman' }]);
    expect(tabIcon()).toBe(core.faviconDataUrl('totman'));
    await wait(TIMES.settledMs * 3);
    expect(claims()).toHaveLength(1);
  });

  test('Keep Glass saves glass: the choice counts as made', async () => {
    await opened();
    act(() => primary().click());
    await until(() => saves().length === 1);
    expect(saves().map((s) => s.body)).toEqual([{ favicon: 'glass' }]);
  });

  for (const [way, close] of [
    ['Escape', (d: HTMLDialogElement) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside', (d: HTMLDialogElement) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ] as const) {
    test(`${way}: the loaded icon back on the tab, nothing saved, no Not now, and final on this load`, async () => {
      const set = await opened();
      choose('yellow');
      expect(tabIcon()).toBe(core.faviconDataUrl('yellow'));
      act(() => void close(dialog()!));
      expect(dialog()).toBeNull();
      expect(tabIcon()).toBe(LOADED);
      await wait(TIMES.settledMs * 3);
      expect(saves()).toHaveLength(0);
      expect(posts.filter((p) => p.body.answer !== undefined)).toHaveLength(0);
      // Another moment on the same load: never again.
      set({ thread: 'thr_c' });
      set({ thread: null });
      await wait(TIMES.settledMs * 4);
      expect(dialog()).toBeNull();
      expect(claims()).toHaveLength(1);
    });
  }

  test('focus starts on the question, not on a choice', async () => {
    await opened();
    expect(document.activeElement?.id).toBe('ib-tic-title');
  });
});
