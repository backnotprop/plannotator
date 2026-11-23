/**
 * The canvas as a capability, in the window (Settings → Capabilities → Canvas, the Inbox's `settings.canvas`, off by
 * default; docs/agent-guides/inbox-canvas.md "The switch"). Off: a thread has no pen in its header or reply box, and
 * none of the canvas's code is fetched. On: both pens are there. The row: present only on an Inbox that sends
 * `canvas`, and a click saves `{ canvas: { on } }`. The server's refusals: packages/server/inbox-canvas-capability.test.ts.
 *
 * What regresses: a pen (or the canvas's chunk) for a person who never turned it on; no pen once they did; the row
 * missing or saving the wrong value.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { SettingsModel } from '../api';
import type { ThreadSlotHost } from '../thread/slotHost';

const hasDom = typeof document !== 'undefined';
const { useThreadCanvas } = (hasDom ? await import('./useThreadCanvas') : {}) as typeof import('./useThreadCanvas');
const { SketchButtonPart, CanvasLayerPart } = (hasDom ? await import('../lazyParts') : {}) as typeof import('../lazyParts');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
const { SettingsPage } = (hasDom ? await import('../components/Settings') : {}) as typeof import('../components/Settings');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { useSettingsSaves } = (hasDom ? await import('../data/actions/settings') : {}) as typeof import('../data/actions/settings');

let root: Root | null = null;
let host: HTMLElement | null = null;
const savedFetch = globalThis.fetch;
const posted: Record<string, unknown>[] = [];

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  posted.length = 0;
  if (hasDom) document.body.innerHTML = '';
});

function mount(node: React.ReactNode) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/api/inbox/settings') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      return Response.json(body);
    }
    return Response.json({});
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

const thread = { thread_id: 'msg_A1', subject: 'Plan', messages: [] } as unknown as InboxThread;

function Pens({ canvas }: { canvas: { on: boolean } | undefined }) {
  const slot = { settings: { canvas } as SettingsModel, setShapeReply: () => {} } as unknown as ThreadSlotHost;
  const pens = useThreadCanvas(thread, slot, false);
  return (
    <>
      <header>{pens.header}</header>
      <footer>{pens.reply}</footer>
    </>
  );
}

const renderPens = (canvas: { on: boolean } | undefined) =>
  mount(
    <ThemeProvider>
      <Pens canvas={canvas} />
    </ThemeProvider>,
  );

describe("a thread's pens follow the switch", () => {
  test.skipIf(!hasDom)('off, or an Inbox that sends no switch: no pen in the header or the reply box, and no canvas code fetched', async () => {
    for (const canvas of [{ on: false }, undefined]) {
      renderPens(canvas);
      await act(async () => {});
      expect(document.querySelector('[data-thread-sketch]')).toBeNull();
      expect(document.querySelector('[data-reply-sketch]')).toBeNull();
      act(() => root?.unmount());
      root = null;
    }
    expect(SketchButtonPart.isLoaded()).toBe(false);
    expect(CanvasLayerPart.isLoaded()).toBe(false);
  });

  test.skipIf(!hasDom)('on: the pen is in the header and in the reply box', async () => {
    renderPens({ on: true });
    await act(async () => {
      await SketchButtonPart.preload();
    });
    await act(async () => {});
    expect(document.querySelector('header [data-thread-sketch]')).not.toBeNull();
    expect(document.querySelector('footer [data-reply-sketch]')).not.toBeNull();
  });
});

describe('Settings → Capabilities → Canvas', () => {
  const baseModel = { serverSession: 's', version: '0.29.1', port: 1, home: '/home/u', data_dir: '/home/u/.plannotator', inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null }, notifications: { enabled: true, dismissed: false, allowed_origin: null }, phones: false } as unknown as SettingsModel;
  function Window({ canvas }: { canvas: { on: boolean } | undefined }) {
    const [settings, setSettings] = useState<SettingsModel | null>({ ...baseModel, ...(canvas ? { canvas } : {}) } as SettingsModel);
    const noop = () => {};
    const { toggleCanvas } = useSettingsSaves({ setSettings, setError: noop, refresh: async () => {}, adoptStore: noop, readStore: noop, refreshList: async () => {} });
    return (
      <SidebarProvider>
        <SettingsPage section="capabilities" settings={settings} context={null} error={null} onToggleTool={noop} onToggleTailscale={noop} tailscaleBusy={false} permission="granted" onToggleNotifications={noop} onDeleteThread={async () => {}} onDeleteProject={async () => {}} onToggleCanvas={toggleCanvas} />
      </SidebarProvider>
    );
  }
  const toggle = () => document.querySelector<HTMLButtonElement>('[data-settings-canvas] button[role="switch"]');

  test.skipIf(!hasDom)('off by default: the row is in Capabilities, and a click saves it on', async () => {
    mount(<Window canvas={{ on: false }} />);
    const row = document.querySelector('[data-settings-canvas]');
    expect(row?.closest('[data-settings-capabilities]')).toBeTruthy();
    expect(row?.querySelector('.ib-l')?.textContent).toBe('Canvas');
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle()!.click());
    expect(posted.filter((body) => 'canvas' in body)).toEqual([{ canvas: { on: true } }]);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  });

  test.skipIf(!hasDom)('an Inbox that sends no canvas switch has no row', () => {
    mount(<Window canvas={undefined} />);
    expect(document.querySelector('[data-settings-canvas]')).toBeNull();
  });
});
