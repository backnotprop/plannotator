import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const chooser = (hasDom ? await import('./themeChooser') : {}) as typeof import('./themeChooser');
const { ThemeChooser } = (hasDom ? await import('./components/ThemeChooser') : {}) as typeof import('./components/ThemeChooser');
const themes = (hasDom ? await import('./theme') : {}) as typeof import('./theme');
const { ThemeProvider, useTheme } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
const { configStore } = (hasDom ? await import('@plannotator/ui/config') : {}) as typeof import('@plannotator/ui/config');
const { writeThemePairCookies } = (hasDom ? await import('@plannotator/ui/config/settings') : {}) as typeof import('@plannotator/ui/config/settings');
type Art = import('./themeChooserArt').ThemeChooserArt;

const TIMES = { pageAgeMs: 400, readMs: 5_000, settledMs: 40, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };
const ART: Art = {
  sheets: { plannotator: { light: 'data:,original-light', dark: 'data:,original-dark' }, 'plannotator-modern': { light: 'data:,modern-light', dark: 'data:,modern-dark' } },
  own: { catppuccin: 'data:,catppuccin', solarized: 'data:,solarized', 'tokyo-night': 'data:,tokyo-night' },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedMatchMedia: typeof window.matchMedia;
let savedAnimate: unknown;
let savedWidth = 0;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let stamped = false;
let os: { dark: boolean; reduced: boolean } = { dark: false, reduced: false };
let artLoads: boolean[] = [];
let animations: { reversed: number; cancelled: boolean; playbackRate: number; finish: () => void }[] = [];

const loadArt = (deck: boolean) => {
  artLoads.push(deck);
  return Promise.resolve(ART);
};

function fakeAnimate() {
  let done: () => void = () => {};
  const anim = {
    reversed: 0,
    cancelled: false,
    playbackRate: 1,
    finished: new Promise<void>((resolve) => {
      done = resolve;
    }),
    reverse() {
      anim.reversed += 1;
      anim.playbackRate = -anim.playbackRate;
    },
    cancel() {
      anim.cancelled = true;
    },
    finish: () => done(),
  };
  animations.push(anim);
  return anim;
}

beforeEach(() => {
  if (!hasDom) return;
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  savedTimes = { ...reveal.REVEAL_TIMES };
  // The dialog's own page age is `soonPageAgeMs` (15 s in the product, shrunk here); the line's 60 s is set out of reach,
  // so a dialog that still waited for it would never open in these tests.
  Object.assign(reveal.REVEAL_TIMES, TIMES, { soonPageAgeMs: TIMES.pageAgeMs, pageAgeMs: 600_000 });
  savedFetch = globalThis.fetch;
  savedMatchMedia = window.matchMedia;
  savedAnimate = (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  savedWidth = window.innerWidth;
  posts = [];
  stamped = false;
  os = { dark: false, reduced: false };
  artLoads = [];
  animations = [];
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-color-scheme: dark') ? os.dark : query.includes('prefers-color-scheme: light') ? !os.dark : query.includes('prefers-reduced-motion') ? os.reduced : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = fakeAnimate;
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
    if (path.endsWith('/api/inbox/settings') && init?.method === 'POST') return ok({ theme: body.theme });
    return new Response(JSON.stringify({ error: 'not in this test' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  configStore.setServerSync(themes.inboxServerSync);
  themes.resetInboxThemeForTests();
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  await new Promise((resolve) => setTimeout(resolve, 340));
  configStore.resetServerSync();
  themes.resetInboxThemeForTests();
  globalThis.fetch = savedFetch;
  window.matchMedia = savedMatchMedia;
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = savedAnimate;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: savedWidth });
  window.location.hash = '';
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal'));
const saves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings'));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="theme-chooser"]');
const stage = () => dialog()!.querySelector<HTMLElement>('[data-theme-stage]')!;
const card = (id: string) => dialog()!.querySelector<HTMLElement>(`[data-theme-card="${id}"]`)!;
const pickButton = (id: string) => dialog()!.querySelector<HTMLButtonElement>(`[data-theme-pick="${id}"]`)!;
const corner = (id: string, half: string) => card(id).querySelector<HTMLButtonElement>(`[data-theme-corner="${half}"]`)!;
const sheetInFront = (id: string) => card(id).querySelector<HTMLElement>('.ib-thc-sheet[data-pos="front"]')!.dataset.half;
const line = (id: string) => card(id).querySelector('[data-theme-line]')!.textContent;
const press = (el: HTMLElement) => act(() => el.click());
const key = (el: HTMLElement, name: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const finishMotion = () => act(async () => {
  for (const anim of animations) anim.finish();
  await Promise.resolve();
});
const rootTheme = () => [...document.documentElement.classList].filter((name) => name.startsWith('theme-') || name === 'light').sort();

interface State {
  due: boolean;
  thread: string | null;
}
const READING: State = { due: true, thread: 'thr_a' };

function Harness({ state }: { state: State }) {
  const theme = useTheme();
  const pick = themes.useInboxThemePick();
  const reveals = chooser.useThemeChooser({
    due: state.due,
    blocked: false,
    listLoaded: true,
    firstRun: false,
    thread: state.thread,
    rows: [],
    clear: true,
    place: state.thread ?? '',
    heldBack: () => false,
    toast: false,
    light: theme.lightTheme,
    dark: theme.darkTheme,
  });
  return (
    <>
      <main className="ib-main">
        <button type="button" data-opener="">
          Inbox
        </button>
      </main>
      {reveals.stage === 'open' && (
        <ThemeChooser
          inUse={{ light: theme.lightTheme, dark: theme.darkTheme, mode: theme.mode }}
          onPick={(picked) => {
            pick(picked);
            reveals.close();
          }}
          onOwn={() => {
            reveals.close();
            chooser.openThemeSettings();
          }}
          onDismiss={reveals.close}
          loadArt={loadArt}
        />
      )}
    </>
  );
}

function mount(state: State, pair: { mode: 'light' | 'dark' | 'system'; light: string; dark: string } = { mode: 'system', light: 'plannotator', dark: 'plannotator' }) {
  writeThemePairCookies(pair);
  configStore.init({ theme: pair });
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const draw = (next: State) => (
    <ThemeProvider defaultTheme="system">
      <Harness state={next} />
    </ThemeProvider>
  );
  act(() => {
    root = createRoot(host!);
    root.render(draw(state));
  });
  return (next: Partial<State>) => {
    state = { ...state, ...next };
    act(() => root!.render(draw(state)));
  };
}

async function opened(pair?: Parameters<typeof mount>[1]) {
  const set = mount(READING, pair);
  await until(() => dialog() !== null);
  expect(dialog() !== null).toBe(true);
  return set;
}

describe.skipIf(!hasDom)('the "themes" dialog', () => {
  test('15 s into the page with the pointer never at rest and a thread open: it opens, through the line, and no picture is asked for before', async () => {
    mount(READING);
    const moving = setInterval(() => {
      window.dispatchEvent(new Event('pointermove'));
      window.dispatchEvent(new Event('scroll'));
    }, 15);
    try {
      await wait(TIMES.pageAgeMs / 2);
      expect(dialog() === null).toBe(true);
      expect(claims()).toEqual([]);
      expect(artLoads).toEqual([]);
      expect(document.querySelector('img')).toBeNull();
      await until(() => dialog() !== null);
      expect(dialog() !== null).toBe(true);
    } finally {
      clearInterval(moving);
    }
    expect(claims().map((c) => c.body)).toEqual([{ id: 'theme_chooser', key: expect.any(String) }]);
    expect(artLoads).toEqual([false]);
    expect(dialog()!.querySelectorAll('img').length).toBe(7);
  });

  test('not next in the line: never; on another theme: never claimed', async () => {
    const set = mount({ due: false, thread: 'thr_a' });
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: null });
    await wait(200);
    expect(dialog() === null).toBe(true);
    expect(claims()).toEqual([]);
    act(() => root!.unmount());
    host!.remove();
    const other = mount(READING, { mode: 'system', light: 'plannotator', dark: 'tokyo-night' });
    await wait(TIMES.pageAgeMs + 20);
    other({ thread: null });
    await wait(200);
    expect(dialog() === null).toBe(true);
    expect(claims()).toEqual([]);
    expect(artLoads).toEqual([]);
  });

  test('opens on Plannotator Original with the system mode in front; the heading is "Themes"; focus on its button', async () => {
    os.dark = true;
    await opened();
    expect(stage().dataset.themeFront).toBe('plannotator');
    expect(card('plannotator').hasAttribute('data-front')).toBe(true);
    expect(sheetInFront('plannotator')).toBe('dark');
    expect(sheetInFront('plannotator-modern')).toBe('dark');
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)!.querySelector('.ib-sr')!.textContent).toBe('Themes');
    expect(pickButton('plannotator').textContent).toBe('Keep Original');
    expect(pickButton('plannotator-modern').textContent).toBe('Use Modern, dark');
    expect(document.activeElement).toBe(pickButton('plannotator'));
  });

  test('picking without a shuffle keeps following the system: the theme on both halves, applied at once, saved as Settings saves it', async () => {
    await opened();
    expect(line('plannotator-modern')).toContain('follows your system');
    act(() => pickButton('plannotator-modern').focus());
    expect(stage().dataset.themeFront).toBe('plannotator-modern');
    await press(pickButton('plannotator-modern'));
    expect(dialog() === null).toBe(true);
    expect(rootTheme()).toEqual(['light', 'theme-plannotator-modern']);
    expect(configStore.get('themePair')).toEqual({ mode: 'system', light: 'plannotator-modern', dark: 'plannotator-modern' });
    await until(() => saves().length > 0);
    expect(saves().map((s) => s.body)).toEqual([{ theme: { light: 'plannotator-modern', dark: 'plannotator-modern' } }]);
    expect(claims().length).toBe(1);
  });

  test('picking after a shuffle fixes the mode: Tab reaches the corner, Enter on it brings the other sheet forward', async () => {
    await opened();
    expect(corner('plannotator', 'dark').tabIndex).toBe(0);
    expect(corner('plannotator', 'dark').getAttribute('aria-label')).toBe('Show Plannotator Original in dark');
    expect(corner('plannotator', 'light').tabIndex).toBe(-1);
    act(() => corner('plannotator', 'dark').focus());
    await press(corner('plannotator', 'dark'));
    expect(pickButton('plannotator').textContent).toBe('Use Original, dark');
    expect(line('plannotator')).toContain('always dark');
    expect(sheetInFront('plannotator')).toBe('light');
    await finishMotion();
    expect(sheetInFront('plannotator')).toBe('dark');
    expect(document.activeElement).toBe(corner('plannotator', 'light'));
    expect(corner('plannotator', 'light').tabIndex).toBe(0);
    await press(pickButton('plannotator'));
    expect(rootTheme()).toEqual(['theme-plannotator']);
    await until(() => saves().length > 0);
    expect(saves().map((s) => s.body)).toEqual([{ theme: { mode: 'dark' } }]);
  });

  test('a shuffle turned round mid-move goes back from where it is, and nothing trades places', async () => {
    await opened();
    await press(corner('plannotator', 'dark'));
    const running = animations.length;
    expect(running).toBeGreaterThan(0);
    await press(corner('plannotator', 'light'));
    expect(animations.length).toBe(running);
    expect(animations.every((anim) => anim.reversed === 1)).toBe(true);
    expect(pickButton('plannotator').textContent).toBe('Keep Original');
    await finishMotion();
    expect(sheetInFront('plannotator')).toBe('light');
    expect(animations.every((anim) => anim.cancelled)).toBe(true);
  });

  test('"Keep Original" writes nothing; the close button and Escape change nothing and are final', async () => {
    await opened();
    await press(pickButton('plannotator'));
    expect(dialog() === null).toBe(true);
    await wait(360);
    expect(saves()).toEqual([]);
    act(() => root!.unmount());
    host!.remove();

    stamped = false;
    posts = [];
    const set = await opened();
    await press(dialog()!.querySelector<HTMLButtonElement>('[data-theme-close]')!);
    expect(dialog() === null).toBe(true);
    set({ thread: 'thr_b' });
    await wait(60);
    set({ thread: null });
    await wait(200);
    expect(dialog() === null).toBe(true);
    expect(posts.map((p) => p.body)).toEqual([{ id: 'theme_chooser', key: expect.any(String) }]);
    act(() => root!.unmount());
    host!.remove();

    stamped = false;
    posts = [];
    await opened();
    await key(pickButton('plannotator'), 'Escape');
    expect(dialog() === null).toBe(true);
    await wait(360);
    expect(posts.map((p) => p.body)).toEqual([{ id: 'theme_chooser', key: expect.any(String) }]);
    expect(rootTheme()).toEqual(['light', 'theme-plannotator']);
  });

  test('the arrow keys move the fan card by card; "Open Settings" closes the dialog, opens Settings and saves nothing', async () => {
    await opened();
    await key(pickButton('plannotator'), 'ArrowRight');
    expect(document.activeElement).toBe(pickButton('plannotator-modern'));
    expect(stage().dataset.themeFront).toBe('plannotator-modern');
    expect(card('plannotator-modern').style.getPropertyValue('--thc-d')).toBe('600ms');
    expect(card('plannotator-modern').style.getPropertyValue('--thc-dl')).toBe('0ms');
    expect(card('plannotator').style.getPropertyValue('--thc-d')).toBe('516ms');
    expect(card('plannotator').style.getPropertyValue('--thc-dl')).toBe('60ms');
    await key(pickButton('plannotator-modern'), 'ArrowRight');
    const settings = card('own').querySelector<HTMLButtonElement>('[data-theme-main]')!;
    expect(document.activeElement).toBe(settings);
    expect(stage().dataset.themeFront).toBe('own');
    await key(settings, 'ArrowLeft');
    expect(stage().dataset.themeFront).toBe('plannotator-modern');
    await key(pickButton('plannotator-modern'), 'ArrowRight');
    await press(settings);
    expect(dialog() === null).toBe(true);
    expect(window.location.hash).toBe('#settings/general');
    await wait(360);
    expect(saves()).toEqual([]);
    expect(rootTheme()).toEqual(['light', 'theme-plannotator']);
  });

  test('reduced motion: the same behaviour, instant (no durations, no animation)', async () => {
    os.reduced = true;
    await opened();
    await key(pickButton('plannotator'), 'ArrowRight');
    expect(stage().dataset.themeFront).toBe('plannotator-modern');
    for (const id of ['plannotator', 'plannotator-modern', 'own']) {
      expect(card(id).style.getPropertyValue('--thc-d')).toBe('0ms');
      expect(card(id).style.getPropertyValue('--thc-dl')).toBe('0ms');
    }
    await press(corner('plannotator-modern', 'dark'));
    expect(animations).toEqual([]);
    expect(sheetInFront('plannotator-modern')).toBe('dark');
    expect(pickButton('plannotator-modern').textContent).toBe('Use Modern, dark');
  });

  test('a phone: the deck, its own pictures, a swipe moves one card and a tap on the corner shuffles', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    await opened();
    expect(artLoads).toEqual([true]);
    const swipe = (fromX: number, toX: number) =>
      act(() => {
        stage().dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: fromX, clientY: 300, bubbles: true }));
        stage().dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX: toX, clientY: 304, bubbles: true }));
      });
    await swipe(300, 120);
    expect(stage().dataset.themeFront).toBe('plannotator-modern');
    await swipe(200, 185);
    expect(stage().dataset.themeFront).toBe('plannotator-modern');
    await swipe(120, 300);
    expect(stage().dataset.themeFront).toBe('plannotator');
    await wait(80);
    await act(() => void card('plannotator').querySelector('.ib-thc-hit')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    expect(pickButton('plannotator').textContent).toBe('Use Original, dark');
  });
});

