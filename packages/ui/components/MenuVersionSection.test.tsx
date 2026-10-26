/**
 * The Options menu's version section: the host's command (remembered flags
 * included) for every host, and Update now only where the install script
 * manages the binary (never on Pi, whose command is `pi update --extensions`).
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UpdateInfo } from '../hooks/useUpdateCheck';
import { MenuVersionSection } from './MenuVersionSection';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const info = (over: Partial<UpdateInfo>): UpdateInfo => ({
  currentVersion: '0.28.10',
  latestVersion: '0.28.12',
  updateAvailable: true,
  dismissed: false,
  releaseUrl: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.12',
  action: 'script',
  command: 'curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-gemini',
  dismiss: () => {},
  ...over,
});

function render(updateInfo: UpdateInfo | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<MenuVersionSection appVersion="0.28.10" updateInfo={updateInfo} isWSL={false} closeMenu={() => {}} />);
  });
  return host;
}

const buttonNamed = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name);

test.skipIf(!hasDom)('the managed binary: its command with the remembered flags, and Update now', () => {
  const el = render(info({}));
  expect(el.textContent).toContain('0.28.12 is available');
  expect(el.textContent).toContain('bash -s -- --skip-gemini');
  expect(buttonNamed(el, 'Update now')).toBeDefined();
});

test.skipIf(!hasDom)('Pi: pi update --extensions, no Update now', () => {
  const el = render(info({ action: 'pi', command: 'pi update --extensions' }));
  expect(el.textContent).toContain('pi update --extensions');
  expect(el.textContent).not.toContain('pi install');
  expect(buttonNamed(el, 'Update now')).toBeUndefined();
});

test.skipIf(!hasDom)('up to date: no command, only the release notes link', () => {
  const el = render(null);
  expect(el.querySelector('code')).toBeNull();
  expect(el.textContent).toContain('Release notes');
});

test.skipIf(!hasDom)('checking for updates failing for hours: a quiet line with since and why, the command, no Update now', () => {
  const el = render(
    info({
      updateAvailable: false,
      latestVersion: '0.28.10',
      checkFailing: { since: '2026-10-26T09:14:00Z', error: "release page didn't answer as expected" },
      command: 'curl -fsSL https://plannotator.ai/install.sh | bash',
    }),
  );
  expect(el.querySelector('[data-menu-update-check-failing]')?.textContent).toContain("Can't check for updates since");
  expect(el.querySelector('[data-menu-update-check-failing]')?.textContent).toContain("release page didn't answer as expected");
  expect(el.querySelector('[data-menu-update-command] code')?.textContent).toBe('curl -fsSL https://plannotator.ai/install.sh | bash');
  expect(buttonNamed(el, 'Update now')).toBeUndefined();
  expect(el.textContent).not.toContain('is available');
});
