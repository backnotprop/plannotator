import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImageAnnotator } from './index';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('ImageAnnotator compact toolbar layout', () => {
  test('bounds the content-fit toolbar and keeps Save outside its horizontal scroller', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <ImageAnnotator
          imageSrc="data:image/png;base64,"
          isOpen
          onAccept={async () => {}}
          onClose={() => {}}
        />,
      );
    });

    const overlay = host.querySelector<HTMLElement>('[data-popover-layer]');
    const stage = host.querySelector<HTMLElement>('[data-pn-image-annotator-stage]');
    const toolbar = host.querySelector<HTMLElement>('[data-pn-image-annotator-toolbar]');
    const scroller = host.querySelector<HTMLElement>('[data-pn-image-toolbar-scroll]');
    const save = host.querySelector<HTMLButtonElement>('button[title="Save (Esc)"]');

    expect(overlay?.classList.contains('pn-visible-viewport-overlay')).toBe(true);
    expect(stage?.classList.contains('max-w-full')).toBe(true);
    expect(toolbar?.classList.contains('w-fit')).toBe(true);
    expect(toolbar?.classList.contains('max-w-full')).toBe(true);
    expect(scroller?.classList.contains('min-w-0')).toBe(true);
    expect(scroller?.classList.contains('overflow-x-auto')).toBe(true);
    expect(scroller?.contains(save ?? null)).toBe(false);

    for (const title of [
      'Pen (1)',
      'Arrow (2)',
      'Circle (3)',
      'Smaller stroke',
      'Larger stroke',
      'Undo (Cmd+Z)',
      'Redo (Cmd+Shift+Z)',
      'Clear all',
    ]) {
      const control = host.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
      expect(scroller?.contains(control ?? null)).toBe(true);
    }
  });
});
