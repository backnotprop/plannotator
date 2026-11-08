/**
 * Shape's one-time offer in a DOM (approval "shape-turn-on-dialog", 2026-11-08): the page's moment (shapeOffer.ts
 * `useShapeOffer`, on the line's `useLineReveal`) driving the dialog (components/ShapeOffer.tsx), as App wires them.
 *
 * What regresses: the offer opening without the line (`reveal.next` not `shape`: Shape on or decided, held, or
 * another dialog next), on a load that showed another one-time dialog, while Shape is on, or after the Inbox refused
 * the claim; opening at load, or on a leave that is not its moment (a short message, a thread not read long enough,
 * on to another thread); going around the line (no `POST /api/inbox/reveal` `shape` claim); showing it turning
 * anything on; "Turn on Shape" not saving the Shape switch as Settings does; Not now, Escape or a click outside
 * turning anything on, not being the line's Not now, or letting it show again (on this load or the next); the dialog
 * not labelled, not keeping focus, or not starting on the dialog itself; the picture not drawn by the real Shape
 * renderer, reachable by assistive tech or the keyboard, or moving under reduced motion.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxThread } from '@plannotator/core/inbox-types';
import { bridgeSanitizerDom } from '../../tests/helpers/chat-sanitizer-dom';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { useShapeOffer } = (hasDom ? await import('./shapeOffer') : {}) as typeof import('./shapeOffer');
const { ShapeOffer, preloadShapeOfferArt } = (hasDom ? await import('./components/ShapeOffer') : {}) as typeof import('./components/ShapeOffer');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { turnOnFromReveal } = (hasDom ? await import('./revealTurnOn') : {}) as typeof import('./revealTurnOn');

const TIMES = { pageAgeMs: 0, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };
const SHAPE = { minWords: 150, readMs: 120 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedShape: typeof reveal.SHAPE_REVEAL;
let savedMatchMedia: typeof window.matchMedia;
let posts: { path: string; body: Record<string, unknown> }[] = [];
/** The Inbox's compare-and-set: the first claim shows it. */
let stamped = false;
/** Whether the Inbox grants the claim at all (false: another tab won, or it is no longer next). */
let grants = true;

// happy-dom cannot host DOMPurify as it stands (the Shape renderer sanitizes the picture's board): the chat folder's
// bridge makes it, for the whole file, as the sanitizer decides once per page.
let unbridge: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => {
  unbridge?.();
  unbridge = null;
});

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedShape = { ...reveal.SHAPE_REVEAL };
  Object.assign(reveal.SHAPE_REVEAL, SHAPE);
  savedMatchMedia = window.matchMedia;
  savedFetch = globalThis.fetch;
  posts = [];
  stamped = false;
  grants = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if ((init?.method ?? 'GET') === 'POST') posts.push({ path, body });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/api/inbox/reveal')) {
      if (body.answer === 'not_now') return ok({ show: false, reveal: { next: null }, board: { on: false } });
      const show = grants && !stamped;
      stamped = true;
      return ok({ show, reveal: { next: null }, board: { on: false } });
    }
    if (path.endsWith('/api/inbox/settings') && init?.method === 'POST') return ok({ shape: { on: true } });
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
  globalThis.fetch = savedFetch;
  window.matchMedia = savedMatchMedia;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
  Object.assign(reveal.SHAPE_REVEAL, savedShape);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === undefined);
const notNows = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === 'not_now');
const switchSaves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings'));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="shape-offer"]');

function row(id: string): InboxListRow {
  return { thread_id: id, section: 'sent', unseen: 0, snoozed: false, questions: { open: 0 }, project: { id: 'prj_1', name: 'billing' } } as unknown as InboxListRow;
}
const ROWS = ['t_long', 't_short', 't_c', 't_d', 't_e'].map(row);

/** The window loaded each thread: `t_long`'s newest agent message is long, `t_short`'s is not. */
function noteThreads() {
  const thread = (id: string, words: number) =>
    ({
      thread_id: id,
      messages: [
        { author: { kind: 'agent', host: 'claude-code', session: 'ses_a' }, body: 'short' },
        { author: { kind: 'agent', host: 'claude-code', session: 'ses_a' }, body: Array.from({ length: words }, (_, i) => `word${i}`).join(' ') },
      ],
    }) as unknown as InboxThread;
  reveal.noteRevealThread(thread('t_long', 180));
  reveal.noteRevealThread(thread('t_short', 40));
}

interface State {
  /** Settings `reveal.next === 'shape'` at load. */
  due: boolean;
  /** Another one-time dialog, the tour or an update on this load. */
  blocked: boolean;
  clear: boolean;
  held: boolean;
  toast: boolean;
  thread: string | null;
  /** Shape on at load (Settings, another window). */
  shapeOnAtLoad: boolean;
  phone: boolean;
}

