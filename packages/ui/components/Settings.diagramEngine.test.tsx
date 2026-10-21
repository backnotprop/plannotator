import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const storage = new Map<string, string>();

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" externalOpen />);
  });
  const display = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Display');
  await act(async () => display?.click());
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  storage.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

test.skipIf(!hasDom)('renderer setting is accessible, reactive, and keeps Mermaid shadow Mermaid-only', async () => {
  setStorageBackend({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  });
  await mount();

  const group = document.querySelector('[role="group"][aria-label="Diagram renderer"]');
  const mermaid = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.trim() === 'Mermaid');
  const pele = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.includes('Pele'));
  expect(mermaid?.textContent?.trim()).toBe('Mermaid');
  expect(pele?.getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('[data-diagram-shadow-setting] button')?.hasAttribute('disabled')).toBe(false);

  await act(async () => pele?.click());
  expect(pele?.getAttribute('aria-pressed')).toBe('true');
  expect(storage.get('plannotator-diagram-engine')).toBe('pele');
  expect(document.querySelector('[data-diagram-shadow-setting]')?.textContent).toContain('Applies to Mermaid only');
  expect(document.querySelector<HTMLButtonElement>('[data-diagram-shadow-setting] button')?.disabled).toBe(true);

  await act(async () => mermaid?.click());
  expect(document.querySelector('[role="group"] button[aria-pressed="true"]')?.textContent?.trim()).toBe('Mermaid');
  expect(storage.get('plannotator-diagram-engine')).toBe('mermaid');
});
