/**
 * Inbox search's palette model (search/model.ts): the group order and its
 * "Show all" rows, where each result opens (the hash and a message's
 * landing), what the live region says, the time format, the marked runs and
 * the mark each row starts with.
 */
import { expect, test } from 'bun:test';
import type { InboxSearchRow } from '@plannotator/core/inbox-search';
import { countWords, markedRuns, moreLabel, resultTarget, scopeWords, searchGroups, searchRowMark, searchTime, typeCountWords } from './search/model';

const project = { id: 'prj_a', name: 'api' };
const base = { project, section: 'quiet' as const, archived: false, at: '2026-10-09T14:03:00Z' };
const thread: InboxSearchRow = { type: 'thread', id: 'msg_t', thread_id: 'msg_t', ...base, title: 'T', title_marks: [], thread_name: null };
const message: InboxSearchRow = { type: 'message', id: 'msg_m', thread_id: 'msg_t', ...base, author: { kind: 'me', name: 'You' }, title: 'T', snippet: { text: 'x', marks: [] }, question: { key: 'q-1', replaced: false } };
const file: InboxSearchRow = { type: 'file', id: 'att_f', thread_id: 'msg_t', message_id: 'msg_m', ...base, name: 'a.md', name_marks: [], folder: 'docs', kind: 'md', title: 'T' };
const guide: InboxSearchRow = { ...file, type: 'guide', id: 'msg_g', message_id: 'msg_g', folder: null, kind: 'guide' };
const projectRow: InboxSearchRow = { type: 'project', id: 'prj_a', project, name: 'api', name_marks: [], root: '/w/api', at: base.at };

test('groups in the fixed order, empty ones left out, "Show all" while a group holds more', () => {
  const totals = { threads: 1, messages: 23, files: 1, projects: 0 };
  const groups = searchGroups({ groups: { files: [file], messages: [message], threads: [thread] }, totals, recent: null });
  expect(groups.map((g) => g.id)).toEqual(['threads', 'messages', 'files']);
  const more = groups[1]!.options.at(-1)!;
  expect(more).toEqual({ kind: 'more', group: 'messages', total: 23, shown: 1 });
  expect(moreLabel(more as never)).toBe('Show all 23 messages');
  expect(moreLabel({ kind: 'more', group: 'messages', total: 1284, shown: 50 })).toBe('Show 50 more');
  expect(groups[1]!.total).toBe(23);
});

test('the recent view: recent searches, then the threads looked at last', () => {
  const groups = searchGroups({ groups: null, totals: null, recent: [thread as never], recent_searches: ['rate limit'] });
  expect(groups.map((g) => [g.id, g.heading])).toEqual([['recent-searches', 'Recent searches'], ['recent', 'Recent']]);
});

test('where each result opens', () => {
  expect(resultTarget(thread, ['x'])).toEqual({ hash: '#thread=msg_t', land: null });
  expect(resultTarget(message, ['rate', 'lim'])).toEqual({ hash: '#thread=msg_t&msg=msg_m', land: { messageId: 'msg_m', terms: ['rate', 'lim'], questionKey: 'q-1' } });
  expect(resultTarget(file, []).hash).toBe('#thread=msg_t&file=att_f');
  expect(resultTarget(guide, []).hash).toBe('#thread=msg_t&guide=msg_g');
  expect(resultTarget(projectRow, []).hash).toBe('#project=prj_a');
});

test('the live region: counts with Intl, no matches by name, silent for the recent view and while indexing', () => {
  expect(countWords({ totals: { threads: 2, messages: 1282, files: 0, projects: 0 }, recent: null }, 'deploy', false)).toBe('1,284 results in 2 groups');
  expect(countWords({ totals: { threads: 1, messages: 0, files: 0, projects: 0 }, recent: null }, 'x', false)).toBe('1 result in 1 group');
  expect(countWords({ totals: { threads: 0, messages: 0, files: 0, projects: 0 }, recent: null }, ' rate limitr ', false)).toBe('No matches for rate limitr');
  expect(countWords({ totals: null, recent: [] }, '', false)).toBe('');
  expect(countWords({ totals: null, recent: null, indexing: true }, 'x', false)).toBe('');
});

