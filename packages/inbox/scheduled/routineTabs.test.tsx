/**
 * A routine's Edit and Runs tabs (RoutineTabs.tsx), against a stand-in Inbox. What regresses: words lost or a save
 * that stops when the tab changes, a Runs tab that hides a run that didn't start or one that is going, the Edit tab
 * losing the last run's outcome (or its way to Runs), an address that does not open Runs (a reload or a shared link
 * landing on Edit), a tab switch that adds a history entry or a new routine that loses its tab when it takes its id
 * (both through the window's real address), the tab keys (and Cmd/Alt+← left to the browser), and a Runs tab with
 * nothing in it for a new routine.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxScheduledRow, InboxScheduledRunSummary } from '@plannotator/core/inbox-scheduled-types';
import { lastRun, scheduledRow } from './testRows';
import type { RoutineTab } from './RoutineTabs';

const hasDom = typeof document !== 'undefined';
const { ScheduledPage } = (hasDom ? await import('./ScheduledPage') : {}) as typeof import('./ScheduledPage');
const { resetScheduledForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { routeOf, readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { ScheduledRoute } = (hasDom ? await import('./ScheduledPage') : {}) as typeof import('./ScheduledPage');
const { hashOf } = (hasDom ? await import('../app/writeRoute') : {}) as typeof import('../app/writeRoute');

const PAUSE = 700;
const realFetch = globalThis.fetch;
let root: Root | null = null;
let unlisten = () => {};
type Call = { method: string; path: string; body: Record<string, unknown> | null };
beforeEach(() => {
  sessionStorage.clear();
  if (hasDom) window.history.replaceState(null, '', '/');
});
afterEach(() => {
  unlisten();
  unlisten = () => {};
  window.history.replaceState(null, '', '/');
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  sessionStorage.clear();
});

function inbox(row: InboxScheduledRow, runs: InboxScheduledRunSummary[] = []) {
  const calls: Call[] = [];
  let current = row;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    if (path === '/api/inbox/scheduled' && method === 'POST') {
      // A new one made: it is the one read from here on.
      current = scheduledRow('sch_made', { ...(body as Partial<InboxScheduledRow>), state: 'off', enabled: false });
      return json({ scheduled: current }, 201);
    }
    if (path === '/api/inbox/scheduled') return json({ scheduled: [current], launch_on: true });
    if (path === '/api/inbox/scheduled/preview') return json({ ok: true, schedule_words: 'Every weekday at 9:00 AM', tz_short: 'EST', next_run: '2026-11-16T14:00:00.000Z' });
    if (method === 'GET' && path === `/api/inbox/scheduled/${current.id}`) return json({ scheduled: current, runs });
    if (method === 'POST' && path === `/api/inbox/scheduled/${current.id}`) {
      current = { ...current, ...(body as Partial<InboxScheduledRow>), updated_at: new Date(Date.now() + calls.length).toISOString() };
      return json({ scheduled: current });
    }
    return json({ code: 'not_found', error: 'No route.' }, 404);
  }) as typeof fetch;
  return { calls, now: () => current };
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}
const wait = (ms: number) => act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));

/** The page with the address's tab held here, as ScheduledRoute holds it in the address. */
function page(openId: string, rows: InboxScheduledRow[], start: RoutineTab = 'edit') {
  resetScheduledForTests(rows, true);
  const tabs: RoutineTab[] = [];
  let tab = start;
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const draw = () =>
    act(() =>
      root!.render(
        <SidebarProvider>
          <ScheduledPage
            openId={openId}
            switch="on"
            rows={[]}
            phone={false}
            stacked={false}
            onOpen={() => {}}
            onOpenThread={() => {}}
            onSettings={() => {}}
            tab={tab}
            onTab={(next) => {
              tabs.push(next);
              tab = next;
              void draw();
            }}
          />
        </SidebarProvider>,
      ),
    );
  draw();
  return { tabs };
}

/** The page as App draws it: ScheduledRoute from the window's address, drawn again on every hashchange. */
function routed(rows: InboxScheduledRow[], hash: string) {
  resetScheduledForTests(rows, true);
  window.location.hash = hash;
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () =>
    act(() =>
      root!.render(
        <SidebarProvider>
          <ScheduledRoute route={readRoute()} settings={{ scheduled_threads: { on: true } } as never} rows={[]} phone={false} stacked={false} onToast={() => {}} />
        </SidebarProvider>,
      ),
    );
  window.addEventListener('hashchange', render);
  unlisten = () => window.removeEventListener('hashchange', render);
  render();
}

const tabEl = (id: RoutineTab) => document.querySelector<HTMLButtonElement>(`[data-scheduled-tab="${id}"]`)!;
const panel = (id: RoutineTab) => document.querySelector<HTMLElement>(`[data-scheduled-panel="${id}"]`)!;
const nameBox = () => document.querySelector<HTMLInputElement>('[data-scheduled-editor] input[aria-label="Name"]')!;
const promptBox = () => document.querySelector<HTMLTextAreaElement>('[data-scheduled-editor] textarea[aria-label="Prompt"]')!;
const status = () => document.querySelector('[data-scheduled-status]')?.textContent ?? '';
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const off = (change: Partial<InboxScheduledRow> = {}) => scheduledRow('sch_digest', { name: 'Morning PR digest', state: 'off', enabled: false, ...change });

