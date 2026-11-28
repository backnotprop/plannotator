/**
 * The reply box's start row (thread/replyStart.ts): which agent and folder a new session for an ended session's reply
 * would start with. The failures this catches: a row where the machine can start nothing (starting off, Windows, no
 * agent, the folder gone), another agent than the ended one while that one can start, a folder other than the ended
 * session's, and a start that forgets the machine's last model and effort.
 */
import { expect, test } from 'bun:test';
import type { InboxComposeLaunch, InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import type { AskingSession } from './components/ReplyRoute';
import { isStartRow, replyStartOf } from './thread/replyStart';

const thread = { thread_id: 'm1', project: { id: 'prj_ledger', key: 'ledger', name: 'ledger', root: '/work/ledger', created_at: '' }, subject: null, thread_name: null, resolved_at: null, messages: [] } as InboxThread;
const asking = (host: string, fromRoot?: string): AskingSession => ({
  session: 'ses_asker',
  host,
  name: 'Claude Code',
  message: { id: 'm1', author: { kind: 'agent', host, session: 'ses_asker' }, ...(fromRoot ? { from_project: { name: 'billing', root: fromRoot } } : {}) } as InboxMessageWire,
});
const block = (over: Partial<InboxComposeLaunch> = {}): InboxComposeLaunch => ({
  agents: [
    { agent: 'pi', name: 'Pi' },
    { agent: 'claude-code', name: 'Claude Code', choices: { models: ['opus'], efforts: ['high'], effort_word: 'Effort', last: { model: 'opus', effort: 'high' } } },
  ],
  projects: [
    { id: 'prj_ledger', name: 'ledger', root: '/work/ledger', exists: true },
    { id: 'prj_billing', name: 'billing', root: '/work/billing', exists: true },
  ],
  ...over,
});

test('the ended agent itself, in the thread\'s project, with the machine\'s last model and effort', () => {
  const start = replyStartOf(block(), thread, asking('claude-code'))!;
  expect(start.row).toMatchObject({ session: 'new:claude-code', host: 'claude-code', label: 'New Claude Code session', state: 'live', start: { project: 'ledger', asleep: false } });
  expect(start.to).toEqual({ launch: { agent: 'claude-code', project_id: 'prj_ledger', model: 'opus', effort: 'high' } });
  expect(isStartRow(start.row.session)).toBe(true);
  expect(isStartRow('ses_asker')).toBe(false);
});

test('the ended session worked in another folder: that folder', () => {
  expect(replyStartOf(block(), thread, asking('claude-code', '/work/billing'))!.to.launch.project_id).toBe('prj_billing');
});

test('an agent the machine cannot start (Qwen Code): the first one it can', () => {
  expect(replyStartOf(block(), thread, asking('qwen-code'))!.row.label).toBe('New Pi session');
});

test('no row: no block (starting off, Windows), no agent to start, the folder gone, or nothing ended', () => {
  expect(replyStartOf(undefined, thread, asking('claude-code'))).toBeNull();
  expect(replyStartOf(block({ agents: [] }), thread, asking('claude-code'))).toBeNull();
  expect(replyStartOf(block({ projects: [{ id: 'prj_ledger', name: 'ledger', root: '/work/ledger', exists: false }] }), thread, asking('claude-code'))).toBeNull();
  expect(replyStartOf(block(), thread, null)).toBeNull();
});

test('the thread\'s machine is away: the row says it starts when it is back', () => {
  expect(replyStartOf(block(), thread, asking('claude-code'), true)!.row.start).toEqual({ project: 'ledger', asleep: true });
});
