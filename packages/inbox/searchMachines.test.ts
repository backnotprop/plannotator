/**
 * Cmd+K across linked machines, the window's half (docs/agent-guides/inbox-machines.md, "Search across machines"):
 * in the merged view `searchInbox` asks with `machines=1`, and a linked machine's row (a typed search's or Recent's)
 * routes its ids to that machine, so opening it reads from there. Before the list named this Inbox, search is its own.
 */
import { afterEach, expect, test } from 'bun:test';
import { inboxApi, searchInbox } from './api';
import { machineOf, resetMachineRoutes, setSelfMachine } from './inboxUrl';

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const LOCAL = 'thr_01KLOCAL000000000000000001';
const MAC_RECENT = 'thr_01KMACRECENT00000000000001';
const MAC_FOUND = 'thr_01KMACFOUND000000000000001';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetMachineRoutes();
});

function stub(answer: unknown): string[] {
  const asked: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    asked.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  return asked;
}

const row = (id: string, machine?: string) => ({
  type: 'thread',
  id,
  thread_id: id,
  project: { id: machine ? 'prj_01KMACPROJ00000000000000001' : 'prj_01KLOCALPROJ0000000000001', name: 'billing', ...(machine ? { machine } : {}) },
  title: 't',
  title_marks: [],
  thread_name: null,
  section: 'needs_you',
  archived: false,
  at: '2026-11-08T10:00:00.000Z',
});

test("in the merged view search asks the linked machines, and their rows (groups and Recent) route there", async () => {
  setSelfMachine(SELF);
  const asked = stub({ q: '', terms: [], took_ms: 0, indexing: false, threads: 3, totals: null, groups: { threads: [row(MAC_FOUND, MAC)] }, recent: [row(LOCAL), row(MAC_RECENT, MAC)], recent_searches: [], serverSession: 's' });
  await searchInbox({ q: '' });
  expect(new URL(asked[0]!, 'http://x').searchParams.get('machines')).toBe('1');
  expect(machineOf(MAC_RECENT)).toBe(MAC);
  expect(machineOf(MAC_FOUND)).toBe(MAC);
  expect(machineOf(LOCAL)).toBeNull();
  const opened = stub({});
  await inboxApi.thread(MAC_RECENT).catch(() => {});
  expect(opened[0]).toStartWith(`/api/inbox/m/${MAC}/threads/${MAC_RECENT}`);
});

test('before the merged list named this Inbox, search is its own', async () => {
  const asked = stub({ q: 'x', terms: [], took_ms: 0, indexing: false, threads: 0, totals: null, groups: null, recent: null, serverSession: 's' });
  await searchInbox({ q: 'x' });
  expect(asked[0]).not.toContain('machines=1');
});
