/**
 * Settings → Display → Document font (#1657): picking a font reaches the page
 * the app is on (through `useDocumentFont`, which the plan / annotate app
 * mounts), Theme Default clears it, a typed name is saved after the pause, and
 * a host that does not opt in never shows a row that would do nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { configStore } from '../config';
import { useDocumentFont } from '../hooks/useDocumentFont';
import { DOCUMENT_FONT_ATTRIBUTE, DOCUMENT_FONT_PROPERTY } from '../utils/documentFont';

const hasDom = typeof document !== 'undefined';
const SAVE_DEBOUNCE_MS = 400;
let root: Root | null = null;
let host: HTMLElement | null = null;

function AppHarness(props: { mode: 'plan' | 'annotate'; show: boolean }) {
  useDocumentFont();
  return (
    <Settings
      taterMode={false}
      onTaterModeChange={() => {}}
      mode={props.mode}
      annotateParity={props.mode === 'annotate'}
      showDocumentFont={props.show}
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
  return document.querySelector<HTMLElement>('[data-document-font-setting]');
}

async function choose(value: string) {
  const select = row()?.querySelector('select');
  if (!select) throw new Error('document font select not found');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.if(hasDom)('Settings → Display → Document font', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    configStore.set('documentFontFamily', '');
    document.body.replaceChildren();
  });

  test('at the default the page carries nothing; a font sets it, Theme Default clears it', async () => {
    configStore.set('documentFontFamily', '');
    await mount('plan');
    const html = document.documentElement;
    expect(html.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(false);

    await choose('serif');
    expect(configStore.get('documentFontFamily')).toBe('serif');
    expect(html.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(true);
    expect(html.style.getPropertyValue(DOCUMENT_FONT_PROPERTY)).toContain('serif');

    await choose('');
    expect(html.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(false);
    expect(html.style.getPropertyValue(DOCUMENT_FONT_PROPERTY)).toBe('');
  });

  test('a typed name is saved after the pause and reaches the page; the code font is untouched', async () => {
    await mount('annotate');
    const codeFontBefore = configStore.get('diffFontFamily');
    await choose('__custom__');
    const input = row()?.querySelector<HTMLInputElement>('input[aria-label="Custom document font name"]');
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' Iowan Old Style ');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => wait(SAVE_DEBOUNCE_MS + 50));
    expect(configStore.get('documentFontFamily')).toBe('Iowan Old Style');
    expect(document.documentElement.style.getPropertyValue(DOCUMENT_FONT_PROPERTY)).toContain('"Iowan Old Style"');
    expect(configStore.get('diffFontFamily')).toBe(codeFontBefore);
  });

  test('leaving the app puts the theme font back', async () => {
    configStore.set('documentFontFamily', 'serif');
    await mount('plan');
    expect(document.documentElement.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(true);
    const mounted = root;
    await act(async () => mounted?.unmount());
    root = null;
    expect(document.documentElement.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(false);
  });

  // Settings → Reviews draws the same font field in its own controls; plan
  // review and annotate keep this row's look. These are the row's classes from
  // before Settings → Reviews existed.
  test("the row keeps Settings → Display's own look, not Settings → Reviews' controls", async () => {
    const classes = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).sort();
    const expected = (s: string) => s.split(/\s+/).filter(Boolean).sort();
    configStore.set('documentFontFamily', 'serif');
    await mount('plan');
    await choose('__custom__');
    const select = row()!.querySelector('select');
    const input = row()!.querySelector('input[aria-label="Custom document font name"]');
    const status = row()!.querySelector('[aria-live="polite"]');
    const preview = Array.from(row()!.querySelectorAll('div')).find((d) => d.textContent === 'Preview: The quick brown fox jumps over the lazy dog.');

    expect(classes(select)).toEqual(expected('w-full px-3 py-1.5 text-sm rounded-md bg-muted/50 border border-border text-foreground'));
    expect(input?.getAttribute('type')).toBe('text');
    expect(classes(input)).toEqual(expected('w-full px-3 py-1.5 text-sm rounded-md bg-muted/50 border border-border text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring'));
    expect(classes(status)).toEqual(['text-[11px]']);
    expect(status?.children.length).toBe(1);
    expect(status?.firstElementChild?.tagName).toBe('SPAN');
    expect(classes(status?.firstElementChild)).toEqual(['text-muted-foreground']);
    expect(classes(preview)).toEqual(expected('text-xs text-muted-foreground px-1 py-1 rounded bg-muted/30'));
  });

  test('a host that does not opt in shows no row', async () => {
    await mount('plan', false);
    expect(row()).toBeNull();
  });
});
