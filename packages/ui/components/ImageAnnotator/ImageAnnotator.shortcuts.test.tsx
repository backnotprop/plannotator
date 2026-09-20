import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImageAnnotator } from './index';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function selectedTool(title: string): boolean {
  const button = host?.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!button) throw new Error(`missing ${title} tool button`);
  return button.className.includes('bg-primary');
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  host?.remove();
  host = null;
});

describe('ImageAnnotator shortcut ownership', () => {
  test.skipIf(!hasDom)('keeps tool digits out of the attachment name input', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ImageAnnotator
          imageSrc="data:image/png;base64,"
          isOpen
          initialName="v"
          onAccept={async () => {}}
          onClose={() => {}}
        />,
      );
    });

    const input = host.querySelector<HTMLInputElement>('input[placeholder="Image name..."]');
    if (!input) throw new Error('image name input did not render');
    expect(selectedTool('Pen (1)')).toBe(true);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: '2',
        code: 'Digit2',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(selectedTool('Pen (1)')).toBe(true);
    expect(selectedTool('Arrow (2)')).toBe(false);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '2',
        code: 'Digit2',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(selectedTool('Pen (1)')).toBe(false);
    expect(selectedTool('Arrow (2)')).toBe(true);
  });
});