test.skipIf(!hasDom)('switching to Runs mid-edit keeps the words, saves them, and the header still says so', async () => {
  const row = off();
  const server = inbox(row);
  page('sch_digest', [row]);
  await settle();
  await typeInto(promptBox(), 'Summarize the open pull requests, oldest first.');
  await act(async () => tabEl('runs').click());
  expect(panel('edit').hidden).toBe(true);
  expect(panel('runs').hidden).toBe(false);
  expect(status()).toBe('Saving…');
  await wait(PAUSE);
  await settle();
  expect(server.now().prompt).toBe('Summarize the open pull requests, oldest first.');
  expect(status()).toBe('Saved');
  await act(async () => tabEl('edit').click());
  // The same box, not a new one: the words and the box are as they were.
  expect(promptBox().value).toBe('Summarize the open pull requests, oldest first.');
  expect(panel('edit').hidden).toBe(false);
});

test.skipIf(!hasDom)("a last run that didn't start: a red dot on Runs, the outcome on Edit, and one click to Runs", async () => {
  const row = off({ runs: 3, thread_id: 'thr_digest', last_run: lastRun(3, new Date().toISOString(), 'didnt_start') });
  inbox(row, [lastRun(3, new Date().toISOString(), 'didnt_start'), lastRun(2, '2026-11-12T14:00:00.000Z')]);
  const { tabs } = page('sch_digest', [row]);
  await settle();
  expect(tabEl('edit').getAttribute('aria-selected')).toBe('true');
  expect(tabEl('runs').querySelector('[data-scheduled-runs-failed]')).not.toBeNull();
  // A screen reader hears it too, not only a dot.
  // Heard as "Runs, 3, the last run didn't start": the count apart from the word, and the outcome in words.
  expect(tabEl('runs').textContent).toBe("Runs, 3, the last run didn't start");
  expect(tabEl('runs').querySelector('.ib-n')?.textContent).toBe('3');
  const last = document.querySelector<HTMLButtonElement>('[data-scheduled-last-run]')!;
  expect(last.getAttribute('data-scheduled-last-run')).toBe('didnt_start');
  expect(last.querySelector('.st-bad')?.textContent).toBe("Didn't start");
  // Run once now stays in the foot on Edit.
  expect(document.querySelector('[data-scheduled-run-now]')).not.toBeNull();
  await act(async () => last.click());
  expect(tabs).toEqual(['runs']);
  expect(document.activeElement).toBe(tabEl('runs'));
  expect([...panel('runs').querySelectorAll('[data-run-outcome]')].map((el) => el.getAttribute('data-run-outcome'))).toEqual(['didnt_start', 'replied']);
  // Runs has the foot too. The last-run line is off: unheard and out of the Tab order (its first row is that run).
  expect(last.isConnected).toBe(true);
  expect(last.hasAttribute('data-off')).toBe(true);
  expect(last.getAttribute('aria-hidden')).toBe('true');
  expect(last.tabIndex).toBe(-1);
  expect(document.querySelector('[data-scheduled-run-now]')).not.toBeNull();
});

test.skipIf(!hasDom)('a run going: the running mark on Runs, and on Edit its time so far', async () => {
  const since = new Date(Date.now() - 42_000).toISOString();
  const row = scheduledRow('sch_digest', { name: 'Morning PR digest', state: 'running', runs: 4, running_since: since, last_run: lastRun(4, since, 'running') });
  inbox(row, [lastRun(4, since, 'running')]);
  page('sch_digest', [row]);
  await settle();
  expect(tabEl('runs').querySelector('.st-dots')).not.toBeNull();
  expect(tabEl('runs').querySelector('[data-scheduled-runs-failed]')).toBeNull();
  const last = document.querySelector('[data-scheduled-last-run]')!;
  expect(last.getAttribute('data-scheduled-last-run')).toBe('running');
  expect(last.textContent).toMatch(/^Running · 0:4\d$/);
  expect(document.querySelector('[data-scheduled-stop]')).not.toBeNull();
});

test.skipIf(!hasDom)('the address opens Runs: #routine=…&runs lands on it, with the runs read', async () => {
  expect(routeOf('#routine=sch_digest&runs')).toMatchObject({ page: 'scheduled', scheduled: 'sch_digest', routineRuns: true });
  expect(routeOf('#routine=sch_digest').routineRuns).toBeUndefined();
  expect(hashOf({ page: 'scheduled', project: null, thread: null, scheduled: 'sch_digest', routineRuns: true })).toBe('#routine=sch_digest&runs');
  expect(hashOf({ page: 'scheduled', project: null, thread: null, scheduled: 'sch_digest' })).toBe('#routine=sch_digest');
  const row = off({ runs: 1, thread_id: 'thr_digest', last_run: lastRun(1, '2026-11-12T14:00:00.000Z') });
  inbox(row, [lastRun(1, '2026-11-12T14:00:00.000Z')]);
  page('sch_digest', [row], 'runs');
  await settle();
  expect(tabEl('runs').getAttribute('aria-selected')).toBe('true');
  expect(panel('runs').hidden).toBe(false);
  expect(panel('edit').hidden).toBe(true);
  expect(panel('runs').querySelectorAll('[data-run-outcome]').length).toBe(1);
});

