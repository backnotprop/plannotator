/**
 * The one-time agent-note dialog (components/AgentNoteDialog.tsx; the
 * approved "inbox-agent-note-dialog" design, Checklist with the band at the
 * top): one row per agent asked about, all ticked, Claude Code like the rest;
 * one agent has no checkbox; the primary names who it adds to and never
 * refuses; results in the same rows with Try again; Not now, Escape and
 * "Don't add a note" answer for these agents only and write nothing. The
 * page's requests go to a recording fetch.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgentRow, InboxAgentsModel, InboxConnectReport } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { AgentNoteDialog } = (hasDom ? await import('./components/AgentNoteDialog') : {}) as typeof import('./components/AgentNoteDialog');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  document.body.innerHTML = '';
});

const NOTE = '<!-- plannotator-inbox:start v1 · added by Plannotator. -->\n## Plannotator Inbox\n<!-- plannotator-inbox:end -->';

function row(id: InboxAgentRow['id'], label: string, note: Partial<NonNullable<InboxAgentRow['note']>>, kind: 'mcp' | 'tool' = 'mcp'): InboxAgentRow {
  return {
    id,
    label,
    detected: true,
    reach: { kind, on: true, state: 'connected', path: null, locked: false, reason: null },
    reminder: null,
    note: { agent: id as never, path: null, target: null, state: 'absent', create: false, created: false, reason: null, ...note },
  };
}

const CODEX = row('codex', 'Codex', { path: '~/.codex/AGENTS.md' });
const GEMINI = row('gemini', 'Gemini CLI', { path: '~/.gemini/GEMINI.md', create: true });
const CLAUDE = row('claude-code', 'Claude Code', { path: '~/.claude/rules/plannotator-inbox.md', create: true }, 'tool');
const PI = row('pi', 'Pi', { path: '~/.pi/agent/AGENTS.md' }, 'tool');
const OPENCODE = row('opencode', 'OpenCode', { path: '~/.config/opencode/AGENTS.md' }, 'tool');

const REPORT: InboxConnectReport = {
  at: '2026-10-13T00:00:00.000Z',
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

function model(over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return { agents: [CLAUDE, CODEX, GEMINI], last_report: null, connecting: false, connect_env_off: false, tool_env: null, notes_offered: true, notes_asked: [], note_text: NOTE, ...over };
}

const calls: { path: string; body: Record<string, unknown> }[] = [];
function recordFetch(answer: (path: string, body: Record<string, unknown>) => unknown): void {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    return new Response(JSON.stringify(answer(path, body)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function mount(rows: InboxAgentRow[], report: InboxConnectReport | null = null) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const seen = { closed: 0, settings: 0, models: [] as InboxAgentsModel[] };
  act(() => {
    root = createRoot(host!);
    root.render(
      <AgentNoteDialog
        rows={rows}
        report={report}
        noteText={NOTE}
        onModel={(next) => seen.models.push(next)}
        onSettings={() => seen.settings++}
        onClosed={() => seen.closed++}
      />,
    );
  });
  const dialog = () => host!.querySelector('dialog[data-dialog="agent-note"]') as HTMLDialogElement;
  return { el: host!, dialog, seen };
}

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const buttons = (el: Element) => [...el.querySelectorAll('button')];
const button = (el: Element, name: string) => buttons(el).find((b) => b.textContent?.trim() === name)!;
const primary = (el: Element) => el.querySelector('[data-anote-primary]') as HTMLButtonElement;
const rowsOf = (el: Element) =>
  [...el.querySelectorAll('.ib-anote-table > li')].map((li) => ({
    name: li.querySelector('.ib-anote-name')?.textContent,
    path: li.querySelector('.ib-anote-path')?.textContent,
    state: li.querySelector('.ib-anote-st')?.textContent,
    ticked: (li.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked ?? null,
  }));
const title = (el: Element) => el.querySelector('.ib-anote-head h2')?.textContent;

test.skipIf(!hasDom)('several agents: the band, every agent ticked (Claude Code too), each exact file, and a primary that names them', () => {
  const { el, dialog } = mount([CODEX, GEMINI, CLAUDE], REPORT);
  expect(dialog().getAttribute('aria-labelledby')).toBe(el.querySelector('.ib-anote-head h2')!.id);
  expect([...el.querySelectorAll('.ib-anote-band p')].map((p) => p.textContent)).toEqual([
    'Connected Codex and Gemini CLI to the Inbox.',
    'Pi needs connecting by hand: Settings → Agents',
  ]);
  expect(title(el)).toBe('Tell your agents about the Inbox');
  expect(rowsOf(el)).toEqual([
    { name: 'Codex', path: '~/.codex/AGENTS.md', state: 'Adds to end', ticked: true },
    { name: 'Gemini CLI', path: '~/.gemini/GEMINI.md', state: 'New file', ticked: true },
    { name: 'Claude Code', path: '~/.claude/rules/plannotator-inbox.md', state: 'New file', ticked: true },
  ]);
  expect(primary(el).textContent).toBe('Add to Codex, Gemini CLI and Claude Code');
  expect(document.activeElement).toBe(primary(el));
  // Each checkbox is named by its whole row (name, path, pill), so the path is read once: no second description.
  const box = el.querySelector('.ib-anote-table input') as HTMLInputElement;
  expect(box.hasAttribute('aria-describedby')).toBe(false);
  expect(box.closest('label')?.textContent?.split('~/.codex/AGENTS.md')).toHaveLength(2);
  expect(el.querySelector('[data-anote-notnow]')).not.toBeNull();
  expect(el.querySelector('.ib-anote-later')?.textContent).toBe('Change it later in Settings → Agents.');
});

test.skipIf(!hasDom)('unticking renames the primary; with nothing ticked it is "Don\'t add a note", Not now goes, and pressing it writes nothing', async () => {
  const { el, seen } = mount([CODEX, GEMINI, CLAUDE], REPORT);
  const boxes = () => [...el.querySelectorAll('.ib-anote-table input')] as HTMLInputElement[];
  act(() => boxes()[2]!.click());
  expect(primary(el).textContent).toBe('Add to Codex and Gemini CLI');
  expect(el.querySelectorAll('.ib-anote-unpicked')).toHaveLength(1);
  act(() => boxes()[0]!.click());
  act(() => boxes()[1]!.click());
  expect(primary(el).textContent).toBe("Don't add a note");
  expect(primary(el).hasAttribute('disabled')).toBe(false);
  expect(el.querySelector('[data-anote-notnow]')).toBeNull();
  recordFetch(() => model({ notes_asked: ['claude-code', 'codex', 'gemini'] }));
  act(() => primary(el).click());
  await flush();
  expect(calls).toEqual([{ path: '/api/inbox/agents/notes', body: { add: [], asked: ['codex', 'gemini', 'claude-code'], seen: true } }]);
  expect(seen.closed).toBe(1);
  expect(seen.models).toHaveLength(1);
});

test.skipIf(!hasDom)('four or more ticked: "Add to N agents"', () => {
  const { el } = mount([CODEX, GEMINI, PI, OPENCODE, CLAUDE]);
  expect(primary(el).textContent).toBe('Add to 5 agents');
  expect(el.querySelector('.ib-anote-band')).toBeNull();
});

test.skipIf(!hasDom)('one agent: no checkbox; the two buttons are the choice', () => {
  const { el } = mount([CODEX]);
  expect(title(el)).toBe('Add the note to Codex?');
  expect(el.querySelector('input[type="checkbox"]')).toBeNull();
  expect(rowsOf(el)).toEqual([{ name: 'Codex', path: '~/.codex/AGENTS.md', state: 'Adds to end', ticked: null }]);
  expect(primary(el).textContent).toBe('Add to Codex');
  expect(button(el, 'Not now')).toBeDefined();
});

test.skipIf(!hasDom)('Add: only the ticked notes are sent; results in the same rows, a failure with its reason and Try again; Done closes', async () => {
  const { el, seen } = mount([CODEX, GEMINI, CLAUDE], REPORT);
  act(() => ([...el.querySelectorAll('.ib-anote-table input')][2] as HTMLInputElement).click());
  recordFetch((_path, body) =>
    (body.add as string[]).length === 2
      ? {
          ...model(),
          results: [
            { ok: true, agent: 'codex', action: 'added', path: '~/.codex/AGENTS.md' },
            { ok: false, agent: 'gemini', reason: '~/.gemini/GEMINI.md can\'t be written: permission denied', path: '~/.gemini/GEMINI.md' },
          ],
        }
      : { ...model(), results: [{ ok: true, agent: 'gemini', action: 'created', path: '~/.gemini/GEMINI.md' }] },
  );
  act(() => primary(el).click());
  await flush();
  expect(calls).toEqual([{ path: '/api/inbox/agents/notes', body: { add: ['codex', 'gemini'], asked: ['codex', 'gemini', 'claude-code'], seen: true } }]);
  expect(title(el)).toBe('Added the note to Codex');
  expect(rowsOf(el)).toEqual([
    { name: 'Codex', path: '~/.codex/AGENTS.md', state: 'Added', ticked: null },
    { name: 'Gemini CLI', path: '~/.gemini/GEMINI.md', state: 'Not added', ticked: null },
  ]);
  expect(el.querySelector('.ib-anote-err')?.textContent).toBe("~/.gemini/GEMINI.md can't be written: permission denied. Try again");
  // The results view: focus on Done, the live region says what was written, the band is gone.
  expect(document.activeElement).toBe(button(el, 'Done'));
  expect(el.querySelector('[data-anote-band]')).toBeNull();
  expect(el.querySelector('.ib-anote-doneline')?.textContent).toBe('Each agent reads it from its next session. Fix the file, then try again here or in Settings → Agents.');
  expect(el.querySelector('[aria-live="polite"]')?.textContent).toBe("Added the note to Codex. Couldn't add the note to Gemini CLI.");

  act(() => button(el, 'Try again').click());
  await flush();
  expect(calls[1]).toEqual({ path: '/api/inbox/agents/notes', body: { add: ['gemini'], asked: ['gemini'], seen: false } });
  expect(rowsOf(el).map((r) => r.state)).toEqual(['Added', 'Created']);
  expect(title(el)).toBe('Added the note to Codex and Gemini CLI');
  expect(el.querySelector('.ib-anote-err')).toBeNull();
  expect(document.activeElement).toBe(button(el, 'Done'));

  act(() => button(el, 'Done').click());
  expect(seen.closed).toBe(1);
});

test.skipIf(!hasDom)('Add that cannot reach the Inbox shows each row as not added, with the reason, never a dead end', async () => {
  const { el } = mount([CODEX]);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'The Inbox stopped' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  act(() => primary(el).click());
  await flush();
  expect(title(el)).toBe('The note was not added');
  expect(rowsOf(el)[0]!.state).toBe('Not added');
  expect(button(el, 'Try again')).toBeDefined();
  expect(button(el, 'Done')).toBeDefined();
});

test.skipIf(!hasDom)('Escape is Not now: nothing written, these agents answered, the band seen', async () => {
  const { dialog, seen } = mount([CODEX, CLAUDE], REPORT);
  recordFetch(() => model());
  act(() => {
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await flush();
  expect(calls).toEqual([{ path: '/api/inbox/agents/notes', body: { add: [], asked: ['codex', 'claude-code'], seen: true } }]);
  expect(seen.closed).toBe(1);
});

test.skipIf(!hasDom)('Not now without news: seen is false', async () => {
  const { el } = mount([CODEX]);
  recordFetch(() => model());
  act(() => button(el, 'Not now').click());
  await flush();
  expect(calls[0]!.body).toEqual({ add: [], asked: ['codex'], seen: false });
});

test.skipIf(!hasDom)('the band\'s Settings → Agents link: the dialog closes as Not now and Settings opens', async () => {
  const { el, seen } = mount([CODEX], REPORT);
  recordFetch(() => model());
  act(() => button(el, 'Settings → Agents').click());
  await flush();
  expect(calls[0]!.body).toEqual({ add: [], asked: ['codex'], seen: true });
  expect(seen).toMatchObject({ closed: 1, settings: 1 });
});

test.skipIf(!hasDom)('Show the note opens the exact block', () => {
  const { el } = mount([CODEX, GEMINI]);
  act(() => button(el, 'Show the note').click());
  expect(el.querySelector('.ib-anote-note pre')?.textContent).toBe(NOTE);
  expect(button(el, 'Hide the note').getAttribute('aria-expanded')).toBe('true');
});

test.skipIf(!hasDom)('a long path is cut in the middle on screen, whole in the DOM and in its title; folder names isolated; the name left to the browser\'s direction', () => {
  const long = '~/Library/Application Support/com.openai.codex/profiles/work-laptop-2026-q4/AGENTS.override.md';
  const { el } = mount([row('codex', 'Codex', { path: long }), row('pi', 'Pi', { path: '/Users/ジョン・スミス/.config/مشاريع/AGENTS.md' })]);
  const path = el.querySelector('.ib-anote-path')!;
  expect(path.textContent).toBe(long);
  expect(path.getAttribute('title')).toBe(long);
  expect(path.getAttribute('dir')).toBe('ltr');
  expect(path.querySelector('.ib-anote-pt')?.textContent).toBe('AGENTS.override.md');
  expect([...el.querySelectorAll('.ib-anote-path')[1]!.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['Users', 'ジョン・スミス', '.config', 'مشاريع', 'AGENTS.md']);
  expect(el.querySelector('.ib-anote-name')?.getAttribute('dir')).toBe('auto');
  expect(el.textContent).toContain('Pi reads only one of its instruction files; this is the one.');
});

test.skipIf(!hasDom)('a failure and a foreign entry in the band; "new on this computer" after the first run', () => {
  const { el } = mount([CODEX], {
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
  expect([...el.querySelectorAll('.ib-anote-band p')].map((p) => p.textContent)).toEqual([
    'Connected Codex to the Inbox (new on this computer).',
    "Couldn't connect Amp: amp mcp add exited with code 3. Settings → Agents",
    "Couldn't connect Gemini CLI: gemini mcp add exited with code 3: boom: gemini could not write its config (permission denied). Settings → Agents",
    'Cursor has its own plannotator-inbox entry in ~/.cursor/mcp.json; Plannotator left it alone.',
  ]);
});
