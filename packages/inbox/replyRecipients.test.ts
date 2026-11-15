/**
 * The recipient pill's names and order (approval "inbox-reply-recipient"): two
 * sessions of one agent in different folders are told apart by the folder,
 * two in one folder by a number, and ended agents come last. A wrong name here
 * makes two Claude Codes look the same, and the reply goes to the wrong one.
 */
import { expect, test } from 'bun:test';
import { raceWhat } from './components/ReplyRoute';
import { aimable, canAddRecipient, canTakeAlone, knownRecipients, recipientRows, recipientState, toggleRecipient, type RecipientState } from './replyRecipients';
import type { TaggableModel } from './api';

const rowsOf = (people: { host: string; session: string }[], folders: Record<string, string | null>, states: Record<string, RecipientState> = {}) =>
  recipientRows(people, (s) => folders[s] ?? null, (s) => states[s] ?? 'live').map((r) => [r.session, r.label, r.short, r.state]);

test('one agent in two folders: each named by its folder, the phone shows the folder alone', () => {
  expect(rowsOf([{ host: 'claude-code', session: 'a' }, { host: 'claude-code', session: 'b' }, { host: 'pi', session: 'p' }], { a: 'superfans', b: 'plannotator', p: 'superfans' })).toEqual([
    ['a', 'Claude Code (superfans)', 'superfans', 'live'],
    ['b', 'Claude Code (plannotator)', 'plannotator', 'live'],
    ['p', 'Pi', 'Pi', 'live'],
  ]);
});

test('two sessions in one folder: "Claude Code", then "Claude Code 2", in the order given', () => {
  expect(rowsOf([{ host: 'claude-code', session: 'a' }, { host: 'claude-code', session: 'b' }], { a: 'superfans', b: 'superfans' })).toEqual([
    ['a', 'Claude Code', 'Claude Code', 'live'],
    ['b', 'Claude Code 2', 'Claude Code 2', 'live'],
  ]);
});

test('live first, ended last, each group in the order given', () => {
  const rows = rowsOf([{ host: 'codex', session: 'gone' }, { host: 'pi', session: 'p' }, { host: 'opencode', session: 'o' }], {}, { gone: 'ended', o: 'reader' });
  expect(rows.map((r) => r[0])).toEqual(['p', 'o', 'gone']);
});

test('state: the live list decides; a session not in it has ended, an MCP reader is not woken, an older Plannotator cannot be tagged', () => {
  const model = {
    serverSession: 's',
    owner: null,
    sessions: [
      { session: 'live', kind: 'live', taggable: true },
      { session: 'mcp', kind: 'mcp', taggable: true },
      { session: 'old', kind: 'live', taggable: false },
    ],
  } as unknown as TaggableModel;
  expect(['live', 'mcp', 'old', 'missing'].map((s) => recipientState(s, model, new Set()))).toEqual(['live', 'reader', 'old', 'ended']);
  expect(recipientState('live', model, new Set(['live']))).toBe('ended');
  // Not read yet: taken as live.
  expect(recipientState('anyone', null, new Set())).toBe('live');
});

test('an ended agent, or one on an older Plannotator, cannot be added as a second recipient, but stays removable', () => {
  const row = (state: RecipientState) => ({ session: 'x', host: null, label: 'X', short: 'X', state });
  expect(canAddRecipient(row('ended'), ['a'])).toBe(false);
  expect(canAddRecipient(row('old'), ['a'])).toBe(false);
  expect(canAddRecipient(row('reader'), ['a'])).toBe(true);
  expect(canAddRecipient(row('ended'), ['a', 'x'])).toBe(true);
});

test('any number of recipients: a twentieth circle can still be ticked, and one already in stays removable', () => {
  const row = { session: 'x', host: null, label: 'X', short: 'X', state: 'live' as const };
  const many = Array.from({ length: 19 }, (_, i) => `s${i}`);
  expect(canAddRecipient(row, many)).toBe(true);
  expect(toggleRecipient(many, 'x')).toEqual([...many, 'x']);
  expect(canAddRecipient({ ...row, session: 's0' }, many)).toBe(true);
  expect(toggleRecipient(['a'], 'b', 1)).toEqual(['a']);
});

test('a restored choice keeps only the sessions the window lists; none left falls back to the default', () => {
  const known = (id: string) => id === 'a' || id === 'b';
  expect(knownRecipients(['zz', 'b', 'a'], known)).toEqual(['b', 'a']);
  expect(knownRecipients(['zz'], known)).toBeNull();
  expect(knownRecipients(null, known)).toBeNull();
});

test('alone: an agent with no message here takes the reply alone only while `to` reaches it (live), never ended or a reader', () => {
  expect((['live', 'old', 'reader', 'ended'] as const).map((s) => canTakeAlone(s, false))).toEqual([true, true, false, false]);
  expect((['reader', 'ended'] as const).map((s) => canTakeAlone(s, true))).toEqual([true, true]);
});

test('the first recipient stays one that can take the reply alone: taking it away moves the next such one first, or does nothing', () => {
  const alone = (id: string) => id !== 'reader';
  expect(toggleRecipient(['a', 'reader'], 'a', 9, alone)).toEqual(['a', 'reader']);
  expect(toggleRecipient(['a', 'reader', 'b'], 'a', 9, alone)).toEqual(['b', 'reader']);
  expect(aimable(['reader'], alone)).toBeNull();
  expect(aimable(['reader', 'b'], alone)).toEqual(['b', 'reader']);
});

test('the race line names the agent, or reads "That session" with no host known', () => {
  expect(raceWhat(null, { went: 0, total: 1 })).toBe('That session ended before your reply went. Nothing was sent.');
  expect(raceWhat('pi', { went: 0, total: 1 })).toBe('That Pi session ended before your reply went. Nothing was sent.');
  expect(raceWhat(null, { went: 1, total: 2 })).toStartWith('That session ended before all of your reply went.');
});

test('a circle adds, and takes away all but the last recipient', () => {
  expect(toggleRecipient(['a'], 'b')).toEqual(['a', 'b']);
  expect(toggleRecipient(['a', 'b'], 'a')).toEqual(['b']);
  expect(toggleRecipient(['a'], 'a')).toEqual(['a']);
});
