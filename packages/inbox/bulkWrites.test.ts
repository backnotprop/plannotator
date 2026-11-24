/**
 * The picks' bulk actions (bulkWrites.ts): every thread's write goes, a few at a time, each through its own route; a
 * write held for a machine that is away counts as made and the toast says when it applies; a refused one is counted
 * and its words shown; every refused leaves no toast of its own (the caller shows the error); one Undo takes back
 * exactly what was made.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { InboxApiError, InboxHeldError, inboxApi } from './api';
import { bulkToast, bulkWrites, eachRow, batchAllToast, tagsToast, type BulkHost } from './bulkWrites';
import { projectBatchToast } from './projectMenu';

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

  test('Mark all as read: the warning asks once for every row, one toast with its words after the count, one Undo', async () => {
    const { toasts, bulk } = harness();
    const asked: unknown[] = [];
    const calls: string[] = [];
    const real = inboxApi.markRead;
    inboxApi.markRead = (async (id: string, on: boolean) => {
      calls.push(`${on ? 'read' : 'unread'} ${id}`);
      return {};
    }) as typeof inboxApi.markRead;
    try {
      const rows = [
        { ...row('a'), questions: { open: 2, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 } },
        { ...row('b'), questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 } },
      ] as unknown as InboxListRow[];
      const ok = await bulkWrites({ ...bulk.host, warnSetAside: async (count: unknown) => (asked.push(count), true) }).markRead(rows, true);
      expect(ok).toBe(true);
      expect(asked).toEqual([{ questions: 2, actions: 0, threads: 1 }]);
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({ lead: 'Marked 2 threads read', detail: 'Closed 2 questions' });
      toasts[0]!.onUndo!();
      await flush();
      expect(calls.sort()).toEqual(['read a', 'read b', 'unread a', 'unread b']);
    } finally {
      inboxApi.markRead = real;
    }
  });

  test('Mark all as read cancelled at the warning writes nothing and shows no toast', async () => {
    const { toasts, bulk } = harness();
    const real = inboxApi.markRead;
    let wrote = 0;
    inboxApi.markRead = (async () => void (wrote += 1)) as unknown as typeof inboxApi.markRead;
    try {
      const rows = [{ ...row('a'), questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 } }] as unknown as InboxListRow[];
      expect(await bulkWrites({ ...bulk.host, warnSetAside: async () => false }).markRead(rows, true)).toBe(false);
      expect(wrote).toBe(0);
      expect(toasts).toHaveLength(0);
    } finally {
      inboxApi.markRead = real;
    }
  });
});

/** A full list row (the rules read its section, questions and agent activity). */
const NO_QUESTIONS = { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 };
const T1 = '2026-11-20T07:00:00.000Z';
const T2 = '2026-11-20T07:05:00.000Z';
function full(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    subject: id,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: 'Claude Code' },
    created_at: T1,
    last_at: T1,
    last_agent_at: T1,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: NO_QUESTIONS,
    waiting_on_person: true,
    project: { id: 'prj_a', name: 'alpha' },
    thread_name: null,
    section: 'new',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 1,
    sent: null,
    guide: false,
    priority: null,
    ...over,
  } as InboxListRow;
}

