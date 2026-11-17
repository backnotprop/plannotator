/**
 * The Routines intro in a DOM: the line's moment (`useLineReveal` with id `routines`, as App wires it) driving the
 * dialog (components/RoutinesIntro.tsx), "Turn on" (routinesIntro.ts) and the loop (routinesIntroArt.ts).
 *
 * What regresses: the two buttons stopping being equal (one styled as the primary, a different size class, a default
 * action: a form, a submit button, or first focus on "Turn on" so Enter picks it); "Turn on" not saving the switch as
 * Settings does, not opening the Routines page, or not putting the switch back and saying so when the save fails;
 * "No thanks", Escape or a click outside turning anything on, not being the line's Not now, or letting it show again;
 * it opening while a thread needs the person's answer (the line's held-back rule) or without the line; the dialog not
 * labelled, not keeping focus, or the picture not hidden from screen readers with its words beside it; the
 * `/create-routine` line naming a command this build does not have; the loop moving under reduced motion, or its still
 * losing what says "scheduled and repeating" (the schedule's label, the arrows, the count).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { createRoutineBuiltIn } = (hasDom ? await import('./components/RoutinesIntro') : {}) as typeof import('./components/RoutinesIntro');
const { useRoutinesReveal } = (hasDom ? await import('./components/useRoutinesReveal') : {}) as typeof import('./components/useRoutinesReveal');
const { routinesIntroHolds } = (hasDom ? await import('./routinesIntro') : {}) as typeof import('./routinesIntro');
const art = (hasDom ? await import('./routinesIntroArt') : {}) as typeof import('./routinesIntroArt');

const TIMES = { pageAgeMs: 0, readMs: 5_000, settledMs: 40, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedHash = '';
let posts: { path: string; body: Record<string, unknown> }[] = [];
let stamped = false;
let saveFails = false;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  savedHash = window.location.hash;
  posts = [];
  stamped = false;
  saveFails = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if ((init?.method ?? 'GET') === 'POST') posts.push({ path, body });
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/api/inbox/reveal')) {
      if (body.answer === 'not_now') return ok({ show: false, reveal: { next: null } });
      const show = !stamped;
      stamped = true;
      return ok({ show, reveal: { next: null } });
    }
    if (path.endsWith('/api/inbox/settings') && init?.method === 'POST') return saveFails ? ok({ error: 'config_not_saved' }, 500) : ok({ scheduled_threads: { on: true, login: 'added' } });
    if (path.includes('/skills')) return ok({ skills: [] });
    return ok({ error: 'not in this test' }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
  window.location.hash = savedHash;
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === undefined);
const notNows = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === 'not_now');
const switchSaves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings'));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="routines-intro"]');

interface State {
  /** Settings `reveal.next === 'routines'`. */
  due: boolean;
  /** The page is idle (its calm moment). */
  idle: boolean;
  /** A question waits in the open thread, or something is typed (App's `revealHeldBack`). */
  held: boolean;
}

type Settings = { scheduled_threads?: { on: boolean } };
let current: Settings | null = null;
let toasts: string[] = [];

/** App's wiring: the page's hook with the line's inputs, and the dialog it gives back. */
function Harness({ state }: { state: State }) {
  const [settings, setSettings] = useState<Settings | null>({ scheduled_threads: { on: false } });
  current = settings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { dialog } = useRoutinesReveal<Settings>({
    due: state.due,
    revealAt: { blocked: false, thread: null, rows: [], clear: true, place: '', heldBack: () => state.held, toast: false },
    idle: state.idle,
    listLoaded: true,
    firstRun: false,
    phone: false,
    settings: () => settingsRef.current,
    setSettings,
    showToast: (toast) => toasts.push(String(toast.lead)),
    dismissToast: () => {},
    refreshSettings: () => Promise.resolve(),
    openSettings: () => {},
  });
  return (
    <>
      <main className="ib-main">
        <h1>Inbox</h1>
        <button type="button" data-opener="">
          Something on the page
        </button>
      </main>
      {dialog}
    </>
  );
}

