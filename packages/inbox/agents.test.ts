/**
 * Who the agent-note dialog asks about (agents.ts): each agent once, Claude
 * Code like the rest (last, as the approved dialog lists it), nobody with
 * PLANNOTATOR_INBOX_NOTES=0, and an Inbox of 0.28.18 or older (no
 * `notes_asked`) read as "asked once in all". Plus the primary's label and
 * the middle cut of a path.
 */
import { expect, test } from 'bun:test';
import type { InboxAgentRow, InboxAgentsModel } from '@plannotator/core/inbox-types';
import { cardReport, noteQuestionRows, primaryAction, sentence, splitPath, tidyReason } from './agents';

function row(id: InboxAgentRow['id'], over: Partial<InboxAgentRow> = {}): InboxAgentRow {
  return {
    id,
    label: id,
    detected: true,
    reach: { kind: 'mcp', on: true, state: 'connected', path: null, locked: false, reason: null },
    reminder: null,
    note: { agent: id as never, path: `~/${id}.md`, target: null, state: 'absent', create: false, created: false, reason: null },
    ...over,
  };
}

function model(over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return {
    agents: [row('claude-code'), row('codex'), row('gemini'), row('pi', { reach: { kind: 'tool', on: false, state: 'off', path: null, locked: false, reason: null } }), row('cursor', { note: null })],
    last_report: null,
    connecting: false,
    connect_env_off: false,
    tool_env: null,
    notes_offered: false,
    notes_asked: [],
    note_text: '',
    ...over,
  };
}

const ids = (m: InboxAgentsModel) => noteQuestionRows(m).map((r) => r.id);

test('every candidate not asked yet, Claude Code last; not reaching, no file, or failed this run: not a candidate', () => {
  expect(ids(model())).toEqual(['codex', 'gemini', 'claude-code']);
  const failed = model({ last_report: { at: '', first: true, added: [], already: [], failed: [{ agent: 'gemini', reason: 'x', path: null }], foreign: [], manual: [], unfinished: [], claude_code: false } });
  expect(ids(failed)).toEqual(['codex', 'claude-code']);
});

test('each agent is asked once: an agent asked before is left out, one that connects later is asked alone', () => {
  expect(ids(model({ notes_offered: true, notes_asked: ['claude-code', 'codex'] }))).toEqual(['gemini']);
  expect(ids(model({ notes_offered: true, notes_asked: ['claude-code', 'codex', 'gemini'] }))).toEqual([]);
});

test('an Inbox of 0.28.18 or older (no notes_asked): answered means nobody is asked; never answered means everyone', () => {
  expect(ids(model({ notes_asked: undefined, notes_offered: true }))).toEqual([]);
  expect(ids(model({ notes_asked: undefined, notes_offered: false }))).toEqual(['codex', 'gemini', 'claude-code']);
});

test('PLANNOTATOR_INBOX_NOTES=0: nobody is asked', () => {
  expect(ids(model({ notes_env_off: true }))).toEqual([]);
});

test('the band reads only unseen news, and never a skipped run', () => {
  const report = { at: '', first: true, added: ['codex' as const], already: [], failed: [], foreign: [], manual: [], unfinished: [], claude_code: false };
  expect(cardReport(model({ last_report: report }))).not.toBeNull();
  expect(cardReport(model({ last_report: { ...report, seen: true } }))).toBeNull();
  expect(cardReport(model({ last_report: { ...report, added: [] } }))).toBeNull();
});

test('the primary: up to three names, then a count; nothing ticked closes without adding', () => {
  expect(primaryAction(['Codex'])).toEqual({ label: 'Add to Codex', add: true });
  expect(primaryAction(['Codex', 'Gemini CLI', 'Claude Code'])).toEqual({ label: 'Add to Codex, Gemini CLI and Claude Code', add: true });
  expect(primaryAction(['a', 'b', 'c', 'd']).label).toBe('Add to 4 agents');
  expect(primaryAction([])).toEqual({ label: "Don't add a note", add: false });
});

test('a path is cut in the middle: a short file name whole, a long one by its last 22 characters', () => {
  expect(splitPath('~/.codex/AGENTS.md')).toEqual({ head: '~/.codex/', tail: 'AGENTS.md' });
  const long = '~/Documents/Cline/Rules/plannotator-inbox-instructions-generated-by-plannotator.md';
  const { head, tail } = splitPath(long);
  expect(head + tail).toBe(long);
  expect(tail).toHaveLength(22);
});

test('a reason never ends "))": an agent CLI\'s own message in parentheses is unwrapped to a colon when it ends in a parenthesis', () => {
  expect(tidyReason('codex mcp add exited with code 3 (boom: codex could not write its config (permission denied))')).toBe(
    'codex mcp add exited with code 3: boom: codex could not write its config (permission denied)',
  );
  expect(tidyReason('codex mcp add exited with code 3 (permission denied)')).toBe('codex mcp add exited with code 3 (permission denied)');
  expect(tidyReason('timed out after 10 s')).toBe('timed out after 10 s');
  expect(sentence('it failed (permission denied)')).toBe('it failed (permission denied).');
  expect(sentence('Nothing was changed.')).toBe('Nothing was changed.');
});