test('a picked type: the live region counts that type alone, from the totals, singular for one; nothing without words', () => {
  const totals = { threads: 6, messages: 1284, files: 10, projects: 1 };
  // Not the sum over the groups: only the picked type's total.
  expect(typeCountWords({ totals }, 'relay', 'files')).toBe('10 files');
  expect(typeCountWords({ totals }, 'relay', 'messages')).toBe('1,284 messages');
  expect(typeCountWords({ totals }, 'relay', 'projects')).toBe('1 project');
  // A no-match names the type, as the screen does.
  expect(typeCountWords({ totals: { ...totals, projects: 0 } }, ' relay ', 'projects')).toBe('No projects match relay');
  expect(typeCountWords({ totals: null }, '', 'files')).toBe('');
  expect(typeCountWords({ totals }, '  ', 'files')).toBe('');
  expect(typeCountWords({ totals, indexing: true }, 'relay', 'files')).toBe('');
});

test('a no-match scope names a picked type once, with the project it was searched in', () => {
  const name = (id: string) => (id === 'prj_a' ? 'relay' : id);
  const filters = { project: 'prj_a', status: 'archived' as const, from: null };
  // The type and the project read as one scope, not as two items of a list.
  expect(scopeWords(filters, name, 'projects')).toEqual(['projects in relay', 'Archived']);
  expect(scopeWords({ ...filters, project: null }, name, 'files')).toEqual(['files', 'Archived']);
  // All types: the scope as before.
  expect(scopeWords(filters, name)).toEqual(['relay', 'Archived']);
});

test('times: today, this year, another year', () => {
  const now = new Date(2026, 9, 13, 15, 0);
  expect(searchTime(new Date(2026, 9, 13, 11, 42).toISOString(), now)).toBe('11:42 AM');
  expect(searchTime(new Date(2026, 9, 9, 14, 3).toISOString(), now)).toBe('Oct 9');
  expect(searchTime(new Date(2025, 8, 2, 16, 20).toISOString(), now)).toBe('Sep 2, 2025');
});

test('marked runs follow the marks, ignore overlaps', () => {
  expect(markedRuns('the rate limit', [[4, 4], [9, 3], [5, 2]])).toEqual([
    { text: 'the ', mark: false },
    { text: 'rate', mark: true },
    { text: ' ', mark: false },
    { text: 'lim', mark: true },
    { text: 'it', mark: false },
  ]);
});

test('the mark a row starts with: the agent for a message, an outline for what the row is otherwise', () => {
  const agent = (host: string | null | undefined): InboxSearchRow => ({ ...message, author: host === undefined ? { kind: 'agent', name: 'Codex' } : { kind: 'agent', name: 'Codex', host } });
  expect(searchRowMark(agent('codex'))).toEqual({ kind: 'agent', host: 'codex' });
  // No host known, or an older Inbox without the field: the generic agent mark, as the list draws it.
  expect(searchRowMark(agent(null))).toEqual({ kind: 'agent', host: null });
  expect(searchRowMark(agent(undefined))).toEqual({ kind: 'agent', host: null });
  // The person's reply never shows an agent's mark.
  expect(searchRowMark({ ...message, author: { kind: 'me', name: 'You', host: null } })).toEqual({ kind: 'icon', icon: 'user' });
  expect(searchRowMark(thread)).toEqual({ kind: 'icon', icon: 'comment' });
  expect(searchRowMark(file)).toEqual({ kind: 'icon', icon: 'doc' });
  expect(searchRowMark(guide)).toEqual({ kind: 'icon', icon: 'book' });
  expect(searchRowMark(projectRow)).toEqual({ kind: 'icon', icon: 'folder' });
});
