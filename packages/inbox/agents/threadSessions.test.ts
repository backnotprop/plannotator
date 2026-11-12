/**
 * A thread's sessions as its header names them (issue #3108, `threadSessions` in agents/model.ts): the sidebar's
 * names for listed agents, the session's label or its agent's name otherwise, one entry per agent.
 *
 * What this catches: a session named by a thread's subject or a project inside a thread (the sidebar's fallbacks,
 * which there read as the thread's own title), a title or label it was given left out,
 * a conversation that went on under a new session id counted twice, a session that ended read as running (or as
 * "ended" on a machine whose agents the Inbox does not list), and another machine's agent with the same session id
 * taken for this one's.
 */
import { expect, test } from 'bun:test';
import type { InboxAgent, InboxAgentsGroup, InboxListRow, InboxParticipant } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
import { machinesModel } from '../machines';
import { agentRowName, agentThread, threadSessions } from './model';

const SELF = 'ibx_01K0000000000000000000000S';
const MAC = 'ibx_01K0000000000000000000000M';
const view = (id: string, name: string): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0 }) as MachineView;

const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({
  id,
  session: id,
  host: 'claude-code',
  project: { id: 'prj_bill', name: 'billing-svc' },
  state: 'idle',
  waiting: 0,
  live: true,
  started_at: '2026-11-09T09:14:00.000Z',
  last_seen_at: '2026-11-09T09:46:00.000Z',
  ...over,
});
const group = (agents: InboxAgent[], machine?: string): InboxAgentsGroup => ({ ...(machine ? { machine } : {}), agents, total: agents.length, ended_today: 0 });
const who = (session: string, host = 'claude-code', name?: string): InboxParticipant => ({ host, session, ...(name ? { name } : {}) });
const NONE: InboxListRow[] = [];

test('three Claude Code sessions: each by its sidebar name (its label), in the order they joined, with its state', () => {
  const groups = [
    group([
      agent('ses_b', { label: 'Retry worker', state: 'working' }),
      agent('ses_a', { label: 'Billing refactor', state: 'waiting', waiting: 1 }),
      agent('ses_c', { label: 'Ledger export' }),
    ]),
  ];
  const sessions = threadSessions([who('ses_a'), who('ses_b'), who('ses_c')], groups, machinesModel(null), NONE, null);
  expect(sessions.map((s) => [s.name, s.state, s.agentId])).toEqual([
    ['Billing refactor', 'waiting', 'ses_a'],
    ['Retry worker', 'working', 'ses_b'],
    ['Ledger export', 'idle', 'ses_c'],
  ]);
});

test('a conversation that went on under a new session id is one session, by its current name', () => {
  const groups = [group([agent('ses_new', { label: 'Billing refactor', continues: ['ses_old'] }), agent('ses_pi', { host: 'pi', label: 'Docs pass' })])];
  const sessions = threadSessions([who('ses_old'), who('ses_pi', 'pi'), who('ses_new')], groups, machinesModel(null), NONE, null);
  expect(sessions.map((s) => [s.name, s.sessions])).toEqual([
    ['Billing refactor', ['ses_old', 'ses_new']],
    ['Docs pass', ['ses_pi']],
  ]);
});

test('a session the list no longer names: its label, else its agent\'s name, and "ended" when the list names this machine\'s agents', () => {
  const groups = [group([agent('ses_a', { label: 'Billing refactor' })])];
  const sessions = threadSessions([who('ses_a'), who('ses_gone'), who('ses_cx', 'codex')], groups, machinesModel(null), NONE, null, { ses_gone: 'Old spike' });
  expect(sessions.map((s) => [s.name, s.state, s.agentId])).toEqual([
    ['Billing refactor', 'idle', 'ses_a'],
    ['Old spike', 'ended', null],
    ['Codex', 'ended', null],
  ]);
});

test('no agents list at all: labels and agent names, and no state (never "ended" for want of a list)', () => {
  const sessions = threadSessions([who('ses_a'), who('ses_b', 'pi')], null, machinesModel(null), NONE, null, { ses_a: 'Billing refactor' });
  expect(sessions.map((s) => [s.name, s.state])).toEqual([
    ['Billing refactor', null],
    ['Pi', null],
  ]);
});

test("another machine's thread is named from that machine's agents, never this one's with the same session id", () => {
  const machines = machinesModel([view(SELF, 'Studio'), view(MAC, 'MacBook')]);
  const groups = [group([agent('ses_a', { label: 'Here' }), agent('ses_b', { label: 'Here too' })], SELF), group([agent('ses_a', { label: 'On the MacBook', state: 'working' })], MAC)];
  const sessions = threadSessions([who('ses_a'), who('ses_b')], groups, machines, NONE, MAC);
  expect(sessions.map((s) => [s.name, s.state])).toEqual([
    ['On the MacBook', 'working'],
    ['Claude Code', 'ended'],
  ]);
});

test("an unnamed session is its agent inside a thread, never the sidebar's thread or project name; two read the same", () => {
  const rows = [
    { thread_id: 't_inv', subject: 'Invoice retries', thread_name: null, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null }, last_at: '2026-11-09T09:00:00.000Z', waiting_on_person: false },
  ] as unknown as InboxListRow[];
  const a = agent('ses_a');
  const b = agent('ses_b', { project: { id: 'prj_bill', name: 'billing-svc' } });
  const pi = agent('ses_pi', { host: 'pi', label: 'Queue timeouts' });
  // The sidebar names them by their thread and their project (unchanged).
  expect(agentRowName(a, agentThread(a, null, null, rows))).toBe('Invoice retries');
  expect(agentRowName(b, agentThread(b, null, null, rows))).toBe('billing-svc');
  const sessions = threadSessions([who('ses_a'), who('ses_b'), who('ses_pi', 'pi')], [group([a, b, pi])], machinesModel(null), rows, null);
  expect(sessions.map((s) => s.name)).toEqual(['Claude Code', 'Claude Code', 'Queue timeouts']);
});
