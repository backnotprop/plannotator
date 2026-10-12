/**
 * The first-open card (components/AgentsCard.tsx; the approved
 * "inbox-agent-awareness" design, 01-07): the head names what `plannotator
 * inbox` connected, a failure shows in amber with Try again, the one-time
 * question lists each agent with its exact file, Show the note opens the
 * exact block, Add sends only the ticked agents and lists what it wrote, Not
 * now and × answer it for good. The page's requests go to a recording fetch.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgentRow, InboxAgentsModel } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { AgentsCard } = (hasDom ? await import('./components/AgentsCard') : {}) as typeof import('./components/AgentsCard');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const NOTE = '<!-- plannotator-inbox:start v1 · added by Plannotator. -->\n## Plannotator Inbox\n<!-- plannotator-inbox:end -->';

function row(id: InboxAgentRow['id'], label: string, note: Partial<NonNullable<InboxAgentRow['note']>> | null, on = true): InboxAgentRow {
  return {
    id,
    label,
    detected: true,
    reach: { kind: 'mcp', on, state: on ? 'connected' : 'not_connected', path: null, locked: false, reason: null },
    reminder: null,
    note: note
      ? { agent: id as never, path: null, target: null, state: 'absent', create: false, created: false, reason: null, ...note }
      : null,
  };
}

function model(over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return {
    agents: [
      row('codex', 'Codex', { path: '~/.codex/AGENTS.md' }),
      row('gemini', 'Gemini CLI', { path: '~/.gemini/GEMINI.md', create: true }),
      row('cursor', 'Cursor', null),
      row('opencode', 'OpenCode', { state: 'unavailable', path: '~/.config/opencode/AGENTS.md' }),
    ],
    last_report: {
      at: '2026-10-12T00:00:00.000Z',
      first: true,
      added: ['codex', 'gemini', 'cursor'],
      already: [],
      failed: [],
      foreign: [],
      manual: [],
      unfinished: [],
      claude_code: true,
      seen: false,
    },
    connecting: false,
    connect_env_off: false,
    tool_env: null,
    notes_offered: false,
    note_text: NOTE,
    ...over,
  };
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

function mount(start: InboxAgentsModel): { el: HTMLElement; current: () => InboxAgentsModel; settings: string[] } {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  let current = start;
  const settings: string[] = [];
  const render = () =>
    root!.render(
      <AgentsCard
        model={current}
        onModel={(next) => {
          current = next;
          render();
        }}
        onSettings={() => settings.push('settings')}
        variant="empty"
      />,
    );
  act(() => {
    root = createRoot(host!);
    render();
  });
  return { el: host, current: () => current, settings };
}

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!;

test.skipIf(!hasDom)('the head says what was connected; the question lists each agent with its exact file, all ticked', () => {
  const { el } = mount(model());
  expect(el.querySelector('.ib-conn-head b')?.textContent).toBe('Connected Codex, Gemini CLI and Cursor to the Inbox.');
  expect(el.querySelector('.ib-conn-head .ib-mut')?.textContent).toBe('Claude Code was already on. Each one starts using it in its next session.');
  expect(el.querySelector('#' + CSS.escape(el.querySelector('[role="group"]')!.getAttribute('aria-labelledby')!))?.textContent).toBe('Tell them when to use it?');
  const rows = [...el.querySelectorAll('.ib-conn-picks li')].map((li) => [
    li.querySelector('.ib-conn-pick')?.textContent,
    li.querySelector('code')?.textContent,
    li.querySelector('.ib-conn-what')?.textContent,
    (li.querySelector('input') as HTMLInputElement).checked,
  ]);
  // Cursor keeps its rules in its settings (no note), OpenCode has no AGENTS.md to add to: neither is offered.
  expect(rows).toEqual([
    ['Codex', '~/.codex/AGENTS.md', 'adds a marked section', true],
    ['Gemini CLI', '~/.gemini/GEMINI.md', 'will create', true],
  ]);
  expect(button(el, 'Add to 2 files')).toBeDefined();
});

test.skipIf(!hasDom)('Show the note opens the exact block; Add sends only the ticked agents and lists what it wrote', async () => {
  const { el } = mount(model());
  act(() => button(el, 'Show the note').click());
  expect(el.querySelector('.ib-conn-note pre')?.textContent).toBe(NOTE);
  expect(button(el, 'Hide the note').getAttribute('aria-expanded')).toBe('true');
  act(() => (el.querySelectorAll('.ib-conn-picks input')[1] as HTMLInputElement).click());
  expect(button(el, 'Add to 1 file')).toBeDefined();
  recordFetch(() => ({ ...model({ notes_offered: true }), results: [{ ok: true, agent: 'codex', action: 'added', path: '~/.codex/AGENTS.md' }] }));
  act(() => button(el, 'Add to 1 file').click());
  await flush();
  expect(calls).toEqual([{ path: '/api/inbox/agents/notes', body: { add: ['codex'] } }]);
  expect([...el.querySelectorAll('.ib-conn-done li')].map((li) => li.textContent)).toEqual([
    'Codex: Added a marked section to ~/.codex/AGENTS.md',
    'Each agent reads its note from its next session. Remove a note any time in Settings.',
  ]);
  expect(el.querySelector('[role="group"]')).toBeNull();
});

test.skipIf(!hasDom)('nothing ticked: Add asks for a tick instead of sending; Not now answers with none and leaves the head', async () => {
  const { el } = mount(model());
  for (const box of el.querySelectorAll('.ib-conn-picks input')) act(() => (box as HTMLInputElement).click());
  act(() => button(el, 'Add the note').click());
  expect(el.querySelector('[role="alert"]')?.textContent).toBe('Tick at least one agent, or choose Not now.');
  recordFetch(() => model({ notes_offered: true }));
  act(() => button(el, 'Not now').click());
  await flush();
  expect(calls).toEqual([{ path: '/api/inbox/agents/notes', body: { add: [] } }]);
  expect(el.querySelector('[role="group"]')).toBeNull();
  expect(el.querySelector('.ib-conn-head b')?.textContent).toContain('Connected Codex');
});

test.skipIf(!hasDom)('a failure: amber, names the reason, Try again turns the agent on; × closes the card for good', async () => {
  const failed = model({
    last_report: { ...model().last_report!, added: ['gemini'], failed: [{ agent: 'codex', reason: '~/.codex/config.toml can\'t be written (permission denied)', path: '~/.codex/config.toml' }] },
    agents: [row('codex', 'Codex', { path: '~/.codex/AGENTS.md' }, false), row('gemini', 'Gemini CLI', { path: '~/.gemini/GEMINI.md', create: true })],
  });
  const { el, settings } = mount(failed);
  const fail = el.querySelector('.ib-conn-fail')!;
  expect(fail.getAttribute('role')).toBe('status');
  expect(fail.textContent).toContain("Couldn't connect Codex: ~/.codex/config.toml can't be written (permission denied). Plannotator left it as it was.");
  // A failed agent is not offered a note.
  expect([...el.querySelectorAll('.ib-conn-pick')].map((p) => p.textContent)).toEqual(['Gemini CLI']);
  act(() => button(el, 'Settings').click());
  expect(settings).toEqual(['settings']);

  recordFetch((path) => (path === '/api/inbox/agents' ? failed : { ...failed, notes_offered: true, last_report: { ...failed.last_report!, seen: true } }));
  act(() => button(el, 'Try again').click());
  await flush();
  expect(calls[0]).toEqual({ path: '/api/inbox/agents', body: { agent: 'codex', reach: true } });

  calls.length = 0;
  act(() => button(el, 'Close this notice').click());
  await flush();
  await flush();
  expect(calls.map((c) => c.path)).toEqual(['/api/inbox/agents/notes', '/api/inbox/agents/seen']);
  expect(el.querySelector('[data-agents-card]')).toBeNull();
});

test.skipIf(!hasDom)('nothing new and the question answered: no card at all', () => {
  const { el } = mount(model({ notes_offered: true, last_report: { ...model().last_report!, seen: true } }));
  expect(el.querySelector('[data-agents-card]')).toBeNull();
});
