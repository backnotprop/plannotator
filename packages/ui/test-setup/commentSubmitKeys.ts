import { expect, test } from 'bun:test';
import { act } from 'react';
import { configStore } from '../config/configStore';

export interface MountedComposer {
  field: () => HTMLTextAreaElement;
  saves: () => number;
}

export async function setEnterSavesComment(on: boolean): Promise<void> {
  await act(async () => {
    configStore.set('enterSavesComment', on);
  });
}

export async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

export async function pressKey(
  el: HTMLElement,
  key: string,
  init: KeyboardEventInit & { keyCode?: number } = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await act(async () => {});
  return event;
}

export function describeCommentSubmitKeys(
  name: string,
  mount: (text: string) => Promise<MountedComposer>,
  options: { skip: boolean; text?: string },
): void {
  const text = options.text ?? 'needs a test';
  const run = (title: string, body: () => Promise<void>) =>
    test.skipIf(options.skip)(`${name}: ${title}`, async () => {
      try {
        await body();
      } finally {
        await setEnterSavesComment(false);
      }
    });

  run('off (the default): Enter is a new line, not a save', async () => {
    await setEnterSavesComment(false);
    const composer = await mount(text);
    const event = await pressKey(composer.field(), 'Enter');
    expect(composer.saves()).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  run('off: Cmd/Ctrl+Enter saves', async () => {
    await setEnterSavesComment(false);
    const composer = await mount(text);
    await pressKey(composer.field(), 'Enter', { ctrlKey: true });
    expect(composer.saves()).toBe(1);
  });

  run('on: Enter saves and adds no new line', async () => {
    await setEnterSavesComment(true);
    const composer = await mount(text);
    const event = await pressKey(composer.field(), 'Enter');
    expect(composer.saves()).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  run('on: Shift+Enter is a new line, not a save', async () => {
    await setEnterSavesComment(true);
    const composer = await mount(text);
    const event = await pressKey(composer.field(), 'Enter', { shiftKey: true });
    expect(composer.saves()).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  run('on: Cmd+Enter still saves', async () => {
    await setEnterSavesComment(true);
    const composer = await mount(text);
    await pressKey(composer.field(), 'Enter', { metaKey: true });
    expect(composer.saves()).toBe(1);
  });

  run('on: an Enter that commits an IME composition never saves', async () => {
    await setEnterSavesComment(true);
    const composer = await mount(text);
    await pressKey(composer.field(), 'Enter', { isComposing: true, keyCode: 229 });
    await pressKey(composer.field(), 'Enter', { isComposing: false, keyCode: 229 });
    expect(composer.saves()).toBe(0);
  });
}
