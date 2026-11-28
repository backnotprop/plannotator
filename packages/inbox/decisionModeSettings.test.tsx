/**
 * Settings → Capabilities → Decision mode (on unless turned off, the owner 2026-11-24) while the environment decides:
 * PLANNOTATOR_EXPERIMENTAL=-decision-mode keeps it off (`decision_mode.env` false), so the row is locked the way Grid's
 * is, its words saying what holds it. What regresses if this fails: the person flips a switch the Inbox then refuses
 * (409), or the row stays locked when nothing decides.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsModel } from './api';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const baseModel = {
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
  board: { on: false },
} as unknown as SettingsModel;

function render(decisionMode: SettingsModel['decision_mode'], toggles: boolean[]) {
  const noop = () => {};
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <SettingsPage
          settings={{ ...baseModel, decision_mode: decisionMode }}
          context={null}
          error={null}
          onToggleTool={noop}
          onToggleBoard={noop}
          onToggleDecisionMode={(next) => toggles.push(next)}
          onToggleTailscale={noop}
          tailscaleBusy={false}
          permission="granted"
          onToggleNotifications={noop}
          onDeleteThread={async () => {}}
          onDeleteProject={async () => {}}
          section="capabilities"
        />
      </SidebarProvider>,
    );
  });
}

const row = () => host!.querySelector<HTMLElement>('[data-settings-decision-mode]')!;
const toggle = () => row().querySelector<HTMLButtonElement>('[role="switch"]')!;

test.skipIf(!hasDom)('PLANNOTATOR_EXPERIMENTAL turns it off: the switch is locked and says why; a press asks nothing', () => {
  const toggles: boolean[] = [];
  render({ on: false, env: false }, toggles);
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(toggle().disabled).toBe(true);
  expect(row().querySelector('.ib-desc')!.textContent).toBe('PLANNOTATOR_EXPERIMENTAL turns it off.');
  act(() => toggle().click());
  expect(toggles).toEqual([]);
});

test.skipIf(!hasDom)('nothing decides (env null, or an Inbox before the field): the switch works', () => {
  for (const decisionMode of [{ on: true, env: null }, { on: true }] as const) {
    const toggles: boolean[] = [];
    render(decisionMode, toggles);
    expect(toggle().disabled).toBe(false);
    act(() => toggle().click());
    expect(toggles).toEqual([false]);
    act(() => root!.unmount());
    host!.remove();
    root = null;
    host = null;
  }
});
