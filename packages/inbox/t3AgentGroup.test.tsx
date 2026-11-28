/**
 * Settings → Agents' T3 Code group (the owner's "A · One row", 2026-11-15):
 * absent when T3 Code is not on this computer; after Codex when it is, with
 * T3 Code's own mark and one row, Your replies, in each state the design
 * names (its command wakes a thread; T3 closed now; nothing here can wake
 * one, with the sign-in fix and its Copy). Settings' Agents item gets no dot
 * from it: the row says it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INBOX_T3_LOGIN_COMMAND, type InboxAgentRow, type InboxAgentsModel, type InboxT3Status } from '@plannotator/core/inbox-types';
import type { SettingsModel } from './api';

const hasDom = typeof document !== 'undefined';
const { AgentsSettings } = (hasDom ? await import('./components/AgentsSettings') : {}) as typeof import('./components/AgentsSettings');
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

const row = (id: InboxAgentRow['id'], label: string, kind: 'tool' | 'mcp'): InboxAgentRow => ({
  id,
  label,
  detected: true,
  reach: { kind, on: true, state: 'connected', path: kind === 'mcp' ? '~/.codex/config.toml' : null, locked: false, reason: null },
  reminder: null,
  note: null,
  ...(kind === 'mcp' ? { wakes: true } : {}),
});

function model(t3: InboxT3Status | null | undefined, over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return {
    agents: [row('claude-code', 'Claude Code', 'tool'), row('codex', 'Codex', 'mcp'), row('pi', 'Pi', 'tool')],
    last_report: null,
    connecting: false,
    connect_env_off: false,
    tool_env: null,
    notes_offered: true,
    note_text: 'note',
    ...(t3 === undefined ? {} : { t3 }),
    ...over,
  };
}

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  return host;
}

const agents = (m: InboxAgentsModel) => mount(<AgentsSettings model={m} onModel={() => {}} context={null} />);
const t3Group = (el: HTMLElement) => el.querySelector('[data-agent="t3"]');
const read = (group: Element) => ({
  name: group.querySelector('.ib-aghead b')?.textContent,
  via: group.querySelector('.ib-agvia')?.textContent,
  state: group.querySelector('.ib-agstate')?.textContent,
  rows: [...group.querySelectorAll('.ib-agrow')].map((r) => ({ k: r.querySelector('.ib-agk')?.textContent, v: r.querySelector('.ib-agv')?.textContent, sub: r.querySelector('.ib-agsub')?.textContent ?? null })),
  copy: group.querySelector('[data-restart-copy]') !== null,
  command: group.querySelector('[data-t3-command]')?.textContent ?? null,
});

test.skipIf(!hasDom)('no T3 Code group when T3 Code is not on this computer, or the Inbox does not say', () => {
  for (const t3 of [null, undefined]) {
    const el = agents(model(t3));
    expect(t3Group(el)).toBeNull();
    expect(el.textContent).not.toContain('T3 Code');
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)("its command here and T3 open: replies arrive as a new turn, Connected, no fix; the group follows Codex's", () => {
  const el = agents(model({ local: true, open: true, sign_in: 'none' }));
  expect([...el.querySelectorAll('[data-agent]')].map((g) => g.getAttribute('data-agent'))).toEqual(['claude-code', 'codex', 't3', 'pi']);
  // T3 Code's own logo, not the neutral code glyph.
  expect(t3Group(el)!.querySelector('.ib-aghead .ib-mk [data-mark="t3"]')).not.toBeNull();
  expect(read(t3Group(el)!)).toEqual({
    name: 'T3 Code',
    via: 'Claude and Codex threads',
    state: 'Connected',
    rows: [{ k: 'Your replies', v: 'arrive as a new turn', sub: null }],
    copy: false,
    command: null,
  });
});

test.skipIf(!hasDom)("T3 closed now: the same, and the note that they go in when it opens; no fix", () => {
  const el = agents(model({ local: true, open: false, sign_in: 'none' }));
  expect(read(t3Group(el)!)).toEqual({
    name: 'T3 Code',
    via: 'Claude and Codex threads',
    state: 'Connected',
    rows: [{ k: 'Your replies', v: 'arrive as a new turn', sub: "T3 isn't open. They go in when you open it." }],
    copy: false,
    command: null,
  });
});

test.skipIf(!hasDom)('nothing here can wake it (Windows, no t3 command): seen when it checks, Not connected, and the sign-in with Copy', () => {
  for (const sign_in of ['none', 'read_only', 'ran_out'] as const) {
    const el = agents(model({ local: false, open: false, sign_in }));
    const seen = read(t3Group(el)!);
    expect(seen.state).toBe('Not connected');
    expect(seen.rows).toEqual([{ k: 'Your replies', v: "seen when it checks the Inbox; it can't be woken", sub: `Sign in to T3 once and replies go in by themselves: ${INBOX_T3_LOGIN_COMMAND}Copy` }]);
    expect(seen.copy).toBe(true);
    expect(seen.command).toBe(INBOX_T3_LOGIN_COMMAND);
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)('a saved sign-in that sends wakes it with no t3 command here: Connected, no fix', () => {
  const el = agents(model({ local: false, open: false, sign_in: 'ok' }));
  const seen = read(t3Group(el)!);
  expect(seen.state).toBe('Connected');
  expect(seen.rows).toEqual([{ k: 'Your replies', v: 'arrive as a new turn', sub: null }]);
  expect(seen.copy).toBe(false);
});

const settingsModel = {
  serverSession: 's',
  version: '0.29.0',
  port: 1,
  url: 'http://localhost:1/',
  mcp_url: 'http://127.0.0.1:1/mcp',
  mcp_command: ['plannotator', 'inbox', 'mcp'],
  home: '/home/u',
  data_dir: '/home/u/.plannotator',
  inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
  notifications: { enabled: true, dismissed: false, allowed_origin: null },
  phones: false,
  store_dir: '/home/u/.plannotator/inbox',
} as unknown as SettingsModel;

test.skipIf(!hasDom)("Settings' Agents item gets no dot when T3 Code cannot be woken; a session that needs a reload still lights it", () => {
  const noop = () => {};
  const page = (m: InboxAgentsModel) =>
    mount(
      <SidebarProvider>
        <SettingsPage
          settings={settingsModel}
          section="agents"
          agents={m}
          onAgents={noop}
          context={null}
          error={null}
          onToggleTool={noop}
          onToggleTailscale={noop}
          tailscaleBusy={false}
          permission="granted"
          onToggleNotifications={noop}
          onDeleteThread={async () => {}}
          onDeleteProject={async () => {}}
        />
      </SidebarProvider>,
    );
  const el = page(model({ local: false, open: false, sign_in: 'ran_out' }));
  expect(el.querySelector('[data-agent="t3"]')).not.toBeNull();
  expect(el.querySelector('[data-settings-link="agents"]')).not.toBeNull();
  expect(el.querySelector('[data-settings-link="agents"] [data-agents-dot]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  const stale = page(
    model(null, { sessions: { 'claude-code': { running: 1, outdated: 1, installed: null, update_command: null, sessions: [] } } }),
  );
  expect(stale.querySelector('[data-settings-link="agents"] [data-agents-dot]')).not.toBeNull();
});
