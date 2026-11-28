/**
 * Swarm's row in Settings → Capabilities → Experimental (components/Settings.tsx), rendered on its own, no server. What
 * this catches: the row missing, its switch not saying the setting or not turning Swarm (and not Grid or Decision mode),
 * an environment variable's lock not shown, or the Capabilities row's value not naming Swarm when it is on.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const MODEL = {
  serverSession: 's',
  version: '0.29.4',
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
};
const experimental = (swarm: { on: boolean; env: boolean | null }) => ({ decision_mode: { on: false, env: null }, grid: { on: false, env: null }, swarm });

async function renderSettings(settings: object, section: 'capabilities' | null, onToggle: (next: boolean, feature?: string) => void, onToggleDecisionMode?: (next: boolean) => void) {
  const { SettingsPage } = await import('../components/Settings');
  const { SidebarProvider } = await import('../shell/sidebar');
  const noop = () => {};
  const page = (
    <SidebarProvider>
      <SettingsPage
        settings={settings as never}
        context={null}
        error={null}
        onToggleTool={noop}
        onToggleExperimental={onToggle}
        onToggleDecisionMode={onToggleDecisionMode}
        onToggleBoard={noop}
        onToggleTailscale={noop}
        tailscaleBusy={false}
        permission="granted"
        onToggleNotifications={noop}
        onDeleteThread={async () => {}}
        onDeleteProject={async () => {}}
        section={section}
        phone={section === null}
      />
    </SidebarProvider>
  );
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
    });
  }
  act(() => root!.render(page));
  return host;
}

test.skipIf(!hasDom)('Capabilities → Experimental has Swarm: its words, its switch off by default, and a press turns Swarm alone', async () => {
  const turns: [boolean, string | undefined][] = [];
  const el = await renderSettings({ ...MODEL, experimental: experimental({ on: false, env: null }) }, 'capabilities', (next, feature) => turns.push([next, feature]));
  const row = el.querySelector<HTMLElement>('[data-settings-experimental] [data-settings-swarm]')!;
  expect(row.querySelector('.ib-l')!.textContent).toBe('Swarm');
  expect(row.querySelector('.ib-desc')!.textContent).toBe('Several agents work one thread as a team, and talk to each other in its ghost thread.');
  const sw = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(sw.getAttribute('aria-checked')).toBe('false');
  expect(sw.disabled).toBe(false);
  act(() => sw.click());
  expect(turns).toEqual([[true, 'swarm']]);
});

test.skipIf(!hasDom)('Swarm comes after Grid in Experimental, and Decision mode keeps its own row in Capabilities', async () => {
  const settings = { ...MODEL, decision_mode: { on: true, env: null }, experimental: experimental({ on: false, env: null }) };
  const el = await renderSettings(settings, 'capabilities', () => {}, () => {});
  const rows = [...el.querySelectorAll<HTMLElement>('[data-settings-experimental] .ib-prow')].map((row) => row.querySelector('.ib-l')!.textContent);
  expect(rows.slice(0, 2)).toEqual(['Grid', 'Swarm']);
  expect(el.querySelector('[data-settings-capabilities] [data-settings-decision-mode]')).not.toBeNull();
  expect(el.querySelector('[data-settings-experimental] [data-settings-decision-mode]')).toBeNull();
});

test.skipIf(!hasDom)('PLANNOTATOR_EXPERIMENTAL deciding it: the row says so and its switch is locked; on, the phone row names Swarm', async () => {
  const el = await renderSettings({ ...MODEL, experimental: experimental({ on: true, env: true }) }, 'capabilities', () => {});
  const row = el.querySelector<HTMLElement>('[data-settings-swarm]')!;
  expect(row.querySelector('.ib-desc')!.textContent).toBe('PLANNOTATOR_EXPERIMENTAL turns it on.');
  expect(row.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
  await renderSettings({ ...MODEL, experimental: experimental({ on: true, env: null }) }, null, () => {});
  expect(el.querySelector('[data-settings-list] [data-settings-link="capabilities"] .ib-v')?.textContent).toBe('Swarm');
});
