/**
 * The agent's line (line.ts) and the profile's address (app/route.ts `profile`). What this catches: a live agent with
 * no plugin claimed idle (it must get no line at all); "Idle since" read from the last poll instead of the turn's end;
 * a permission prompt in the agent's terminal not winning over "Waiting on you"; an ended agent asked about its
 * terminal; a duration in the wrong unit; a profile address kept beside an open thread (a thread takes its place).
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAgent } from '@plannotator/core/inbox-types';
import { agentLineOf, durationWords, lineFactsOf } from './line';
import { routeOf } from '../app/route';
import { hashOf } from '../app/writeRoute';

const NOW = new Date(2026, 10, 24, 10, 0, 0);
const at = (h: number, m: number) => new Date(2026, 10, 24, h, m, 0).toISOString();

function agent(over: Partial<InboxAgent> = {}): InboxAgent {
  return { id: 'ses_a', session: 'ses_a', host: 'claude-code', project: { id: 'prj_h', name: 'harbor' }, state: 'idle', waiting: 0, live: true, started_at: at(8, 40), last_seen_at: at(9, 59), ...over };
}
const line = (over: Partial<InboxAgent>) => agentLineOf(lineFactsOf(agent(over)), NOW);

describe('the line', () => {
  test('working counts from when its turn started; idle says when its turn ended, never the last poll', () => {
    expect(line({ state: 'working', state_since: at(9, 57) })).toEqual({ tone: 'working', words: 'Working', from: at(9, 57) });
    expect(line({ state: 'idle', state_since: at(9, 15) })?.words).toMatch(/^Idle since 9:15\sAM$/);
    // No time known (an older Inbox): only the state.
    expect(line({ state: 'idle' })?.words).toBe('Idle');
  });

  test('an agent whose host says nothing about its turns gets no line, nothing in its place', () => {
    expect(line({ state: 'idle', turns_unknown: true })).toBeNull();
  });

  test('a permission prompt or a question in its terminal, amber, before "Waiting on you"; an ended agent asks nothing', () => {
    expect(line({ state: 'waiting', waiting: 1, status_mark: { state: 'blocked', kind: 'permission', where: 'terminal' } })).toEqual({ tone: 'asking', words: 'Asking for permission', from: null });
    expect(line({ state: 'working', status_mark: { state: 'blocked', kind: 'question', where: 'terminal' } })?.words).toBe('Asking a question');
    expect(line({ state: 'waiting', waiting: 2, status_mark: { state: 'blocked', where: 'inbox' } })).toEqual({ tone: 'waiting', words: 'Waiting on you', from: null });
    expect(line({ state: 'waiting', rex_status: { state: 'blocked', kind: 'auth' } })?.words).toBe('Needs sign-in');
    const ended = line({ state: 'ended', live: false, last_seen_at: at(9, 10), status_mark: { state: 'blocked', kind: 'permission', where: 'terminal' } });
    expect(ended?.tone).toBe('ended');
    expect(ended?.words.startsWith('Ended 9:10')).toBe(true);
  });

  test('a duration in seconds, then minutes, then hours and minutes', () => {
    expect([12_000, 59_999, 60_000, 3 * 60_000 + 5_000, 60 * 60_000, 65 * 60_000, -5].map(durationWords)).toEqual(['12s', '59s', '1m', '3m', '1h', '1h 5m', '0s']);
  });
});

describe("the profile's address", () => {
  test('a profile rides beside the agent filter, survives a reload, and gives way to a thread', () => {
    const open = hashOf({ page: 'inbox', project: null, agent: 'ses_a', profile: 'ses_a', thread: null });
    expect(routeOf(open)).toMatchObject({ page: 'inbox', agent: 'ses_a', profile: 'ses_a', thread: null });
    expect(hashOf({ page: 'inbox', project: null, agent: 'ses_a', profile: 'ses_a', thread: 'thr_1' })).not.toContain('profile');
    expect(routeOf('#agent=ses_a&profile=ses_a&thread=thr_1').profile).toBeNull();
  });
});
