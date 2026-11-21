/**
 * Save to Notion acts with the server's NOTION_TOKEN, so Settings shows the
 * Notion tab only when the server offered it (`notion: true` on /api/plan,
 * which it sends only for a local session with the token).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { setNotionAvailable } from '../utils/notion';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function sidebarTabs(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button'))
    .map((b) => b.textContent?.trim() ?? '');
}

async function mountSettings() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" origin="claude-code" externalOpen />);
  });
}

describe('Settings Notion tab', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    setNotionAvailable(false);
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('is hidden when the server does not offer Notion (no token, remote, --tailscale)', async () => {
    await mountSettings();
    const tabs = sidebarTabs();
    expect(tabs).toContain('Octarine');
    expect(tabs).not.toContain('Notion');
  });

  test.skipIf(!hasDom)('shows when the server offers Notion', async () => {
    setNotionAvailable(true);
    await mountSettings();
    expect(sidebarTabs()).toContain('Notion');
  });
});
