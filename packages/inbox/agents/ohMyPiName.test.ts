/**
 * The window names a session started by hand in Oh My Pi "Oh My Pi" (#3443): it polls as host `pi`, and the Inbox
 * says `runtime: "oh-my-pi"` on its compose session and its agent. What this catches: the Agents sidebar's row, its
 * hover line or the To picker's agent name reading "Pi" for it; a plain Pi session, or one from an older Inbox (no
 * `runtime`), named anything but Pi.
 */
import { expect, test } from 'bun:test';
import type { InboxAgent } from '@plannotator/core/inbox-types';
import { agentFacts, agentRowName } from './model';
import { hostLabel } from '../compose/model';

const agent = (over: Partial<InboxAgent> = {}): InboxAgent => ({ id: 'omp-1', session: 'omp-1', host: 'pi', project: { id: 'prj_harbor', name: 'harbor' }, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });

test('the Agents sidebar: an Oh My Pi session is named Oh My Pi on its row and its hover line; Pi and an older Inbox stay Pi', () => {
  const omp = agent({ runtime: 'oh-my-pi' });
  expect(agentRowName(omp, 'thread')).toBe('Oh My Pi');
  expect(agentFacts({ agent: omp, machine: null, name: 'harbor', thread: null }, null).sub).toBe('Oh My Pi · harbor');
  expect(agentRowName(agent(), 'thread')).toBe('Pi');
  expect(agentFacts({ agent: agent(), machine: null, name: 'harbor', thread: null }, null).sub).toBe('Pi · harbor');
});

test('the To picker: the agent name comes from the host and its runtime', () => {
  expect(hostLabel('pi', 'oh-my-pi')).toBe('Oh My Pi');
  expect(hostLabel('pi')).toBe('Pi');
  expect(hostLabel('claude-code', 'oh-my-pi')).toBe('Claude Code');
});
