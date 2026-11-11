/**
 * The Launch tip in compose (approval "launch-tip", variant Beside; compose/launchTip.ts). A plain New message whose To
 * can start an agent, on an Inbox that has the tip for this page, claims it once and shows the card in the To row.
 *
 * The failures this catches: the tip shown at + on a project row, a reopened draft, the tour, or with no claim (a guest,
 * or stamped already), or claimed there and so used up; a claim the Inbox refused still drawing it; the first Escape
 * closing the box instead of only the tip; the tip taking focus (from To or the message) or Got it leaving focus on a
 * button that is going; the tip staying up once To is opened or Send is pressed; To not described by its words, or
 * no polite announcement; a phone's card staying over the message once it is tapped.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import type { DraftView, MachineView } from './api';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { setSelfMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { resetMachineLaunchesForTests } = (hasDom ? await import('./compose/useMachineLaunches') : {}) as typeof import('./compose/useMachineLaunches');
const { LAUNCH_TIP_SAID, LAUNCH_TIP_TIMES, LAUNCH_TIP_WORDS } = (hasDom ? await import('./compose/launchTip') : {}) as typeof import('./compose/launchTip');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SELF_VIEW = { id: SELF, name: 'MacBook', self: true, state: 'online', since: '2026-11-06T22:42:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: null } as unknown as MachineView;
const CAN_START: InboxComposeLaunch = {
  agents: [{ agent: 'claude-code', name: 'Claude Code' }],
  projects: [{ id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true }],
  scratch: { root: '/Users/me/scratch' },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes = { delayMs: 0, leaveMs: 0 };
/** The Inbox's launch block for this page (null: Launch off, To can start nothing). */
let launch: InboxComposeLaunch | null = CAN_START;
let claims = 0;
let claimAnswer = true;
/** When set, the claim's answer waits for this (the Inbox is slow to answer). */
let claimHeld: Promise<void> | null = null;
let closed = 0;

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  resetMachineLaunchesForTests();
  setSelfMachine(SELF);
  savedTimes = { ...LAUNCH_TIP_TIMES };
  LAUNCH_TIP_TIMES.delayMs = 30;
  LAUNCH_TIP_TIMES.leaveMs = 10;
  launch = CAN_START;
  claims = 0;
  claimAnswer = true;
  claimHeld = null;
  closed = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? 'GET') === 'POST') return Response.json({});
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines: [SELF_VIEW] });
    if (path.startsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/Users/me', projects: [], ...(launch ? { launch } : {}) });
    if (path.startsWith('/api/inbox/skills')) return Response.json({ skills: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  Object.assign(LAUNCH_TIP_TIMES, savedTimes);
});

const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<HTMLElement>(selector) ?? null;
const tip = () => inDialog('[data-launch-tip]:not(button)');
const toButton = () => inDialog('button[data-compose-to]') as HTMLButtonElement;
const field = () => inDialog('textarea') as HTMLTextAreaElement;
const key = (target: Element, name: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const claim = {
  claim: async () => {
    claims++;
    if (claimHeld) await claimHeld;
    return claimAnswer;
  },
};

async function open(request: Record<string, unknown> = {}, opts: { phone?: boolean; tip?: typeof claim | null; tour?: boolean } = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const transport = opts.tour
    ? { sessions: async () => ({ serverSession: 's', home: null, projects: [], launch: CAN_START }) as never, startThread: async () => ({ thread_id: 'msg_x' }), drafts: false, uploads: false }
    : undefined;
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={request}
        phone={opts.phone ?? false}
        current={null}
        lastSent={null}
        home="/Users/me"
        transport={transport}
        launchTip={opts.tip === undefined ? claim : opts.tip}
        onSent={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
        onClose={() => closed++}
      />,
    );
  });
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
}

/** Open a plain New message and wait for the tip. */
async function openWithTip(opts: { phone?: boolean } = {}) {
  await open({}, opts);
  await until(() => tip() !== null && !tip()!.hasAttribute('data-leaving'), 'the tip');
}

