import { afterEach, expect, test } from 'bun:test';
import { dispatchInboxFrame } from './api';
import { inboxAgentsFlat, inboxAgentsNow, inboxAgentsWatched, setInboxAgents, subscribeInboxAgents } from './agentsList';

const agent = (id: string, state = 'idle') => ({ id, session: id, host: 'claude-code', project: null, state, waiting: 0, live: true, started_at: null, last_seen_at: null });

afterEach(() => setInboxAgents(undefined));

test('a read with the same agents draws nothing again; a change draws once', () => {
  let drawn = 0;
  const stop = subscribeInboxAgents(() => void drawn++);
  setInboxAgents([{ agents: [agent('ses_1')], total: 1, ended_today: 0 }]);
  setInboxAgents([{ agents: [agent('ses_1')], total: 1, ended_today: 0 }]);
  expect(drawn).toBe(1);
  setInboxAgents([{ agents: [agent('ses_1', 'working')], total: 1, ended_today: 0 }]);
  expect(drawn).toBe(2);
  stop();
});

test("only what parses is kept, each machine's agents named by it; an Inbox that names none reads null", () => {
  setInboxAgents([
    { machine: 'ibx_a', agents: [agent('ses_1'), { id: 'bad' }, agent('ses_2', 'asleep')], total: 9, ended_today: 1 },
    { agents: 'nope' },
    { machine: 'ibx_b', agents: [agent('ses_3')], total: -4 },
  ]);
  expect(inboxAgentsNow()).toEqual([
    { machine: 'ibx_a', agents: [agent('ses_1')], total: 9, ended_today: 1 },
    { machine: 'ibx_b', agents: [agent('ses_3')], total: 1, ended_today: 0 },
  ] as never);
  expect(inboxAgentsFlat(inboxAgentsNow()).map((a) => [a.machine, a.id])).toEqual([
    ['ibx_a', 'ses_1'],
    ['ibx_b', 'ses_3'],
  ]);
  setInboxAgents(undefined);
  expect(inboxAgentsNow()).toBeNull();
});

test("`event: deliveries` carries `agents` to the window, and agents count as drawn only while something reads them", () => {
  const changes: unknown[] = [];
  const handlers = { onRecord: () => {}, onStatus: () => {}, onDeliveries: (change: unknown) => void changes.push(change) };
  dispatchInboxFrame({ name: 'deliveries', id: null, data: '{"agents":true}' }, handlers);
  dispatchInboxFrame({ name: 'deliveries', id: null, data: '{"sessions":true}' }, handlers);
  expect(changes).toEqual([
    { labels: false, sessions: false, agents: true },
    { labels: false, sessions: true, agents: false },
  ]);
  expect(inboxAgentsWatched()).toBe(false);
  const stop = subscribeInboxAgents(() => {});
  expect(inboxAgentsWatched()).toBe(true);
  stop();
  expect(inboxAgentsWatched()).toBe(false);
});
