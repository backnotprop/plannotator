/**
 * The picks' bulk actions (bulkWrites.ts): every thread's write goes, a few at a time, each through its own route; a
 * write held for a machine that is away counts as made and the toast says when it applies; a refused one is counted
 * and its words shown; every refused leaves no toast of its own (the caller shows the error); one Undo takes back
 * exactly what was made.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { InboxApiError, InboxHeldError, inboxApi } from './api';
import { bulkToast, bulkWrites, eachRow, tagsToast, type BulkHost } from './bulkWrites';

const row = (id: string) => ({ thread_id: id, subject: id }) as InboxListRow;
const held = (name: string) => new InboxHeldError({ id: 'out_1', state: 'queued' } as never, { name, state: 'asleep' } as never);

describe('eachRow', () => {
  test('keeps the rows order, at most six writes on their way at once', async () => {
    let now = 0;
    let most = 0;
    const rows = Array.from({ length: 15 }, (_, i) => row(`t${i}`));
    const out = await eachRow(rows, async (r) => {
      now += 1;
      most = Math.max(most, now);
      await new Promise((done) => setTimeout(done, 1));
      now -= 1;
      return r.thread_id;
    });
    expect(out.map((o) => (o.ok ? o.value : null))).toEqual(rows.map((r) => r.thread_id));
    expect(most).toBe(6);
  });
  test('a held write is made, for the machine named; a refusal keeps its cause', async () => {
    const out = await eachRow([row('a'), row('b'), row('c')], async (r) => {
      if (r.thread_id === 'b') throw held('Mac mini');
      if (r.thread_id === 'c') throw new InboxApiError(409, 'gone', 'That thread is gone.');
      return true;
    });
    expect(out.map((o) => o.ok)).toEqual([true, true, false]);
    expect(out[1]!.ok && out[1]!.held).toBe('Mac mini');
  });
});

describe('bulkToast', () => {
  const made = (id: string, machine: string | null = null) => ({ row: row(id), ok: true as const, value: undefined, held: machine });
  const refused = (id: string, why: string) => ({ row: row(id), ok: false as const, cause: new Error(why) });

  test('every write made: the count, with Undo by the caller', () => {
    expect(bulkToast('archive', [made('a'), made('b'), made('c')])).toEqual({ icon: 'archive', lead: 'Archived 3 threads', phoneLead: 'Archived 3' });
    expect(bulkToast('read', [made('a')])!.lead).toBe('Marked 1 thread read');
    expect(bulkToast('priority-remove', [made('a'), made('b')])!.lead).toBe('Removed 2 threads from Priority');
  });
  test('a snooze names its time; writes held for an away machine say when they apply', () => {
    const copy = bulkToast('snooze', [made('a'), made('b', 'Mac mini')], 'Sat 8:00 AM');
    expect(copy!.lead).toBe('Snoozed 2 threads');
    expect(copy!.detail).toBe('Sat 8:00 AM · 1 when Mac mini is back');
  });
  test('some refused: "2 of 3", a warning, and the first refusal in words', () => {
    const copy = bulkToast('archive', [made('a'), refused('b', 'That thread is gone.'), made('c')]);
    expect(copy).toEqual({ icon: 'warn', lead: 'Archived 2 of 3 threads', phoneLead: 'Archived 2', detail: '1 did not change: That thread is gone.', wrap: true });
  });
  test('every one refused: no toast here (the window shows the error)', () => {
    expect(bulkToast('star', [refused('a', 'No.')])).toBeNull();
  });
  test('Add tag: the tag after the count', () => {
    expect(tagsToast([made('a'), made('b')], 'Billing', true)).toMatchObject({ icon: 'check', lead: 'Tagged 2 threads', detail: 'Billing' });
    expect(tagsToast([made('a'), made('b')], 'Billing', false)).toMatchObject({ lead: 'Removed 2 threads', detail: 'from Billing' });
  });
});

describe('one Undo', () => {
  /** A host that keeps what it was asked; the list draws nothing (no rows shown). */
  function harness() {
    const toasts: { onUndo?: () => void; lead: string }[] = [];
    const restored: string[] = [];
    const host = {
      rowOf: () => undefined,
      rowWrites: { draw: () => ({ failed: () => {}, done: () => {} }) },
      setShown: () => {},
      shownRef: { current: null },
      latestRef: { current: null },
      routeRef: { current: {} },
      listCovered: () => false,
      armSlide: () => {},
      afterWrite: async () => {},
      showToast: (toast: { onUndo?: () => void; lead: string }) => void toasts.push(toast),
      dismissToast: () => {},
      say: () => {},
      warnSetAside: async () => true,
      restoreSnooze: async (id: string, snoozed: unknown) => {
        restored.push(`snooze ${id} ${snoozed ? 'on' : 'off'}`);
        if (id === 'b') throw held('Mac mini');
      },
      restorePriority: async (id: string, priority: unknown) => {
        restored.push(`priority ${id} ${priority ? 'on' : 'off'}`);
        if (id === 'b') throw held('Mac mini');
      },
      closeThread: () => {},
      openThread: () => {},
    } as unknown as BulkHost;
    return { toasts, restored, bulk: bulkWrites(host) };
  }
  const flush = () => new Promise((done) => setTimeout(done, 10));

  test('an Archive’s Undo unarchives only what was archived, held ones too, and brings back their snooze and Priority', async () => {
    const { toasts, restored, bulk } = harness();
    const calls: string[] = [];
    const real = inboxApi.resolve;
    inboxApi.resolve = (async (id: string, resolved: boolean) => {
      calls.push(`${resolved ? 'archive' : 'unarchive'} ${id}`);
      // b's machine is away: held both ways. c is refused.
      if (id === 'b') throw held('Mac mini');
      if (id === 'c' && resolved) throw new InboxApiError(409, 'gone', 'That thread is gone.');
      return {};
    }) as typeof inboxApi.resolve;
    try {
      const rows = [
        { ...row('a'), snoozed: { until: '2099-01-01T00:00:00.000Z', at: '2026-11-01T00:00:00.000Z' }, priority: { at: '2026-11-01T00:00:00.000Z' } },
        { ...row('b'), snoozed: { until: '2099-01-01T00:00:00.000Z', at: '2026-11-01T00:00:00.000Z' }, priority: { at: '2026-11-01T00:00:00.000Z' } },
        { ...row('c'), priority: { at: '2026-11-01T00:00:00.000Z' } },
      ] as unknown as InboxListRow[];
      await bulk.archive(rows);
      expect(toasts).toHaveLength(1);
      toasts[0]!.onUndo!();
      await flush();
      expect(calls.filter((c) => c.startsWith('unarchive')).sort()).toEqual(['unarchive a', 'unarchive b']);
      // b's unarchive was held: its snooze and Priority are still asked for, in order, after it.
      expect(restored.sort()).toEqual(['priority a on', 'priority b on', 'snooze a on', 'snooze b on']);
    } finally {
      inboxApi.resolve = real;
    }
  });

  test('a Snooze’s Undo puts back only the snoozes that were made', async () => {
    const { toasts, bulk } = harness();
    const calls: string[] = [];
    const real = inboxApi.snooze;
    inboxApi.snooze = (async (id: string, until: string | null) => {
      calls.push(`${id} ${until ?? 'none'}`);
      if (id === 'c') throw new InboxApiError(409, 'gone', 'That thread is gone.');
      return {};
    }) as typeof inboxApi.snooze;
    try {
      await bulk.snooze([row('a'), row('c')], '2099-01-01T00:00:00.000Z');
      toasts[0]!.onUndo!();
      await flush();
      expect(calls).toEqual(['a 2099-01-01T00:00:00.000Z', 'c 2099-01-01T00:00:00.000Z', 'a none']);
    } finally {
      inboxApi.snooze = real;
    }
  });
});
