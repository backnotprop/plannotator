/** DOM-gated (DOM_TESTS=1, tests/dom-test-list.txt). fetch is scripted and restored. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ForgeMarkdown } = (hasDom ? await import('./PullDescription') : {}) as typeof import('./PullDescription');

const SHOT = 'https://github.com/user-attachments/assets/1111-aaaa';
const CLIP = 'https://github.com/user-attachments/assets/2222-bbbb';
const FILE = 'https://github.com/user-attachments/assets/3333-cccc';
const ELSEWHERE = 'https://example.com/elsewhere.png';

const layer = {
  key: 'github.com/acme/widgets#42',
  platform: 'github',
  host: 'github.com',
  repo: 'acme/widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
} as InboxPull;

const BODY = [`![shot](${SHOT})`, `![elsewhere](${ELSEWHERE})`, CLIP, FILE].join('\n\n');

let host: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;
let asked: string[] = [];
beforeEach(() => {
  if (!hasDom) return;
  document.body.className = 'pn-inbox';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  asked = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url.includes('/pulls/media/sizes')) return Response.json({ sizes: { [SHOT]: { width: 1000, height: 500 } } });
    const named = new URL(url, 'http://inbox.test').searchParams.get('url');
    return named === CLIP
      ? new Response(new Uint8Array([0]), { status: 206, headers: { 'content-type': 'video/mp4' } })
      : new Response(new Uint8Array([0]), { status: 206, headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});
const viewer = () => document.querySelector('[data-pull-media-viewer]');

test.if(hasDom)('a GitHub upload loads through the Inbox (a failed one is the chip) and opens in the viewer; another host stays a chip', async () => {
  act(() => root.render(<ForgeMarkdown markdown={BODY} layer={layer} />));
  await settle();

  const shot = host.querySelector<HTMLImageElement>(`img[data-image-src="${SHOT}"]`)!;
  const src = new URL(shot.getAttribute('src')!, 'http://inbox.test');
  expect(src.pathname).toBe('/api/inbox/pulls/media');
  expect(src.searchParams.get('url')).toBe(SHOT);
  expect([shot.getAttribute('width'), shot.getAttribute('height')]).toEqual(['1000', '500']);
  expect(host.querySelector(`img[src="${ELSEWHERE}"]`)).toBeNull();
  expect(host.textContent).toContain('elsewhere');

  // happy-dom cannot load it.
  expect(shot.hidden).toBe(true);
  expect(host.querySelector('[title="Image could not be loaded"]')?.textContent).toBe('shot');
  expect(shot.hasAttribute('role')).toBe(false);

  await act(async () => {
    shot.removeAttribute('hidden');
    shot.removeAttribute('data-image-failed');
  });
  await settle();
  expect(shot.getAttribute('role')).toBe('button');
  expect(shot.tabIndex).toBe(0);
  act(() => {
    shot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(viewer()?.querySelector('img, [data-image-stage], .ib-imgstage')).not.toBeNull();
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(viewer()).toBeNull();
});

test.if(hasDom)("GitHub's pasted video plays in the viewer; a link the route does not answer as a video stays a link", async () => {
  act(() => root.render(<ForgeMarkdown markdown={BODY} layer={layer} />));
  await settle();

  const clip = host.querySelector<HTMLAnchorElement>(`a[href="${CLIP}"]`)!;
  const file = host.querySelector<HTMLAnchorElement>(`a[href="${FILE}"]`)!;
  expect(clip.getAttribute('data-pull-media')).toBe('video');
  expect(file.hasAttribute('data-pull-media')).toBe(false);

  const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  act(() => {
    clip.dispatchEvent(newTab);
  });
  expect(viewer()).toBeNull();

  act(() => clip.click());
  expect(viewer()?.querySelector('video')).not.toBeNull();
});

test.if(hasDom)('a GitLab MR asks nothing of the route: its pictures stay chips', async () => {
  const gitlab = { ...layer, key: 'gitlab.com/acme/widgets#42:pull', platform: 'gitlab', host: 'gitlab.com', url: 'https://gitlab.com/acme/widgets/-/merge_requests/42' } as InboxPull;
  act(() => root.render(<ForgeMarkdown markdown={BODY} layer={gitlab} />));
  await settle();
  expect(host.querySelector('img')).toBeNull();
  expect(asked).toEqual([]);
});
