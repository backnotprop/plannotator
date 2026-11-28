import { afterEach, expect, test } from 'bun:test';
import { mountAgentMark, showAgentFace, unmountAgentMark } from './motion';

const hasDom = typeof document !== 'undefined';
let el: HTMLElement | null = null;

afterEach(() => {
  if (el) unmountAgentMark(el);
  el?.remove();
  el = null;
});

test.skipIf(!hasDom)('the Inbox draws an own icon and a set icon through the shared motion engine, from its own addresses', () => {
  el = document.createElement('span');
  document.body.append(el);
  mountAgentMark(el, { rig: null, face: 'own:abc123', size: 24, seed: 'seed' });
  showAgentFace(el, 'own:abc123', false);
  const own = el.querySelector<HTMLImageElement>('img[data-own]');
  expect(own?.getAttribute('src')).toContain('/agent-icons/abc123');
  showAgentFace(el, 'set:tiny-creatures/zombie', false);
  const set = el.querySelector<HTMLImageElement>('img[data-set]');
  expect(set?.getAttribute('src')).toContain('tiny-creatures');
  expect(set?.getAttribute('src')).toContain('zombie');
});
