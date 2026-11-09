/**
 * Settings → Display → Grid Background is a real choice. Clean is the default
 * and a stored Grid value counts only once the choice is resolved (see
 * `config/gridEnabledSetting.test.ts`), so the switch must record the choice:
 * otherwise turning Grid on in Settings would fall back to Clean on reload.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { configStore, ConfigStoreForTest } from '../config/configStore';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function installBackend(): Map<string, string> {
  const values = new Map<string, string>();
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

async function mountDisplayTab() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(
    <Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" externalOpen />,
  ));
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button'))
    .find((b) => b.textContent?.trim() === 'Display');
  if (!tab) throw new Error('Display tab did not render');
  await act(async () => tab.click());
}

function gridSwitch(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Grid Background"]');
  if (!button) throw new Error('Grid Background switch not found');
  return button;
}

let priorGrid: boolean | null = null;

describe.if(hasDom)('Settings → Grid Background', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    // Put the shared store back as it was, through the test's backend, before
    // the real backend returns.
    if (priorGrid !== null) configStore.set('gridEnabled', priorGrid);
    priorGrid = null;
    resetStorageBackend();
    document.body.replaceChildren();
  });

  test('turning Grid on survives a reload', async () => {
    priorGrid = configStore.get('gridEnabled');
    installBackend();
    configStore.set('gridEnabled', false);
    await mountDisplayTab();
    expect(gridSwitch().getAttribute('aria-checked')).toBe('false');

    await act(async () => gridSwitch().click());
    expect(gridSwitch().getAttribute('aria-checked')).toBe('true');

    // A reload resolves settings from storage again.
    expect(new ConfigStoreForTest().get('gridEnabled')).toBe(true);
  });
});
