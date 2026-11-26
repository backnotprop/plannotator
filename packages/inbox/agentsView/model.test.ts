/**
 * The Agents view's grouping (agentsView/model.ts): whose thread a row is, in what order the agents and their threads
 * come, where ended agents and threads with no agent go, and the held order between two sorts.
 *
 * What this catches: a thread with several agents drawn twice or under the wrong one; an agent with something for the
 * person not first or not open; threads inside an agent not newest first (an older Priority or Stopped above a newer
 * Quiet); an ended agent mixed with the live ones,
 * or one the list no longer names dropped (its threads under "No agent") or split per session; a launch's thread
 * before its agent writes there not under it; and, between two sorts, rows or agents moving under the reader, or an
 * agent that ended jumping to the Ended band before the list settles.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAgent, InboxAgentsGroup, InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { MachinesModel } from '../machines';
import { agentsLayout, otherAgents, rowAgentSession, type AgentsInputs } from './model';

const NO_MACHINES: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };
const T = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, '0')}:00Z`;

function row(id: string, at: number, section: InboxListRow['section'], extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'harbor-ops' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    last_at: T(at),
    last_agent_at: T(at),
    section,
    unread: false,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    ...extra,
  } as unknown as InboxListRow;
}

function agent(id: string, state: InboxAgent['state'], extra: Partial<InboxAgent> = {}): InboxAgent {
  return { id, session: id, host: 'claude-code', label: `Agent ${id}`, project: { id: 'prj_a', name: 'harbor-ops' }, state, waiting: 0, live: state !== 'ended', started_at: null, last_seen_at: T(1), ...extra };
}

function sections(byGroup: Partial<Record<InboxListGroupId, InboxListRow[]>>): InboxListSection[] {
  const ids: InboxListGroupId[] = ['priority', 'stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: byGroup[id] ?? [] })) as InboxListSection[];
}

const groups = (...agents: InboxAgent[]): InboxAgentsGroup[] => [{ agents, total: agents.length, ended_today: 0 }];
const inputs = (s: InboxListSection[], g: InboxAgentsGroup[] | null, extra: Partial<AgentsInputs> = {}): AgentsInputs => ({ sections: s, groups: g, machines: NO_MACHINES, ...extra });
const ids = (rows: { row: InboxListRow }[]) => rows.map((r) => r.row.thread_id);
const by = (session: string) => ({ author: { kind: 'agent', host: 'claude-code', session, name: null } }) as Partial<InboxListRow>;

describe('whose thread', () => {
  test('the agent it was sent to, else its author, else its first participant; none: no agent', () => {
    expect(rowAgentSession(row('t', 1, 'new', { addressee: { session: 'ses_to', host: 'codex' } } as Partial<InboxListRow>))?.session).toBe('ses_to');
    expect(rowAgentSession(row('t', 1, 'new'))?.session).toBe('ses_a');
    expect(rowAgentSession(row('t', 1, 'new', { author: { kind: 'person' }, participants: [{ session: 'ses_p', host: 'pi' }] } as Partial<InboxListRow>))?.session).toBe('ses_p');
    expect(rowAgentSession(row('t', 1, 'new', { author: { kind: 'person' } } as Partial<InboxListRow>))).toBeNull();
  });

  test('a thread with several agents is drawn once, under the agent it was sent to; the others are its icons', () => {
    const shared = row('shared', 5, 'waiting', { ...by('ses_b'), addressee: { session: 'ses_a', host: 'claude-code' }, participants: [{ session: 'ses_a', host: 'claude-code' }, { session: 'ses_b', host: 'codex' }] } as Partial<InboxListRow>);
    const layout = agentsLayout(inputs(sections({ waiting: [shared] }), groups(agent('ses_a', 'waiting'), agent('ses_b', 'idle'))), null, { epoch: 1, keep: null });
    expect(layout.live.map((b) => [b.agent.id, ids(b.rows)])).toEqual([['ses_a', ['shared']]]);
    expect(otherAgents(shared, layout.live[0]!.agent.sessions).map((p) => p.session)).toEqual(['ses_b']);
  });

  test("a launch's thread is its agent's before that agent writes there", () => {
    const launched = agent('lch_1', 'working', { session: 'launch:lch_1', launch: { id: 'lch_1', thread_id: 'mine' } });
    const layout = agentsLayout(inputs(sections({ new: [row('mine', 3, 'new', { author: { kind: 'person' } } as Partial<InboxListRow>)] }), groups(launched)), null, { epoch: 1, keep: null });
    expect(layout.live.map((b) => b.agent.id)).toEqual(['lch_1']);
    expect(layout.none).toEqual([]);
  });

  test("a conversation that went on under a new session keeps its old session's threads", () => {
    const later = agent('ses_new', 'idle', { continues: ['ses_old'] });
    const layout = agentsLayout(inputs(sections({ quiet: [row('old', 1, 'quiet', by('ses_old')), row('new', 2, 'quiet', by('ses_new'))] }), groups(later)), null, { epoch: 1, keep: null });
    expect(layout.live.map((b) => [b.agent.id, ids(b.rows)])).toEqual([['ses_new', ['new', 'old']]]);
  });
});

describe('the order', () => {
  test('agents with something for the person first, open; then the others by their newest thread; inside, newest first', () => {
    const s = sections({
      waiting: [row('a-wait', 2, 'waiting', by('ses_a'))],
      quiet: [row('a-quiet-new', 9, 'quiet', by('ses_a')), row('b-quiet', 8, 'quiet', by('ses_b')), row('a-quiet-old', 1, 'quiet', by('ses_a'))],
      sent: [row('c-sent', 7, 'sent', by('ses_c'))],
    });
    const layout = agentsLayout(inputs(s, groups(agent('ses_a', 'waiting'), agent('ses_b', 'idle'), agent('ses_c', 'working'))), null, { epoch: 1, keep: null });
    // An older Sent (ses_c) does not top a fresher Quiet (ses_b).
    expect(layout.live.map((b) => b.agent.id)).toEqual(['ses_a', 'ses_b', 'ses_c']);
    expect(ids(layout.live[0]!.rows)).toEqual(['a-quiet-new', 'a-wait', 'a-quiet-old']);
    expect(layout.live.map((b) => b.open)).toEqual([true, false, false]);
  });

  test("an agent's threads are newest first whatever their group: a newer Quiet above an older Priority or Stopped", () => {
    const s = sections({
      priority: [row('a-priority', 3, 'waiting', by('ses_a'))],
      stopped: [row('a-stopped', 2, 'stopped', by('ses_a'))],
      waiting: [row('a-wait-tie-b', 6, 'waiting', by('ses_a'))],
      quiet: [row('a-quiet', 8, 'quiet', by('ses_a')), row('a-quiet-tie-a', 6, 'quiet', by('ses_a'))],
      sent: [row('b-sent', 9, 'sent', by('ses_b'))],
    });
    const layout = agentsLayout(inputs(s, groups(agent('ses_a', 'waiting'), agent('ses_b', 'idle'))), null, { epoch: 1, keep: null });
    // The agents keep the urgency order: ses_a (a Priority) above ses_b's newer Sent; ses_a starts open.
    expect(layout.live.map((b) => [b.agent.id, b.open])).toEqual([['ses_a', true], ['ses_b', false]]);
    // Each row keeps the group it is drawn in (its marks), only its place changes.
    expect(layout.live[0]!.rows.map((r) => [r.row.thread_id, r.drawn])).toEqual([
      ['a-quiet', 'quiet'],
      ['a-quiet-tie-a', 'quiet'],
      ['a-wait-tie-b', 'waiting'],
      ['a-priority', 'priority'],
      ['a-stopped', 'stopped'],
    ]);
    // Ties keep one order whichever group lists them first.
    const swapped = sections({ waiting: [row('a-wait-tie-b', 6, 'waiting', by('ses_a'))], quiet: [row('a-quiet-tie-a', 6, 'quiet', by('ses_a'))] });
    const again = agentsLayout(inputs(swapped, groups(agent('ses_a', 'waiting'))), null, { epoch: 1, keep: null });
    expect(ids(again.live[0]!.rows)).toEqual(['a-quiet-tie-a', 'a-wait-tie-b']);
  });

  test("past five threads the fold hides the oldest, one that waits on the person too; the agent still ranks and opens by it", () => {
    // AgentsList.tsx shows an open agent's first AGENT_ROWS_SHOWN (5) rows, then "N more" (the owner, 2026-11-23: "Fold it like any other").
    const quiet = [2, 3, 4, 5, 6].map((minute) => row(`a-quiet-${minute}`, minute, 'quiet', by('ses_a')));
    const s = sections({ stopped: [row('a-stopped', 1, 'stopped', by('ses_a'))], quiet: [...quiet, row('b-quiet', 9, 'quiet', by('ses_b'))] });
    const layout = agentsLayout(inputs(s, groups(agent('ses_a', 'waiting'), agent('ses_b', 'idle'))), null, { epoch: 1, keep: null });
    expect(layout.live.map((b) => [b.agent.id, b.open])).toEqual([['ses_a', true], ['ses_b', false]]);
    const rows = layout.live[0]!.rows;
    expect(ids(rows.slice(0, 5))).toEqual(['a-quiet-6', 'a-quiet-5', 'a-quiet-4', 'a-quiet-3', 'a-quiet-2']);
    expect(rows.slice(5).map((r) => [r.row.thread_id, r.drawn])).toEqual([['a-stopped', 'stopped']]);
  });

  test("the time a row prints orders it: a delivered message's time", () => {
    const delivered = row('delivered', 2, 'sent', { ...by('ses_a'), delivery: { state: 'delivered', at: T(7) } } as Partial<InboxListRow>);
    const layout = agentsLayout(inputs(sections({ sent: [row('later', 5, 'sent', by('ses_a')), delivered] }), groups(agent('ses_a', 'idle'))), null, { epoch: 1, keep: null });
    expect(ids(layout.live[0]!.rows)).toEqual(['delivered', 'later']);
  });

  test('a filter leaves an agent with no thread out (the sections come filtered)', () => {
    const layout = agentsLayout(inputs(sections({ quiet: [row('a', 1, 'quiet', by('ses_a'))] }), groups(agent('ses_a', 'idle'), agent('ses_b', 'idle'))), null, { epoch: 1, keep: null });
    expect(layout.live.map((b) => b.agent.id)).toEqual(['ses_a']);
  });

  test('snoozed rows stay out (their band is drawn under the list)', () => {
    const layout = agentsLayout(inputs(sections({ snoozed: [row('z', 1, 'new', by('ses_a'))] }), groups(agent('ses_a', 'idle'))), null, { epoch: 1, keep: null });
    expect(layout.live).toEqual([]);
  });
});

describe('ended agents and no agent', () => {
  test('an ended agent the list names sits in the Ended band, folded, with when it ended', () => {
    const layout = agentsLayout(inputs(sections({ waiting: [row('e', 5, 'waiting', by('ses_e'))], quiet: [row('l', 1, 'quiet', by('ses_l'))] }), groups(agent('ses_e', 'ended', { last_seen_at: T(4) }), agent('ses_l', 'idle'))), null, { epoch: 1, keep: null });
    expect(layout.live.map((b) => b.agent.id)).toEqual(['ses_l']);
    expect(layout.ended.map((b) => [b.agent.id, b.open, b.agent.endedAt])).toEqual([['ses_e', false, T(4)]]);
  });

  test('one the list no longer names is rebuilt from its sessions: one agent per kept chain, named by its label', () => {
    const s = sections({ quiet: [row('x1', 2, 'quiet', by('ses_x1')), row('x2', 1, 'quiet', by('ses_x2'))] });
    const chains = new Map([['ses_x1', { id: 'ses_x1', sessions: ['ses_x1', 'ses_x2'] }], ['ses_x2', { id: 'ses_x1', sessions: ['ses_x1', 'ses_x2'] }]]);
    const layout = agentsLayout(inputs(s, groups(), { labels: { ses_x2: 'Search index' }, chains }), null, { epoch: 1, keep: null });
    expect(layout.none).toEqual([]);
    expect(layout.ended.map((b) => [b.agent.id, b.agent.name, b.agent.state, ids(b.rows)])).toEqual([['ses_x1', 'Search index', 'ended', ['x1', 'x2']]]);
  });

  test('on an Inbox that names no agents its state is not known, and it is not called ended', () => {
    const layout = agentsLayout(inputs(sections({ quiet: [row('x', 1, 'quiet', by('ses_x'))] }), null), null, { epoch: 1, keep: null });
    expect(layout.live.map((b) => [b.agent.name, b.agent.state])).toEqual([['Claude Code', null]]);
  });

  test('a thread with no agent goes under No agent, newest first', () => {
    const person = { author: { kind: 'person' } } as Partial<InboxListRow>;
    const layout = agentsLayout(inputs(sections({ quiet: [row('n1', 1, 'quiet', person), row('n2', 3, 'quiet', person)] }), groups()), null, { epoch: 1, keep: null });
    expect(ids(layout.none)).toEqual(['n2', 'n1']);
  });
});

describe('held order between two sorts', () => {
  const live = groups(agent('ses_a', 'idle'), agent('ses_b', 'idle'));
  const first = sections({ quiet: [row('a', 5, 'quiet', by('ses_a')), row('b', 4, 'quiet', by('ses_b')), row('b2', 1, 'quiet', by('ses_b'))] });

  test('a newer time in place moves no agent and no row until the list is sorted whole', () => {
    const one = agentsLayout(inputs(first, live), null, { epoch: 1, keep: null });
    const moved = sections({ quiet: [row('a', 5, 'quiet', by('ses_a')), row('b', 4, 'quiet', by('ses_b')), row('b2', 9, 'quiet', by('ses_b'))] });
    const held = agentsLayout(inputs(moved, live), one.places, { epoch: 1, keep: null });
    expect(held.live.map((b) => [b.agent.id, ids(b.rows)])).toEqual([['ses_a', ['a']], ['ses_b', ['b', 'b2']]]);
    const settled = agentsLayout(inputs(moved, live), held.places, { epoch: 2, keep: null });
    expect(settled.live.map((b) => [b.agent.id, ids(b.rows)])).toEqual([['ses_b', ['b2', 'b']], ['ses_a', ['a']]]);
  });

  test('rows of mixed groups hold their places between two sorts, then go newest first', () => {
    const mixed = (p: number, s: number) =>
      sections({
        priority: [row('p', p, 'waiting', by('ses_a'))],
        stopped: [row('s', s, 'stopped', by('ses_a'))],
        waiting: [row('w', 4, 'waiting', by('ses_a'))],
        quiet: [row('q', 5, 'quiet', by('ses_a')), row('b', 6, 'quiet', by('ses_b'))],
      });
    const one = agentsLayout(inputs(mixed(3, 2), live), null, { epoch: 1, keep: null });
    expect(one.live.map((b) => [b.agent.id, ids(b.rows)])).toEqual([['ses_a', ['q', 'w', 'p', 's']], ['ses_b', ['b']]]);
    // The Priority and the Stopped thread get newer messages in their groups: nothing moves under the reader.
    const held = agentsLayout(inputs(mixed(9, 7), live), one.places, { epoch: 1, keep: null });
    expect(held.live.map((b) => [b.agent.id, ids(b.rows)])).toEqual([['ses_a', ['q', 'w', 'p', 's']], ['ses_b', ['b']]]);
    const settled = agentsLayout(inputs(mixed(9, 7), live), held.places, { epoch: 2, keep: null });
    expect(settled.live.map((b) => [b.agent.id, ids(b.rows)])).toEqual([['ses_a', ['p', 's', 'q', 'w']], ['ses_b', ['b']]]);
  });

  test('an agent that ends keeps its place and changes only its state until the list settles', () => {
    const one = agentsLayout(inputs(first, live), null, { epoch: 1, keep: null });
    const now = groups(agent('ses_a', 'ended'), agent('ses_b', 'idle'));
    const held = agentsLayout(inputs(first, now), one.places, { epoch: 1, keep: null });
    expect(held.live.map((b) => [b.agent.id, b.agent.state])).toEqual([['ses_a', 'ended'], ['ses_b', 'idle']]);
    expect(held.ended).toEqual([]);
    const settled = agentsLayout(inputs(first, now), held.places, { epoch: 2, keep: null });
    expect(settled.ended.map((b) => b.agent.id)).toEqual(['ses_a']);
  });

  test('the open thread keeps its place through a sort, and so does the agent it is under', () => {
    const before = sections({ quiet: [row('b', 6, 'quiet', by('ses_b')), row('a', 5, 'quiet', by('ses_a'))] });
    const one = agentsLayout(inputs(before, live), null, { epoch: 1, keep: null });
    expect(one.live.map((b) => b.agent.id)).toEqual(['ses_b', 'ses_a']);
    // The person wrote in the open thread "a": a sort that keeps it does not move it, nor its agent, to the top.
    const wrote = sections({ quiet: [row('a', 9, 'quiet', by('ses_a')), row('b', 6, 'quiet', by('ses_b'))] });
    expect(agentsLayout(inputs(wrote, live), one.places, { epoch: 2, keep: 'a' }).live.map((b) => b.agent.id)).toEqual(['ses_b', 'ses_a']);
    expect(agentsLayout(inputs(wrote, live), one.places, { epoch: 2, keep: null }).live.map((b) => b.agent.id)).toEqual(['ses_a', 'ses_b']);
  });

  test('an agent the list stops naming keeps its threads and its name until the list settles', () => {
    const one = agentsLayout(inputs(first, live), null, { epoch: 1, keep: null });
    const held = agentsLayout(inputs(first, groups(agent('ses_b', 'idle'))), one.places, { epoch: 1, keep: null });
    expect(held.live.map((b) => [b.agent.name, ids(b.rows)])).toEqual([['Agent ses_a', ['a']], ['Agent ses_b', ['b', 'b2']]]);
  });
});
