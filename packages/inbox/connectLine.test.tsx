/**
 * The connect line above the list (components/ConnectLine.tsx; approval
 * "inbox-agent-note-auto": the note is written by itself, so the old dialog's
 * band moved to one quiet line): what the last run connected, the notes
 * written by themselves with each file in a tooltip, failures and entries
 * left alone, Got it, and the way to Settings → Agents.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgentsModel, InboxConnectReport, InboxNoteAutoAdd } from '@plannotator/core/inbox-types';
import { connectLineNews } from './agents';
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { ConnectLine } = (hasDom ? await import('./components/ConnectLine') : {}) as typeof import('./components/ConnectLine');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (typeof document !== 'undefined') document.body.innerHTML = '';
});

const REPORT: InboxConnectReport = {
  at: '2026-11-07T00:00:00.000Z',
  first: true,
  added: ['codex', 'gemini'],
  already: [],
  failed: [],
  foreign: [],
  manual: ['pi'],
  manual_why: [{ agent: 'pi', why: 'Pi before 0.99 has no `pi mcp`' }],
  unfinished: [],
  claude_code: true,
};

const CLAUDE_NOTE: InboxNoteAutoAdd = { agent: 'claude-code', path: '~/.claude/rules/plannotator-inbox.md' };

function mount(report: InboxConnectReport | null, notes: InboxNoteAutoAdd[] = []) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const seen = { dismissed: 0, settings: 0 };
  act(() => {
    root = createRoot(host!);
    root.render(<ConnectLine report={report} notes={notes} onDismiss={() => seen.dismissed++} onSettings={() => seen.settings++} />);
  });
  return { el: host!, seen };
}

const lines = (el: Element) => [...el.querySelectorAll('.ib-cline-lines p')].map((p) => p.textContent);
const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;

test.skipIf(!hasDom)('one note written by itself: one quiet line naming the agent, the file in its tooltip and for a screen reader', async () => {
  const { el } = mount(null, [CLAUDE_NOTE]);
  // What a screen reader reads: the file before the full stop.
  expect(lines(el)).toEqual(["Added the Inbox note to Claude Code's instructions (~/.claude/rules/plannotator-inbox.md)."]);
  expect(el.querySelector('[data-connect-notes] .ib-sr')?.textContent).toBe(' (~/.claude/rules/plannotator-inbox.md)');
  expect(await tooltipOf(el.querySelector('[data-note-agent="claude-code"]')!)).toBe('~/.claude/rules/plannotator-inbox.md');
  // A line, never a dialog, and nothing to confirm.
  expect(el.querySelector('dialog')).toBeNull();
  expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Got it']);
});

test.skipIf(!hasDom)('the run\'s news and several notes: connected first, then the notes, each name its own file', async () => {
  const { el } = mount(REPORT, [
    { agent: 'codex', path: '~/.codex/AGENTS.md' },
    { agent: 'gemini', path: '~/.gemini/GEMINI.md' },
    CLAUDE_NOTE,
  ]);
  const visible = [...el.querySelectorAll('.ib-cline-lines p')].map((p) => {
    const copy = p.cloneNode(true) as Element;
    copy.querySelectorAll('.ib-sr').forEach((sr) => sr.remove());
    return copy.textContent;
  });
  expect(visible).toEqual([
    'Connected Codex and Gemini CLI to the Inbox.',
    'Added the Inbox note to the instructions of Codex, Gemini CLI and Claude Code.',
    'Pi needs connecting yourself: Settings → Agents',
  ]);
  expect(await tooltipOf(el.querySelector('[data-note-agent="gemini"]')!)).toBe('~/.gemini/GEMINI.md');
});

test.skipIf(!hasDom)('Got it hides it; the Settings → Agents link goes there', () => {
  const { el, seen } = mount(REPORT);
  act(() => button(el, 'Got it').click());
  act(() => button(el, 'Settings → Agents').click());
  expect(seen).toEqual({ dismissed: 1, settings: 1 });
});

test.skipIf(!hasDom)('a trusted sender in Qwen Code, and one removed in Qwen: said under what was connected, the removal as a warning with the way to Settings', () => {
  const { el } = mount({ ...REPORT, added: ['qwen'], manual_why: [], trusted: ['qwen'], trust_failed: [{ agent: 'qwen', reason: 'removed in Qwen' }] });
  expect(lines(el)[0]).toBe('Connected Qwen Code to the Inbox.');
  expect(el.querySelector('[data-connect-trusted]')?.textContent).toContain('Qwen Code');
  const warn = el.querySelector('.ib-cline-warn');
  expect(warn?.textContent).toContain('removed in Qwen');
  expect(warn?.querySelector('button')?.textContent).toBe('Settings → Agents');
});

test.skipIf(!hasDom)('a failure and a foreign entry; "new on this computer" after the first run', () => {
  const { el } = mount({
    ...REPORT,
    first: false,
    added: ['codex'],
    manual_why: [],
    failed: [
      { agent: 'amp', reason: 'amp mcp add exited with code 3', path: null },
      { agent: 'gemini', reason: 'gemini mcp add exited with code 3 (boom: gemini could not write its config (permission denied))', path: null },
    ],
    foreign: [{ agent: 'cursor', path: '~/.cursor/mcp.json' }],
  });
  expect(lines(el)).toEqual([
    'Connected Codex to the Inbox (new on this computer).',
    "Couldn't connect Amp: amp mcp add exited with code 3. Settings → Agents",
    "Couldn't connect Gemini CLI: gemini mcp add exited with code 3: boom: gemini could not write its config (permission denied). Settings → Agents",
    'Cursor has its own plannotator-inbox entry in ~/.cursor/mcp.json; Plannotator left it alone.',
  ]);
});

function model(over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return { agents: [], last_report: null, connecting: false, connect_env_off: false, tool_env: null, notes_offered: false, notes_asked: [], note_text: '', ...over };
}

test('the line shows only with news not said yet: an unseen report or a note written by itself', () => {
  expect(connectLineNews(model())).toBeNull();
  expect(connectLineNews(model({ last_report: { ...REPORT, seen: true } }))).toBeNull();
  expect(connectLineNews(model({ notes_auto: [CLAUDE_NOTE] }))).toEqual({ report: null, notes: [CLAUDE_NOTE] });
  expect(connectLineNews(model({ last_report: { ...REPORT, seen: false } }))?.report?.added).toEqual(['codex', 'gemini']);
});
