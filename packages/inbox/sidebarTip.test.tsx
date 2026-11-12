/**
 * The Sidebar tip in a DOM (sidebarTip.ts): its hook (`useSidebarTip`) driving `SidebarTipCard` beside a sidebar, as
 * App wires them.
 *
 * What regresses: the tip showing on load, or to an Inbox that does not report it due (already shown, or the sidebar
 * already customized); a claim spent while the sidebar is closed, or while another one-time dialog is claiming, open
 * or was shown on this load (the tip must stand down unclaimed, so a later load still has it); the other reveals not
 * held back once it is up; the card shown after the Inbox refused the claim (another window showed it); focus moving
 * to the card; Got it, Escape, a right-click on the sidebar or the Customize panel not closing it; Escape taken from
 * a menu that is open over it; a second claim after it closed; the arrow a different colour from its card (this one
 * and the Launch tip's), which happened when another component's rule for the same class name repainted the card.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const launchCard = (hasDom ? await import('./compose/LaunchTipCard') : {}) as typeof import('./compose/LaunchTipCard');
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const tip = (hasDom ? await import('./sidebarTip') : {}) as typeof import('./sidebarTip');
const cardModule = (hasDom ? await import('./components/SidebarTipCard') : {}) as typeof import('./components/SidebarTipCard');

const TIMES = { pageAgeMs: 120, readMs: 60, settledMs: 60, momentMs: 600, recheckMs: 20, claimRetryMs: 30, broReadMs: 120 };
const TIP_TIMES = { yieldMs: 80, leaveMs: 20 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedTipTimes: typeof tip.SIDEBAR_TIP_TIMES;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let answerShow = true;
let said: string[] = [];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedTipTimes = { ...tip.SIDEBAR_TIP_TIMES };
  Object.assign(tip.SIDEBAR_TIP_TIMES, TIP_TIMES);
  reveal.resetOneTimeDialogShownForTests();
  savedFetch = globalThis.fetch;
  posts = [];
  said = [];
  answerShow = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path.endsWith('/api/inbox/reveal')) return json({ show: answerShow, reveal: { next: null }, board: { on: false } });
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
  Object.assign(tip.SIDEBAR_TIP_TIMES, savedTipTimes);
  reveal.resetOneTimeDialogShownForTests();
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal'));
const card = () => document.querySelector<HTMLElement>('[data-sidebar-tip]');
/** Long enough for a moment to settle, the tip to yield and a claim to come back. */
const settle = () => wait(TIMES.settledMs + TIP_TIMES.yieldMs + 120);

const ROW = { thread_id: 'msg_a', section: 'sent', unseen: 0 } as InboxListRow;

interface State {
  due: boolean;
  blocked: boolean;
  sidebar: boolean;
  thread: string | null;
  idle: boolean;
  customizing: boolean;
  held: boolean;
}

const BASE: State = { due: true, blocked: false, sidebar: true, thread: 'msg_a', idle: false, customizing: false, held: false };
let now: State = BASE;

