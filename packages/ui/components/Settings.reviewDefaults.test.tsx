/**
 * Settings → Reviews › Files and defaults (the old Review tab, before that
 * Git): a Git and a Jujutsu default diff, each with its own saved value. Picking one must
 * never change the other (a jj user's choice would otherwise reopen their
 * Git reviews on a jj mode, or the reverse).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { configStore } from '../config';
import type { SettingValue } from '../config/configStore';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const saved = new Map<string, string>();
let restore: { defaultDiffType: SettingValue<'defaultDiffType'>; reviewDefaults: SettingValue<'reviewDefaults'> };

async function mountReviewSettings() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Settings taterMode={false} onTaterModeChange={() => {}} mode="review" externalOpen />);
  });
}

const sidebarTabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button')).map((b) => b.textContent?.trim() ?? '');

async function openTab(label: string) {
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button')).find((b) => b.textContent?.trim() === label);
  if (!tab) throw new Error(`Tab "${label}" did not render`);
  await act(async () => tab.click());
}

const section = (id: 'git' | 'jj') => document.querySelector<HTMLElement>(`section[aria-labelledby="settings-review-${id}"]`);
const diffSelect = (id: 'git' | 'jj') => section(id)?.querySelector<HTMLSelectElement>('select') ?? null;
const checkedLabel = (id: 'git' | 'jj') => {
  const select = diffSelect(id);
  return select ? Array.from(select.options).find((o) => o.value === select.value)?.textContent : undefined;
};
async function pick(id: 'git' | 'jj', label: string) {
  const select = diffSelect(id);
  const option = select && Array.from(select.options).find((o) => o.textContent === label);
  if (!select || !option) throw new Error(`No "${label}" choice in ${id}`);
  await act(async () => {
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// The Review tab's defaults now sit in Settings → Reviews › Files and defaults.
describe.if(hasDom)('Settings → Reviews: default diff per VCS', () => {
  beforeEach(() => {
    saved.clear();
    setStorageBackend({ getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => void saved.set(k, v), removeItem: (k) => void saved.delete(k) });
    restore = { defaultDiffType: configStore.get('defaultDiffType'), reviewDefaults: configStore.get('reviewDefaults') };
    configStore.set('defaultDiffType', 'since-base');
    configStore.set('reviewDefaults', {});
  });

  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    document.body.replaceChildren();
    configStore.set('defaultDiffType', restore.defaultDiffType);
    configStore.set('reviewDefaults', restore.reviewDefaults);
    resetStorageBackend();
  });

  test('Reviews holds a Git and a Jujutsu default, each with its own saved value', async () => {
    await mountReviewSettings();
    expect(sidebarTabs()).toContain('Reviews');
    expect(sidebarTabs()).not.toContain('Git');
    await openTab('Reviews');
    expect(section('git')).not.toBeNull();
    expect(section('jj')).not.toBeNull();
    // A jj user who never chose opens on Current change.
    expect(checkedLabel('jj')).toBe('Current change');
    expect(checkedLabel('git')).toBe('All Changes (Recommended)');
  });

  test('picking a Jujutsu default saves it apart from the Git default, and the reverse', async () => {
    await mountReviewSettings();
    await openTab('Reviews');

    await pick('jj', 'Line of work');
    expect(configStore.get('reviewDefaults').jj?.defaultDiffType).toBe('jj-line');
    expect(configStore.get('defaultDiffType')).toBe('since-base');
    expect(checkedLabel('jj')).toBe('Line of work');

    await pick('git', 'Uncommitted');
    expect(configStore.get('defaultDiffType')).toBe('uncommitted');
    expect(configStore.get('reviewDefaults').jj?.defaultDiffType).toBe('jj-line');
    expect(checkedLabel('jj')).toBe('Line of work');
  });
});
