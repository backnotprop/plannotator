/**
 * Re-ask all in the window (markAllRead.ts says which rows, reaskAll.ts what came of it, bulkWrites.ts `reaskAll`
 * writes): offered only on the bands of open questions, and on the picks only when every picked thread has one; it
 * takes only rows with a question open that were not asked again already; one press is one key for every thread; a
 * linked machine's row is no part of it (never offered on, written or counted); the toast counts each agent once and
 * says how many could not be reached (a note that failed beside one written included); the live region says
 * "Nothing to re-ask." unless every thread had its agents asked again already; there is no Undo.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { bandMenuActions, bandReaskAllRows, offersRowReask } from './markAllRead';
import { offersPicksReask, type PickRules } from './rowPicks';
import { reaskAllQuiet, reaskAllToast, tallyReaskAll, type ReaskAllOutcome } from './reaskAll';
import { bulkWrites, type BulkHost } from './bulkWrites';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';
import type { ThreadReaskAllView } from './data/actions/reaskAll';

const open = (n: number) => ({ open: n, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 });
const row = (id: string, section: InboxListGroupId, over: Partial<InboxListRow> = {}) =>
  ({ thread_id: id, subject: id, section, questions: open(1), snoozed: null, unseen: 0, last_at: '2026-11-20T07:00:00.000Z', ...over }) as unknown as InboxListRow;
const band = (id: InboxListGroupId, threads: InboxListRow[]): InboxListSection => ({ id, label: id, threads }) as InboxListSection;

describe('which rows Re-ask all takes', () => {
  test('only on the bands of open questions: Stopped, Holding up work, Waiting on you', () => {
    for (const id of ['stopped', 'holding', 'waiting'] as const) expect(bandMenuActions(band(id, [row('a', id)]))).toContain('reask');
    for (const id of ['new', 'sent', 'quiet', 'priority', 'snoozed'] as const) expect(bandMenuActions(band(id, [row('a', id)]))).not.toContain('reask');
  });

  test('a row with no question open, or one already asked again, is left out; a band of only those offers no Re-ask all', () => {
    const rows = [row('a', 'holding'), row('b', 'holding', { questions: open(0) }), row('c', 'holding', { reask_pending: true })];
    expect(bandReaskAllRows(band('holding', rows)).map((r) => r.thread_id)).toEqual(['a']);
    expect(bandMenuActions(band('waiting', rows.slice(1)))).not.toContain('reask');
    expect(offersRowReask(row('d', 'waiting'), 'new')).toBe(false);
  });

  test('the picks offer Re-ask only when every picked thread has a question open', () => {
    const rules = { drawn: (r: InboxListRow) => r.section } as unknown as PickRules;
    expect(offersPicksReask([row('a', 'holding'), row('b', 'waiting')], rules)).toBe(true);
    expect(offersPicksReask([row('a', 'holding'), row('q', 'quiet', { questions: open(0) })], rules)).toBe(false);
    expect(offersPicksReask([], rules)).toBe(false);
  });

  test('a linked machine’s row is no part of it: a band of only those offers no Re-ask all, and a picked one neither offers nor blocks it', () => {
    rememberMachine(['far1', 'far2'], 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    try {
      expect(offersRowReask(row('far1', 'holding'), 'holding')).toBe(false);
      expect(bandMenuActions(band('holding', [row('far1', 'holding'), row('far2', 'holding')]))).not.toContain('reask');
      expect(bandReaskAllRows(band('holding', [row('far1', 'holding'), row('a', 'holding')])).map((r) => r.thread_id)).toEqual(['a']);
      const rules = { drawn: (r: InboxListRow) => r.section } as unknown as PickRules;
      expect(offersPicksReask([row('a', 'holding'), row('far1', 'quiet', { questions: open(0) })], rules)).toBe(true);
      expect(offersPicksReask([row('far1', 'holding'), row('far2', 'holding')], rules)).toBe(false);
    } finally {
      resetMachineRoutes();
    }
  });
});

describe('what came of it', () => {
  const answer = (id: string, asked: string[], unreached: string[] = []): ReaskAllOutcome => ({
    row: row(id, 'holding'),
    ok: true,
    value: {
      thread_id: id,
      asked: asked.map((s) => ({ host: 'claude-code', session: s, message_id: `msg_${id}`, reply_id: `msg_r${id}${s}` })),
      unreached: unreached.map((s) => ({ host: 'pi', session: s })),
    },
  });

  test('each agent counts once across its threads; one asked anywhere is never also "could not be reached"', () => {
    const t = tallyReaskAll([answer('t1', ['ses_a']), answer('t2', ['ses_a', 'ses_b'], ['ses_c']), answer('t3', [], ['ses_c'])]);
    expect(t).toMatchObject({ asked: 2, unreached: 1, refused: 0 });
  });

  test('a note that failed beside one written: the agent asked counts, the failed one could not be reached', () => {
    const partial = answer('t1', ['ses_a']);
    if (partial.ok) partial.value.failed = [{ host: 'pi', session: 'ses_b' }];
    const toast = reaskAllToast(tallyReaskAll([partial]))!;
    expect(toast.lead).toBe('Asked 1 agent to re-ask');
    expect(toast.detail).toBe('1 could not be reached');
  });

  test('nothing to say in a toast: "Nothing to re-ask." unless every such thread had its agents asked again already', () => {
    const quiet = (already: number): ReaskAllOutcome => ({ row: row(`t${already}`, 'holding'), ok: true, value: { thread_id: 't', asked: [], unreached: [], failed: [], already } });
    // Only a permission prompt, or only picks: nobody was asked again.
    expect(reaskAllQuiet(tallyReaskAll([quiet(0)]))).toBe('Nothing to re-ask.');
    expect(reaskAllQuiet(tallyReaskAll([quiet(1), quiet(0)]))).toBe('Nothing to re-ask.');
    expect(reaskAllQuiet(tallyReaskAll([quiet(2)]))).toBe('Every agent was already asked again.');
  });

  test('the toast: a count and the ones not reached; a warning when none was asked; nothing to say when every agent waits already', () => {
    const some = reaskAllToast({ asked: 3, unreached: 1, refused: 0, cause: null })!;
    expect(some.icon).toBe('check');
    expect(some.lead).toContain('3');
    expect(some.detail).toContain('1');
    const none = reaskAllToast({ asked: 0, unreached: 2, refused: 0, cause: null })!;
    expect(none.icon).toBe('warn');
    expect(none.lead).toContain('2');
    expect(reaskAllToast({ asked: 0, unreached: 0, refused: 0, cause: null })).toBeNull();
  });
});

describe('bulkWrites.reaskAll', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetMachineRoutes();
  });

  test('one key for the press, only rows that take it as they are now, nothing for a linked machine’s thread, one toast with no Undo', async () => {
    const posts: { path: string; batch: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as { batch_id: string };
      posts.push({ path, batch: body.batch_id });
      const id = decodeURIComponent(/threads\/([^/]+)\/reask/.exec(path)![1]!);
      const view: ThreadReaskAllView = { thread_id: id, asked: [{ host: 'claude-code', session: `ses_${id}`, message_id: `msg_q${id}`, reply_id: `msg_n${id}` }], unreached: [] };
      return new Response(JSON.stringify(view), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const drawn = [row('msg_a', 'holding'), row('msg_b', 'holding'), row('msg_c', 'waiting'), row('msg_far', 'waiting')];
    // b was answered since it was drawn; far lives on a linked machine.
    const now = new Map(drawn.map((r) => [r.thread_id, r]));
    now.set('msg_b', row('msg_b', 'holding', { questions: open(0) }));
    rememberMachine(['msg_far'], 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const toasts: { lead: string; detail?: string; onUndo?: () => void }[] = [];
    const written: string[][] = [];
    const host = {
      rowOf: (id: string) => now.get(id),
      shownRef: { current: [band('holding', drawn.slice(0, 2)), band('waiting', drawn.slice(2))] },
      afterWrite: async (ids: readonly string[] = []) => void written.push([...ids]),
      showToast: (toast: { lead: string; detail?: string; onUndo?: () => void }) => void toasts.push(toast),
      say: () => {},
    } as unknown as BulkHost;
    expect(await bulkWrites(host).reaskAll(drawn)).toBe(true);
    expect(posts.map((p) => p.path)).toEqual(['/api/inbox/threads/msg_a/reask', '/api/inbox/threads/msg_c/reask']);
    expect(new Set(posts.map((p) => p.batch)).size).toBe(1);
    expect(written).toEqual([['msg_a', 'msg_c']]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.lead).toContain('2');
    // The linked machine's thread is no part of it: not counted as an agent not reached.
    expect(toasts[0]!.detail).toBeUndefined();
    expect(toasts[0]!.onUndo).toBeUndefined();
  });

  test('a thread whose only open item is a permission prompt, or whose agent has only picks: "Nothing to re-ask.", no toast', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ thread_id: 'msg_p', asked: [], unreached: [], failed: [], already: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const drawn = [row('msg_p', 'stopped')];
    const said: string[] = [];
    const toasts: unknown[] = [];
    const host = {
      rowOf: (id: string) => drawn.find((r) => r.thread_id === id),
      shownRef: { current: [band('stopped', drawn)] },
      afterWrite: async () => {},
      showToast: (toast: unknown) => void toasts.push(toast),
      say: (words: string) => void said.push(words),
    } as unknown as BulkHost;
    expect(await bulkWrites(host).reaskAll(drawn)).toBe(false);
    expect(said).toEqual(['Nothing to re-ask.']);
    expect(toasts).toEqual([]);
  });
});
