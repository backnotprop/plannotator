/**
 * Code review's one-time offer in a DOM (approval "code-review-offer-card", 2026-11-06): the page's moment
 * (codeReviewOffer.ts `useCodeReviewOffer`, on the line's `useLineReveal`) driving the Card (components/CodeReviewOffer.tsx),
 * as App wires them.
 *
 * What regresses: the offer opening over the tour's entry screen, its intro or the tour; not opening at once once they
 * are gone (it must not wait for a thread to be read and left, nor for the page to age: "show up like immediately");
 * opening without the line (`reveal.next` not `code_review`), when Code review is on, or after the Inbox refused the
 * claim; going around the line (no `POST /api/inbox/reveal` `code_review` claim); the agent note not waiting for it;
 * "Turn on code review" not saving the switch as Settings does; Not now, Escape or a click outside turning anything on,
 * not being the line's Not now, or letting it show again (on this load or the next); the dialog not labelled, not
 * keeping focus, or not giving it back; the art's hops playing under reduced motion.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { useCodeReviewOffer } = (hasDom ? await import('./codeReviewOffer') : {}) as typeof import('./codeReviewOffer');
const { CodeReviewOffer } = (hasDom ? await import('./components/CodeReviewOffer') : {}) as typeof import('./components/CodeReviewOffer');
const { playCodeReviewArt, CODE_REVIEW_ART_BEAT_MS } = (hasDom ? await import('./codeReviewOfferArt') : {}) as typeof import('./codeReviewOfferArt');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { turnOnFromReveal } = (hasDom ? await import('./revealTurnOn') : {}) as typeof import('./revealTurnOn');

const TIMES = { pageAgeMs: 60_000, readMs: 5_000, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let posts: { path: string; body: Record<string, unknown> }[] = [];
/** The Inbox's compare-and-set: the first claim shows it. */
let stamped = false;
/** Whether the Inbox grants the claim at all (false: another tab won, or it is no longer next). */
let grants = true;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
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
    if (path.endsWith('/api/inbox/settings') && init?.method === 'POST') return ok({ code_review: { on: true } });
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
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === undefined);
const notNows = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === 'not_now');
const switchSaves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings'));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="code-review-offer"]');

interface State {
  /** Settings `reveal.next === 'code_review'` at load. */
  due: boolean;
  blocked: boolean;
  /** The tour's entry screen (or its intro, or the tour) is on screen. */
  tourScreen: boolean;
  clear: boolean;
  held: boolean;
  toast: boolean;
  thread: string | null;
}

/** Day 0: the line has it next, the first-run screen with the tour's entry screen up. */
const DAY0: State = { due: true, blocked: false, tourScreen: true, clear: true, held: false, toast: false, thread: null };

/** What App holds: Code review on, and whether the agent note may go (it waits for the offer). */
let codeReviewOn = false;
let agentNoteMayGo = false;

