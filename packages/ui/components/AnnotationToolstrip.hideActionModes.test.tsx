import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { AnnotationToolstrip } = (hasDom ? await import('./AnnotationToolstrip') : {}) as typeof import('./AnnotationToolstrip');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function render(props: Partial<React.ComponentProps<typeof AnnotationToolstrip>>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<AnnotationToolstrip inputMethod="pinpoint" onInputMethodChange={() => {}} mode="selection" onModeChange={() => {}} showHelpLink={false} {...props} />));
  return [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '').join(' ');
}

describe.if(hasDom)('AnnotationToolstrip', () => {
  test('by default it has Select, Pinpoint and the action modes', () => {
    const words = render({});
    expect(words).toContain('Select');
    expect(words).toContain('Pinpoint');
    expect(words).toContain('Comment');
  });

  test('hideActionModes leaves only Select and Pinpoint', () => {
    const words = render({ hideActionModes: true });
    expect(words).toContain('Select');
    expect(words).toContain('Pinpoint');
    expect(words).not.toContain('Comment');
    expect(words).not.toContain('Markup');
  });
});
