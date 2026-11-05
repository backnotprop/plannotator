/**
 * Bro mode's one-time offer in a DOM (approval "bro-mode"): the calm-moment gate (reveal.ts `useBroReveal`) driving
 * `BroIntro`, as App wires them.
 *
 * What regresses: the card showing on load, or for a thread left too soon or on another thread, too young a page, the
 * tour or another one-time dialog this load, a toast, or something typed; a list too short holding it back (it is for
 * everyone); Bro mode turned on by the card showing or by any way out but "Turn it on"; "Turn it on" not saving the
 * switch; a second claim after any way out; the card opening once another window turned it on.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { BroIntro } = (hasDom ? await import('./components/BroIntro') : {}) as typeof import('./components/BroIntro');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { turnOnFromReveal } = (hasDom ? await import('./revealTurnOn') : {}) as typeof import('./revealTurnOn');

const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let grants = true;
let held = false;
let setOnElsewhere: (on: boolean) => void = () => {};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  posts = [];
  grants = true;
  held = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path.endsWith('/api/inbox/reveal')) return json({ show: grants, reveal: { next: null }, board: { on: false } });
    if (path.endsWith('/api/inbox/settings')) return json({ bro: { on: true } });
    return new Response('{}', { status: 404 });
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
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal'));
const saves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings'));
const card = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="bro-intro"]');
const press = (selector: string) => act(() => document.querySelector<HTMLButtonElement>(selector)!.click());

const ROW = { thread_id: 'msg_a', section: 'sent', unseen: 0 } as InboxListRow;

interface State {
  due: boolean;
  blocked: boolean;
  firstRun: boolean;
  toast: boolean;
  thread: string | null;
}

const BASE: State = { due: true, blocked: false, firstRun: false, toast: false, thread: 'msg_a' };

let shownOn = false;

function Harness({ state }: { state: State }) {
  const [settings, setSettings] = useState<{ bro?: { on: boolean } } | null>({ bro: { on: false } });
  shownOn = settings?.bro?.on === true;
  setOnElsewhere = (on) => setSettings({ bro: { on } });
  const r = reveal.useBroReveal({
    due: state.due,
    listLoaded: true,
    firstRun: state.firstRun,
    blocked: state.blocked,
    rows: [ROW],
    toast: state.toast,
    thread: state.thread,
    clear: true,
    place: state.thread ?? '',
    heldBack: () => held,
    on: shownOn,
  });
  if (r.stage !== 'open') return null;
  return (
    <BroIntro
      phone={false}
      onClose={r.close}
      onTurnOn={() =>
        void turnOnFromReveal('bro', r.close, {
          save: () => inboxApi.saveBro(true).then((saved) => saved.bro),
          setSettings,
          showToast: () => {},
          dismissToast: () => {},
          refreshSettings: () => Promise.resolve(),
          openSettings: () => {},
        })
      }
    />
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
  return (next: State) => act(() => root!.render(<Harness state={next} />));
}

/** The page old enough and the thread read: what comes next is leaving it. */
async function readThread(state: State = BASE) {
  const render = mount(state);
  await wait(TIMES.pageAgeMs + 20);
  return render;
}

describe.skipIf(!hasDom)('the Bro mode offer', () => {
  test('never on load; at the calm moment back on the list it opens, with one row in the list, and nothing is on', async () => {
    const render = await readThread();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    expect(card()).not.toBeNull();
    expect(claims()).toHaveLength(1);
    expect(claims()[0]!.body.id).toBe('bro');
    expect(saves()).toHaveLength(0);
    expect(shownOn).toBe(false);
  });

  for (const [name, state, age] of [
    ['a page too young', {}, 0],
    ['the tour or another one-time dialog this load', { blocked: true }, TIMES.pageAgeMs + 20],
    ['the first-run screen', { firstRun: true }, TIMES.pageAgeMs + 20],
    ['not next in the queue', { due: false }, TIMES.pageAgeMs + 20],
  ] as const) {
    test(`held back by ${name}`, async () => {
      const render = mount({ ...BASE, ...state });
      if (age) await wait(age);
      render({ ...BASE, ...state, thread: null });
      await wait(TIMES.settledMs + 80);
      expect(card()).toBeNull();
      expect(claims()).toHaveLength(0);
    });
  }

  test('leaving for another thread is not the moment', async () => {
    const render = await readThread();
    render({ ...BASE, thread: 'msg_b' });
    await wait(TIMES.settledMs + 80);
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test('something typed waits while the moment lasts, then it opens', async () => {
    held = true;
    const render = await readThread();
    render({ ...BASE, thread: null });
    await wait(TIMES.settledMs + 80);
    expect(claims()).toHaveLength(0);
    held = false;
    await until(() => card() !== null);
    expect(card()).not.toBeNull();
  });

  test('another window turned it on: the offer no longer opens', async () => {
    const render = await readThread();
    act(() => setOnElsewhere(true));
    render({ ...BASE, thread: null });
    await wait(TIMES.settledMs + 80);
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test("the credit's links open the person and the repo in a new tab, never in place of the Inbox", async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    const links = [...card()!.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel.includes('noopener')])).toEqual([
      ['@dillon_mullroy', 'https://x.com/dillon_mullroy', '_blank', true],
      ['backnotprop/bro', 'https://github.com/backnotprop/bro', '_blank', true],
    ]);
  });

  test('refused: no card', async () => {
    grants = false;
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => claims().length === 1);
    await wait(40);
    expect(card()).toBeNull();
  });

  test('Not now closes it for good and writes nothing', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    press('[data-bro-intro-close]');
    expect(card()).toBeNull();
    expect(saves()).toHaveLength(0);
    expect(shownOn).toBe(false);
    // The next visit and leave asks nothing more.
    render({ ...BASE, thread: 'msg_a' });
    await wait(TIMES.readMs + 10);
    render({ ...BASE, thread: null });
    await wait(TIMES.settledMs + 80);
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(1);
  });

  test('Escape closes it and writes nothing', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    act(() => {
      card()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await until(() => card() === null);
    expect(card()).toBeNull();
    expect(saves()).toHaveLength(0);
  });

  test('Turn it on saves the switch and closes', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    press('[data-bro-intro-on]');
    expect(card()).toBeNull();
    await until(() => saves().length === 1);
    expect(saves()[0]!.body.bro).toEqual({ on: true });
    expect(shownOn).toBe(true);
  });
});
