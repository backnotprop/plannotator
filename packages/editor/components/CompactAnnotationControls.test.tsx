import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
const domClient = hasDom ? await import('react-dom/client') : null;
const act = hasDom ? (await import('react')).act : null;
const component = await import('./CompactAnnotationControls');
const CompactAnnotationControls = component.CompactAnnotationControls;

afterEach(() => {
  if (hasDom) document.body.innerHTML = '';
});

describe('CompactAnnotationControls', () => {
  test('keeps the idle compact surface to one current-method entry', () => {
    const html = renderToStaticMarkup(
      <CompactAnnotationControls inputMethod="pinpoint" onInputMethodChange={() => {}} />,
    );

    expect(html).toContain('data-pn-compact-annotate-entry="true"');
    expect(html).toContain('Annotate');
    expect(html).toContain('Pinpoint');
    expect(html).not.toContain('Select text</span>');
    expect(html).not.toContain('Comment');
    expect(html).not.toContain('Redline');
    expect(html).not.toContain('Label');
  });

  test.skipIf(!hasDom)('reveals only target acquisition choices and collapses after selection', async () => {
    const choices: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = domClient!.createRoot(host);

    await act!(async () => {
      root.render(
        <CompactAnnotationControls
          inputMethod="pinpoint"
          onInputMethodChange={(method) => choices.push(method)}
        />,
      );
    });
    await act!(async () => {
      host.querySelector<HTMLButtonElement>('[data-pn-compact-annotate-entry]')!.click();
    });

    expect(host.querySelector('[data-pn-compact-annotate-choices]')).not.toBeNull();
    const selectText = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Select text'))!;
    expect(selectText.getAttribute('data-pn-touch-target')).not.toBeNull();

    await act!(async () => selectText.click());
    expect(choices).toEqual(['drag']);
    expect(host.querySelector('[data-pn-compact-annotate-choices]')).toBeNull();
    await act!(async () => root.unmount());
  });
});
