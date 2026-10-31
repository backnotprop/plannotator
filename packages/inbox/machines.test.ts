/**
 * Linked machines in the window (docs/agent-guides/inbox-machines.md), the
 * pure half: a window routes another machine's thread through
 * `/api/inbox/m/<machine>/…` and its own through `/api/inbox/…`; nothing is
 * labelled, greyed or filtered while no machine is linked; the same folder on
 * two machines reads as two machines, not as a clash; a filter keeps one
 * machine's rows and "Hide offline machines" drops only the away ones; a held
 * answer says "Sending…" or "Will send when … is back" and never anything
 * like delivered before that machine answered (PLAN.md section 12).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { idsIn, InboxApiError, inboxApi, type MachineView, type OutboxView } from './api';
import { inboxUrl, isContested, machineOf, rememberMachine, resetMachineRoutes, setSelfMachine } from './inboxUrl';
import { filterMachineRows, machineCounts, machineProjectNames, machinesModel, outboxLine, threadAwayLine, threadOutbox } from './machines';

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const MINI = `ibx_01K${'0'.repeat(22)}N`;

function machine(id: string, name: string, state: MachineView['state'], extra: Partial<MachineView> = {}): MachineView {
  return { id, name, self: id === SELF, state, since: '2026-10-30T10:42:00.000Z', reason: null, version: '0.28.39', address: null, both_ways: true, waiting: 0, ...extra };
}

function row(id: string, section: InboxListSection['id'], owner?: string): InboxListRow {
  return { thread_id: id, section, project: { id: `prj_${id}`, name: 'billing-svc' }, ...(owner ? { machine: owner } : {}) } as unknown as InboxListRow;
}

function outbox(key: string, route: string, state: OutboxView['state'], extra: Partial<OutboxView> = {}): OutboxView {
  return { key, machine: MAC, route, state, queued_at: `2026-10-30T10:4${key.length % 10}:00.000Z`, settled_at: null, status: null, answer: null, notice: null, dismissed: false, words: 'Ship it', ...extra };
}

afterEach(() => resetMachineRoutes());

describe('routing', () => {
  test("another machine's ids go through its forward; this machine's and unknown ids stay local", () => {
    setSelfMachine(SELF);
    rememberMachine(['msg_01KREMOTE00000000000000001', 'thr_01KREMOTE00000000000000001'], MAC);
    // This machine's own id never becomes a forward, even when a frame names it.
    rememberMachine(['msg_01KLOCAL000000000000000001'], SELF);
    expect(machineOf('msg_01KREMOTE00000000000000001')).toBe(MAC);
    expect(machineOf('msg_01KLOCAL000000000000000001')).toBeNull();
    expect(inboxUrl('/messages/msg_01KREMOTE00000000000000001/reply', undefined, machineOf('msg_01KREMOTE00000000000000001'))).toBe(
      `/api/inbox/m/${MAC}/messages/msg_01KREMOTE00000000000000001/reply`,
    );
    expect(inboxUrl('/threads/x', 'a=1', MAC)).toBe(`/api/inbox/m/${MAC}/threads/x?a=1`);
    expect(inboxUrl('/threads/x', undefined, SELF)).toBe('/api/inbox/threads/x');
    expect(inboxUrl('/threads/x', undefined, null)).toBe('/api/inbox/threads/x');
  });
});

describe('never linked', () => {
  const sections: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [row('a', 'waiting'), row('b', 'waiting')] }];

  test('the model is empty: no machine to label, grey or filter, and the list and names are what they were', () => {
    for (const machines of [undefined, null, [], [machine(SELF, 'Studio', 'online')]]) {
      const model = machinesModel(machines);
      expect(model.linked).toEqual([]);
      expect(model.all).toEqual([]);
      expect(model.away.size).toBe(0);
      expect(filterMachineRows(sections, model, null, true)).toBe(sections);
      expect(filterMachineRows(sections, model, MAC, false)).toBe(sections);
      const names = machineProjectNames({ projects: [{ id: 'prj_a', root: '/w/billing-svc', name: 'billing-svc' }], sidebar: [{ id: 'prj_a' }], sections: [] }, model, true);
      expect(names.get('prj_a')).toBe('billing-svc');
    }
  });
});

describe('linked', () => {
  const machines = [machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'offline'), machine(MINI, 'Mini', 'online')];
  const model = machinesModel(machines);
  const sections: InboxListSection[] = [
    { id: 'waiting', label: 'Waiting on you', threads: [row('own', 'waiting'), row('mac', 'waiting', MAC), row('mini', 'waiting', MINI)] },
    { id: 'quiet', label: 'Quiet', threads: [row('mac2', 'quiet', MAC)] },
  ];
  const ids = (out: InboxListSection[]) => out.map((s) => s.threads.map((t) => t.thread_id));

  test('the same folder on two machines carries the other machine\'s name, not a clash; one machine\'s list drops it', () => {
    const projects = [
      { id: 'prj_own', root: '/work/billing-svc', name: 'billing-svc' },
      { id: 'prj_mac', root: '/work/billing-svc', name: 'billing-svc', machine: MAC },
    ];
    const labelled = machineProjectNames({ projects, sidebar: projects, sections: [] }, model, true);
    expect(labelled.get('prj_own')).toBe('billing-svc');
    expect(labelled.get('prj_mac')).toBe('billing-svc · MacBook');
    expect(machineProjectNames({ projects, sidebar: projects, sections: [] }, model, false).get('prj_mac')).toBe('billing-svc');
  });

  test('a machine filter keeps its rows (this machine: rows with no machine); Hide offline machines drops only the away ones', () => {
    expect(model.away).toEqual(new Set([MAC]));
    expect(ids(filterMachineRows(sections, model, MAC, false))).toEqual([['mac'], ['mac2']]);
    expect(ids(filterMachineRows(sections, model, SELF, false))).toEqual([['own'], []]);
    expect(ids(filterMachineRows(sections, model, null, true))).toEqual([['own', 'mini'], []]);
    expect(ids(filterMachineRows(sections, model, null, false))).toEqual([['own', 'mac', 'mini'], ['mac2']]);
    // The sidebar counts what waits on the person per machine, as Projects counts do.
    expect(machineCounts(sections, model)).toEqual(new Map([[SELF, 1], [MAC, 1], [MINI, 1]]));
  });

  test("an away machine's thread that cannot open says so; one that is there says nothing", () => {
    expect(threadAwayLine(machines[1])).toStartWith('MacBook asleep since ');
    expect(threadAwayLine(machines[1])).toEndWith('This thread opens when it is back.');
    expect(threadAwayLine(machine(MAC, 'MacBook', 'needs_update'))).toBe('Update Plannotator on MacBook to see its threads here.');
    expect(threadAwayLine(machines[2])).toBeNull();
    expect(threadAwayLine(undefined)).toBeNull();
  });
});

describe('held answers', () => {
  const asleep = machine(MAC, 'MacBook', 'offline');
  const online = machine(MAC, 'MacBook', 'online');

  test('waiting reads "Sending to …" while it is there and "Will send when … is back" while it sleeps; a delivered one says nothing', () => {
    const held = outbox('k1', 'messages/msg_1/reply', 'queued');
    expect(outboxLine(held, asleep)).toEqual({ tone: 'waiting', text: 'Will send when MacBook is back' });
    expect(outboxLine(outbox('k1', 'messages/msg_1/reply', 'sending'), online)).toEqual({ tone: 'waiting', text: 'Sending to MacBook…' });
    expect(outboxLine(outbox('k1', 'messages/msg_1/reply', 'delivered'), online)).toBeNull();
    for (const state of ['queued', 'sending'] as const) {
      for (const m of [asleep, online]) expect(outboxLine(outbox('k', 'messages/msg_1/reply', state), m)!.text).not.toMatch(/deliver/i);
    }
  });

  test('a write that did not land says why, until dismissed', () => {
    const refused = outbox('k2', 'messages/msg_1/reply', 'refused', { notice: { kind: 'refused', at: 'x' }, answer: { error: 'The question was already answered.' } });
    expect(outboxLine(refused, online)).toEqual({ tone: 'failed', text: 'Not delivered: The question was already answered.' });
    expect(outboxLine({ ...refused, notice: { kind: 'may_have_been_delivered', at: 'x' } }, online)!.text).toBe('May have been delivered. Check on MacBook.');
    expect(outboxLine({ ...refused, dismissed: true }, online)).toBeNull();
  });

  test("a thread shows its own held words and failures, oldest first; not other threads', not a delivered one, not a read mark", () => {
    const entries = new Map<string, OutboxView>(
      [
        outbox('k-reply', 'messages/msg_1/reply', 'queued', { queued_at: '2026-10-30T10:45:00.000Z' }),
        outbox('k-msg', 'threads/thr_1/message', 'sending', { queued_at: '2026-10-30T10:44:00.000Z' }),
        outbox('k-read', 'threads/thr_1/read', 'queued'),
        outbox('k-done', 'messages/msg_1/reask', 'delivered'),
        outbox('k-other', 'messages/msg_9/reply', 'queued'),
        outbox('k-fail', 'messages/msg_1/reply', 'refused', { notice: { kind: 'refused', at: 'x' }, queued_at: '2026-10-30T10:40:00.000Z' }),
      ].map((e) => [e.key, e]),
    );
    const shown = threadOutbox(entries, { thread_id: 'thr_1', messages: [{ id: 'msg_1' }] });
    expect(shown.map((e) => e.key)).toEqual(['k-fail', 'k-msg', 'k-reply']);
  });
});

describe('held answers by state', () => {
  test('connecting is on its way, out of date waits for an update, removed there says it will not go; none says delivered', () => {
    const held = outbox('k', 'messages/msg_1/reply', 'queued');
    expect(outboxLine(held, machine(MAC, 'MacBook', 'connecting'))!.text).toBe('Sending to MacBook…');
    expect(outboxLine(held, machine(MAC, 'MacBook', 'needs_update'))!.text).toBe('Will send when MacBook is updated');
    expect(outboxLine(held, machine(MAC, 'MacBook', 'revoked'))!.text).toMatch(/^Not sent: MacBook removed the link/);
    for (const state of ['connecting', 'needs_update', 'revoked', 'offline', 'online'] as const) {
      expect(outboxLine(held, machine(MAC, 'MacBook', state))!.text).not.toMatch(/deliver/i);
    }
  });

  test('a held answer the window tied to its thread shows while the thread cannot be read (no messages yet), and only there', () => {
    const entries = new Map<string, OutboxView>(
      [outbox('k-mine', 'messages/msg_1/reply', 'queued', { thread: 'thr_1' }), outbox('k-other', 'messages/msg_9/reply', 'queued', { thread: 'thr_9' })].map((e) => [e.key, e]),
    );
    expect(threadOutbox(entries, { thread_id: 'thr_1', messages: [] }).map((e) => e.key)).toEqual(['k-mine']);
  });
});

describe("thread ids: a linked machine never takes over this machine's", () => {
  const LOCAL = 'thr_01KLOCAL00000000000000001';
  const REMOTE = 'thr_01KREMOTE0000000000000001';
  const LOCAL_PROJECT = 'prj_01KLOCAL00000000000000001';
  const REMOTE_PROJECT = 'prj_01KREMOTE0000000000000001';
  const listModel = {
    self: SELF,
    sections: [
      {
        id: 'needs_you',
        threads: [
          { thread_id: LOCAL, section: 'needs_you', project: { id: LOCAL_PROJECT, name: 'billing-svc' } },
          // MacBook sends a row with this machine's own thread id, and one of its own.
          { thread_id: LOCAL, section: 'needs_you', project: { id: REMOTE_PROJECT, name: 'billing-svc' }, machine: MAC },
          { thread_id: REMOTE, section: 'needs_you', project: { id: REMOTE_PROJECT, name: 'billing-svc' }, machine: MAC },
        ],
      },
    ],
    projects: [
      { id: LOCAL_PROJECT, name: 'billing-svc' },
      { id: REMOTE_PROJECT, name: 'billing-svc', machine: MAC },
    ],
    machines: [],
  };

  /** The window's fetch, answered by `answer` for the time of `run`; every URL it asked, in order. */
  async function withFetch(answer: (url: string) => Response, run: () => Promise<unknown>): Promise<string[]> {
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return answer(String(input));
    }) as unknown as typeof fetch;
    try {
      await run().catch(() => {});
    } finally {
      globalThis.fetch = realFetch;
    }
    return asked;
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const listOf = (rows: Record<string, unknown>[]) => ({ self: SELF, sections: [{ id: 'needs_you', threads: rows }], projects: [], machines: [] });
  const ROW = (thread: string, owner?: string, extra: Record<string, unknown> = {}) => ({
    thread_id: thread,
    section: 'needs_you',
    project: { id: owner ? REMOTE_PROJECT : LOCAL_PROJECT, name: 'billing-svc' },
    ...(owner ? { machine: owner } : {}),
    ...extra,
  });

  test('a peer listing a local active id: the id stays local, and no later answer or frame from a linked machine claims it', async () => {
    await withFetch(() => json(listModel), () => inboxApi.list());
    expect(machineOf(LOCAL)).toBeNull();
    expect(machineOf(LOCAL_PROJECT)).toBeNull();
    expect(machineOf(REMOTE)).toBe(MAC);
    rememberMachine([LOCAL], MAC);
    rememberMachine([LOCAL], MINI);
    expect(machineOf(LOCAL)).toBeNull();
    expect(inboxUrl(`/threads/${LOCAL}/read`, undefined, machineOf(LOCAL))).toBe(`/api/inbox/threads/${LOCAL}/read`);
  });

  test("a peer listing a local archived id: the archived list made it local, so an unarchive or a reply stays here", async () => {
    const ARCHIVED = 'thr_01KARCHIVED00000000000001';
    await withFetch(() => json({ threads: [{ thread_id: ARCHIVED, project: { id: LOCAL_PROJECT } }], total: 1 }), () => inboxApi.archived());
    await withFetch(() => json(listOf([ROW(ARCHIVED, MAC)])), () => inboxApi.list());
    expect(machineOf(ARCHIVED)).toBeNull();
  });

  test('a peer listing a local pinned id (a pinned row of this machine, a pin-only one included) cannot take it', async () => {
    const PINNED = 'thr_01KPINNED000000000000001';
    // This machine's pinned row and MacBook's copy of it, in either order in the same list.
    await withFetch(() => json(listOf([ROW(PINNED, MAC), ROW(PINNED, undefined, { pinned_at: '2026-10-30T10:00:00.000Z' })])), () => inboxApi.list());
    expect(machineOf(PINNED)).toBeNull();
  });

  test('a peer event naming a local message id, then Send now from the row: it goes to this Inbox', async () => {
    const MESSAGE = 'msg_01KLOCALDELIVERY000000001';
    // The list row carries its delivery's message id: local, though its thread was never opened here.
    await withFetch(() => json(listOf([ROW(LOCAL, undefined, { delivery: { message_id: MESSAGE, state: 'queued' } })])), () => inboxApi.list());
    rememberMachine([MESSAGE], MAC);
    expect(machineOf(MESSAGE)).toBeNull();
    const asked = await withFetch(() => json({ ok: true }), () => inboxApi.sendNow(MESSAGE));
    expect(asked).toEqual([`/api/inbox/messages/${MESSAGE}/send-now`]);
  });

  test("a kept compose draft naming another machine's project leaves that project on its machine", async () => {
    await withFetch(() => json({ ...listOf([ROW(REMOTE, MAC)]), projects: [{ id: REMOTE_PROJECT, name: 'billing-svc', machine: MAC }] }), () => inboxApi.list());
    expect(machineOf(REMOTE_PROJECT)).toBe(MAC);
    // This Inbox's drafts answer echoes the project the draft was written for: not a record of this Inbox.
    await withFetch(
      () => json({ serverSession: 'srv', drafts: [{ id: 'drf_1', project: { id: REMOTE_PROJECT, name: 'billing-svc' }, body: 'hi' }] }),
      () => inboxApi.drafts(),
    );
    expect(machineOf(REMOTE_PROJECT)).toBe(MAC);
    const asked = await withFetch(() => json({ read: [] }), () => inboxApi.markProjectRead(REMOTE_PROJECT, 'b1'));
    expect(asked).toEqual([`/api/inbox/m/${MAC}/projects/${REMOTE_PROJECT}/read`]);
  });

  test('the server says an id is this machine\'s (id_is_local): the window stops forwarding it and asks this Inbox', async () => {
    const UNSEEN = 'msg_01KUNSEENLOCAL000000000001';
    rememberMachine([UNSEEN], MAC);
    const asked = await withFetch(
      (url) => (url.includes('/m/') ? json({ error: 'That is on this computer.', code: 'id_is_local', id: UNSEEN }, 409) : json({ ok: true })),
      () => inboxApi.sendNow(UNSEEN),
    );
    expect(asked).toEqual([`/api/inbox/m/${MAC}/messages/${UNSEEN}/send-now`, `/api/inbox/messages/${UNSEEN}/send-now`]);
    expect(machineOf(UNSEEN)).toBeNull();
  });

  for (const [first, second] of [
    [MAC, MINI],
    [MINI, MAC],
  ] as const) {
    test(`two peers claiming one id (${first === MAC ? 'MacBook' : 'Mini'} first): it routes to neither, and opening it is refused plainly`, async () => {
      await withFetch(() => json(listOf([ROW(REMOTE, first), ROW(REMOTE, second)])), () => inboxApi.list());
      expect(machineOf(REMOTE)).toBeNull();
      expect(isContested(REMOTE)).toBe(true);
      // A later list in the other order, or a frame from either, gives it to no one.
      await withFetch(() => json(listOf([ROW(REMOTE, second), ROW(REMOTE, first)])), () => inboxApi.list());
      rememberMachine([REMOTE], first);
      expect(machineOf(REMOTE)).toBeNull();
      let refused: unknown = null;
      const asked = await withFetch(
        () => json({}),
        () => inboxApi.thread(REMOTE).catch((cause) => (refused = cause)),
      );
      expect(asked).toEqual([]);
      expect(refused).toBeInstanceOf(InboxApiError);
      expect((refused as InboxApiError).code).toBe('machine_conflict');
    });
  }

  test('a forwarded answer teaches only its routed id fields, never any string under a key ending in _id', () => {
    const ids = idsIn({
      thread: { id: REMOTE, messages: [{ message_id: 'msg_01KREMOTE00000000000000001' }] },
      x_id: LOCAL,
      session_id: 'ses_01KREMOTE0000000000000001',
    });
    expect([...ids].sort()).toEqual(['msg_01KREMOTE00000000000000001', REMOTE]);
  });
});