describe.skipIf(!hasDom)('what a pick saves', () => {
  test('the sheet in front is the system mode: Match system; the other sheet: that mode, fixed', () => {
    expect(chooser.themeChooserPick('plannotator-modern', 'light', 'light')).toEqual({ light: 'plannotator-modern', dark: 'plannotator-modern', mode: 'system' });
    expect(chooser.themeChooserPick('plannotator-modern', 'dark', 'light')).toEqual({ light: 'plannotator-modern', dark: 'plannotator-modern', mode: 'dark' });
    expect(chooser.themeChooserPick('plannotator', 'light', 'dark')).toEqual({ light: 'plannotator', dark: 'plannotator', mode: 'light' });
  });

  test('"Keep" only when nothing would change: a fixed mode that matches the system is still a change to Match system', () => {
    const original = { light: 'plannotator', dark: 'plannotator' };
    expect(chooser.themeChooserButton('plannotator', 'dark', 'dark', { ...original, mode: 'system' })).toBe('Keep Original');
    expect(chooser.themeChooserButton('plannotator', 'dark', 'dark', { ...original, mode: 'dark' })).toBe('Use Original, dark');
    expect(chooser.themeChooserButton('plannotator', 'light', 'dark', { ...original, mode: 'light' })).toBe('Keep Original');
    expect(chooser.themeChooserButton('plannotator-modern', 'dark', 'dark', { ...original, mode: 'system' })).toBe('Use Modern, dark');
  });

  test('the pointer means a card by where the cards are going: the front card first, a side card where it shows', () => {
    const g = chooser.themeChooserGeometry(1440);
    const h = 560;
    expect(chooser.themeChooserCardAt(0, 200, 0, 3, h, g)).toBe(0);
    expect(chooser.themeChooserCardAt(0, 200, 1, 3, h, g)).toBe(1);
    expect(chooser.themeChooserCardAt(450, 300, 0, 3, h, g)).toBe(2);
    expect(chooser.themeChooserCardAt(250, 300, 0, 3, h, g)).toBe(1);
    expect(chooser.themeChooserCardAt(900, 300, 0, 3, h, g)).toBe(-1);
  });
});