test.skipIf(!hasDom)('the arrows, Home and End move between the tabs and focus the one picked', async () => {
  const row = off();
  inbox(row);
  const { tabs } = page('sch_digest', [row]);
  await settle();
  const list = document.querySelector<HTMLElement>('[data-scheduled-tabs]')!;
  expect(list.getAttribute('role')).toBe('tablist');
  expect(tabEl('edit').tabIndex).toBe(0);
  expect(tabEl('runs').tabIndex).toBe(-1);
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(tabs).toEqual(['runs']);
  expect(document.activeElement).toBe(tabEl('runs'));
  expect(tabEl('runs').tabIndex).toBe(0);
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(tabs).toEqual(['runs', 'edit']);
  expect(document.activeElement).toBe(tabEl('edit'));
  // Cmd+←, Ctrl+→, Alt+← are the browser's (Back, Forward): the tabs leave them alone.
  for (const keys of [{ key: 'ArrowLeft', metaKey: true }, { key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowLeft', altKey: true }, { key: 'End', metaKey: true }]) {
    const event = new KeyboardEvent('keydown', { ...keys, bubbles: true, cancelable: true });
    await act(async () => list.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  expect(tabs).toEqual(['runs', 'edit']);
});

test.skipIf(!hasDom)('a new routine: Runs says there are none yet', async () => {
  inbox(off());
  page('new', [], 'runs');
  await settle();
  expect(panel('runs').hidden).toBe(false);
  expect(panel('runs').querySelector('[data-scheduled-no-runs] p')?.textContent).toBe('No runs yet.');
  expect(tabEl('runs').querySelector('.ib-n')).toBeNull();
});

test.skipIf(!hasDom)('through the window\'s address: #routine=…&runs opens Runs, and a switch rewrites the address in place', async () => {
  const row = off({ runs: 1, thread_id: 'thr_digest', last_run: lastRun(1, '2026-11-12T14:00:00.000Z') });
  inbox(row, [lastRun(1, '2026-11-12T14:00:00.000Z')]);
  routed([row], '#routine=sch_digest&runs');
  await settle();
  expect(tabEl('runs').getAttribute('aria-selected')).toBe('true');
  expect(panel('runs').hidden).toBe(false);
  const entries = window.history.length;
  await act(async () => tabEl('edit').click());
  expect(window.location.hash).toBe('#routine=sch_digest');
  expect(panel('edit').hidden).toBe(false);
  await act(async () => tabEl('runs').click());
  expect(window.location.hash).toBe('#routine=sch_digest&runs');
  expect(panel('runs').hidden).toBe(false);
  // Not a step back: Back leaves the routine, not the tab.
  expect(window.history.length).toBe(entries);
});

test.skipIf(!hasDom)('through the window\'s address: a new one switched to Runs keeps Runs when it takes its id', async () => {
  const server = inbox(off());
  routed([], '#routine=new');
  await settle();
  await typeInto(nameBox(), 'Docs link check');
  await typeInto(promptBox(), 'Check every link in the docs.');
  await act(async () => tabEl('runs').click());
  expect(window.location.hash).toBe('#routine=new&runs');
  const entries = window.history.length;
  // The typing pause: it is made, and the address takes its id in place.
  await wait(PAUSE);
  await settle();
  expect(server.calls.filter((call) => call.method === 'POST' && call.path === '/api/inbox/scheduled').length).toBe(1);
  expect(window.location.hash).toBe('#routine=sch_made&runs');
  expect(window.history.length).toBe(entries);
  expect(tabEl('runs').getAttribute('aria-selected')).toBe('true');
  expect(panel('runs').hidden).toBe(false);
  // The same editor: the words are there on Edit.
  await act(async () => tabEl('edit').click());
  expect(promptBox().value).toBe('Check every link in the docs.');
});

test.skipIf(!hasDom)('a one-time one that ran says when once: "Done" by the switch, the time on the last-run line', async () => {
  const row = off({ state: 'done', runs: 1, thread_id: 'thr_digest', last_run: lastRun(1, '2026-11-13T22:02:00.000Z') });
  inbox(row, [lastRun(1, '2026-11-13T22:02:00.000Z')]);
  page('sch_digest', [row]);
  await settle();
  expect(document.querySelector('.st-meta')?.firstElementChild?.textContent).toBe('Done');
  expect(document.querySelector('[data-scheduled-last-run]')?.textContent).toMatch(/^Last run .+ · Replied$/);
});
