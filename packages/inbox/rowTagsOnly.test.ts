/**
 * A Sent row whose latest message only its tagged agents get (Swarm's Add an agent: the person's `/swarm` to the agent
 * added, no owner). What this catches: the row's words naming the thread's first agent ("To Claude Code") for a message
 * that went to Pi alone, while a plain Sent row of a thread the person started still names its agent.
 */
import { expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { countWords } from './components/rowParts';

const row = (recipients?: { host: string | null; session: string; name?: string; owner: boolean; wakes: boolean; delivered_at: string | null }[]) =>
  ({
    section: 'sent',
    thread_id: 'msg_1',
    addressee: { host: 'claude-code', session: 'ses_claude' },
    sent: { checked_at: null, ...(recipients ? { recipients } : {}) },
    delivery: null,
    resolved_at: null,
  }) as unknown as InboxListRow;

test("a Sent row whose last message only Pi gets says \"To Pi\", not the thread's first agent", () => {
  expect(countWords(row([{ host: 'pi', session: 'ses_pi', owner: false, wakes: true, delivered_at: null }]), Date.now())?.full).toBe('To Pi');
});

test('a Sent row of a thread the person started still names its agent, also when its reply tags another', () => {
  expect(countWords(row(), Date.now())?.full).toBe('To Claude Code');
  expect(countWords(row([{ host: 'claude-code', session: 'ses_claude', owner: true, wakes: true, delivered_at: null }, { host: 'pi', session: 'ses_pi', owner: false, wakes: true, delivered_at: null }]), Date.now())?.full).toBe('To Claude Code');
});
