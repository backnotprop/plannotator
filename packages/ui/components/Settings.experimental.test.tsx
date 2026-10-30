/**
 * Settings → Experimental (the owner, 2026-10-27: "its own page on settings"):
 * the experimental settings sit in their own tab, the LAST one, never inside
 * another tab. Code review's "Edit Code to Suggest" lives there and still
 * toggles and persists under the same cookie; the Editor tab no longer holds
 * it; plan review and annotate (which never showed it) get no Experimental tab.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { configStore } from '../config';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';

const hasDom = typeof document !== 'undefined';
const COOKIE = 'plannotator-experimental-edit-suggestions';
let root: Root | null = null;
let host: HTMLElement | null = null;
/** What Settings saved, by key (the storage seam; the default backend is cookies). */
const saved = new Map<string, string>();

async function mountSettings(mode: 'plan' | 'annotate' | 'review') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Settings taterMode={false} onTaterModeChange={() => {}} mode={mode} annotateParity={mode === 'annotate'} externalOpen />);
  });
}

/** The desktop sidebar's tabs, in order. */
const sidebarTabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button')).map((b) => b.textContent?.trim() ?? '');
/** The phone's horizontal tab bar, in order. */
const phoneTabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('nav.md\\:hidden button')).map((b) => b.textContent?.trim() ?? '');

async function openTab(label: string) {
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button')).find((b) => b.textContent?.trim() === label);
  if (!tab) throw new Error(`Tab "${label}" did not render`);
  await act(async () => tab.click());
}

const editSwitch = () => document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Edit Code to Suggest"]');

describe.if(hasDom)('Settings → Experimental', () => {
  beforeEach(() => {
    saved.clear();
    setStorageBackend({ getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => void saved.set(k, v), removeItem: (k) => void saved.delete(k) });
  });

  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    document.body.replaceChildren();
    configStore.set('editSuggestions', false);
    resetStorageBackend();
  });

  test('code review: Experimental is the last tab on desktop and on a phone, and holds Edit Code to Suggest', async () => {
    await mountSettings('review');
    expect(sidebarTabs().at(-1)).toBe('Experimental');
    expect(sidebarTabs().filter((t) => t === 'Experimental')).toHaveLength(1);
    expect(phoneTabs().at(-1)).toBe('Experimental');
    await openTab('Experimental');
    expect(document.querySelector('[data-settings-experimental]')).not.toBeNull();
    expect(editSwitch()).not.toBeNull();
  });

  test('the switch still toggles and persists under the same cookie, both ways', async () => {
    await mountSettings('review');
    await openTab('Experimental');
    expect(editSwitch()!.getAttribute('aria-checked')).toBe('false');
    await act(async () => editSwitch()!.click());
    expect(editSwitch()!.getAttribute('aria-checked')).toBe('true');
    expect(saved.get(COOKIE)).toBe('true');
    expect(configStore.get('editSuggestions')).toBe(true);
    await act(async () => editSwitch()!.click());
    expect(saved.get(COOKIE)).toBe('false');
    expect(configStore.get('editSuggestions')).toBe(false);
  });

  test('the Editor tab no longer holds it', async () => {
    await mountSettings('review');
    await openTab('Editor');
    expect(document.body.textContent).toContain('Hover cards');
    expect(editSwitch()).toBeNull();
    expect(document.querySelector('[data-settings-experimental]')).toBeNull();
  });

  test('plan review and annotate, which never showed it, have no Experimental tab', async () => {
    for (const mode of ['plan', 'annotate'] as const) {
      await mountSettings(mode);
      expect(sidebarTabs()).not.toContain('Experimental');
      expect(phoneTabs()).not.toContain('Experimental');
      expect(editSwitch()).toBeNull();
      await act(async () => root?.unmount());
      root = null;
      host?.remove();
      document.body.replaceChildren();
    }
  });
});
