/**
 * Settings → Display → Source line numbers (#1650): off by default, the
 * switch writes the cookie-backed store, annotate offers the row too, and a
 * host that does not opt in never shows a row that would do nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { configStore } from '../config';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function AppHarness(props: { mode: 'plan' | 'annotate'; show: boolean }) {
  return (
    <Settings
      taterMode={false}
      onTaterModeChange={() => {}}
      mode={props.mode}
      annotateParity={props.mode === 'annotate'}
      showDocumentTextSize={props.show}
      externalOpen
    />
  );
}

async function mount(mode: 'plan' | 'annotate', show = true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<AppHarness mode={mode} show={show} />));
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button'))
    .find((b) => b.textContent?.trim() === 'Display');
  if (!tab) throw new Error('Display tab did not render');
  await act(async () => tab.click());
}

function row(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-document-source-line-numbers-setting]');
}

function toggle(): HTMLButtonElement {
  const button = row()?.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!button) throw new Error('Source line numbers switch did not render');
  return button;
}

describe.if(hasDom)('Settings → Display → Source line numbers', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    configStore.set('documentSourceLineNumbers', false);
    document.body.replaceChildren();
  });

  test('off by default; the switch turns it on', async () => {
    configStore.set('documentSourceLineNumbers', false);
    await mount('plan');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(row()?.textContent).toContain('plan');

    await act(async () => toggle().click());
    expect(configStore.get('documentSourceLineNumbers')).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  test('annotate offers the row too; a host that does not opt in shows none', async () => {
    await mount('annotate');
    expect(row()).not.toBeNull();
    expect(row()?.textContent).toContain('document');
    const mounted = root;
    await act(async () => mounted?.unmount());
    root = null;
    document.body.replaceChildren();
    await mount('plan', false);
    expect(row()).toBeNull();
  });
});
