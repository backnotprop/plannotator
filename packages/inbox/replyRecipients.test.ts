/**
 * The recipient pill's names and order (approval "inbox-reply-recipient"): two
 * sessions of one agent in different folders are told apart by the folder,
 * two in one folder by a number, and ended agents come last. A wrong name here
 * makes two Claude Codes look the same, and the reply goes to the wrong one.
 */
import { expect, test } from 'bun:test';
import { canAddRecipient, recipientRows, recipientState, toggleRecipient, type RecipientState } from './replyRecipients';
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

test('a circle adds, and takes away all but the last recipient', () => {
  expect(toggleRecipient(['a'], 'b')).toEqual(['a', 'b']);
  expect(toggleRecipient(['a', 'b'], 'a')).toEqual(['b']);
  expect(toggleRecipient(['a'], 'a')).toEqual(['a']);
});
