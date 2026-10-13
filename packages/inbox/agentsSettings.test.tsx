/**
 * Settings → Agents (components/AgentsSettings.tsx; the approved
 * "inbox-agent-awareness" design, 08-09): one group per agent found, its
 * three switches and their states (connected, removed outside Plannotator,
 * the person's edited note, the OpenCode trap, no file for Cursor), the env
 * lock, "Agent's next session" after a change, and the agents not found
 * folded behind the harness picker. Requests go to a recording fetch.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgentRow, InboxAgentsModel } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { AgentsSettings } = (hasDom ? await import('./components/AgentsSettings') : {}) as typeof import('./components/AgentsSettings');

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

const tool = (id: InboxAgentRow['id'], label: string, over: Partial<InboxAgentRow> = {}): InboxAgentRow => ({
  id,
  label,
  detected: true,
  reach: { kind: 'tool', on: true, state: 'connected', path: null, locked: false, reason: null },
  reminder: { on: true, locked: false, needs_tool: false },
  note: null,
  ...over,
});
const mcp = (id: InboxAgentRow['id'], label: string, path: string, over: Partial<InboxAgentRow> = {}): InboxAgentRow => ({
  id,
  label,
  detected: true,
  reach: { kind: 'mcp', on: true, state: 'connected', path, locked: false, reason: null },
  reminder: null,
  note: null,
  ...over,
});
const note = (agent: string, over: object) => ({ agent, path: null, target: null, state: 'absent', create: false, created: false, reason: null, ...over }) as InboxAgentRow['note'];

function model(over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return {
    agents: [
      tool('claude-code', 'Claude Code', { note: note('claude-code', { path: '~/.claude/rules/plannotator-inbox.md', create: true }) }),
      mcp('codex', 'Codex', '~/.codex/config.toml', { note: note('codex', { path: '~/.codex/AGENTS.md', state: 'added' }) }),
      tool('pi', 'Pi', { note: note('pi', { path: '~/.pi/agent/CLAUDE.md', state: 'edited' }) }),
      tool('opencode', 'OpenCode', {
        note: note('opencode', { path: '~/.config/opencode/AGENTS.md', state: 'unavailable', reason: 'Creating this file would stop OpenCode 1 from reading your ~/.claude/CLAUDE.md.' }),
      }),
      mcp('cursor', 'Cursor', '~/.cursor/mcp.json', { reach: { kind: 'mcp', on: false, state: 'removed', path: '~/.cursor/mcp.json', locked: false, reason: null } }),
      { ...mcp('amp', 'Amp', '~/.config/amp/settings.json'), detected: false },
    ],
    last_report: null,
    connecting: false,
    connect_env_off: false,
    tool_env: null,
    notes_offered: true,
    note_text: '<!-- plannotator-inbox:start v1 -->\nnote\n<!-- plannotator-inbox:end -->',
    ...over,
  };
}

function mount(start: InboxAgentsModel) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  let current = start;
  const render = () =>
    root!.render(
      <AgentsSettings
        model={current}
        onModel={(next) => {
          current = next;
          render();
        }}
        context={{ command: ['/opt/plannotator', 'inbox', 'mcp'], mcpUrl: 'http://127.0.0.1:1/mcp', platform: 'mac' }}
      />,
    );
  act(() => {
    root = createRoot(host!);
    render();
  });
  return host;
}

const group = (el: HTMLElement, id: string) => el.querySelector(`[data-agent="${id}"]`)!;
const rows = (el: Element) =>
  [...el.querySelectorAll('.ib-agrow')].map((r) => ({
    k: r.querySelector('.ib-agk')?.textContent,
    v: r.querySelector('.ib-agv')?.textContent,
    sw: (r.querySelector('[role="switch"]') as HTMLButtonElement | null)?.getAttribute('aria-checked') ?? null,
    sub: r.querySelector('.ib-agsub')?.textContent ?? null,
  }));

test.skipIf(!hasDom)('one group per agent found, with its switches and the states the design names', () => {
  const el = mount(model());
  expect([...el.querySelectorAll('[data-agent]')].map((g) => g.getAttribute('data-agent'))).toEqual(['claude-code', 'codex', 'pi', 'opencode', 'cursor']);
  expect(group(el, 'claude-code').querySelector('.ib-agvia')?.textContent).toBe("Plannotator's plugin");
  expect(rows(group(el, 'claude-code'))).toEqual([
    { k: 'Reaches the Inbox', v: 'the plannotator_inbox tool', sw: 'true', sub: null },
    { k: 'Reminder at session start', v: 'one line when a session starts', sw: 'true', sub: null },
    { k: 'Note in its instructions', v: '~/.claude/rules/plannotator-inbox.md · would createShow', sw: 'false', sub: null },
  ]);
  expect(rows(group(el, 'codex'))).toEqual([
    { k: 'Reaches the Inbox', v: 'plannotator-inbox in ~/.codex/config.toml', sw: 'true', sub: null },
    { k: 'Note in its instructions', v: '~/.codex/AGENTS.md · marked sectionShow', sw: 'true', sub: null },
  ]);
  expect(rows(group(el, 'pi'))[2]!.sub).toBe("You edited this note, so Plannotator won't update it. Turning it off removes it as you left it.");
  const opencode = rows(group(el, 'opencode'))[2]!;
  expect(opencode.sw).toBeNull();
  expect(opencode.sub).toContain('OpenCode 1');
  expect(group(el, 'cursor').querySelector('.ib-agstate')?.textContent).toBe('Removed outside Plannotator');
  expect(rows(group(el, 'cursor'))).toEqual([
    { k: 'Reaches the Inbox', v: "plannotator-inbox is no longer in ~/.cursor/mcp.json. Plannotator won't add it back on its own; turn this on to add it.", sw: 'false', sub: null },
    { k: 'Note in its instructions', v: 'Cursor keeps its rules in its own settings, so there is no file to add a note to.', sw: null, sub: null },
  ]);
});

test.skipIf(!hasDom)('a switch saves that one change and says it applies to the agent\'s next session; Show opens the exact note', async () => {
  const el = mount(model());
  const sent: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    const next = model();
    next.agents[2] = tool('pi', 'Pi', { reminder: { on: false, locked: false, needs_tool: false }, note: next.agents[2]!.note });
    return new Response(JSON.stringify({ ...next, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const reminder = group(el, 'pi').querySelectorAll('[role="switch"]')[1] as HTMLButtonElement;
  await act(async () => {
    reminder.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(sent).toEqual([{ agent: 'pi', reminder: false }]);
  expect(group(el, 'pi').querySelectorAll('[role="switch"]')[1]!.getAttribute('aria-checked')).toBe('false');
  expect(group(el, 'pi').querySelector('.ib-agpending')?.textContent).toBe("Pi's next session");

  const show = [...group(el, 'codex').querySelectorAll('button')].find((b) => b.textContent === 'Show')!;
  act(() => show.click());
  expect(group(el, 'codex').querySelector('pre')?.textContent).toBe('<!-- plannotator-inbox:start v1 -->\nnote\n<!-- plannotator-inbox:end -->');
});

test.skipIf(!hasDom)('PLANNOTATOR_INBOX_TOOL locks the tool and reminder switches and says why', () => {
  const locked = model({ tool_env: false });
  locked.agents[0] = tool('claude-code', 'Claude Code', {
    reach: { kind: 'tool', on: false, state: 'off', path: null, locked: true, reason: null },
    reminder: { on: false, locked: true, needs_tool: true },
  });
  const el = mount(locked);
  expect(el.querySelector('[role="note"]')?.textContent).toContain('PLANNOTATOR_INBOX_TOOL=0 is set in this Inbox\'s environment');
  const switches = group(el, 'claude-code').querySelectorAll('[role="switch"]');
  expect([...switches].map((s) => (s as HTMLButtonElement).disabled)).toEqual([true, true]);
  expect(rows(group(el, 'claude-code'))[1]!.v).toBe('Needs the tool');
});

test.skipIf(!hasDom)('the agents not found fold behind the harness picker, editors included', () => {
  const el = mount(model());
  const more = [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Not found on this computer'))!;
  expect(more.textContent).toBe('Not found on this computer1 agent · connect one by hand');
  expect(more.getAttribute('aria-expanded')).toBe('false');
  act(() => more.click());
  expect([...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toContain('VS Code');
});

test.skipIf(!hasDom)('Claude Code, Pi and OpenCode keep their Inbox tool switch when not found here; a found Pi without the extension shows it too', () => {
  const base = model();
  const notFound: InboxAgentRow = {
    ...tool('opencode', 'OpenCode'),
    detected: false,
    reach: { kind: 'manual', on: false, state: 'manual', path: null, locked: false, reason: null },
    tool: { on: false, locked: false },
    reminder: { on: false, locked: false, needs_tool: true },
  };
  const piCli: InboxAgentRow = { ...mcp('pi', 'Pi', '~/.pi/agent/mcp.json'), tool: { on: false, locked: false }, reminder: { on: false, locked: false, needs_tool: true } };
  const el = mount({ ...base, agents: [base.agents[1]!, piCli, notFound] });
  expect(group(el, 'opencode').querySelector('.ib-agstate')?.textContent).toBe('Not found on this computer');
  expect(group(el, 'opencode').querySelector('[aria-label="The Inbox tool: OpenCode"]')).not.toBeNull();
  expect(group(el, 'pi').querySelector('[aria-label="The Inbox tool: Pi"]')).not.toBeNull();
  expect(group(el, 'pi').querySelector('[aria-label="Reaches the Inbox: Pi"]')).not.toBeNull();
});

test.skipIf(!hasDom)('a second click while a change to that agent saves is ignored', async () => {
  const el = mount(model());
  let calls = 0;
  let release: () => void = () => {};
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => (release = resolve));
    return new Response(JSON.stringify({ ...model(), error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const sw = group(el, 'codex').querySelector('[role="switch"]') as HTMLButtonElement;
  act(() => sw.click());
  expect(sw.getAttribute('aria-busy')).toBe('true');
  act(() => sw.click());
  expect(calls).toBe(1);
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(sw.getAttribute('aria-busy')).toBeNull();
});

test.skipIf(!hasDom)('OpenCode with no AGENTS.md says "no file yet", never "would create"; PLANNOTATOR_INBOX_NOTES=0 says notes are off', () => {
  const el = mount(model({ notes_env_off: true }));
  expect(rows(group(el, 'opencode'))[2]!.v).toBe('~/.config/opencode/AGENTS.md · no file yetShow');
  expect([...el.querySelectorAll('[role="note"]')].map((n) => n.textContent).join(' ')).toContain('PLANNOTATOR_INBOX_NOTES=0 is set');
});
