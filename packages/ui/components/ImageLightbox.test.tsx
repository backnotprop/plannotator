/**
 * The image lightbox is keyboard-modal. The failures this guards: Escape
 * reaching the raw-HTML surface's Esc ladder (which would also drop the page
 * to Interact) instead of only closing the lightbox, and Mod+Enter submitting
 * a review decision behind an open lightbox. Both app-level handlers listen on
 * the window in the bubble phase, which is what the probe listener stands in
 * for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const lightboxModule = hasDom ? await import('./ImageLightbox') : null;

const cleanups: Array<() => void> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  document.body.replaceChildren();
});

async function mount(onClose: () => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const { ImageLightbox } = lightboxModule!;
  await act(async () => {
    root.render(<ImageLightbox src="/api/html-assets/t/x.png" alt="x.png" onClose={onClose} />);
  });
  cleanups.push(() => root.unmount());
  return host;
}

function behindTheLightbox() {
  const seen: string[] = [];
  const listener = (e: KeyboardEvent) => seen.push(e.key);
  window.addEventListener('keydown', listener);
  cleanups.push(() => window.removeEventListener('keydown', listener));
  return seen;
}

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe.if(hasDom)('ImageLightbox', () => {
  test('Escape closes it and never reaches the page behind', async () => {
    let closed = 0;
    await mount(() => { closed += 1; });
    const seen = behindTheLightbox();
    await act(async () => { press('Escape'); });
    expect(closed).toBe(1);
    expect(seen).toEqual([]);
  });

  test('Mod+Enter is swallowed so no decision submits behind it', async () => {
    await mount(() => {});
    const seen = behindTheLightbox();
    const meta = press('Enter', { metaKey: true });
    const ctrl = press('Enter', { ctrlKey: true });
    expect(seen).toEqual([]);
    expect(meta.defaultPrevented).toBe(true);
    expect(ctrl.defaultPrevented).toBe(true);
  });

  test('takes focus when it opens, so keys typed after an iframe click reach it', async () => {
    const host = await mount(() => {});
    expect(document.activeElement === host.querySelector('[data-image-lightbox]')).toBe(true);
  });

  test('once closed, keys reach the page again', async () => {
    await mount(() => {});
    await act(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); });
    const seen = behindTheLightbox();
    press('Escape');
    expect(seen).toEqual(['Escape']);
  });
});