function mount(state: State) {
  current = null;
  toasts = [];
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

async function opened() {
  const set = mount({ due: true, idle: false, held: false });
  set({ idle: true });
  await until(() => dialog() !== null);
  return set;
}

describe.skipIf(!hasDom)('when it opens', () => {
  test('at the calm moment, through the line: one routines claim; never while a thread needs the person, and never without the line', async () => {
    const set = mount({ due: false, idle: true, held: false });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    set({ due: true, idle: false, held: true });
    set({ idle: true });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
    // The question answered (or the draft sent): it goes.
    set({ held: false });
    await until(() => dialog() !== null);
    expect(claims().map((c) => c.body)).toEqual([{ id: 'routines', key: expect.any(String) }]);
    expect(switchSaves()).toHaveLength(0);
    expect(current?.scheduled_threads?.on).toBe(false);
  });

  test('held: once Routines are on (or not offered), it is no longer worth showing', () => {
    expect(routinesIntroHolds({ scheduled_threads: { on: false } })).toBe(true);
    expect(routinesIntroHolds({ scheduled_threads: { on: true } })).toBe(false);
    expect(routinesIntroHolds({})).toBe(false);
    expect(routinesIntroHolds(null)).toBe(false);
  });
});

describe.skipIf(!hasDom)('two equal actions', () => {
  test('the same button, the same classes, neither the primary nor a ghost; no form, no submit, and first focus on the dialog so Enter picks nothing', async () => {
    await opened();
    const d = dialog()!;
    const no = d.querySelector<HTMLButtonElement>('[data-routines-intro-close]')!;
    const on = d.querySelector<HTMLButtonElement>('[data-routines-intro-on]')!;
    expect(no.textContent).toBe('No thanks');
    expect(on.textContent).toBe('Turn on');
    expect(on.className).toBe(no.className);
    for (const button of [no, on]) {
      expect(button.classList.contains('ib-pri')).toBe(false);
      expect(button.classList.contains('ib-ghost')).toBe(false);
      expect(button.type).toBe('button');
      expect(button.closest('form')).toBeNull();
    }
    expect(d.querySelectorAll('button')).toHaveLength(2);
    expect(document.activeElement).toBe(d);
    act(() => void d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    await wait(30);
    expect(dialog()).not.toBeNull();
    expect(switchSaves()).toHaveLength(0);
    expect(notNows()).toHaveLength(0);
  });

  test('keyboard: Tab goes in at "No thanks", then "Turn on", and wraps; never out of the dialog', async () => {
    await opened();
    const d = dialog()!;
    const no = d.querySelector<HTMLButtonElement>('[data-routines-intro-close]')!;
    const on = d.querySelector<HTMLButtonElement>('[data-routines-intro-on]')!;
    const tab = (shiftKey = false) => act(() => void (document.activeElement ?? d).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })));
    tab();
    expect(document.activeElement).toBe(no);
    act(() => on.focus());
    tab();
    expect(document.activeElement).toBe(no);
    tab(true);
    expect(document.activeElement).toBe(on);
  });
});

describe.skipIf(!hasDom)('the words and the picture', () => {
  test('labelled by its title, described by its sentence; the picture hidden from screen readers, its words beside it; Settings → Capabilities named', async () => {
    await opened();
    const d = dialog()!;
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toBe('Routines');
    expect(document.getElementById(d.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Save a prompt and pick when it runs. An agent runs it on this computer each time, and every run replies in its own thread.',
    );
    expect(d.querySelector('.ib-rti-art')!.getAttribute('aria-hidden')).toBe('true');
    expect(d.querySelector('[data-routines-intro-picture]')!.closest('[aria-hidden]')).toBeNull();
    expect(d.querySelector('[data-routines-intro-settings]')!.textContent).toContain('Settings → Capabilities');
  });

  test('the /create-routine line shows only when this build has that built-in', async () => {
    await opened();
    const line = dialog()!.querySelector('[data-routines-intro-skill]');
    expect(line !== null).toBe(createRoutineBuiltIn());
    if (line) expect(line.textContent).toContain('/create-routine');
  });
});

describe.skipIf(!hasDom)('Turn on', () => {
  test('one press: the switch saved as Settings saves it, on at once, and the Routines page opens; nothing sent as a Not now', async () => {
    await opened();
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-routines-intro-on]')!.click());
    expect(dialog()).toBeNull();
    expect(current?.scheduled_threads?.on).toBe(true);
    expect(window.location.hash).toBe('#routines');
    await until(() => switchSaves().length === 1);
    expect(switchSaves().map((s) => s.body)).toEqual([{ scheduled_threads: { on: true } }]);
    expect(notNows()).toHaveLength(0);
  });

  test("a save that fails: the switch goes back off and a toast says Routines aren't on", async () => {
    saveFails = true;
    await opened();
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-routines-intro-on]')!.click());
    await until(() => toasts.length === 1);
    expect(current?.scheduled_threads?.on).toBe(false);
    expect(toasts).toEqual(['Routines aren’t on']);
  });
});

