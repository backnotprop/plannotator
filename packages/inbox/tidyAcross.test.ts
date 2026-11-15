/**
 * Tidy across machines (tidyAcross.ts): picked threads go to the machine that holds them, a machine away or too old
 * is named instead of asked, the parts' plans read as one, and each machine is sent only its own agents under its
 * own key (the outbox refuses one key on two machines); a refused part gets a new key for the next press, and only it.
 */
import { expect, test } from 'bun:test';
import type { InboxListRow, InboxTidyPlan } from '@plannotator/core/inbox-types';
import { InboxApiError } from './apiError';
import type { MachinesModel } from './machines';
import { PressKeys } from './pressKeys';
import { mergePlans, pickTargets, startAcross, type TidyAcrossAgent } from './tidyAcross';

const model = (marks: string[]): MachinesModel =>
  ({ self: 'm_self', all: [], linked: [{ id: 'm_mini', name: 'Mac mini', marks, state: 'online' }], names: new Map([['m_mini', 'Mac mini']]), away: new Set() }) as unknown as MachinesModel;
const row = (id: string, machine?: string) => ({ thread_id: id, ...(machine ? { machine } : {}) }) as InboxListRow;
const plan = (agents: string[], extra: Partial<InboxTidyPlan> = {}): InboxTidyPlan => ({
  serverSession: 's',
  count: agents.length,
  agents: agents.map((session) => ({ session, host: 'claude-code', name: session, reach: 'wakes' as const, items: [{ thread_id: 't' } as never] })),
  run: null,
  ...extra,
});

test('picked rows go to the machine that holds them, this one first', () => {
  const targets = pickTargets([row('a', 'm_mini'), row('b'), row('c', 'm_mini')], model(['tidy']));
  expect(targets).toEqual([
    { machine: null, name: null, threads: ['b'] },
    { machine: 'm_mini', name: 'Mac mini', threads: ['a', 'c'] },
  ]);
});

test('a machine too old for Tidy is out, and its threads are counted as not asked', () => {
  const targets = pickTargets([row('a', 'm_mini'), row('b')], model([]));
  expect(targets[1]).toMatchObject({ machine: 'm_mini', out: true });
  const merged = mergePlans(targets.map((target) => ({ target, plan: target.out ? null : plan(['ses_1'], { unreached: { ended: 1, asked: 0 } }) })))!;
  expect(merged.agents.map((a) => a.session)).toEqual(['ses_1']);
  expect(merged.unasked).toEqual([{ name: 'Mac mini', threads: 1 }]);
  expect(merged.unreached).toEqual({ ended: 1, asked: 0 });
});

test('the parts read as one: every agent, named with its machine', () => {
  const targets = pickTargets([row('a', 'm_mini'), row('b')], model(['tidy']));
  const merged = mergePlans([
    { target: targets[0]!, plan: plan(['ses_here']) },
    { target: targets[1]!, plan: plan(['ses_far']) },
  ])!;
  expect(merged.agents.map((a) => [a.session, a.machine, a.machineName])).toEqual([
    ['ses_far', 'm_mini', 'Mac mini'],
    ['ses_here', null, null],
  ]);
  expect(merged.count).toBe(2);
});

test('each machine is sent its own agents under its own key; a refusal is said', async () => {
  const agents = [
    { session: 'ses_here', machine: null },
    { session: 'ses_far', machine: 'm_mini' },
    { session: 'ses_far2', machine: 'm_mini' },
  ] as TidyAcrossAgent[];
  const sent: [string | null, string[], string][] = [];
  expect(await startAcross(agents, 'k', async (machine, sessions, key) => void sent.push([machine, sessions, key]))).toBeNull();
  expect(sent).toEqual([
    [null, ['ses_here'], 'k'],
    ['m_mini', ['ses_far', 'ses_far2'], 'k-m_mini'],
  ]);
  const failed = await startAcross(agents, 'k', async (machine) => {
    if (machine) throw new Error('Mac mini is away.');
  });
  expect(failed).toBe('Mac mini is away.');
});

test('pressed again: only the part a machine refused gets a new key; one that went, or was lost on the way, keeps its own', async () => {
  const agents = [
    { session: 'ses_here', machine: null },
    { session: 'ses_far', machine: 'm_mini' },
    { session: 'ses_box', machine: 'm_box' },
  ] as TidyAcrossAgent[];
  const keys = new PressKeys('tidy', 'k');
  const sent: Record<string, string>[] = [];
  const press = (fail: Record<string, Error>) => {
    const round: Record<string, string> = {};
    sent.push(round);
    return startAcross(agents, keys, async (machine, _sessions, key) => {
      round[machine ?? 'here'] = key;
      if (fail[machine ?? 'here']) throw fail[machine ?? 'here'];
    });
  };
  expect(await press({ m_mini: new InboxApiError(409, 'session_not_live', 'That session ended.'), m_box: new TypeError('Failed to fetch') })).toBe('That session ended.');
  expect(await press({})).toBeNull();
  expect(sent[0]).toEqual({ here: 'k', m_mini: 'k-m_mini', m_box: 'k-m_box' });
  expect(sent[1]!.here).toBe('k');
  expect(sent[1]!.m_box).toBe('k-m_box');
  expect(sent[1]!.m_mini).not.toBe('k-m_mini');
  expect(sent[1]!.m_mini.endsWith('-m_mini')).toBe(true);
});
