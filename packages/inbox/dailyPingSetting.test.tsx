/**
 * Settings → About's daily ping switch in the Inbox window (DOM_TESTS=1): it
 * follows `telemetry` from GET /api/inbox/settings, a click asks to flip the
 * config.json value, and it is locked (saying what holds it) while the
 * environment holds the ping off. No row without `telemetry` (an older Inbox,
 * a page through the tailnet).
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TelemetrySwitch } from './api';

const hasDom = typeof document !== 'undefined';
// Updates.tsx draws What's new with ui's Viewer, which reads `window` at module-eval time.
const { AboutBlock } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(telemetry: TelemetrySwitch | undefined, toggles: boolean[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root!.render(
      <AboutBlock
        version="0.28.46"
        details={null}
        switches={{ update_check: { on: true, env: null }, auto_update: { on: false, env: null } }}
        checking={false}
        error={null}
        onCheckNow={() => {}}
        onToggle={() => {}}
        telemetry={telemetry}
        onTelemetry={(on) => toggles.push(on)}
      />,
    );
  });
  return host;
}

const sw = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-settings-telemetry] button[role="switch"]');

test.skipIf(!hasDom)('on: a click asks to turn it off; off: a click asks to turn it on', () => {
  const toggles: boolean[] = [];
  let el = render({ on: true, config: true, env: null, notice_due: false }, toggles);
  expect(sw(el)?.getAttribute('aria-checked')).toBe('true');
  act(() => sw(el)!.click());
  expect(toggles).toEqual([false]);
  act(() => root?.unmount());
  host?.remove();
  el = render({ on: false, config: false, env: null, notice_due: false }, toggles);
  act(() => sw(el)!.click());
  expect(toggles).toEqual([false, true]);
});

test.skipIf(!hasDom)('locked, shown off and naming what holds it while the environment holds it off', () => {
  const toggles: boolean[] = [];
  const el = render({ on: false, config: true, env: 'NO_ANON_PING', notice_due: false }, toggles);
  expect(el.querySelector('[data-settings-telemetry]')?.getAttribute('data-settings-telemetry')).toBe('env');
  expect(sw(el)?.disabled).toBe(true);
  expect(sw(el)?.getAttribute('aria-checked')).toBe('false');
  expect(el.querySelector('[data-settings-telemetry]')?.textContent).toContain('NO_ANON_PING');
  act(() => root?.unmount());
  host?.remove();
  // Owner decision: NO_ANON_PING is the only variable named to users; DO_NOT_TRACK is honoured but never shown.
  const quiet = render({ on: false, config: true, env: 'DO_NOT_TRACK', notice_due: false }, toggles);
  expect(sw(quiet)?.disabled).toBe(true);
  expect(quiet.querySelector('[data-settings-telemetry]')?.textContent).not.toContain('DO_NOT_TRACK');
});

test.skipIf(!hasDom)('no row without the server\'s telemetry', () => {
  const el = render(undefined, []);
  expect(el.querySelector('[data-settings-telemetry]')).toBeNull();
});