const BASE: State = { due: true, blocked: false, clear: true, held: false, toast: false, thread: null, shapeOnAtLoad: false, phone: false };

/** What App holds: Shape on. */
let shapeOn = false;

function Harness({ state }: { state: State }) {
  const [settings, setSettings] = useState<{ shape?: { on: boolean } } | null>({ shape: { on: state.shapeOnAtLoad } });
  shapeOn = settings?.shape?.on === true;
  const offer = useShapeOffer({
    due: state.due,
    blocked: state.blocked,
    listLoaded: true,
    firstRun: false,
    thread: state.thread,
    rows: ROWS,
    clear: state.clear,
    place: state.thread ?? '',
    heldBack: () => state.held,
    toast: state.toast,
    on: shapeOn,
    preload: preloadShapeOfferArt,
  });
  return (
    <>
      <main className="ib-main">
        <h1>Inbox</h1>
        <button type="button" data-opener="">
          Something on the page
        </button>
      </main>
      {offer.stage === 'open' && (
        <ShapeOffer
          phone={state.phone}
          onClose={() => {
            void inboxApi.revealNotNow('shape');
            offer.close();
          }}
          onTurnOn={() =>
            void turnOnFromReveal('shape', offer.close, {
              save: () => inboxApi.saveShape(true).then((saved) => saved.shape),
              setSettings,
              showToast: () => {},
              dismissToast: () => {},
              refreshSettings: () => Promise.resolve(),
              openSettings: () => {},
            })
          }
        />
      )}
    </>
  );
}

