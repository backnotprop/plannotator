/**
 * The naming rules over time (agents/agentNames.ts): a given name over the session's own title, decided at read time.
 *
 * What this catches: a tool's later title showing over a given name; a stale title after Reset name (one captured at
 * rename time); a title change not followed while no name is given; a continued session (new id, `continues`) not
 * named until the faces store folds the agents in; a name given to one agent showing on another; a surface that
 * copies the list when nothing is named (every read would draw again).
 */
import { afterEach, expect, test } from 'bun:test';
import type { InboxAgent, InboxAgentsGroup, InboxParticipant } from '@plannotator/core/inbox-types';
import type { ComposeSessionsModel } from '../api';
import { setAgentNames, withGivenLabels } from './agentNames';
import { agentAsListed, agentIsNamed, withGivenNames } from '../agentsList';
import { labelOf, sessionLabelsNow, setSessionLabels } from '../sessionLabels';
import { withGivenSessionNames } from '../compose/useComposeSessions';
import { machinesModel } from '../machines';
import { threadSessions } from './model';

afterEach(() => {
  setAgentNames(new Map());
  setSessionLabels({});
});

const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({ id, session: id, host: 'claude-code', project: null, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });
const groups = (...agents: InboxAgent[]): InboxAgentsGroup[] => [{ agents, total: agents.length, ended_today: 0 }];
const label = (session: string) => labelOf(sessionLabelsNow(), session);

test('session labels: the tool’s title until a name is given, the name through later titles, the current title after Reset name', () => {
  setSessionLabels({ ses_a: 'Fix login' });
  expect(label('ses_a')).toBe('Fix login');
  setSessionLabels({ ses_a: 'Fix login redirect' });
  expect(label('ses_a')).toBe('Fix login redirect');
  setAgentNames(new Map([['ses_a', 'Retry worker']]));
  expect(label('ses_a')).toBe('Retry worker');
  // The tool renames the session (`/rename`, a new transcript title): the given name stays.
  setSessionLabels({ ses_a: 'Ship the retry fix' });
  expect(label('ses_a')).toBe('Retry worker');
  // Reset name: the title as the latest poll sent it, not the one there was at rename time.
  setAgentNames(new Map());
  expect(label('ses_a')).toBe('Ship the retry fix');
  // A poll that clears its title: no label.
  setSessionLabels({});
  expect(label('ses_a')).toBeNull();
  // A name given to a session that has no title of its own.
  setAgentNames(new Map([['ses_a', 'Retry worker']]));
  expect(label('ses_a')).toBe('Retry worker');
});

test('the agents’ list: the same order over its rows, the agent as read kept, one agent’s name never on another', () => {
  const read = groups(agent('ses_a', { label: 'Fix login' }), agent('ses_b', { label: 'Docs pass' }));
  expect(withGivenNames(read, new Map())).toBe(read);
  const names = new Map([['ses_a', 'Retry worker']]);
  const named = withGivenNames(read, names)!;
  expect(named[0]!.agents.map((a) => a.label)).toEqual(['Retry worker', 'Docs pass']);
  expect(agentIsNamed(named[0]!.agents[0]!)).toBe(true);
  expect(agentIsNamed(named[0]!.agents[1]!)).toBe(false);
  expect(agentAsListed(named[0]!.agents[0]!).label).toBe('Fix login');
  // The same objects while nothing changes, so the sidebar's rows are not drawn again.
  expect(withGivenNames(read, names)).toBe(named);
  // A later title from the tool: the given name stays; Reset name: that later title.
  const later = groups(agent('ses_a', { label: 'Ship the retry fix' }), agent('ses_b', { label: 'Docs pass' }));
  expect(withGivenNames(later, names)![0]!.agents[0]!.label).toBe('Retry worker');
  expect(withGivenNames(later, new Map())![0]!.agents[0]!.label).toBe('Ship the retry fix');
});

test('a continued session is named by its old session’s name at once; a launch by its launch id', () => {
  const names = new Map([['ses_old', 'Retry worker'], ['lnc_1', 'Release notes']]);
  const read = groups(agent('ses_new', { continues: ['ses_old'], label: 'Its own title' }), agent('lnc_1', { session: 'ses_launched' }), agent('ses_clear', { label: 'After /clear' }));
  expect(withGivenNames(read, names)![0]!.agents.map((a) => a.label)).toEqual(['Retry worker', 'Release notes', 'After /clear']);
});

test('the To picker’s and Send to another session’s sessions read the given name; nothing is copied when none is named', () => {
  const sessions = [{ session: 'ses_a', host: 'claude-code', label: 'Fix login' }, { session: 'ses_b', host: 'pi' }];
  expect(withGivenLabels(sessions, new Map([['ses_x', 'Other']]))).toBe(sessions);
  expect(withGivenLabels(sessions, new Map([['ses_b', 'Docs pass']])).map((s) => s.label)).toEqual(['Fix login', 'Docs pass']);
  const model = { projects: [{ project: { id: 'p', name: 'billing-svc', root: '/b' }, sessions }] } as unknown as ComposeSessionsModel;
  expect(withGivenSessionNames(model, new Map())).toBe(model);
  expect(withGivenSessionNames(model, new Map([['ses_a', 'Retry worker']]))!.projects[0]!.sessions[0]!.label).toBe('Retry worker');
});

test('a thread with several sessions names a listed agent and an unlisted session by the given name', () => {
  const who = (session: string): InboxParticipant => ({ host: 'claude-code', session });
  setSessionLabels({ ses_a: 'Fix login', ses_gone: 'Old title' });
  setAgentNames(new Map([['ses_a', 'Retry worker'], ['ses_gone', 'Ledger']]));
  const listed = withGivenNames(groups(agent('ses_a', { label: 'Fix login' }), agent('ses_b', { label: 'Docs pass' })), new Map([['ses_a', 'Retry worker']]));
  const names = threadSessions([who('ses_a'), who('ses_b'), who('ses_gone')], listed, machinesModel(null), [], null, sessionLabelsNow()).map((s) => s.name);
  expect(names).toEqual(['Retry worker', 'Docs pass', 'Ledger']);
});
