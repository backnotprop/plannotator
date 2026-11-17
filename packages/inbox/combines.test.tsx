/**
 * The Combines the window follows (components/useCombines.ts): only the ones this browser started, so an Inbox where
 * nobody combines reads nothing; a Combine still waiting marks its threads; one that arrived is told once with Undo
 * (which asks its machine to bring the threads back) and Open; one that failed says nothing was archived, and is told
 * again if it is done after all; a second load tells neither again; a linked machine's Combines are read through its door.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxCombineRecord } from '@plannotator/core/inbox-types';
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
    const body = method === 'GET' ? { serverSession: 's', combines: lists[far] ?? [] } : { combine: { ...DONE, state: 'undone' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  globalThis.fetch = realFetch;
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
let seen: ReadonlyMap<string, string> = new Map();
const bulk = {
  host: {
    showToast: (toast: Omit<InboxToastModel, 'id'>) => void toasts.push(toast),
    dismissToast: () => {},
    say: () => {},
    afterWrite: async () => {},
    restoreSnooze: async () => {},
    restorePriority: async () => {},
    openThread: (id: string) => void opened.push(id),
  },
} as unknown as BulkWrites;
const MACHINES = { self: 'm_self', all: [], linked: [{ id: 'm_mini', name: 'Mac mini', marks: ['combine'], state: 'online' }], names: new Map([['m_mini', 'Mac mini']]), away: new Set() } as unknown as MachinesModel;

function Probe() {
  seen = useCombines(bulk, MACHINES).waiting;
  return null;
}
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
