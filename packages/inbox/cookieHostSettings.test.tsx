/**
 * Settings → General's "Open Plannotator at plannotator.localhost" (#2184) in the
 * Inbox window: the row follows `cookie_host` from GET /api/inbox/settings,
 * a click asks to flip it, and it is locked (with what holds it) while
 * PLANNOTATOR_URL_HOST is set or config.json holds another urlHost. A
 * settings model without `cookie_host` (a page through the tailnet, an older
 * Inbox) shows no row.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxCookieHost, SettingsModel } from './api';

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
  if (hasDom) document.body.innerHTML = '';
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
  store: { dir: '/home/u/.plannotator/inbox', bytes: 0, projects: [] },
} as unknown as SettingsModel;

function render(cookieHost: InboxCookieHost | undefined, toggles: boolean[]) {
  const noop = () => {};
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <SettingsPage
          settings={{ ...baseModel, ...(cookieHost ? { cookie_host: cookieHost } : {}) }}
          context={null}
          error={null}
          onToggleTool={noop}
          onToggleTailscale={noop}
          tailscaleBusy={false}
          permission="granted"
          onToggleNotifications={noop}
          onToggleCookieHost={(next) => toggles.push(next)}
          onDeleteThread={async () => {}}
          onDeleteProject={async () => {}}
        />
      </SidebarProvider>,
    );
  });
}

const group = () => document.querySelector<HTMLElement>('[data-settings-cookie-host]');
const toggle = () => group()?.querySelector<HTMLButtonElement>('button[role="switch"]') ?? null;

describe('Inbox Settings: the cookie switch', () => {
  test.skipIf(!hasDom)('off: a click asks to turn it on; the switch is named by its title', () => {
    const toggles: boolean[] = [];
    render({ on: false, env: null, url_host: null }, toggles);
    expect(group()?.getAttribute('data-settings-cookie-host')).toBe('off');
    const label = document.getElementById(toggle()!.getAttribute('aria-labelledby')!);
    expect(label?.textContent).toBe('Open Plannotator at plannotator.localhost');
    expect(group()?.textContent).toContain('plannotator.localhost');
    expect(group()?.textContent).toContain('Notifications need allowing once');
    act(() => toggle()?.click());
    expect(toggles).toEqual([true]);
  });

  test.skipIf(!hasDom)('on: a click asks to turn it off', () => {
    const toggles: boolean[] = [];
    render({ on: true, env: null, url_host: null }, toggles);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    act(() => toggle()?.click());
    expect(toggles).toEqual([false]);
  });

  test.skipIf(!hasDom)('locked by another urlHost or the env var: disabled, and says what holds it', () => {
    const toggles: boolean[] = [];
    render({ on: false, env: null, url_host: 'my-machine.tailnet.ts.net' }, toggles);
    expect(group()?.getAttribute('data-settings-cookie-host')).toBe('locked-url-host');
    expect(toggle()?.disabled).toBe(true);
    expect(group()?.textContent).toContain('my-machine.tailnet.ts.net');
    act(() => root?.unmount());
    host?.remove();
    render({ on: true, env: 'plannotator.localhost', url_host: null }, toggles);
    expect(group()?.getAttribute('data-settings-cookie-host')).toBe('locked-env');
    expect(toggle()?.disabled).toBe(true);
    expect(group()?.textContent).toContain('PLANNOTATOR_URL_HOST');
    expect(toggles).toEqual([]);
  });

  test.skipIf(!hasDom)('no cookie_host (through the tailnet, an older Inbox): no row', () => {
    render(undefined, []);
    expect(group()).toBeNull();
  });
});
