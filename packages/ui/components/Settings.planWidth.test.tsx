/**
 * Settings → Display → Plan Width: still three choices; picking Wide saves
 * "wide" and tells the app, and the preview no longer claims the old 1280px
 * cap (Wide now fills the space between the panels). Compact keeps its px.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import type { UIPreferences } from '../utils/uiPreferences';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

async function mount(onChange: (prefs: UIPreferences) => void = () => {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(
    <Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" externalOpen onUIPreferencesChange={onChange} />,
  ));
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button'))
    .find((b) => b.textContent?.trim() === 'Display');
  if (!tab) throw new Error('Display tab did not render');
  await act(async () => tab.click());
}

function row(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-plan-width-setting]');
  if (!el) throw new Error('Plan Width row did not render');
  return el;
}

function choices(): HTMLButtonElement[] {
  return Array.from(row().querySelectorAll<HTMLButtonElement>('button'));
}

describe.if(hasDom)('Settings → Display → Plan Width', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    resetStorageBackend();
    document.body.replaceChildren();
  });

  test('three choices; Wide saves "wide" and the preview drops the old cap', async () => {
    const backend = memoryStorage();
    setStorageBackend(backend);
    const seen: UIPreferences[] = [];
    await mount((prefs) => seen.push(prefs));

    expect(choices()).toHaveLength(3);
    expect(row().textContent).toContain('832px');

    const wide = choices()[2];
    await act(async () => wide.click());
    expect(backend.getItem('plannotator-plan-width')).toBe('wide');
    expect(seen.at(-1)?.planWidth).toBe('wide');
    expect(row().textContent).not.toContain('1280px');
  });

  test('a saved Wide opens with Wide chosen', async () => {
    setStorageBackend(memoryStorage({ 'plannotator-plan-width': 'wide' }));
    await mount();
    expect(choices()[2].className).toContain('shadow-sm');
    expect(row().textContent).not.toContain('px —');
  });
});
