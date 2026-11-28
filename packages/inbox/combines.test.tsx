/**
 * The Combines the window follows (components/useCombines.ts): only the ones this browser started, so an Inbox where
 * nobody combines reads nothing; a Combine still waiting marks its threads; one that arrived is told once with Undo
 * (which asks its machine to bring the threads back) and Open; one that failed says nothing was archived, and is told
 * again if it is done after all; a second load tells neither again; a linked machine's Combines are read through its door.
 * Its toasts name the agent as the dialog did, after a reload too; an Undo that waits for a computer asleep gives back
 * only what is back and says "Combine undone." only once it landed everywhere.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxCombineRecord, InboxListRow } from '@plannotator/core/inbox-types';
import type { BulkWrites } from './bulkWrites';
import type { InboxToastModel } from './components/Toast';
import type { MachinesModel } from './machines';

const hasDom = typeof document !== 'undefined';
const { useCombines } = (hasDom ? await import('./components/useCombines') : {}) as typeof import('./components/useCombines');

const TOLD_KEY = 'plannotator-inbox-combines-told';
const WATCH_KEY = 'plannotator-inbox-combines-watch';
/** This browser started these (what `begin` keeps). */
const started = (...list: [string, string | null, string][]) => localStorage.setItem(WATCH_KEY, JSON.stringify(list.map(([id, machine, at]) => ({ id, machine, at }))));
let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const requests: { method: string; url: string }[] = [];
let lists: Record<string, InboxCombineRecord[]> = {};
/** What a POST answers: its status and body. */
let posted: () => { status: number; body: unknown } = () => ({ status: 200, body: { combine: { ...DONE, state: 'undone' } } });
beforeEach(() => {
  if (!hasDom) return;
  requests.length = 0;
  localStorage.removeItem(TOLD_KEY);
  localStorage.removeItem(WATCH_KEY);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, url });
    const far = /\/m\/([^/]+)\/combine/.exec(url)?.[1] ?? 'here';
    const { status, body } = method === 'GET' ? { status: 200, body: { serverSession: 's', combines: lists[far] ?? [] } } : posted();
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  posted = () => ({ status: 200, body: { combine: { ...DONE, state: 'undone' } } });
  model = MACHINES;
  localStorage.removeItem(TOLD_KEY);
  localStorage.removeItem(WATCH_KEY);
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const AT = new Date(Date.now() - 60_000).toISOString();
const DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const base = { threads: [{ id: 'a', subject: 'A' }, { id: 'b', subject: 'B' }], session: 'ses_a', host: 'claude-code', name: 'Billing work', at: AT };
const DONE: InboxCombineRecord = { ...base, id: 'cmb_done', state: 'done', thread: { id: 'n', subject: 'Billing retries and refunds' }, settled_at: AT };
const FAILED: InboxCombineRecord = { ...base, id: 'cmb_fail', state: 'failed', reason: 'ended', settled_at: AT };
const OLD: InboxCombineRecord = { ...base, id: 'cmb_old', state: 'done', thread: { id: 'o', subject: 'Old' }, at: DAYS_AGO, settled_at: DAYS_AGO };
const OTHER: InboxCombineRecord = { ...base, id: 'cmb_other', state: 'done', thread: { id: 'x', subject: 'Elsewhere' }, settled_at: AT };
const WAITING: InboxCombineRecord = { ...base, id: 'cmb_wait', state: 'asked', threads: [{ id: 'c', subject: 'C' }] };

const toasts: Omit<InboxToastModel, 'id'>[] = [];
const opened: string[] = [];
const said: string[] = [];
const restored: string[] = [];
let seen: ReadonlyMap<string, string> = new Map();
let tracker: ReturnType<typeof useCombines> | null = null;
const bulk = {
  host: {
    showToast: (toast: Omit<InboxToastModel, 'id'>) => void toasts.push(toast),
    dismissToast: () => {},
    say: (words: string) => void said.push(words),
    afterWrite: async () => {},
    restoreSnooze: async (id: string, until: unknown) => void restored.push(`snooze ${id} ${String(until)}`),
    restorePriority: async (id: string, priority: unknown) => void restored.push(`priority ${id} ${String(priority)}`),
    openThread: (id: string) => void opened.push(id),
  },
} as unknown as BulkWrites;
const MACHINES = { self: 'm_self', all: [], linked: [{ id: 'm_mini', name: 'Mac mini', marks: ['combine'], state: 'online' }], names: new Map([['m_mini', 'Mac mini']]), away: new Set() } as unknown as MachinesModel;
let model = MACHINES;

function Probe() {
  tracker = useCombines(bulk, model);
  seen = tracker.waiting;
  return null;
}