/** Long enough that a tip that was going to come would have (its delay, the claim, a render). */
const settle = () => wait(LAUNCH_TIP_TIMES.delayMs + 80);

test.skipIf(!hasDom)('a plain New message that can start an agent: claimed once, drawn in the To row, To described by it, said once, and focus stays on To', async () => {
  // Longer than To takes to load on a loaded runner, so "not in the first frames" is not a race with that load.
  LAUNCH_TIP_TIMES.delayMs = 200;
  await open();
  const focused = document.activeElement;
  expect(focused === toButton()).toBe(true);
  // Never in the box's first frames: it waits for the box to settle.
  expect(tip() !== null).toBe(false);
  await until(() => tip() !== null, 'the tip');
  expect(claims).toBe(1);
  // Inside the To row (so inside the modal dialog), one Tab after To.
  expect(tip()!.parentElement === inDialog('.ib-cp-to')).toBe(true);
  expect(tip()!.getAttribute('role')).toBe('group');
  expect(tip()!.querySelector('h2')!.textContent).toBe(LAUNCH_TIP_WORDS.title);
  const line = tip()!.querySelector('p')!;
  expect(toButton().getAttribute('aria-describedby')).toBe(line.id);
  expect(document.getElementById(line.id)!.textContent).toBe(LAUNCH_TIP_WORDS.line);
  await until(() => inDialog('[data-compose-paste-live]')!.textContent === LAUNCH_TIP_SAID, 'the announcement');
  // Never a ring: To wears its hover fill (a data attribute), and focus never moved.
  expect(toButton().hasAttribute('data-launch-tip')).toBe(true);
  expect(document.activeElement === focused).toBe(true);
  await settle();
  expect(claims).toBe(1);
});

test.skipIf(!hasDom)('Escape: the first closes only the tip, the box stays; the second is compose’s own', async () => {
  await openWithTip();
  key(document.activeElement!, 'Escape');
  await until(() => tip() === null, 'the tip gone');
  expect(closed).toBe(0);
  expect(inDialog('.ib-cp-to') !== null).toBe(true);
  expect(toButton().hasAttribute('aria-describedby')).toBe(false);
  expect(document.activeElement === toButton()).toBe(true);
  key(document.activeElement!, 'Escape');
  expect(closed).toBe(1);
});

test.skipIf(!hasDom)('opening To: the tip leaves and the picker opens', async () => {
  await openWithTip();
  act(() => toButton().click());
  expect(toButton().getAttribute('aria-expanded')).toBe('true');
  await until(() => tip() === null, 'the tip gone');
  expect(inDialog('[data-compose-start="claude-code"]') !== null).toBe(true);
});

test.skipIf(!hasDom)('Got it: a pointer press keeps focus in the message; a keyboard press sends focus to To', async () => {
  await openWithTip();
  act(() => field().focus());
  const ok = () => inDialog('[data-launch-tip-ok]') as HTMLButtonElement;
  const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  act(() => void ok().dispatchEvent(down));
  expect(down.defaultPrevented).toBe(true);
  act(() => ok().click());
  await until(() => tip() === null, 'the tip gone');
  expect(document.activeElement === field()).toBe(true);
  act(() => root?.unmount());
  host?.remove();

  await openWithTip();
  act(() => ok().focus());
  expect(document.activeElement === ok()).toBe(true);
  act(() => ok().click());
  expect(document.activeElement === toButton()).toBe(true);
  await until(() => tip() === null, 'the tip gone');
});

test.skipIf(!hasDom)('Send: the tip leaves on the press', async () => {
  await openWithTip();
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => tip() === null, 'the tip gone');
});

