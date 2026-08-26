import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PopoutDialog } from './PopoutDialog';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('PopoutDialog visible viewport shell', () => {
  test.skipIf(!hasDom)('centers editable popouts inside the observed viewport', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <PopoutDialog open onClose={() => {}} title="Code file">
          <textarea data-pn-mobile-editable defaultValue="draft" />
        </PopoutDialog>,
      );
    });

    const stage = document.querySelector<HTMLElement>('.pn-visible-viewport-overlay');
    const popup = document.querySelector<HTMLElement>('[data-popout="true"]');
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');

    expect(stage?.className).toContain('pointer-events-none');
    expect(popup?.className).toContain('pointer-events-auto');
    expect(popup?.className).toContain('var(--pn-viewport-height,100vh)');
    expect(close?.getAttribute('data-pn-touch-target')).toBe('true');
    expect(close?.getAttribute('data-pn-touch-target-icon')).toBe('true');
  });
});