function Harness({ state }: { state: State }) {
  const [settings, setSettings] = useState<{ code_review?: { on: boolean } } | null>({});
  codeReviewOn = settings?.code_review?.on === true;
  const offer = useCodeReviewOffer({
    due: state.due,
    blocked: state.blocked,
    tourScreen: state.tourScreen,
    thread: state.thread,
    rows: [],
    clear: state.clear,
    place: state.thread ?? '',
    heldBack: () => state.held,
    toast: state.toast,
    on: codeReviewOn,
  });
  agentNoteMayGo = offer.settled;
  return (
    <>
      <button type="button" data-opener="">
        Something on the page
      </button>
      {offer.stage === 'open' && (
        <CodeReviewOffer
          phone={false}
          onClose={() => {
            void inboxApi.revealNotNow('code_review');
            offer.close();
          }}
          onTurnOn={() =>
            void turnOnFromReveal('code_review', offer.close, {
              save: () => inboxApi.saveCodeReview(true).then((saved) => saved.code_review),
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
  codeReviewOn = false;
  agentNoteMayGo = false;
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

/** Day 0, the tour's entry screen dismissed: the offer opens. */
async function opened(state: Partial<State> = {}) {
  const set = mount({ ...DAY0, ...state });
  set({ tourScreen: false });
  await until(() => dialog() !== null);
  return set;
}

describe.skipIf(!hasDom)("Code review's offer on day 0", () => {
  test('never over the tour entry screen; at once after it, through the line (one code_review claim), before the agent note; Turn on turns Code review on', async () => {
    const set = mount(DAY0);
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(agentNoteMayGo).toBe(false);
    // The entry screen gone: no thread read and left, no minute of page age; the settling wait only.
    set({ tourScreen: false });
    await until(() => dialog() !== null, TIMES.settledMs * 10);
    expect(dialog()).not.toBeNull();
    expect(claims().map((c) => c.body)).toEqual([{ id: 'code_review', key: expect.any(String) }]);
    // Showing it turns nothing on, and the agent note still waits.
    expect(switchSaves()).toHaveLength(0);
    expect(codeReviewOn).toBe(false);
    expect(agentNoteMayGo).toBe(false);
    const on = dialog()!.querySelector<HTMLButtonElement>('[data-code-review-offer-on]')!;
    expect(on.textContent).toBe('Turn on code review');
    act(() => on.click());
    expect(dialog()).toBeNull();
    expect(codeReviewOn).toBe(true);
    await until(() => switchSaves().length === 1);
    expect(switchSaves().map((s) => s.body)).toEqual([{ code_review: { on: true } }]);
    expect(notNows()).toHaveLength(0);
    expect(agentNoteMayGo).toBe(true);
  });

  test('the tour (its intro or the tour itself) holds it the same way; the tour finished, it opens', async () => {
    const set = mount({ ...DAY0, tourScreen: true });
    await wait(TIMES.settledMs * 4);
    expect(dialog()).toBeNull();
    set({ tourScreen: false });
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
  });

  for (const [name, way] of [
    ['Not now', (d: HTMLDialogElement) => d.querySelector<HTMLButtonElement>('[data-code-review-offer-close]')!.click()],
    ['Escape', (d: HTMLDialogElement) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside', (d: HTMLDialogElement) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ] as const) {
    test(`${name}: Code review stays off, the line's Not now is sent, and it never shows again (this load or a reload)`, async () => {
      const set = await opened();
      act(() => way(dialog()!));
      expect(dialog()).toBeNull();
      await until(() => notNows().length === 1);
      expect(notNows().map((p) => p.body)).toEqual([{ id: 'code_review', answer: 'not_now' }]);
      expect(switchSaves()).toHaveLength(0);
      expect(codeReviewOn).toBe(false);
      expect(agentNoteMayGo).toBe(true);
      // The page clears and settles again: no second claim.
      set({ clear: false });
      set({ clear: true });
      await wait(TIMES.settledMs * 4);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
      // A reload: the Inbox stamped it, so `reveal.next` is no longer code_review; and a claim would be refused.
      act(() => root!.unmount());
      host!.remove();
      mount({ ...DAY0, tourScreen: false, due: false });
      await wait(TIMES.settledMs * 4);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
    });
  }

  test('not armed by the line (Code review decided, held, or another dialog next): no claim, and the agent note need not wait', async () => {
    mount({ ...DAY0, tourScreen: false, due: false });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
    expect(agentNoteMayGo).toBe(true);
  });

  test('another one-time dialog on this load (an update, the sound): blocked, no claim', async () => {
    mount({ ...DAY0, tourScreen: false, blocked: true });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    expect(agentNoteMayGo).toBe(true);
  });

  test('a reply being typed or a question waiting holds it; once the page is free it opens', async () => {
    const set = mount({ ...DAY0, held: true });
    set({ tourScreen: false });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    set({ held: false });
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
  });

  test('a page not clear (Settings, a file, a search): it waits; clear again, it opens', async () => {
    const set = mount({ ...DAY0, clear: false });
    set({ tourScreen: false });
    await wait(TIMES.settledMs * 4);
    expect(claims()).toHaveLength(0);
    set({ clear: true });
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
  });

  test('the Inbox refuses the claim (another tab showed it): nothing drawn, and the agent note may go', async () => {
    grants = false;
    const set = mount(DAY0);
    set({ tourScreen: false });
    await until(() => claims().length === 1);
    await wait(TIMES.settledMs * 3);
    expect(dialog()).toBeNull();
    expect(agentNoteMayGo).toBe(true);
  });

  test('an accessible dialog: labelled by its title, described by its list, first focus on the dialog, kept inside on Tab, given back on close', async () => {
    const set = mount(DAY0);
    document.querySelector<HTMLButtonElement>('[data-opener]')!.focus();
    set({ tourScreen: false });
    await until(() => dialog() !== null);
    const d = dialog()!;
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toBe('Code review, in your Inbox');
    expect(document.getElementById(d.getAttribute('aria-describedby')!)!.querySelectorAll('li')).toHaveLength(3);
    expect(d.getAttribute('aria-modal')).toBe('true');
    const on = d.querySelector<HTMLButtonElement>('[data-code-review-offer-on]')!;
    const notNow = d.querySelector<HTMLButtonElement>('[data-code-review-offer-close]')!;
    const tab = (shiftKey = false) => act(() => void (document.activeElement ?? d).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })));
    // First focus on the dialog itself (the approved Card: its name is read, no ring, Enter turns nothing on).
    expect(document.activeElement).toBe(d);
    // Tab goes in at the first button, Shift+Tab at the last; from the edges it wraps, never out.
    tab();
    expect(document.activeElement).toBe(notNow);
    tab(true);
    expect(document.activeElement).toBe(on);
    tab();
    expect(document.activeElement).toBe(notNow);
    act(() => d.focus());
    tab(true);
    expect(document.activeElement).toBe(on);
    // The art is decoration only.
    expect(d.querySelector('.ib-cro-art')!.getAttribute('aria-hidden')).toBe('true');
    act(() => notNow.click());
    expect(document.activeElement).toBe(document.querySelector('[data-opener]'));
  });
});

describe.skipIf(!hasDom)("the offer's art", () => {
  /** A canvas that counts the frames drawn into it. */
  function countingCanvas() {
    let frames = 0;
    const canvas = {
      getContext: () => {
        frames++;
        return null;
      },
      getBoundingClientRect: () => ({ width: 540, height: 200 }),
    } as unknown as HTMLCanvasElement;
    return { canvas, frames: () => frames };
  }

  test('three stepped hops after the first frame, then it holds; under reduced motion only the sorted frame', async () => {
    const moving = countingCanvas();
    const stopMoving = playCodeReviewArt(moving.canvas, { unit: 14, seed: 7, cx: 0.5 }, false);
    const still = countingCanvas();
    const stopStill = playCodeReviewArt(still.canvas, { unit: 14, seed: 7, cx: 0.5 }, true);
    await wait(CODE_REVIEW_ART_BEAT_MS * 6);
    expect(moving.frames()).toBe(4);
    expect(still.frames()).toBe(1);
    stopMoving();
    stopStill();
  });
});