test.skipIf(!hasDom)('a phone: the card leaves once the message is tapped', async () => {
  await openWithTip({ phone: true });
  expect(tip()!.hasAttribute('data-phone')).toBe(true);
  // A phone has no To line: the card stands in the foot's row, over To's pill, its arrow pointing down at it.
  expect(tip()!.closest('.ib-cp-foot')).not.toBeNull();
  expect(inDialog('.ib-cp-to')).toBeNull();
  expect(tip()!.getAttribute('data-side')).toBe('above');
  expect(tip()!.querySelector('.ib-ctip-arrow')!.getAttribute('data-side')).toBe('down');
  expect(inDialog('.ib-cp-foot [data-compose-to]')!.hasAttribute('data-launch-tip')).toBe(true);
  act(() => field().focus());
  await until(() => tip() === null, 'the tip gone');
  expect(document.activeElement === field()).toBe(true);
});

test.skipIf(!hasDom)('+ on a project row and a reopened draft: never shown, never claimed (not used up)', async () => {
  await open({ start: { projectId: 'prj_web', machine: null, agent: 'claude-code' } });
  await settle();
  expect(tip() !== null).toBe(false);
  act(() => root?.unmount());
  host?.remove();

  const draft = { id: 'drf_01ARZ3NDEKTSV4RRFFQ69G5FAV', body: 'Fix the totals', to: null, project: null, files: [], updated_at: '2026-11-08T09:00:00.000Z', created_at: '2026-11-08T09:00:00.000Z' } as unknown as DraftView;
  await open({ draft });
  await settle();
  expect(tip() !== null).toBe(false);
  expect(claims).toBe(0);
});

test.skipIf(!hasDom)('no claim offered (a guest, stamped already), the tour, or To unable to start an agent: never shown, never claimed', async () => {
  await open({}, { tip: null });
  await settle();
  expect(tip() !== null).toBe(false);
  act(() => root?.unmount());
  host?.remove();

  await open({}, { tour: true });
  await settle();
  expect(tip() !== null).toBe(false);
  act(() => root?.unmount());
  host?.remove();

  launch = null;
  await open();
  await settle();
  expect(tip() !== null).toBe(false);
  expect(claims).toBe(0);
});

test.skipIf(!hasDom)('the Inbox refuses the claim (another window or the phone showed it): the card goes at once, never announced', async () => {
  claimAnswer = false;
  await open();
  await settle();
  expect(claims).toBe(1);
  expect(tip() !== null).toBe(false);
  expect(toButton().hasAttribute('aria-describedby')).toBe(false);
  expect(inDialog('[data-compose-paste-live]')!.textContent).toBe('');
});

test.skipIf(!hasDom)('the claim goes as the card shows: To opened while the answer is on its way finds the tip seen, not used up unseen', async () => {
  let answer!: () => void;
  claimHeld = new Promise<void>((done) => (answer = done));
  await open();
  await until(() => tip() !== null, 'the tip');
  // Drawn in the same render the claim was sent: a stamp never lands for a card nobody saw.
  expect(claims).toBe(1);
  act(() => toButton().click());
  await until(() => tip() === null, 'the tip gone');
  await act(async () => answer());
  await settle();
  expect(tip() !== null).toBe(false);
  expect(claims).toBe(1);
});

test.skipIf(!hasDom)('Escape on Got it: the tip leaves and focus goes to To, never to the page', async () => {
  await openWithTip();
  const ok = inDialog('[data-launch-tip-ok]') as HTMLButtonElement;
  act(() => ok.focus());
  expect(document.activeElement === ok).toBe(true);
  key(ok, 'Escape');
  expect(document.activeElement === toButton()).toBe(true);
  await until(() => tip() === null, 'the tip gone');
  expect(document.activeElement === toButton()).toBe(true);
  expect(closed).toBe(0);
});

test.skipIf(!hasDom)('To opened before the tip came: not shown and not claimed, so the next New message still has it', async () => {
  LAUNCH_TIP_TIMES.delayMs = 200;
  await open();
  act(() => toButton().click());
  await wait(300);
  expect(tip() !== null).toBe(false);
  expect(claims).toBe(0);
});
