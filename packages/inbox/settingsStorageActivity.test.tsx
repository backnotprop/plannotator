/**
 * Settings → Storage's Delete and Settings → Activity (approval "settings-storage-activity", 2026-11-08), on the
 * Settings page alone over a scripted `fetch`. Storage: a thread's row and a project's row delete with the same
 * button, each named for what it deletes, and only on a second click. Activity: the chart, then the decision numbers
 * under it; nothing asks the server to count decisions until Activity is shown, and Decision data has no row of its
 * own. The window over a real Inbox (the old address, focus) is `settingsSections.test.tsx`.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxStorageModel, SettingsModel } from './api';
import type { SettingsSection } from './settingsRoute';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** Every request the page made, as its URL. */
let requests: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/inbox/sessions')) return new Response(JSON.stringify({ serverSession: 's', home: '/home/u', projects: [] }));
    // A count that never answers: the section's wait is all these tests need of it.
    if (url.includes('/api/inbox/decision-data')) return new Promise<Response>(() => {});
    return new Response('{}');
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
});

const settings = {
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

const store: InboxStorageModel = {
  dir: '/home/u/.plannotator/inbox',
  bytes: 3000,
  projects: [
    {
      id: 'prj_harbor',
      name: 'harbor',
      root: '/work/harbor',
      bytes: 2000,
      threads: [
        { thread_id: 'msg_one', subject: 'Retry the upload', bytes: 1200 },
        { thread_id: 'msg_two', subject: null, bytes: 800 },
      ],
    },
    { id: 'prj_lantern', name: 'lantern', root: '/work/lantern', bytes: 1000, threads: [{ thread_id: 'msg_three', subject: 'Docs', bytes: 1000 }] },
  ],
};

interface Deleted {
  threads: string[];
  projects: string[];
}

function render(section: SettingsSection, deleted: Deleted = { threads: [], projects: [] }) {
  const noop = () => {};
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
    });
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <SettingsPage
          settings={settings}
          context={null}
          error={null}
          section={section}
          onToggleTool={noop}
          onToggleTailscale={noop}
          tailscaleBusy={false}
          permission="granted"
          onToggleNotifications={noop}
          onDeleteThread={async (id) => void deleted.threads.push(id)}
          onDeleteProject={async (id) => void deleted.projects.push(id)}
          store={store}
          activity={<section className="ib-sgroup" data-activity="" aria-label="Activity" />}
        />
      </SidebarProvider>,
    );
  });
  return host!;
}

const deleteButtons = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.ib-stbl .ib-del-l')];
const counts = () => requests.filter((url) => url.includes('/api/inbox/decision-data')).length;

describe('Settings → Storage: Delete from Inbox', () => {
  test.skipIf(!hasDom)('a project and its threads delete with one button, each named for what it deletes', () => {
    const el = render('storage');
    const buttons = deleteButtons(el);
    // The first project opens with the page: its row, then its two threads, then the next project.
    expect(buttons.map((button) => button.textContent)).toEqual(['Delete from Inbox', 'Delete from Inbox', 'Delete from Inbox', 'Delete from Inbox']);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Delete from Inbox: harbor',
      'Delete from Inbox: Retry the upload',
      'Delete from Inbox: this thread',
      'Delete from Inbox: lantern',
    ]);
  });

  test.skipIf(!hasDom)('a first click only asks; the second deletes that thread or that project, and nothing else', async () => {
    const deleted: Deleted = { threads: [], projects: [] };
    const el = render('storage', deleted);
    const thread = el.querySelector<HTMLButtonElement>('[data-store-thread="msg_one"] .ib-del-l')!;
    act(() => thread.click());
    expect(deleted).toEqual({ threads: [], projects: [] });
    expect(thread.textContent).toBe('Delete? Click again');
    expect(thread.getAttribute('aria-label')).toBe('Delete from Inbox: Retry the upload (click again to delete)');
    await act(async () => thread.click());
    expect(deleted).toEqual({ threads: ['msg_one'], projects: [] });

    const project = el.querySelector<HTMLButtonElement>('[data-store-project="lantern"] .ib-del-l')!;
    act(() => project.click());
    expect(deleted.projects).toEqual([]);
    await act(async () => project.click());
    expect(deleted).toEqual({ threads: ['msg_one'], projects: ['prj_lantern'] });
  });
});

describe('Settings → Activity: the chart and the decision numbers', () => {
  test.skipIf(!hasDom)('Decision data has no row of its own: Activity, before Archived, holds it', () => {
    const el = render('general');
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.ib-snav a')].map((a) => a.getAttribute('data-settings-link'));
    expect(links).toContain('activity');
    expect(links).not.toContain('decision-data');
    expect(links.indexOf('activity')).toBeLessThan(links.indexOf('archived'));
  });

  test.skipIf(!hasDom)('nothing asks to count until Activity is shown; there the chart is on top and the decision numbers under it', () => {
    for (const section of ['general', 'storage', 'archived', 'about'] as const) render(section);
    expect(counts()).toBe(0);
    const el = render('activity');
    expect(counts()).toBe(1);
    const chart = el.querySelector('[data-activity]')!;
    const decisions = el.querySelector('[data-decision-data]')!;
    expect(chart.compareDocumentPosition(decisions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Leaving asks for nothing more; coming back asks once.
    render('about');
    expect(el.querySelector('[data-decision-data]')).toBeNull();
    expect(counts()).toBe(1);
    render('activity');
    expect(counts()).toBe(2);
  });
});
