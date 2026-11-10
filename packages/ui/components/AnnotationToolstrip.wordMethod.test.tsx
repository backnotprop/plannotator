/**
 * The Word input method in the toolstrip's switch: offered only when asked.
 * Failures to catch: Word showing for every host before the owner decides how
 * it is offered; and, when it is not offered but in use, the switch showing no
 * method as the one in use.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InputMethod } from '../types';
import { AnnotationToolstrip } from './AnnotationToolstrip';

const hasDom = typeof document !== 'undefined';
let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

const buttonFor = (label: string) =>
  Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) =>
    button.querySelector<HTMLSpanElement>('span:not([aria-hidden])')?.textContent === label,
  ) ?? null;

let current: InputMethod = 'drag';
function Strip({ start, offer }: { start: InputMethod; offer?: boolean }) {
  const [inputMethod, setInputMethod] = useState<InputMethod>(start);
  current = inputMethod;
  return (
    <AnnotationToolstrip
      inputMethod={inputMethod}
      onInputMethodChange={setInputMethod}
      mode="selection"
      onModeChange={() => {}}
      offerWordInputMethod={offer}
    />
  );
}

async function mount(start: InputMethod, offer?: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<Strip start={start} offer={offer} />); });
}

describe.if(hasDom)('AnnotationToolstrip Word input method', () => {
  test('not offered by default: Select and Pinpoint only', async () => {
    await mount('drag');
    expect(buttonFor('Word')).toBeNull();
    expect(buttonFor('Select')?.getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Pinpoint')).not.toBeNull();
  });

  test('offered: a third choice that turns it on, and Select turns it off', async () => {
    await mount('drag', true);
    await act(async () => buttonFor('Word')!.click());
    expect(current).toBe('word');
    expect(buttonFor('Word')?.getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Select')?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => buttonFor('Select')!.click());
    expect(current).toBe('drag');
  });

  test('in use but not offered: Select shows as the method in use', async () => {
    await mount('word');
    expect(buttonFor('Select')?.getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('Pinpoint')?.getAttribute('aria-pressed')).toBe('false');
  });
});