// The window's poll, by hand: each tick runs the reads the window would run every few seconds.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const polls = new Map<number, () => void>();
function handPoll() {
  polls.clear();
  let next = 1;
  globalThis.setInterval = ((fn: () => void) => (polls.set(next, fn), next++)) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => void polls.delete(id)) as unknown as typeof clearInterval;
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const tick = () =>
  act(async () => {
    for (const fn of [...polls.values()]) fn();
    await wait();
  });
async function load() {
  if (root) act(() => root!.unmount());
  host ??= document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => {
    root!.render(<Probe />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test.skipIf(!hasDom)('a Combine that arrived is told once, with Undo and Open; one that failed says nothing was archived', async () => {
  toasts.length = 0;
  lists = { here: [DONE, OLD, OTHER], m_mini: [FAILED, WAITING] };
  started(['cmb_done', null, AT], ['cmb_old', null, DAYS_AGO], ['cmb_fail', 'm_mini', AT], ['cmb_wait', 'm_mini', AT]);
  await load();
  // This machine's and the linked one's, through its door.
  expect(requests.filter((r) => r.method === 'GET').map((r) => r.url).sort()).toEqual(['/api/inbox/combine', '/api/inbox/m/m_mini/combine']);
  expect([...seen.entries()]).toEqual([['c', 'cmb_wait']]);
  // One started days ago is no longer followed; one another browser started is not this one's to tell.
  expect(toasts).toHaveLength(2);
  const done = toasts.find((t) => t.lead === 'Combined 2 threads')!;
  expect(done.detail).toBe('into “Billing retries and refunds”');
  const failed = toasts.find((t) => t.icon === 'warn')!;
  expect(failed.lead).toBe('Billing work did not combine the 2 threads');
  expect(failed.detail).toBe('Its session ended. Nothing was archived.');
  done.action!.onPress();
  expect(opened).toEqual(['n']);
  await act(async () => {
    done.onUndo!();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(requests.some((r) => r.method === 'POST' && r.url === '/api/inbox/combine/cmb_done/undo')).toBe(true);
  // A second load tells neither again.
  toasts.length = 0;
  await load();
  expect(toasts).toHaveLength(0);
});

test.skipIf(!hasDom)('an Inbox where this browser started no Combine reads nothing for them', async () => {
  toasts.length = 0;
  lists = { here: [DONE], m_mini: [FAILED] };
  await load();
  expect(requests).toHaveLength(0);
  expect(toasts).toHaveLength(0);
});

test.skipIf(!hasDom)('one that failed and is then done after all is told again, as done', async () => {
  toasts.length = 0;
  lists = { here: [FAILED] };
  started(['cmb_fail', null, AT]);
  await load();
  expect(toasts.map((t) => t.icon)).toEqual(['warn']);
  lists = { here: [{ ...FAILED, state: 'done', reason: undefined, thread: { id: 'late', subject: 'Late but here' } }] };
  toasts.length = 0;
  await load();
  expect(toasts.map((t) => [t.lead, t.detail])).toEqual([['Combined 2 threads', 'into “Late but here”']]);
  // Done: no longer followed.
  requests.length = 0;
  await load();
  expect(requests).toHaveLength(0);
});

/** A linked computer, by an id the window forwards to (`/api/inbox/m/<id>/…`). */
const MINI = `ibx_01JZ${'0'.repeat(20)}MN`;
const LINKED = { self: 'm_self', all: [{ id: 'm_self', name: 'MacBook', self: true }], linked: [{ id: MINI, name: 'Mac mini', marks: ['combine', 'combine-across'], state: 'online' }], names: new Map([[MINI, 'Mac mini']]), away: new Set() } as unknown as MachinesModel;
const LINKED_ASLEEP = { ...LINKED, linked: [{ ...(LINKED.linked[0] as object), state: 'offline' }], away: new Set([MINI]) } as unknown as MachinesModel;
const ASKED: InboxCombineRecord = { ...base, id: 'cmb_two', state: 'asked', name: 'Codex' };
const pickedRows = (machine: string | null) =>
  [
    { thread_id: 'a', snoozed: '2026-12-01T09:00:00.000Z', priority: 'high' },
    { thread_id: 'b', snoozed: null, priority: 'low', ...(machine ? { machine } : {}) },
  ] as unknown as InboxListRow[];
const reset = () => {
  toasts.length = 0;
  said.length = 0;
  restored.length = 0;
};

test.skipIf(!hasDom)('its toasts name the agent as the dialog did, after a reload too', async () => {
  reset();
  lists = { here: [] };
  await load();
  act(() => tracker!.begin(ASKED, null, pickedRows(null), 'Codex · ledger'));
  expect(toasts.map((t) => t.lead)).toEqual(['Asked Codex · ledger to combine 2 threads']);
  // A reload: the label was kept with what this browser follows.
  lists = { here: [{ ...ASKED, state: 'failed', reason: 'ended', settled_at: AT }] };
  toasts.length = 0;
  await load();
  expect(toasts.map((t) => t.lead)).toEqual(['Codex · ledger did not combine the 2 threads']);
});

test.skipIf(!hasDom)('an Undo held for the computer that runs the Combine restores nothing and says nothing until a later read says it is undone', async () => {
  reset();
  handPoll();
  model = LINKED;
  lists = { [MINI]: [] };
  await load();
  act(() => tracker!.begin(ASKED, MINI, pickedRows(null), 'Codex · ledger'));
  lists = { [MINI]: [{ ...ASKED, state: 'done', thread: { id: 'n', subject: 'Billing' }, settled_at: AT }] };
  await tick();
  const done = toasts.find((t) => t.lead === 'Combined 2 threads')!;
  posted = () => ({ status: 202, body: { outbox: { key: 'k', machine: MINI, route: 'combine/cmb_two/undo', state: 'queued', queued_at: AT, settled_at: null, status: null, answer: null, notice: null, dismissed: false }, machine: { id: MINI, name: 'Mac mini', state: 'offline' } } });
  await act(async () => {
    done.onUndo!();
    await wait();
  });
  expect(requests.some((r) => r.method === 'POST' && r.url === `/api/inbox/m/${MINI}/combine/cmb_two/undo`)).toBe(true);
  expect(toasts.at(-1)).toMatchObject({ icon: 'clock', lead: 'Waiting for Mac mini: this applies when Mac mini is back.' });
  expect([said, restored]).toEqual([[], []]);
  // Still done there: it waits.
  await tick();
  expect([said, restored]).toEqual([[], []]);
  lists = { [MINI]: [{ ...ASKED, state: 'undone', thread: { id: 'n', subject: 'Billing' }, settled_at: AT }] };
  await tick();
  expect(said).toEqual(['Combine undone.']);
  expect(restored).toEqual(['snooze a 2026-12-01T09:00:00.000Z', 'priority a high', 'snooze b null', 'priority b low']);
  await tick();
  expect(said).toEqual(['Combine undone.']);
});

test.skipIf(!hasDom)('an Undo that still waits for the other computer gives back only the rows that are back, and says "Combine undone." once nothing waits', async () => {
  reset();
  handPoll();
  model = LINKED;
  lists = { here: [] };
  await load();
  act(() => tracker!.begin(ASKED, null, pickedRows(MINI), 'Codex · ledger'));
  const doneRecord: InboxCombineRecord = { ...ASKED, state: 'done', thread: { id: 'n', subject: 'Billing' }, settled_at: AT };
  lists = { here: [doneRecord] };
  await tick();
  const done = toasts.find((t) => t.lead === 'Combined 2 threads')!;
  const waitingOn: InboxCombineRecord = { ...doneRecord, state: 'undone', waiting_on: [MINI] };
  posted = () => ({ status: 200, body: { combine: waitingOn } });
  await act(async () => {
    done.onUndo!();
    await wait();
  });
  // Mac mini is online, only slower than the wait: it applies once Mac mini confirms, not "when it is back".
  expect(toasts.at(-1)).toMatchObject({ icon: 'clock', lead: 'Sending to Mac mini: this applies once Mac mini confirms.' });
  expect(said).toEqual([]);
  // This computer's row is back now; Mac mini's when Mac mini is.
  expect(restored).toEqual(['snooze a 2026-12-01T09:00:00.000Z', 'priority a high']);
  lists = { here: [waitingOn] };
  await tick();
  expect(said).toEqual([]);
  lists = { here: [{ ...waitingOn, waiting_on: undefined }] };
  await tick();
  expect(said).toEqual(['Combine undone.']);
  expect(restored).toEqual(['snooze a 2026-12-01T09:00:00.000Z', 'priority a high', 'snooze b null', 'priority b low']);
  await tick();
  expect(said).toEqual(['Combine undone.']);
});

test.skipIf(!hasDom)('an Undo still waiting for the other computer asleep says it applies when that computer is back', async () => {
  reset();
  handPoll();
  model = LINKED_ASLEEP;
  lists = { here: [] };
  await load();
  act(() => tracker!.begin(ASKED, null, pickedRows(MINI), 'Codex · ledger'));
  const doneRecord: InboxCombineRecord = { ...ASKED, state: 'done', thread: { id: 'n', subject: 'Billing' }, settled_at: AT };
  lists = { here: [doneRecord] };
  await tick();
  posted = () => ({ status: 200, body: { combine: { ...doneRecord, state: 'undone', waiting_on: [MINI] } } });
  await act(async () => {
    toasts.find((t) => t.lead === 'Combined 2 threads')!.onUndo!();
    await wait();
  });
  expect(toasts.at(-1)).toMatchObject({ icon: 'clock', lead: 'Waiting for Mac mini: this applies when Mac mini is back.' });
  expect(said).toEqual([]);
});