describe('Mark all as read and the picks’ Mark read read each thread as it is now', () => {
  /** A host whose list on screen (`shown`) holds still while `latest` (what `rowOf` reads) has moved on. */
  function listHost(shown: InboxListSection[], latest: InboxListRow[], over: Partial<BulkHost> = {}) {
    const state = { shown, toasts: [] as Record<string, unknown>[], asked: [] as unknown[], failed: [] as string[], said: [] as string[] };
    const host = {
      rowOf: (id: string) => latest.find((r) => r.thread_id === id),
      rowWrites: { draw: (id: string) => ({ failed: () => void state.failed.push(id), done: () => {} }) },
      setShown: (next: unknown) => {
        state.shown = typeof next === 'function' ? (next as (c: InboxListSection[]) => InboxListSection[])(state.shown) : (next as InboxListSection[]);
      },
      shownRef: {
        get current() {
          return state.shown;
        },
      },
      latestRef: { current: null },
      routeRef: { current: {} },
      listCovered: () => false,
      armSlide: () => {},
      afterWrite: async () => {},
      showToast: (toast: Record<string, unknown>) => void state.toasts.push(toast),
      dismissToast: () => {},
      say: (text: string) => void state.said.push(text),
      warnSetAside: async (count: unknown) => (state.asked.push(count), true),
      restoreSnooze: async () => {},
      restorePriority: async () => {},
      closeThread: () => {},
      openThread: () => {},
      ...over,
    } as unknown as BulkHost;
    return { state, bulk: bulkWrites(host) };
  }
  const shownRow = (state: { shown: InboxListSection[] }, id: string) => state.shown.flatMap((s) => s.threads).find((r) => r.thread_id === id)!;
  function withWrites<T>(refuse: string[], run: (written: string[]) => Promise<T>): Promise<T> {
    const written: string[] = [];
    const real = inboxApi.markRead;
    inboxApi.markRead = (async (id: string) => {
      if (refuse.includes(id)) throw new InboxApiError(409, 'gone', 'That thread is gone.');
      written.push(id);
      return {};
    }) as unknown as typeof inboxApi.markRead;
    return run(written).finally(() => {
      inboxApi.markRead = real;
    });
  }

  test('a thread in New whose agent has since asked a question (waiting behind "1 new · Show") is left out: not written, still new, no question closed', async () => {
    // On screen: "asked" in New with no question; since then its agent asked one. "quiet" has no news.
    const shown: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: [full('asked'), full('plain')] }];
    const latest = [full('asked', { section: 'waiting', last_at: T2, last_agent_at: T2, unseen: 2, message_count: 2, questions: { ...NO_QUESTIONS, open: 1 } }), full('plain')];
    const { state, bulk } = listHost(shown, latest);
    await withWrites([], async (written) => {
      expect(await bulk.markAllRead(shown[0]!.threads)).toBe(true);
      expect(written).toEqual(['plain']);
    });
    // The warning counted nothing (the only question is in the thread left out), and the toast closes none.
    expect(state.asked).toEqual([{ questions: 0, actions: 0, threads: 0 }]);
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]).toMatchObject({ lead: 'Marked 1 thread read', icon: 'check' });
    expect(state.toasts[0]!.detail).toBeUndefined();
    expect(shownRow(state, 'asked').unread).toBe(true);
    expect(shownRow(state, 'plain').unread).toBe(false);
  });

  test('every thread with news waiting: nothing written, no warning, no toast', async () => {
    const shown: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: [full('asked')] }];
    const { state, bulk } = listHost(shown, [full('asked', { last_at: T2, last_agent_at: T2, unseen: 2 })]);
    await withWrites([], async (written) => {
      expect(await bulk.markAllRead(shown[0]!.threads)).toBe(false);
      expect(written).toEqual([]);
    });
    expect(state.asked).toEqual([]);
    expect(state.toasts).toEqual([]);
  });

  test('the picks’ Mark read still writes a picked thread with news waiting, and its warning counts the question now there', async () => {
    const shown: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: [full('asked')] }];
    const { state, bulk } = listHost(shown, [full('asked', { section: 'waiting', last_at: T2, last_agent_at: T2, questions: { ...NO_QUESTIONS, open: 1 } })]);
    await withWrites([], async (written) => {
      await bulk.markRead(shown[0]!.threads);
      expect(written).toEqual(['asked']);
    });
    expect(state.asked).toEqual([{ questions: 1, actions: 0, threads: 1 }]);
  });

  test('one write refused among three: its row is drawn as it was, and the toast counts only the questions really closed', async () => {
    const q = (open: number) => ({ questions: { ...NO_QUESTIONS, open }, section: 'waiting' as const });
    const rows = [full('a', q(1)), full('b', q(2)), full('c', q(1))];
    const shown: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: rows }];
    const { state, bulk } = listHost(shown, rows);
    await withWrites(['b'], async (written) => {
      await bulk.markAllRead(rows);
      expect(written.sort()).toEqual(['a', 'c']);
    });
    expect(state.failed).toEqual(['b']);
    expect(shownRow(state, 'b')).toBe(rows[1]!);
    expect(shownRow(state, 'a').unread).toBe(false);
    expect(state.toasts[0]).toMatchObject({ icon: 'warn', lead: 'Marked 2 of 3 threads read', detail: 'Closed 2 questions · 1 did not change: That thread is gone.' });
  });

  test('Archive all: a thread whose agent asked since the list was drawn is left out (not archived away unseen), and so is one snoozed since', async () => {
    const shown: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [full('asked'), full('plain'), full('later')] }];
    const latest = [
      full('asked', { section: 'waiting', last_at: T2, last_agent_at: T2, unseen: 2, message_count: 2, questions: { ...NO_QUESTIONS, open: 1 } }),
      full('plain'),
      full('later', { snoozed: { until: '2099-01-01T00:00:00.000Z', at: T2 } as InboxListRow['snoozed'] }),
    ];
    const { state, bulk } = listHost(shown, latest);
    const calls: string[] = [];
    const real = inboxApi.resolve;
    inboxApi.resolve = (async (id: string, on: boolean) => void calls.push(`${on ? 'archive' : 'unarchive'} ${id}`)) as unknown as typeof inboxApi.resolve;
    try {
      expect(await bulk.archiveAll(shown[0]!.threads)).toBe(true);
      expect(calls).toEqual(['archive plain']);
      expect(state.toasts).toHaveLength(1);
      expect(state.toasts[0]).toMatchObject({ lead: 'Archived 1 thread', icon: 'archive' });
      expect(shownRow(state, 'asked').resolved_at).toBeNull();
      expect(shownRow(state, 'plain').resolved_at).not.toBeNull();
      // Only news waiting: nothing written, no toast.
      expect(await bulk.archiveAll([full('asked')])).toBe(false);
      expect(state.said).toEqual(['Nothing to archive.']);
    } finally {
      inboxApi.resolve = real;
    }
  });

  test('Archive all reads a thread that came back from the archive (archiving it again), and its Undo makes it unread again', async () => {
    const back = full('back', { resolved_at: T1, back_from_archive: true } as Partial<InboxListRow>);
    const rows = [full('open'), back];
    const shown: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: rows }];
    const { state, bulk } = listHost(shown, rows);
    const calls: string[] = [];
    const realResolve = inboxApi.resolve;
    const realRead = inboxApi.markRead;
    inboxApi.resolve = (async (id: string, on: boolean) => void calls.push(`${on ? 'archive' : 'unarchive'} ${id}`)) as unknown as typeof inboxApi.resolve;
    inboxApi.markRead = (async (id: string, on: boolean) => void calls.push(`${on ? 'read' : 'unread'} ${id}`)) as unknown as typeof inboxApi.markRead;
    try {
      await bulk.archiveAll(rows);
      expect(calls.sort()).toEqual(['archive open', 'read back']);
      expect(state.toasts[0]).toMatchObject({ lead: 'Archived 2 threads' });
      calls.length = 0;
      (state.toasts[0]!.onUndo as () => void)();
      await new Promise((done) => setTimeout(done, 10));
      expect(calls.sort()).toEqual(['unarchive open', 'unread back']);
    } finally {
      inboxApi.resolve = realResolve;
      inboxApi.markRead = realRead;
    }
  });

  test('Undo of Mark all as read: a thread read before (a read stamp, then Mark unread) goes back by Mark unread; one never read, by a move back', async () => {
    const looked = full('looked', { read_at: T1 } as Partial<InboxListRow>);
    const rows = [full('fresh'), looked];
    const shown: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: rows }];
    const { state, bulk } = listHost(shown, rows);
    const calls: string[] = [];
    const realRead = inboxApi.markRead;
    const realUnread = inboxApi.markUnread;
    inboxApi.markRead = (async (id: string, on: boolean) => void calls.push(`${on ? 'read' : 'unread'} ${id}`)) as unknown as typeof inboxApi.markRead;
    inboxApi.markUnread = (async (id: string) => void calls.push(`mark-unread ${id}`)) as unknown as typeof inboxApi.markUnread;
    try {
      await bulk.markAllRead(rows);
      expect(calls.sort()).toEqual(['read fresh', 'read looked']);
      calls.length = 0;
      (state.toasts[0]!.onUndo as () => void)();
      await new Promise((done) => setTimeout(done, 10));
      expect(calls.sort()).toEqual(['mark-unread looked', 'unread fresh']);
    } finally {
      inboxApi.markRead = realRead;
      inboxApi.markUnread = realUnread;
    }
  });
});

