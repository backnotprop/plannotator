import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { configStore } from '../config';

const hasDom = typeof document !== 'undefined';
const SAVE_DEBOUNCE_MS = 400;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function openEditorTab(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Settings taterMode={false} onTaterModeChange={() => {}} mode="review" externalOpen />,
    );
  });
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Editor');
  if (!tab) throw new Error('review display tab did not render');
  await act(async () => tab.click());
}

function fontSelect(): HTMLSelectElement {
  const select = Array.from(document.querySelectorAll<HTMLSelectElement>('select'))
    .find((el) => Array.from(el.options).some((opt) => opt.textContent === 'Custom…'));
  if (!select) throw new Error('code font select not found');
  return select;
}

function customInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Custom code font name"]');
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  if (hasDom) configStore.set('diffFontFamily', '');
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    configStore.set('diffFontFamily', '');
    document.body.replaceChildren();
  }
});

describe.if(hasDom)('Code Font: Custom…', () => {
  test('a typed name is saved after the pause', async () => {
    await openEditorTab();
    expect(customInput()).toBeNull();

    await choose(fontSelect(), '__custom__');
    const input = customInput();
    expect(input).not.toBeNull();

    await type(input!, '  Iosevka Term  ');
    expect(configStore.get('diffFontFamily')).toBe('');
    await act(async () => wait(SAVE_DEBOUNCE_MS + 50));
    expect(configStore.get('diffFontFamily')).toBe('Iosevka Term');
  });

  test('a saved custom name opens with the field filled in', async () => {
    configStore.set('diffFontFamily', 'Berkeley Mono');
    await openEditorTab();
    expect(fontSelect().value).toBe('__custom__');
    expect(customInput()?.value).toBe('Berkeley Mono');
  });

  test('picking a built-in during the pause keeps the built-in', async () => {
    await openEditorTab();
    await choose(fontSelect(), '__custom__');
    await type(customInput()!, 'Iosevka');
    await choose(fontSelect(), 'JetBrains Mono');
    await act(async () => wait(SAVE_DEBOUNCE_MS + 50));
    expect(configStore.get('diffFontFamily')).toBe('JetBrains Mono');
    expect(customInput()).toBeNull();
  });

  test('closing Settings during the pause still saves the name', async () => {
    await openEditorTab();
    await choose(fontSelect(), '__custom__');
    await type(customInput()!, 'Iosevka');
    await act(async () => root?.unmount());
    root = null;
    expect(configStore.get('diffFontFamily')).toBe('Iosevka');
  });
});