function mount(state: State) {
  shapeOn = false;
  noteThreads();
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

/** Open a thread, read it for `ms`, then go back to the list (or on to `then`). */
async function readAndLeave(set: (next: Partial<State>) => void, thread: string, ms = SHAPE.readMs + 20, then: string | null = null) {
  set({ thread });
  await wait(ms);
  set({ thread: then });
}

async function opened(state: Partial<State> = {}) {
  const set = mount({ ...BASE, ...state });
  await readAndLeave(set, 't_long');
  await until(() => dialog() !== null);
  return set;
}

describe.skipIf(!hasDom)("Shape's offer", () => {
  test('never at load; back on the list from a long agent message read, one shape claim, nothing turned on; Turn on Shape saves the Shape switch', async () => {
    const set = mount(BASE);
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    await readAndLeave(set, 't_long');
    await until(() => dialog() !== null);
    expect(claims().map((c) => c.body)).toEqual([{ id: 'shape', key: expect.any(String) }]);
    // Showing it turns nothing on.
    expect(switchSaves()).toHaveLength(0);
    expect(shapeOn).toBe(false);
    const on = dialog()!.querySelector<HTMLButtonElement>('[data-shape-offer-on]')!;
    act(() => on.click());
    expect(dialog()).toBeNull();
    expect(shapeOn).toBe(true);
    await until(() => switchSaves().length === 1);
    expect(switchSaves().map((s) => s.body)).toEqual([{ shape: { on: true } }]);
    expect(notNows()).toHaveLength(0);
  });

  test('not its moment: a short message, a long one not read long enough, or on to another thread; no claim', async () => {
    const set = mount(BASE);
    await readAndLeave(set, 't_short');
    await wait(TIMES.settledMs * 4);
    await readAndLeave(set, 't_long', 20);
    await wait(TIMES.settledMs * 4);
    await readAndLeave(set, 't_long', SHAPE.readMs + 20, 't_c');
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  for (const [name, way] of [
    ['Not now', (d: HTMLDialogElement) => d.querySelector<HTMLButtonElement>('[data-shape-offer-close]')!.click()],
    ['Escape', (d: HTMLDialogElement) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside', (d: HTMLDialogElement) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ] as const) {
    test(`${name}: Shape stays off, the line's Not now is sent, and it never shows again (this load or a reload)`, async () => {
      const set = await opened();
      act(() => way(dialog()!));
      expect(dialog()).toBeNull();
      await until(() => notNows().length === 1);
      expect(notNows().map((p) => p.body)).toEqual([{ id: 'shape', answer: 'not_now' }]);
      expect(switchSaves()).toHaveLength(0);
      expect(shapeOn).toBe(false);
      // Its moment again on this load: no second claim.
      await readAndLeave(set, 't_long');
      await wait(TIMES.settledMs * 4);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
      // A reload: the Inbox stamped it, so `reveal.next` is no longer shape.
      act(() => root!.unmount());
      host!.remove();
      const again = mount({ ...BASE, due: false });
      await readAndLeave(again, 't_long');
      await wait(TIMES.settledMs * 4);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
    });
  }

  test('not armed by the line (Shape decided or held, or another dialog next): no claim at its moment', async () => {
    const set = mount({ ...BASE, due: false });
    await readAndLeave(set, 't_long');
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('Shape already on (Settings here, another window): never offered, even when the line still names it', async () => {
    const set = mount({ ...BASE, shapeOnAtLoad: true });
    await readAndLeave(set, 't_long');
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('another one-time dialog on this load (the tour, an update, the star card): blocked, no claim', async () => {
    const set = mount({ ...BASE, blocked: true });
    await readAndLeave(set, 't_long');
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('a reply being typed or a question waiting holds it; free again while the moment lasts, it opens', async () => {
    const set = mount({ ...BASE, held: true });
    await readAndLeave(set, 't_long');
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    set({ held: false });
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
  });

  test('the Inbox refuses the claim (another tab showed it): nothing drawn', async () => {
    grants = false;
    const set = mount(BASE);
    await readAndLeave(set, 't_long');
    await until(() => claims().length === 1);
    await wait(TIMES.settledMs * 3);
    expect(dialog()).toBeNull();
  });

  test('an accessible dialog: labelled by its title, described by its lines, first focus on the dialog, Tab to Not now then Turn on Shape, kept inside', async () => {
    const set = mount(BASE);
    document.querySelector<HTMLButtonElement>('[data-opener]')!.focus();
    await readAndLeave(set, 't_long');
    await until(() => dialog() !== null);
    const d = dialog()!;
    const title = document.getElementById(d.getAttribute('aria-labelledby')!)!;
    expect(title).toBe(d.querySelector('h2')!);
    expect(title.textContent!.trim()).not.toBe('');
    const lines = [...document.getElementById(d.getAttribute('aria-describedby')!)!.querySelectorAll('li')];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((li) => d.contains(li) && li.textContent!.trim() !== '')).toBe(true);
    expect(d.getAttribute('aria-modal')).toBe('true');
    const on = d.querySelector<HTMLButtonElement>('[data-shape-offer-on]')!;
    const notNow = d.querySelector<HTMLButtonElement>('[data-shape-offer-close]')!;
    const tab = (shiftKey = false) => act(() => void (document.activeElement ?? d).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })));
    // First focus on the dialog itself: its name is read, no ring, Enter turns nothing on.
    expect(document.activeElement).toBe(d);
    // Tab goes to Not now first, then Turn on Shape: the dialog's only two stops, in that order.
    expect([...d.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]).toEqual([notNow, on]);
    tab();
    expect(document.activeElement).toBe(notNow);
    // From the edges it wraps, never out.
    act(() => on.focus());
    tab();
    expect(document.activeElement).toBe(notNow);
    tab(true);
    expect(document.activeElement).toBe(on);
    act(() => d.focus());
    tab(true);
    expect(document.activeElement).toBe(on);
    act(() => notNow.click());
    expect(document.activeElement).toBe(document.querySelector('[data-opener]'));
  });
});

describe.skipIf(!hasDom)("the offer's picture", () => {
  /** The board the real Shape renderer drew in the dialog's picture (its shadow root), once its chunk is in. */
  async function drawnBoard(): Promise<HTMLElement | null> {
    let board: HTMLElement | null = null;
    await until(() => {
      const art = dialog()?.querySelector('[data-shape-offer-board] .shp-drawn-host');
      board = (art?.shadowRoot?.querySelector('.board') as HTMLElement | null) ?? null;
      return board !== null && board.querySelector('svg') !== null;
    });
    return board;
  }

  test('a board drawn by the Shape renderer, hidden from assistive tech and inert, with nothing in it to focus', async () => {
    await opened();
    const art = dialog()!.querySelector<HTMLElement>('.ib-sho-art')!;
    expect(art.getAttribute('aria-hidden')).toBe('true');
    expect(art.hasAttribute('inert')).toBe(true);
    const board = await drawnBoard();
    expect(board).not.toBeNull();
    expect(board!.querySelectorAll('[data-step]').length).toBeGreaterThan(0);
    expect(board!.querySelector('a, button, [tabindex]')).toBeNull();
  });

  test('under reduced motion it is still: drawn at once, no draw-on', async () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    await opened();
    const board = await drawnBoard();
    expect(board!.classList.contains('entering')).toBe(false);
  });

  test('with motion its lines draw on once', async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    await opened();
    const board = await drawnBoard();
    expect(board!.classList.contains('entering')).toBe(true);
    expect(board!.querySelectorAll('.draw').length).toBeGreaterThan(0);
  });
});
