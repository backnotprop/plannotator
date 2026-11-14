/**
 * Tater mode's sprites draw only in a host that registered them (plan review, `utils/tater-sprites-eager`); a host
 * that never turns Tater mode on leaves the sprite sheets out of its bundle and its Viewer draws nothing there.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';

const hasDom = typeof document !== 'undefined';
const React = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const slots = (hasDom ? await import('./TaterSpriteSlots') : {}) as typeof import('./TaterSpriteSlots');

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await React.act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  slots.registerTaterSprites?.(null);
});

async function draw(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await React.act(async () => root!.render(node));
  return host;
}

test.skipIf(!hasDom)('with no sprites registered the slots draw nothing', async () => {
  const el = await draw(<><slots.TaterPullupSlot /><slots.TaterSittingSlot /></>);
  expect(el.innerHTML).toBe('');
});

test.skipIf(!hasDom)('the registered sprites draw in their slots', async () => {
  await import('../utils/tater-sprites-eager');
  const el = await draw(<><slots.TaterPullupSlot /><slots.TaterSittingSlot /></>);
  expect(el.innerHTML).toContain('tater-pullup');
  expect(el.innerHTML).toContain('tater-sit');
});
