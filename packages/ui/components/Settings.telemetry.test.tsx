/**
 * The daily ping switch in Settings (DOM_TESTS=1), on plan review, annotate
 * and code review, held by useTelemetrySetting as the Apps hold it (adopted
 * from serverConfig, written with POST /api/config).
 *
 * Regressions guarded: the row missing from a surface; turning it off not
 * writing `telemetry: false` (the switch every surface and the Inbox share);
 * the switch staying usable, or showing on, while the environment holds the
 * ping off (DO_NOT_TRACK, NO_ANON_PING, CI).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { useTelemetrySetting } from '../hooks/useTelemetrySetting';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

const ROW = '[data-telemetry-setting]';
type Mode = 'plan' | 'annotate' | 'review';

function Harness({ mode, serverConfig }: { readonly mode: Mode; readonly serverConfig: Record<string, unknown> | undefined }) {
  const telemetry = useTelemetrySetting();
  const { adopt } = telemetry;
  useEffect(() => adopt(serverConfig), [adopt, serverConfig]);
  return (
    <Settings
      taterMode={false}
      onTaterModeChange={() => {}}
      mode={mode}
      origin="claude-code"
      annotateParity={mode === 'annotate'}
      externalOpen
      telemetrySetting={telemetry.setting}
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

function recordConfigWrites(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return bodies;
}

const toggle = () => document.querySelector<HTMLButtonElement>(`${ROW} button[role="switch"]`);
const row = () => document.querySelector<HTMLElement>(ROW);

describe('Settings daily ping switch', () => {
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
    test.skipIf(!hasDom)(`${mode}: on, then off writes telemetry: false`, async () => {
      const bodies = recordConfigWrites();
      await mount(mode, { telemetry: true });
      expect(row()?.getAttribute('data-telemetry-setting')).toBe('on');
      await act(async () => toggle()?.click());
      expect(bodies).toEqual([{ telemetry: false }]);
      expect(row()?.getAttribute('data-telemetry-setting')).toBe('off');
    });
  }

  test.skipIf(!hasDom)('locked and shown off while the environment holds it off', async () => {
    const bodies = recordConfigWrites();
    await mount('plan', { telemetry: true, telemetryEnv: 'NO_ANON_PING' });
    expect(row()?.getAttribute('data-telemetry-setting')).toBe('env');
    expect(toggle()?.disabled).toBe(true);
    expect(row()?.textContent).toContain('NO_ANON_PING');
    await act(async () => toggle()?.click());
    expect(bodies).toEqual([]);
  });

  // Owner decision: NO_ANON_PING is the only variable named to users; DO_NOT_TRACK is honoured but never shown.
  test.skipIf(!hasDom)('held off by DO_NOT_TRACK: locked, and the variable is not named', async () => {
    await mount('plan', { telemetry: true, telemetryEnv: 'DO_NOT_TRACK' });
    expect(toggle()?.disabled).toBe(true);
    expect(row()?.textContent).not.toContain('DO_NOT_TRACK');
  });

  test.skipIf(!hasDom)('no row when the server does not report the switch', async () => {
    await mount('plan', {});
    expect(row()).toBeNull();
  });
});
