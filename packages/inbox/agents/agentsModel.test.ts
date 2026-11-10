/**
 * The Agents section's groups, names, threads and hover facts (agents/model.ts), from the list's `agents`, its rows
 * and the linked machines.
 *
 * What this catches: an agent filed under the wrong machine (or a linked machine's caption lost when it has no agent,
 * which takes its filter away), an ended agent listed again ("N ended today" was dropped), an agent opening another
 * machine's thread with the same session, a row named by its session id instead of words, and a hover card that
 * invents a fact the window does not have.
 */
import { expect, test } from 'bun:test';
import type { InboxAgent, InboxAgentsGroup, InboxListRow } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
import { machinesModel } from '../machines';
import { agentFacts, agentRowName, agentsGroups, agentThread } from './model';

const SELF = 'ibx_01K0000000000000000000000S';
const MAC = 'ibx_01K0000000000000000000000M';
const view = (id: string, name: string, over: Partial<MachineView> = {}): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, ...over }) as MachineView;

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
const row = (id: string, session: string, over: Partial<InboxListRow> = {}): InboxListRow =>
  ({
    thread_id: id,
    subject: `Subject ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session, name: null },
    last_at: '2026-11-09T09:00:00.000Z',
    waiting_on_person: false,
    ...over,
  }) as InboxListRow;

test('no machine linked: one flat group of this Inbox\'s agents, an ended one left out', () => {
  const groups = agentsGroups([group([agent('ses_a'), agent('ses_b', { state: 'ended', live: false })])], machinesModel(null), []);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.machine).toBeNull();
  expect(groups[0]!.agents.map((e) => e.agent.id)).toEqual(['ses_a']);
});

test('linked: one group per machine in the machines\' order, each with its own agents; a machine with none keeps its caption', () => {
  const machines = machinesModel([view(SELF, 'Studio'), view(MAC, 'MacBook'), view('ibx_01K0000000000000000000000N', 'Mini')]);
  const groups = agentsGroups([group([agent('ses_s')], SELF), group([agent('ses_m'), agent('ses_w', { state: 'waiting', waiting: 2, live: false })], MAC)], machines, []);
  expect(groups.map((g) => g.machine?.name)).toEqual(['Studio', 'MacBook', 'Mini']);
  expect(groups.map((g) => g.agents.map((e) => e.agent.id))).toEqual([['ses_s'], ['ses_m', 'ses_w'], []]);
  // A waiting agent whose session ended still waits on the person: listed.
  expect(groups[1]!.agents[1]!.agent.state).toBe('waiting');
});

test("an agent opens its launch's thread, else its own thread on its machine, one waiting on the person first", () => {
  const rows = [
    row('t_old', 'ses_a', { last_at: '2026-11-09T08:00:00.000Z', waiting_on_person: true }),
    row('t_new', 'ses_a', { last_at: '2026-11-09T09:30:00.000Z' }),
    // The same session id on another machine is another agent.
    row('t_mac', 'ses_a', { machine: MAC, last_at: '2026-11-09T10:00:00.000Z', waiting_on_person: true }),
  ];
  expect(agentThread(agent('ses_a'), SELF, SELF, rows)!.id).toBe('t_old');
  expect(agentThread(agent('ses_a'), MAC, SELF, rows)!.id).toBe('t_mac');
  expect(agentThread(agent('ses_z'), SELF, SELF, rows)).toBeNull();
  const launched = agent('lch_1', { session: 'launch:lch_1', launch: { id: 'lch_1', thread_id: 't_launch' } });
  expect(agentThread(launched, SELF, SELF, [row('t_launch', 'nobody', { subject: 'Invoice retries' })])).toEqual({ id: 't_launch', subject: 'Invoice retries' });
  // A thread the person addressed to the session counts as its own.
  expect(agentThread(agent('ses_to'), null, null, [row('t_to', 'x', { author: { kind: 'person' }, addressee: { host: 'pi', session: 'ses_to' } } as Partial<InboxListRow>)])!.id).toBe('t_to');
});

test("an agent's name: its title, else its thread's name, else its project, else its host, never its session", () => {
  expect(agentRowName(agent('ses_a', { label: 'Fix login redirect' }), { id: 't', subject: 'Other' })).toBe('Fix login redirect');
  expect(agentRowName(agent('ses_a'), { id: 't', subject: 'Invoice retries' })).toBe('Invoice retries');
  expect(agentRowName(agent('ses_a'), null)).toBe('billing-svc');
  expect(agentRowName(agent('ses_a', { project: null, host: 'pi' }), null)).toBe('Pi');
  expect(agentRowName(agent('ses_a', { project: null, host: null }), null)).toBe('An agent');
});

test('the hover card says where and when from what the window has, and leaves out what it does not', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');
  const launched = agent('lch_1', { launch: { id: 'lch_1', thread_id: 't1' }, state: 'waiting', waiting: 1 });
  const facts = agentFacts({ agent: launched, machine: MAC, name: 'Invoice retries', thread: { id: 't1', subject: 'Invoice retries' } }, view(MAC, 'MacBook'), now);
  expect(facts.title).toBe('Invoice retries');
  expect(facts.sub).toBe('Claude Code · billing-svc · MacBook');
  expect(facts.state).toBe('Waiting on you');
  expect(facts.rows.map(([k]) => k)).toEqual(['Started', 'Last heard']);
  expect(facts.rows[0]![1]).toStartWith('From the Inbox, ');
  // Never heard start nor seen, no project, no machine: only what is known.
  const bare = agentFacts({ agent: agent('ses_b', { started_at: null, last_seen_at: null, project: null, state: 'working' }), machine: null, name: 'Claude Code', thread: { id: 't2', subject: 'Docs pass' } }, null, now);
  expect(bare.sub).toBe('Claude Code');
  expect(bare.state).toBe('Working');
  expect(bare.rows).toEqual([['Thread', 'Docs pass']]);
  // An asleep machine says so, in place of the agent's state.
  expect(agentFacts({ agent: agent('ses_c'), machine: MAC, name: 'x', thread: null }, view(MAC, 'MacBook', { state: 'offline' }), now).state).toStartWith('MacBook asleep since ');
});

test('a sidebar cookie from before Agents keeps its choice: Machines closed is Agents closed', async () => {
  const { parseClosedSections } = await import('../sidebarSections');
  expect([...parseClosedSections('pinned,machines')].sort()).toEqual(['agents', 'pinned']);
  expect([...parseClosedSections('agents,projects')].sort()).toEqual(['agents', 'projects']);
});

// One conversation under two session ids (`InboxAgent.continues`): one row, opening the conversation's thread.
test('an agent finds its thread under the session id its conversation had before', () => {
  const rows = [row('msg_old', 'ses_old', { subject: 'better-pierre' })];
  const [flat] = agentsGroups([group([agent('ses_new', { continues: ['ses_old'] })])], machinesModel(null), rows);
  expect(flat!.agents.map((e) => [e.agent.id, e.name, e.thread?.id])).toEqual([['ses_new', 'better-pierre', 'msg_old']]);
});

test('an old session id that still polls is not a second row when both open the same thread', () => {
  const rows = [row('msg_t', 'ses_old', { subject: 'better-pierre', participants: [{ session: 'ses_old' }, { session: 'ses_new' }] as InboxListRow['participants'] })];
  const agents = [agent('ses_old'), agent('ses_new', { continues: ['ses_old'] })];
  const [flat] = agentsGroups([group(agents)], machinesModel(null), rows);
  expect(flat!.agents.map((e) => [e.agent.id, e.thread?.id])).toEqual([['ses_new', 'msg_t']]);
  // The same for a launched one: its launch's row gives way to the session that continues it.
  const launched = [agent('lch_1', { session: 'ses_old', launch: { id: 'lch_1', thread_id: 'msg_t' } }), agent('ses_new', { continues: ['ses_old'] })];
  expect(agentsGroups([group(launched)], machinesModel(null), rows)[0]!.agents.map((e) => e.agent.id)).toEqual(['ses_new']);
});

test('two rows stay two: a branch that works in its own thread, and two agents that share a thread', () => {
  const branch = [row('msg_a', 'ses_old'), row('msg_b', 'ses_new')];
  const forked = agentsGroups([group([agent('ses_old'), agent('ses_new', { continues: ['ses_old'] })])], machinesModel(null), branch);
  // The branch keeps to its own thread: the old session's is not its own while that session is listed.
  expect(forked[0]!.agents.map((e) => [e.agent.id, e.thread?.id])).toEqual([['ses_old', 'msg_a'], ['ses_new', 'msg_b']]);
  const shared = [row('msg_t', 'ses_one', { participants: [{ session: 'ses_one' }, { session: 'ses_two' }] as InboxListRow['participants'] })];
  const two = agentsGroups([group([agent('ses_one'), agent('ses_two')])], machinesModel(null), shared);
  expect(two[0]!.agents.map((e) => [e.agent.id, e.thread?.id])).toEqual([['ses_one', 'msg_t'], ['ses_two', 'msg_t']]);
});