describe('Mark all as read’s and Archive all’s toast is the project menu’s', () => {
  const made = (r: InboxListRow) => ({ row: r, ok: true as const, value: undefined, held: null });
  test('a stopped agent: the warning icon, the phone’s words, and the whole name for the live region', () => {
    const long = 'Claude Code on the release machine in the back office';
    const stopped = full('s', { section: 'waiting', author: { kind: 'agent', host: 'claude-code', session: 'ses_s', name: long }, questions: { ...NO_QUESTIONS, open: 1, stopped: true } } as Partial<InboxListRow>);
    const ours = batchAllToast('read', [made(stopped), made(full('n'))])!;
    const project = projectBatchToast('read', 'alpha', 2, [stopped, full('n')]);
    expect(ours.icon).toBe('warn');
    expect(ours.icon).toBe(project.icon);
    expect(ours.detail).toBe(project.detail);
    expect(ours.phoneDetail).toBe(project.phoneDetail!);
    expect(ours.speech).toContain(`${long} was stopped`);
    expect(ours.detail).not.toContain(long);
  });
  test('questions closed: the project menu’s words, the check icon', () => {
    const ours = batchAllToast('read', [made(full('w', { section: 'waiting', questions: { ...NO_QUESTIONS, open: 2 } }))])!;
    expect(ours).toMatchObject({ icon: 'check', lead: 'Marked 1 thread read', detail: 'Closed 2 questions' });
  });
  test('Archive all: the project menu’s Archive all words and icon (a stopped agent warns)', () => {
    const stopped = full('s', { section: 'waiting', questions: { ...NO_QUESTIONS, open: 1, stopped: true } });
    const ours = batchAllToast('archive', [made(stopped), made(full('n'))])!;
    const project = projectBatchToast('archive', 'alpha', 2, [stopped, full('n')]);
    expect(ours).toMatchObject({ icon: 'warn', lead: 'Archived 2 threads', detail: project.detail });
    expect(batchAllToast('archive', [made(full('n'))])).toMatchObject({ icon: 'archive', lead: 'Archived 1 thread' });
  });
});