function Harness({ state }: { state: State }) {
  now = state;
  const r = tip.useSidebarTip({
    due: state.due,
    blocked: state.blocked,
    sidebar: state.sidebar,
    listLoaded: true,
    firstRun: false,
    thread: state.thread,
    rows: [ROW],
    clear: true,
    place: state.thread ?? '',
    heldBack: () => now.held,
    toast: false,
    idle: state.idle,
  });
  return (
    <>
      {state.sidebar && (
        <aside className="ib-side">
          <button type="button" data-inbox-nav="">
            Inbox
          </button>
        </aside>
      )}
      <textarea data-reply="" />
      {r.stage === 'open' && <cardModule.SidebarTipCard gone={!state.sidebar || state.customizing} onSay={(text) => said.push(text)} onLeave={r.close} />}
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
  return (next: State) => act(() => root!.render(<Harness state={next} />));
}

/** A thread read on a page old enough: what comes next is leaving it. */
async function readThread(state: State = BASE) {
  const render = mount(state);
  await wait(Math.max(TIMES.readMs, TIMES.pageAgeMs) + 20);
  return render;
}

/** The tip on screen, after a thread read and left. */
async function shown(state: State = BASE) {
  const render = await readThread(state);
  render({ ...state, thread: null });
  await until(() => card() !== null);
  expect(card()).not.toBeNull();
  return render;
}

describe.skipIf(!hasDom)('the Sidebar tip', () => {
  test('never on load; after a thread read and left it claims once, opens with its words and one button, and never takes focus', async () => {
    const render = await readThread();
    const reply = document.querySelector<HTMLTextAreaElement>('[data-reply]')!;
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    expect(claims().map((c) => c.body.id)).toEqual(['sidebar_tip']);
    expect(typeof claims()[0]!.body.key).toBe('string');
    const words = tip.SIDEBAR_TIP_WORDS;
    expect(card()!.querySelector('.ib-tc-eb')!.textContent).toBe(words.eyebrow);
    expect(card()!.querySelector('h2')!.textContent).toBe(words.title);
    expect(card()!.querySelector('p')!.textContent).toBe(words.line);
    expect([...card()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([words.ok]);
    expect(card()!.getAttribute('role')).toBe('group');
    expect(card()!.contains(document.activeElement)).toBe(false);
    expect(said).toEqual([tip.SIDEBAR_TIP_SAID]);
    // Once it is up, the other one-time dialogs hold back for the gap, and no longer than that: a tab left open gets
    // the next dialog once it is over (the stuck-tab bug: a hold "for the rest of the load" never ended).
    expect(reveal.oneTimeDialogShownThisLoad()).toBe(true);
    const gap = reveal.REVEAL_TIMES.otherDialogMs;
    reveal.REVEAL_TIMES.otherDialogMs = 60;
    await wait(80);
    expect(reveal.oneTimeDialogShownThisLoad()).toBe(false);
    reveal.REVEAL_TIMES.otherDialogMs = gap;
    reply.focus();
    expect(document.activeElement).toBe(reply);
  });

  test('a thread kept open: the page going idle is the moment too', async () => {
    const render = await readThread();
    render({ ...BASE, idle: true });
    await until(() => card() !== null);
    expect(claims().map((c) => c.body.id)).toEqual(['sidebar_tip']);
  });

  test('an Inbox that does not report it due (shown before, or the sidebar already customized): no claim, no card', async () => {
    const render = await readThread({ ...BASE, due: false });
    render({ ...BASE, due: false, thread: null });
    await settle();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test('the Inbox refuses the claim (another window showed it, or the sidebar was customized meanwhile): no card', async () => {
    answerShow = false;
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => claims().length > 0);
    await settle();
    expect(claims()).toHaveLength(1);
    expect(card()).toBeNull();
  });

  test('the sidebar closed: nothing is claimed, so a later load still has it', async () => {
    const render = await readThread({ ...BASE, sidebar: false });
    render({ ...BASE, sidebar: false, thread: null });
    await settle();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test('another one-time dialog on this load: blocked, it claims nothing', async () => {
    const render = await readThread({ ...BASE, blocked: true });
    render({ ...BASE, blocked: true, thread: null });
    await settle();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test('another reveal takes the same moment: the tip yields and stands down unclaimed', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    // The moment settles; the other reveal's claim lands while the tip yields.
    await wait(TIMES.settledMs + 30);
    expect(claims()).toHaveLength(0);
    render({ ...BASE, thread: null, blocked: true });
    await settle();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
    expect(reveal.oneTimeDialogShownThisLoad()).toBe(false);
  });

  test('another dialog shown on this load while the tip yields (its note, no stage): the tip stands down unclaimed', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    await wait(TIMES.settledMs + 30);
    reveal.noteOneTimeDialogShown();
    await settle();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test('something typed or open at its moment: it waits unclaimed, and shows once the page is free', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null, held: true });
    await settle();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
    render({ ...BASE, thread: null, held: false });
    await until(() => card() !== null);
    expect(claims()).toHaveLength(1);
  });

  test('Got it closes it for good: the next moment claims nothing', async () => {
    const render = await shown();
    act(() => document.querySelector<HTMLButtonElement>('[data-sidebar-tip-ok]')!.click());
    await until(() => card() === null);
    expect(card()).toBeNull();
    render({ ...BASE, thread: 'msg_a' });
    await wait(TIMES.readMs + 20);
    render({ ...BASE, thread: null });
    await settle();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(1);
  });

  test('Escape closes only the tip, and is left to a menu open over the page', async () => {
    await shown();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    host!.appendChild(menu);
    const toMenu = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(toMenu));
    await wait(TIP_TIMES.leaveMs + 30);
    expect(toMenu.defaultPrevented).toBe(false);
    expect(card()).not.toBeNull();
    menu.remove();
    let reached = false;
    const below = () => {
      reached = true;
    };
    document.body.addEventListener('keydown', below);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(escape));
    document.body.removeEventListener('keydown', below);
    await until(() => card() === null);
    expect(card()).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    expect(reached).toBe(false);
  });

  test('a right-click on the sidebar closes it (the menu it is about); one elsewhere does not', async () => {
    await shown();
    act(() => void document.querySelector('[data-reply]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await wait(TIP_TIMES.leaveMs + 30);
    expect(card()).not.toBeNull();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => void document.querySelector('[data-inbox-nav]')!.dispatchEvent(event));
    await until(() => card() === null);
    expect(card()).toBeNull();
    // The sidebar's own handler still gets it.
    expect(event.defaultPrevented).toBe(false);
  });

  test('the Customize panel opening, or the sidebar closing, takes it away', async () => {
    const render = await shown();
    render({ ...BASE, thread: null, customizing: true });
    await until(() => card() === null);
    expect(card()).toBeNull();
  });
});

describe.skipIf(!hasDom)('sidebarTipDue and sidebarTipPlace', () => {
  test('due only on the owner\'s page of an Inbox that reports it', () => {
    expect(tip.sidebarTipDue({ reveal: { next: null, sidebar_tip: true } })).toBe(true);
    expect(tip.sidebarTipDue({ guest: true, reveal: { next: null, sidebar_tip: true } })).toBe(false);
    expect(tip.sidebarTipDue({ reveal: { next: null } })).toBe(false);
    expect(tip.sidebarTipDue(null)).toBe(false);
  });

  const sidebar = { left: 0, right: 260, top: 0, bottom: 900, width: 260, height: 900 };
  const row = { left: 8, right: 252, top: 100, bottom: 132, width: 244, height: 32 };

  test('right of the sidebar, the arrow level with the Inbox row', () => {
    const place = tip.sidebarTipPlace({ viewportWidth: 1440, viewportHeight: 900, sidebar, row, cardHeight: 130 })!;
    expect(place.left).toBeGreaterThan(sidebar.right);
    expect(place.left - sidebar.right).toBeLessThanOrEqual(12);
    expect(place.top + place.arrow).toBe(116);
  });

  test('a short window keeps the whole card on screen and still aims the arrow inside the card', () => {
    const low = { ...row, top: 380, bottom: 412 };
    const place = tip.sidebarTipPlace({ viewportWidth: 1440, viewportHeight: 420, sidebar, row: low, cardHeight: 130 })!;
    expect(place.top + 130).toBeLessThanOrEqual(420);
    expect(place.arrow).toBeGreaterThan(0);
    expect(place.arrow).toBeLessThan(130);
  });

  test('no room beside the sidebar for the card: it does not show', () => {
    expect(tip.sidebarTipPlace({ viewportWidth: 520, viewportHeight: 900, sidebar, row, cardHeight: 130 })).toBeNull();
  });
});

/**
 * The `background` inbox.css gives an element, by its classes and attributes alone: among the rules whose selector is
 * one compound of classes the element wears (with `.pn-inbox` before it or not), the most specific, then the last.
 */
function surfaceOf(css: string, el: Element): string | null {
  let best: { weight: number; at: number; value: string } | null = null;
  let at = 0;
  for (const rule of css.matchAll(/(^|[}\n])\s*([^{}@\n]+)\{([^{}]*)\}/g)) {
    const value = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(rule[3]!)?.[1]?.trim();
    if (!value) continue;
    for (const selector of rule[2]!.split(',').map((part) => part.trim())) {
      at += 1;
      const compound = /^(\.pn-inbox\s+)?((?:\.[\w-]+)+)((?:\[[^\]]+\])*)$/.exec(selector);
      if (!compound) continue;
      const classes = compound[2]!.slice(1).split('.');
      if (!classes.every((name) => el.classList.contains(name))) continue;
      try {
        if (!el.matches(`${compound[2]}${compound[3]}`)) continue;
      } catch {
        continue;
      }
      const weight = classes.length + (compound[3]!.match(/\[/g)?.length ?? 0) + (compound[1] ? 1 : 0);
      if (!best || weight > best.weight || (weight === best.weight && at > best.at)) best = { weight, at, value };
    }
  }
  return best?.value ?? null;
}

describe.skipIf(!hasDom)('the tip cards and their arrows are one surface', () => {
  const css = hasDom ? readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8') : '';

  test('the Sidebar tip: the arrow is filled as its card is', async () => {
    await shown();
    const arrow = card()!.querySelector('span[aria-hidden="true"]')!;
    expect(surfaceOf(css, card()!)).toBe('var(--popover)');
    expect(surfaceOf(css, arrow)).toBe(surfaceOf(css, card()!));
  });

  test('the Launch tip, beside and under To: the arrow is filled as its card is', () => {
    for (const side of ['right', 'below'] as const) {
      host = document.createElement('div');
      host.className = 'pn-inbox';
      document.body.appendChild(host);
      act(() => {
        root = createRoot(host!);
        root.render(<launchCard.LaunchTipCard place={{ side, top: 0, left: 0, arrow: 24 }} phone={false} leaving={false} titleId="lt-title" lineId="lt-line" onOk={() => {}} />);
      });
      const tipCard = host.querySelector('[data-launch-tip]')!;
      const arrow = tipCard.querySelector('span[aria-hidden="true"]')!;
      expect(surfaceOf(css, tipCard)).toBe('var(--popover)');
      expect(surfaceOf(css, arrow)).toBe(surfaceOf(css, tipCard));
      act(() => root!.unmount());
      host.remove();
      root = null;
      host = null;
    }
  });
});
