/**
 * Settings → General → "Name the tab after the folder": the row shows only
 * where the host asks for it (`showFolderTabSetting`, a folder annotate
 * session in Plannotator), starts off, and its switch sets
 * `folderTabNamesFolder`. Failures to catch: the row showing in sessions it
 * does nothing in, starting on (the owner's default is the open file), or the
 * switch not reaching the setting.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../config';
import { Settings } from './Settings';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(showRow: boolean): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Settings
        taterMode={false}
        onTaterModeChange={() => {}}
        mode="annotate"
        externalOpen
        showFolderTabSetting={showRow}
      />,
    );
  });
}

function folderTabSwitch(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-folder-tab-setting] button[role="switch"]');
}

describe.if(hasDom)('Settings → General → Name the tab after the folder', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    configStore.set('folderTabNamesFolder', false);
    document.body.replaceChildren();
  });

  test('the row starts off, and its switch turns the setting on and off', async () => {
    configStore.set('folderTabNamesFolder', false);
    await mount(true);
    expect(document.querySelector('[data-folder-tab-setting]')?.textContent).toContain('Name the tab after the folder');
    expect(folderTabSwitch()?.getAttribute('aria-checked')).toBe('false');

    await act(async () => folderTabSwitch()?.click());
    expect(configStore.get('folderTabNamesFolder')).toBe(true);
    expect(folderTabSwitch()?.getAttribute('aria-checked')).toBe('true');

    await act(async () => folderTabSwitch()?.click());
    expect(configStore.get('folderTabNamesFolder')).toBe(false);
  });

  test('a host that does not ask for the row gets none', async () => {
    await mount(false);
    expect(document.querySelector('[data-folder-tab-setting]')).toBeNull();
  });
});
