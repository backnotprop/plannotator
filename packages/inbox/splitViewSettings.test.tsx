/**
 * Settings → General → Appearance → "Threads side by side" (config.json `inboxSplitView`, off by default;
 * docs/agent-guides/inbox-window.md "Free layout"): the row follows `split_view` from GET /api/inbox/settings, and a
 * click saves the other value through POST /api/inbox/settings `{ split_view: { on } }`, showing it at once (every
 * window, this one included, then takes it from `event: capabilities`: capabilities.test.ts).
 *
 * What regresses: the row missing, or on when the Inbox says off; a click not saving, or saving the wrong value; a
 * failed save leaving the switch showing what was not saved; a row for a settings model without `split_view`.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsModel } from './api';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
const savedFetch = globalThis.fetch;
/** The bodies of the window's POST /api/inbox/settings in this test. */
const posted: Record<string, unknown>[] = [];
let answer: (body: Record<string, unknown>) => Response = (body) => Response.json({ split_view: body.split_view });

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  posted.length = 0;
  answer = (body) => Response.json({ split_view: body.split_view });
  if (hasDom) document.body.innerHTML = '';
});

const baseModel = {
  serverSession: 's',
  version: '0.29.1',
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

function render(splitView: { on: boolean } | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/inbox/settings') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      return answer(body);
    }
    return Response.json({});
  }) as typeof fetch;
  const noop = () => {};
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <SettingsPage
          settings={{ ...baseModel, ...(splitView ? { split_view: splitView } : {}) } as SettingsModel}
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
  });
}

const row = () => document.querySelector<HTMLElement>('[data-settings-split-view]');
const toggle = () => row()?.querySelector<HTMLButtonElement>('button[role="switch"]') ?? null;
const splitBodies = () => posted.filter((body) => 'split_view' in body).map((body) => body.split_view);

describe('Inbox Settings: thread panes', () => {
  test.skipIf(!hasDom)('off by default: the row sits in Appearance, named by its title, and a click saves it on, shown at once', async () => {
    render({ on: false });
    expect(row()?.closest('[data-settings-theme]')).not.toBeNull();
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(toggle()!.getAttribute('aria-labelledby')!)?.textContent).toBe('Threads side by side');
    expect(row()?.textContent).toContain('Open to the side');
    await act(async () => toggle()!.click());
    expect(splitBodies()).toEqual([{ on: true }]);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(row()?.getAttribute('data-settings-split-view')).toBe('on');
  });

  test.skipIf(!hasDom)('on (a config.json that already had it): a click saves it off', async () => {
    render({ on: true });
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle()!.click());
    expect(splitBodies()).toEqual([{ on: false }]);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  test.skipIf(!hasDom)('a save that fails puts the switch back and says it was not saved', async () => {
    answer = () => Response.json({ error: 'config.json could not be saved; nothing changed.', code: 'config_not_saved' }, { status: 409 });
    render({ on: false });
    await act(async () => toggle()!.click());
    await act(async () => {});
    expect(splitBodies()).toEqual([{ on: true }]);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(row()?.textContent).toContain('Not saved');
  });

  test.skipIf(!hasDom)('a settings model without split_view: no row', () => {
    render(undefined);
    expect(row()).toBeNull();
  });
});
