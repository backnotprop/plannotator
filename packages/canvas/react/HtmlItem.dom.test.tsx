/**
 * The custom HTML item against a real DOM (happy-dom): what is actually
 * mounted for one, not the constants it is built from. The contract is in
 * `model/html-item.ts`; this fails when the element on the page stops
 * keeping it (a sandbox token added, `inert` dropped, the policy moved
 * behind the item's own markup, the markup drawn into the page itself).
 *
 * happy-dom lays nothing out, so the view is given a size here: nothing is
 * mounted in a view with no width.
 *
 * Requires DOM: listed in tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanvasStore } from '../events/store';
import { createDocument } from '../model/document';
import { CameraController } from '../view/camera';
import { CanvasView } from './CanvasView';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const saved: Record<string, PropertyDescriptor | undefined> = {};

beforeAll(() => {
  if (!hasDom) return;
  for (const [name, value] of [['clientWidth', 800], ['clientHeight', 600]] as const) {
    saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
});

afterAll(() => {
  if (!hasDom) return;
  for (const name of Object.keys(saved)) {
    if (saved[name]) Object.defineProperty(HTMLElement.prototype, name, saved[name]!);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

/** What an item's author would write to get out, if anything could. */
const HOSTILE =
  '<b id="pcv-leak">shown</b><script id="pcv-script">parent.document.title = "owned"</script>' +
  '</body></html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *; script-src \'unsafe-inline\'"></head><body>' +
  '<img src="https://tracker.example.test/p.gif"><a href="https://evil.example.test/" target="_top">open</a>' +
  '<iframe src="https://evil.example.test/"></iframe><form action="https://evil.example.test/"><input name="q"></form>' +
  '" sandbox="allow-scripts allow-same-origin';

async function mount(html: string): Promise<HTMLElement> {
  const store = new CanvasStore(createDocument('board', 'Board'));
  const added = store.dispatch({ type: 'add', objects: [{ id: 'item', type: 'html', x: 40, y: 40, w: 320, h: 120, html, alt: 'A table of results' }] }, { actor: { kind: 'agent', id: 'a' } });
  if (!added.ok) throw new Error(added.error);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<CanvasView store={store} camera={new CameraController()} />);
  });
  return host;
}

describe('a custom HTML item on the page', () => {
  test.skipIf(!hasDom)('is one frame with an empty sandbox, inert, out of the Tab order, sending no referrer', async () => {
    const page = await mount(HOSTILE);
    const frames = page.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    // Present and empty: every restriction on, no token that lifts one.
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    // Its content is the document handed to it, never an address, and it is granted nothing.
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.hasAttribute('allow')).toBe(false);
    expect(frame.hasAttribute('allowfullscreen')).toBe(false);
    expect(frame.getAttribute('srcdoc')).toBeTruthy();
    // What it shows is said in words on the frame, since nothing inside it is read out.
    expect(frame.getAttribute('title')).toBe('A table of results');
  });

  test.skipIf(!hasDom)("carries its policy ahead of anything the item says, and the item's own policy cannot widen it", async () => {
    const page = await mount(HOSTILE);
    const srcdoc = page.querySelector('iframe')!.getAttribute('srcdoc')!;
    // As text, the way a browser's parser meets it: the policy comes before the first byte of the item.
    const policyAt = srcdoc.indexOf('http-equiv="Content-Security-Policy"');
    const itemAt = srcdoc.indexOf('pcv-leak');
    expect(policyAt).toBeGreaterThan(0);
    expect(policyAt).toBeLessThan(itemAt);
    expect(srcdoc.slice(0, policyAt)).toBe('<!doctype html><html><head><meta ');
    const first = new DOMParser().parseFromString(srcdoc, 'text/html').querySelector('meta[http-equiv="Content-Security-Policy"]')!;
    const policy = Object.fromEntries(
      first
        .getAttribute('content')!
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values.join(' ')]),
    );
    // Nothing loads and nothing runs unless named; script, connections, frames and objects are not named.
    expect(policy['default-src']).toBe("'none'");
    for (const open of ['script-src', 'script-src-elem', 'script-src-attr', 'connect-src', 'frame-src', 'child-src', 'object-src', 'media-src', 'worker-src']) expect(policy[open]).toBeUndefined();
    expect(policy['img-src']).toBe('data:');
    expect(policy['font-src']).toBe('data:');
    expect(policy['style-src']).toBe("'unsafe-inline'");
    expect(policy['base-uri']).toBe("'none'");
    expect(policy['form-action']).toBe("'none'");
  });

  test.skipIf(!hasDom)('never puts any of the item into the page itself', async () => {
    const page = await mount(HOSTILE);
    // The item exists only as text inside the frame's `srcdoc`.
    expect(page.querySelector('#pcv-leak')).toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('form')).toBeNull();
    expect(page.querySelector('a[href*="evil.example.test"]')).toBeNull();
    expect(page.querySelector('img[src*="tracker.example.test"]')).toBeNull();
    expect(page.querySelectorAll('iframe')).toHaveLength(1);
    expect(document.title).not.toBe('owned');
    // The words of the attack did not become attributes of the frame.
    expect(page.querySelector('iframe')!.getAttribute('sandbox')).toBe('');
  });
});
