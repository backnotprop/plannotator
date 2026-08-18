import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PermissionModeSetup } from './PermissionModeSetup';

/**
 * The chooser is modal and has no dismiss control, so a card taller than the
 * viewport is a trap: on a short landscape phone its options and its Continue
 * button both sat off-screen with nothing scrollable. Pin the bounded shell.
 */

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

describe.if(hasDom)('PermissionModeSetup shell', () => {
  test('caps the card to the visible viewport and scrolls its options', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<PermissionModeSetup isOpen onComplete={() => {}} />);
    });

    const card = document.querySelector<HTMLElement>('.bg-card.max-w-lg');
    if (!card) throw new Error('permission mode card did not render');
    expect(card.style.maxHeight).toContain('--pn-viewport-height');
    expect(card.className).toContain('flex-col');

    const scroller = Array.from(card.children).find(
      (child) => child instanceof HTMLElement && child.className.includes('overflow-y-auto'),
    );
    expect(scroller).not.toBeUndefined();

    // The confirm control stays inside the card, below the scrolling region,
    // so it can never be pushed past the viewport edge.
    const confirm = Array.from(card.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Continue');
    expect(confirm).not.toBeUndefined();
  });
});
