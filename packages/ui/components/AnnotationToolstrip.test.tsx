import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorMode, InputMethod } from '../types';
import { AnnotationToolstrip } from './AnnotationToolstrip';

const hasDom = typeof document !== 'undefined';
const remainingLabels = ['Select', 'Pinpoint', 'Markup', 'Comment', 'Redline'] as const;

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

function buttonFor(label: string): HTMLButtonElement | null {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) =>
    button.querySelector<HTMLSpanElement>('span:not([aria-hidden])')?.textContent === label,
  ) ?? null;
}

function ControlledToolstrip({ hideQuickLabel = false }: { hideQuickLabel?: boolean }) {
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');

  return (
    <AnnotationToolstrip
      inputMethod={inputMethod}
      onInputMethodChange={setInputMethod}
      mode={mode}
      onModeChange={setMode}
      hideQuickLabel={hideQuickLabel}
    />
  );
}

async function mount(hideQuickLabel?: boolean): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => {
    root?.render(<ControlledToolstrip hideQuickLabel={hideQuickLabel} />);
  });
}

async function press(label: string): Promise<void> {
  const button = buttonFor(label);
  if (!button) throw new Error(`Expected ${label} button to render`);
  await act(async () => button.click());
  expect(buttonFor(label)?.getAttribute('aria-pressed')).toBe('true');
}

describe.if(hasDom)('AnnotationToolstrip Quick Label seam', () => {
  test('includes Label by default', async () => {
    await mount();

    expect(buttonFor('Label')).not.toBeNull();
    for (const label of remainingLabels) expect(buttonFor(label)).not.toBeNull();
  });

  test('omits only Label while every remaining control stays operative', async () => {
    await mount(true);

    expect(buttonFor('Label')).toBeNull();
    for (const label of remainingLabels) expect(buttonFor(label)).not.toBeNull();

    await press('Pinpoint');
    expect(buttonFor('Select')?.getAttribute('aria-pressed')).toBe('false');
    await press('Select');
    expect(buttonFor('Pinpoint')?.getAttribute('aria-pressed')).toBe('false');

    await press('Comment');
    expect(buttonFor('Markup')?.getAttribute('aria-pressed')).toBe('false');
    await press('Redline');
    expect(buttonFor('Comment')?.getAttribute('aria-pressed')).toBe('false');
    await press('Markup');
    expect(buttonFor('Redline')?.getAttribute('aria-pressed')).toBe('false');
  });
});
