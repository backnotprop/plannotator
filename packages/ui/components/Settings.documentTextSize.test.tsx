import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { configStore } from '../config';
import { useDocumentTextSize } from '../hooks/useDocumentTextSize';
import {
  DEFAULT_DOCUMENT_TEXT_SIZE,
  DOCUMENT_TEXT_SCALE_PROPERTY,
  DOCUMENT_TEXT_SIZE_ATTRIBUTE,
} from '../utils/documentTextSize';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function AppHarness(props: { mode: 'plan' | 'annotate'; show: boolean }) {
  useDocumentTextSize();
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
  return document.querySelector<HTMLElement>('[data-document-text-size-setting]');
}

function step(size: number): HTMLButtonElement {
  const button = Array.from(row()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find((b) => b.textContent?.trim() === String(size));
  if (!button) throw new Error(`step ${size} not found`);
  return button;
}

describe.if(hasDom)('Settings → Display → Text size', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    configStore.set('documentTextSize', DEFAULT_DOCUMENT_TEXT_SIZE);
    document.body.replaceChildren();
  });

  test('at the default the page carries nothing; a step sets it, the default clears it', async () => {
    configStore.set('documentTextSize', DEFAULT_DOCUMENT_TEXT_SIZE);
    await mount('plan');
    const html = document.documentElement;
    expect(html.hasAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe(false);
    expect(step(DEFAULT_DOCUMENT_TEXT_SIZE).getAttribute('aria-pressed')).toBe('true');

    await act(async () => step(19).click());
    expect(configStore.get('documentTextSize')).toBe(19);
    expect(step(19).getAttribute('aria-pressed')).toBe('true');
    expect(html.getAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe('19');
    expect(Number(html.style.getPropertyValue(DOCUMENT_TEXT_SCALE_PROPERTY))).toBeCloseTo(19 / 15);

    await act(async () => step(DEFAULT_DOCUMENT_TEXT_SIZE).click());
    expect(html.hasAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe(false);
    expect(html.style.getPropertyValue(DOCUMENT_TEXT_SCALE_PROPERTY)).toBe('');
  });

  test('leaving the app puts the default back', async () => {
    configStore.set('documentTextSize', 21);
    await mount('plan');
    expect(document.documentElement.getAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe('21');
    const mounted = root;
    await act(async () => mounted?.unmount());
    root = null;
    expect(document.documentElement.hasAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe(false);
  });

  test('annotate offers the row too; a host that does not opt in shows none', async () => {
    await mount('annotate');
    expect(row()).not.toBeNull();
    const mounted = root;
    await act(async () => mounted?.unmount());
    root = null;
    document.body.replaceChildren();
    await mount('plan', false);
    expect(row()).toBeNull();
  });
});