describe.skipIf(!hasDom)('No thanks, Escape, a click outside', () => {
  for (const [name, way] of [
    ['No thanks', (d: HTMLDialogElement) => d.querySelector<HTMLButtonElement>('[data-routines-intro-close]')!.click()],
    ['Escape', (d: HTMLDialogElement) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside', (d: HTMLDialogElement) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ] as const) {
    test(`${name}: Routines stay off, the line's Not now is sent, and it never shows again`, async () => {
      const set = await opened();
      act(() => way(dialog()!));
      expect(dialog()).toBeNull();
      await until(() => notNows().length === 1);
      expect(notNows().map((p) => p.body)).toEqual([{ id: 'routines', answer: 'not_now' }]);
      expect(switchSaves()).toHaveLength(0);
      expect(current?.scheduled_threads?.on).toBe(false);
      expect(window.location.hash).not.toBe('#routines');
      // Another calm moment on this load: no second claim.
      set({ idle: false });
      set({ idle: true });
      await wait(TIMES.settledMs * 4);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
      // A reload: the Inbox stamped it, so the line no longer names it.
      act(() => root!.unmount());
      host!.remove();
      mount({ due: false, idle: true, held: false });
      await wait(TIMES.settledMs * 4);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
    });
  }
});

describe.skipIf(!hasDom)('the loop', () => {
  test('the count climbs one each lap, after the clock lets the token go; the token waits at the clock first', () => {
    const first = art.routinesLoopFrame(0);
    expect(first.count).toBe(art.ROUTINES_LOOP_FIRST_COUNT);
    expect(first.moving).toBe(false);
    expect(first.token).toBe(-90);
    expect(art.routinesLoopFrame(art.ROUTINES_LOOP_WAIT_MS + 10).count).toBe(art.ROUTINES_LOOP_FIRST_COUNT + 1);
    expect(art.routinesLoopFrame(art.ROUTINES_LOOP_LAP_MS + art.ROUTINES_LOOP_WAIT_MS + 10).count).toBe(art.ROUTINES_LOOP_FIRST_COUNT + 2);
    expect(art.routinesLoopFrame(art.ROUTINES_LOOP_WAIT_MS).hand).toBe(270);
  });

  function svgOf() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    document.body.appendChild(svg);
    return svg;
  }

  test('reduced motion: one still, no animation frame; it keeps the schedule, the arrows, the count and the token on its way to the agent', async () => {
    const savedRaf = globalThis.requestAnimationFrame;
    let frames = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames++;
      return savedRaf(cb);
    }) as typeof requestAnimationFrame;
    try {
      const svg = svgOf();
      const stop = art.playRoutinesLoop(svg, { phone: false }, true);
      await wait(60);
      expect(frames).toBe(0);
      const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent);
      expect(texts).toContain('Weekdays 9:00 AM');
      expect(texts).toContain('runs so far');
      expect(svg.querySelectorAll('[data-routines-loop-arrow]')).toHaveLength(3);
      expect(svg.querySelector('[data-routines-loop-count]')!.textContent).toBe(String(art.routinesLoopFrame(art.ROUTINES_LOOP_STILL_MS).count));
      const still = art.routinesLoopFrame(art.ROUTINES_LOOP_STILL_MS);
      expect(still.moving).toBe(true);
      expect(still.token).toBeGreaterThan(-90);
      expect(still.token).toBeLessThan(30);
      stop();

      const moving = svgOf();
      const stopMoving = art.playRoutinesLoop(moving, { phone: false }, false);
      await wait(60);
      expect(frames).toBeGreaterThan(0);
      stopMoving();
    } finally {
      globalThis.requestAnimationFrame = savedRaf;
    }
  });
});
