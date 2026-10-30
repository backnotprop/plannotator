/**
 * Notifications that never fail silently, the window's half: the line above
 * the list in each state (ask, moved, blocked, the tab slept), and Settings →
 * General's status, Allow, the blocked steps, Send a test notification with
 * the macOS hint, and "Notifications reach you".
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxNotifyReach } from '@plannotator/core/inbox-types';
import type { SettingsModel } from './api';
import type { TestResult } from './notify';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { NotificationAsk, TabSleptLine } = (hasDom ? await import('./components/NotificationAsk') : {}) as typeof import('./components/NotificationAsk');
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

const settingsModel = (enabled = true) =>
  ({
    serverSession: 's',
    version: '0.29.0',
    port: 1,
    url: 'http://localhost:1/',
    mcp_url: 'http://127.0.0.1:1/mcp',
    mcp_command: ['plannotator', 'inbox', 'mcp'],
    home: '/home/u',
    data_dir: '/home/u/.plannotator',
    inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
    notifications: { enabled, dismissed: false, allowed_origin: null },
    phones: false,
    store: { dir: '/home/u/.plannotator/inbox', bytes: 0, projects: [] },
  }) as unknown as SettingsModel;

function settings(options: {
  permission: NotificationPermission | 'unsupported';
  enabled?: boolean;
  reach?: InboxNotifyReach | null;
  onToggle?: (next: boolean) => void;
  onTest?: () => Promise<TestResult>;
}): HTMLElement {
  const el = mount(
    <SidebarProvider>
      <SettingsPage
        settings={settingsModel(options.enabled ?? true)}
        context={null}
        error={null}
        onToggleTool={() => {}}
        onToggleTailscale={() => {}}
        tailscaleBusy={false}
        permission={options.permission}
        onToggleNotifications={options.onToggle ?? (() => {})}
        notifyReach={options.reach ?? null}
        onTestNotification={options.onTest}
        onDeleteThread={async () => {}}
        onDeleteProject={async () => {}}
      />
    </SidebarProvider>,
  );
  return el.querySelector('[data-settings-notifications]') as HTMLElement;
}

const reach = (windows: number, allowed: number): InboxNotifyReach => ({ enabled: true, windows, allowed, allowed_origins: allowed ? [window.location.origin] : [] });

describe.if(hasDom)('the line above the list', () => {
  test('ask: Turn on and Not now', () => {
    const calls: string[] = [];
    const el = mount(<NotificationAsk kind="ask" onTurnOn={() => calls.push('on')} onNotNow={() => calls.push('not-now')} />);
    const line = el.querySelector('[data-notification-ask="ask"]') as HTMLElement;
    expect(line).not.toBeNull();
    (line.querySelector('.ib-pri') as HTMLButtonElement).click();
    expect(calls).toEqual(['on']);
  });

  test('moved: prominent, names the address it was allowed at and this one, one-click Allow', () => {
    const calls: string[] = [];
    const el = mount(<NotificationAsk kind="moved" movedFrom="http://127.0.0.1:59812" onTurnOn={() => calls.push('allow')} onNotNow={() => {}} />);
    const line = el.querySelector('[data-notification-ask="moved"]') as HTMLElement;
    expect(line.className).toContain('ib-askmoved');
    expect(line.textContent).toContain('127.0.0.1:59812');
    expect(line.textContent).toContain(window.location.host);
    const allow = [...line.querySelectorAll('button')].find((b) => b.textContent === 'Allow') as HTMLButtonElement;
    allow.click();
    expect(calls).toEqual(['allow']);
  });

  test('blocked: a quiet line with How to allow and Hide, no Turn on', () => {
    const calls: string[] = [];
    const el = mount(<NotificationAsk kind="blocked" onTurnOn={() => calls.push('on')} onNotNow={() => calls.push('hide')} onSettings={() => calls.push('settings')} />);
    const line = el.querySelector('[data-notification-ask="blocked"]') as HTMLElement;
    expect(line.className).toContain('ib-askquiet');
    const labels = [...line.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['How to allow', 'Hide']);
    (line.querySelectorAll('button')[0] as HTMLButtonElement).click();
    (line.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(calls).toEqual(['settings', 'hide']);
  });

  test('the tab slept: says why, once, with Got it', () => {
    const calls: string[] = [];
    const el = mount(<TabSleptLine slept="discarded" onDismiss={() => calls.push('ok')} />);
    const line = el.querySelector('[data-tab-slept="discarded"]') as HTMLElement;
    expect(line).not.toBeNull();
    (line.querySelector('button') as HTMLButtonElement).click();
    expect(calls).toEqual(['ok']);
  });
});

describe.if(hasDom)('Settings → General: notifications', () => {
  test('on: the status, a test button, and reach through this tab', async () => {
    let tests = 0;
    const block = settings({ permission: 'granted', reach: reach(1, 1), onTest: async () => (tests++, 'sent') });
    expect(block.querySelector('[data-notify-status]')?.getAttribute('data-notify-status')).toBe('on');
    expect(block.textContent).toContain('On for this address');
    expect(block.querySelector('[data-notify-reach]')?.getAttribute('data-notify-reach')).toBe('yes');
    const send = block.querySelector('[data-notify-test-send]') as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    expect(tests).toBe(1);
    expect(block.querySelector('[data-notify-test]')?.textContent).toContain("Didn't see it?");
  });

  test('not allowed here: Allow asks the browser; reach says no', () => {
    const toggles: boolean[] = [];
    const block = settings({ permission: 'default', reach: reach(1, 0), onToggle: (next) => toggles.push(next) });
    expect(block.querySelector('[data-notify-status]')?.getAttribute('data-notify-status')).toBe('not-allowed');
    expect(block.textContent).toContain('Not allowed in');
    expect(block.querySelector('[data-notify-test]')).toBeNull();
    (block.querySelector('[data-notify-allow]') as HTMLButtonElement).click();
    expect(toggles).toEqual([true]);
    expect(block.querySelector('[data-notify-reach]')?.getAttribute('data-notify-reach')).toBe('no');
    expect(block.querySelector('[data-notify-reach]')?.textContent).toContain('No: no open Inbox tab may notify.');
  });

  test('blocked: the steps for this address, no Allow, no test', () => {
    const block = settings({ permission: 'denied', reach: reach(1, 0) });
    expect(block.querySelector('[data-notify-status]')?.getAttribute('data-notify-status')).toBe('blocked');
    const steps = block.querySelector('[data-notifications-blocked]') as HTMLElement;
    expect(steps.textContent).toContain(window.location.host);
    expect(block.querySelector('[data-notify-allow]')).toBeNull();
    expect(block.querySelector('[data-notify-test]')).toBeNull();
  });

  test('this tab may not, another may: reach says yes and names it', () => {
    const block = settings({ permission: 'default', reach: { enabled: true, windows: 2, allowed: 1, allowed_origins: ['http://localhost:61000'] } });
    expect(block.querySelector('[data-notify-reach]')?.textContent).toContain('localhost:61000');
  });

  test('off: the status says Off and no Allow', () => {
    const block = settings({ permission: 'granted', enabled: false, reach: reach(1, 1) });
    expect(block.querySelector('[data-notify-status]')?.getAttribute('data-notify-status')).toBe('off');
    expect(block.querySelector('[data-notify-allow]')).toBeNull();
  });
});
