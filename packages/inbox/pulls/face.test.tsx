import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { Face } = (hasDom ? await import('./Face') : {}) as typeof import('./Face');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.append(host);
  // happy-dom cannot read a picture and says so the moment it is set: that is not the case under test.
  host.addEventListener('error', (event) => event.stopImmediatePropagation(), true);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
});

function LoadsAtOnce() {
  useLayoutEffect(() => {
    const img = host.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 96 });
    Object.defineProperty(img, 'naturalHeight', { value: 96 });
    img.dispatchEvent(new Event('load'));
  }, []);
  return null;
}

test.skipIf(!hasDom)('a picture that loads before the effects run stays shown (GitHub and a self-managed GitLab alike)', async () => {
  await act(async () => {
    root.render(
      <>
        <Face login="jun" host="gitlab.example.org" size={16} inline />
        <LoadsAtOnce />
      </>,
    );
  });
  const face = host.querySelector('[data-face="jun"]')!;
  expect(face.getAttribute('data-face-state')).toBe('shown');
  const src = new URL(face.querySelector('img')!.getAttribute('src')!, 'http://inbox.test');
  expect(src.pathname).toBe('/api/inbox/pulls/avatar');
  expect(src.searchParams.get('host')).toBe('gitlab.example.org');
  expect(face.querySelector('.ib-prd-pic')!.hasAttribute('data-initial')).toBe(false);
});
