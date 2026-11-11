/**
 * When a project's rows name their sessions, held so rows never flip under the reader (option A, 2026-11-10). The
 * failures this catches: rows going back to the project the moment a second session ends (a restart, a plugin
 * reload, a minute offline would make them flip twice); rows going back while someone is looking; rows never going
 * back at all; an ended or MCP-only agent counted as live; a conversation that went on under a new id counted twice;
 * another machine's project counted with this one's.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAgent, InboxAgentsGroup } from '@plannotator/core/inbox-types';
import { nextSeveral, projectKey, SEVERAL_HOLD_MS, sessionsByProject } from './severalSessions';

const K = projectKey(null, 'p1');
const live = (n: number) => new Map([[K, n]]);

describe('the hold', () => {
  test('a second session turns names on at once; the second-last ending keeps them while anyone looks', () => {
    let held = nextSeveral(new Map(), live(1), 0, true);
    expect(held.has(K)).toBe(false);
    held = nextSeveral(held, live(2), 1_000, false);
    expect(held.has(K)).toBe(true);
    // It ends, comes back, ends again: the rows never change.
    for (const [n, at] of [[1, 2_000], [2, 3_000], [1, 4_000]] as const) {
      held = nextSeveral(held, live(n), at, false);
      expect(held.has(K)).toBe(true);
    }
    // Long after, still looked at: kept.
    held = nextSeveral(held, live(1), 4_000 + SEVERAL_HOLD_MS * 3, false);
    expect(held.has(K)).toBe(true);
  });

  test('let go only when nobody looks and the hold has run out since it last had two', () => {
    let held = nextSeveral(new Map(), live(2), 0, false);
    held = nextSeveral(held, live(1), SEVERAL_HOLD_MS - 1, true);
    expect(held.has(K)).toBe(true);
    held = nextSeveral(held, live(1), SEVERAL_HOLD_MS, true);
    expect(held.has(K)).toBe(false);
  });
});

const agent = (over: Partial<InboxAgent>): InboxAgent => ({ id: over.session ?? 'x', session: 'x', host: 'claude-code', project: { id: 'p1', name: 'plannotator' }, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });

describe('who counts as live in a project', () => {
  test('live agents only, per project and per machine; a conversation under a new id is one agent and names its old ids', () => {
    const groups: InboxAgentsGroup[] = [
      {
        machine: 'ibx_me',
        total: 5,
        ended_today: 1,
        agents: [
          agent({ session: 'a' }),
          agent({ session: 'b2', continues: ['b1'] }),
          agent({ session: 'c', live: false, state: 'ended' }),
          agent({ session: 'd', project: { id: 'p2', name: 'workspaces' } }),
          agent({ session: 'e', project: null }),
        ],
      },
      { machine: 'ibx_mini', total: 1, ended_today: 0, agents: [agent({ session: 'm1' })] },
    ];
    const { live: counts, agents, heirs } = sessionsByProject(groups);
    // This Inbox's rows carry its machine on the merged view and none on its own list: both keys count alike.
    expect(counts.get(projectKey('ibx_me', 'p1'))).toBe(2);
    expect(counts.get(projectKey(null, 'p1'))).toBe(2);
    expect(counts.get(projectKey(null, 'p2'))).toBe(1);
    expect(counts.get(projectKey('ibx_mini', 'p1'))).toBe(1);
    expect(agents.get(projectKey(null, 'p1'))!.map((a) => a.session)).toEqual(['a', 'b2', 'c']);
    expect(heirs.get('|b1')).toBe('b2');
  });
});
