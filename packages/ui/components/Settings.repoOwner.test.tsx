/**
 * Settings → General → "Hide the repository owner": the switch reaches the
 * repository chip beside the document while both are on the page, the chip's
 * hover keeps the full owner/repo either way, and a host that passes
 * `hideRepoOwnerSetting` shows no row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../config';
import { DocBadges } from './DocBadges';
import { Settings } from './Settings';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const repoInfo = { display: 'acme/payments-service', branch: 'main' };

async function mount(hideRow = false): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <>
        <DocBadges layout="header" repoInfo={repoInfo} />
        <Settings
          taterMode={false}
          onTaterModeChange={() => {}}
          mode="annotate"
          externalOpen
          hideRepoOwnerSetting={hideRow}
        />
      </>,
    );
  });
}

function repoChip(): HTMLElement {
  const chip = host?.querySelector<HTMLElement>(`span[title="${repoInfo.display}"]`);
  if (!chip) throw new Error('repository chip did not render');
  return chip;
}

function ownerSwitch(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-repo-owner-setting] button[role="switch"]');
}

describe.if(hasDom)('Settings → General → Hide the repository owner', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    configStore.set('hideRepoOwner', false);
    document.body.replaceChildren();
  });

  test('the switch takes the owner off the chip and puts it back; hover keeps owner/repo', async () => {
    configStore.set('hideRepoOwner', false);
    await mount();
    expect(repoChip().textContent).toBe('acme/payments-service');
    expect(ownerSwitch()?.getAttribute('aria-checked')).toBe('false');

    await act(async () => ownerSwitch()?.click());
    expect(configStore.get('hideRepoOwner')).toBe(true);
    expect(repoChip().textContent).toBe('payments-service');
    expect(repoChip().getAttribute('title')).toBe('acme/payments-service');

    await act(async () => ownerSwitch()?.click());
    expect(repoChip().textContent).toBe('acme/payments-service');
  });

  test('a host that passes hideRepoOwnerSetting gets no row', async () => {
    await mount(true);
    expect(ownerSwitch()).toBeNull();
  });
});
