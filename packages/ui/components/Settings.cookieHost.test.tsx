/**
 * "Open Plannotator at plannotator.localhost" (#2184) in Settings (DOM_TESTS=1),
 * on plan review, annotate and code review, held by useCookieHostSetting as
 * the Apps hold it (adopted from serverConfig, written with POST /api/config).
 *
 * Regressions guarded: the row missing from a surface or shown without the
 * server's advert; the switch writing over another urlHost or an env var (it
 * must be locked and say what holds it); a refused write shown as saved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { useCookieHostSetting } from '../hooks/useCookieHostSetting';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

const ROW = '[data-cookie-host-setting]';
type Mode = 'plan' | 'annotate' | 'review';

function Harness({ mode, serverConfig }: { readonly mode: Mode; readonly serverConfig: Record<string, unknown> | undefined }) {
  const cookieHost = useCookieHostSetting();
  const { adopt } = cookieHost;
  useEffect(() => adopt(serverConfig), [adopt, serverConfig]);
  return (
    <Settings
      taterMode={false}
      onTaterModeChange={() => {}}
      mode={mode}
      origin="claude-code"
      annotateParity={mode === 'annotate'}
      externalOpen
      cookieHostSetting={cookieHost.setting}
    />
  );
}

async function mount(mode: Mode, serverConfig: Record<string, unknown> | undefined) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness mode={mode} serverConfig={serverConfig} />);
  });
}

/** Answer POST /api/config with `answer`, recording the bodies. */
function fakeConfigWrites(answer: (body: Record<string, unknown>) => { status: number; body: unknown }): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bodies.push(body);
    const { status, body: out } = answer(body);
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return bodies;
}

const toggle = () => document.querySelector<HTMLButtonElement>(`${ROW} button[role="switch"]`);
const row = () => document.querySelector<HTMLElement>(ROW);

describe('Settings cookie switch', () => {
  afterEach(async () => {
    globalThis.fetch = realFetch;
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  for (const mode of ['plan', 'annotate', 'review'] as const) {
    test.skipIf(!hasDom)(`${mode}: off, then on writes cookieHost: true and shows it on`, async () => {
      const bodies = fakeConfigWrites(() => ({ status: 200, body: { ok: true, cookieHost: { on: true } } }));
      await mount(mode, { cookieHost: { on: false } });
      expect(row()?.getAttribute('data-cookie-host-setting')).toBe('off');
      expect(toggle()?.getAttribute('aria-checked')).toBe('false');
      expect(row()?.textContent).toContain('plannotator.localhost');
      expect(row()?.textContent).toContain('Keeps Plannotator\'s cookies away from your other localhost apps');
      await act(async () => toggle()?.click());
      expect(bodies).toEqual([{ cookieHost: true }]);
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      expect(row()?.textContent).toContain('this browser\'s preferences start fresh once');
    });

    test.skipIf(!hasDom)(`${mode}: no row without the server's advert (remote, --tailscale, an older server)`, async () => {
      await mount(mode, { autoUpdate: false });
      expect(row()).toBeNull();
    });
  }

  test.skipIf(!hasDom)('locked by another urlHost: names it, and a click writes nothing', async () => {
    const bodies = fakeConfigWrites(() => ({ status: 200, body: {} }));
    await mount('plan', { cookieHost: { on: false, urlHost: 'my-machine.tailnet.ts.net' } });
    expect(row()?.getAttribute('data-cookie-host-setting')).toBe('locked-url-host');
    expect(toggle()?.disabled).toBe(true);
    expect(row()?.textContent).toContain('my-machine.tailnet.ts.net');
    await act(async () => toggle()?.click());
    expect(bodies).toEqual([]);
  });

  test.skipIf(!hasDom)('locked by PLANNOTATOR_URL_HOST: names it, shows its value', async () => {
    fakeConfigWrites(() => ({ status: 200, body: {} }));
    await mount('review', { cookieHost: { on: true, env: 'plannotator.localhost' } });
    expect(row()?.getAttribute('data-cookie-host-setting')).toBe('locked-env');
    expect(toggle()?.disabled).toBe(true);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(row()?.textContent).toContain('PLANNOTATOR_URL_HOST');
  });

  test.skipIf(!hasDom)('a write the server refuses shows its state and the reason', async () => {
    fakeConfigWrites(() => ({
      status: 409,
      body: { error: 'config.json already sets urlHost; it is not replaced.', code: 'cookie_host_url_host_in_use', cookieHost: { on: false, urlHost: 'auto' } },
    }));
    await mount('annotate', { cookieHost: { on: false } });
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(toggle()?.disabled).toBe(true);
    expect(row()?.querySelector('[role="alert"]')?.textContent).toContain('urlHost');
  });
});
