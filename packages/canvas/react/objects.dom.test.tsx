/**
 * What an object looks like once the stylesheet has had its say, against a
 * real DOM (happy-dom): the colour rules that once lost to a later rule, the
 * HTML item that is kept when a view stops drawing it, and a mark that
 * takes its ink from the picture under it.
 *
 * happy-dom works out which declarations win; it does not resolve a custom
 * property to a colour, so what is compared is the declaration that won.
 *
 * Requires DOM: listed in tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HTML_ITEM_CSP, HTML_ITEM_SANDBOX } from '../model/html-item';
import type { CanvasObject, ImageObject, PlacedCanvasObject } from '../model/types';
import { HtmlItemFacesProvider, ObjectView } from './objects';
import { lookOfPixels, rememberLook } from './picture-look';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let sheet: HTMLStyleElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  sheet?.remove();
  host = sheet = null;
});

async function mount(node: React.ReactNode, theme: 'light' | 'dark' = 'dark'): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sheet = document.createElement('style');
  sheet.textContent = await Bun.file(path.join(import.meta.dir, '..', 'canvas.css')).text();
  document.head.append(sheet);
  host = document.createElement('div');
  host.className = 'pcv pcv-root';
  host.setAttribute('data-theme', theme);
  host.setAttribute('data-lod', 'full');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const view = (object: object, extra: object = {}) => <ObjectView object={object as PlacedCanvasObject} selected={false} editing={false} rich {...extra} />;
const note = (extra: object) => ({ id: 'n', type: 'note', x: 0, y: 0, w: 150, h: 120, text: 'A note', ...extra });
const box = (extra: object) => ({ id: 'b', type: 'box', x: 0, y: 0, w: 150, h: 60, text: 'A box', ...extra });

describe.skipIf(!hasDom)('colour rules that once lost to a later rule', () => {
  test('a note in a custom colour is that colour, with the ink chosen for it; a named one is still pale paper', async () => {
    const el = await mount(<>{view(note({ color: { custom: '#1d4ed8' } }))}{view(note({ id: 'v', color: 'violet' }))}{view(note({ id: 'y' }))}</>);
    const custom = getComputedStyle(el.querySelector('[data-id="n"]')!);
    // The colour itself, not paper tinted with it.
    expect(custom.backgroundColor).toBe('#1d4ed8');
    expect(custom.getPropertyValue('--pcv-solid')).toBe('#1d4ed8');
    // A named colour and the usual yellow are still paper (a gradient, which this DOM does not work out), never a flat fill.
    for (const id of ['v', 'y']) expect(getComputedStyle(el.querySelector(`[data-id="${id}"]`)!).backgroundColor).toBe('');
  });

  test('a plain box takes its fill and its dash from its style, like any shape', async () => {
    const orange = { custom: '#b45309' };
    const el = await mount(
      <>
        {view(box({ color: orange, style: { fill: 'solid' } }))}
        {view(box({ id: 'none', color: orange, style: { fill: 'none' } }))}
        {view(box({ id: 'dash', color: orange, style: { dash: true } }))}
        {view(box({ id: 'tint', color: orange }))}
      </>,
    );
    const style = (id: string) => getComputedStyle(el.querySelector(`[data-id="${id}"]`)!);
    // Solid: the colour itself. Without the style: a tint of it (a mix, which this DOM does not work out), never the colour.
    expect(style('b').backgroundColor).toBe('#b45309');
    expect(style('tint').backgroundColor).toBe('');
    expect(style('dash').backgroundColor).toBe('');
    expect(style('none').backgroundColor).toBe('none');
    expect(style('dash').borderStyle).toBe('dashed');
    expect(style('b').borderStyle).not.toBe('dashed');
  });
});

describe.skipIf(!hasDom)('an HTML item', () => {
  const item = { id: 'h', type: 'html', x: 0, y: 0, w: 320, h: 120, html: '<p style="font-family:Geist">212 mm</p>', alt: 'Width' };
  const faces = [{ family: 'Geist', src: `data:font/woff2;base64,${'A'.repeat(40)}` }];

  test('is drawn in the sealed frame, lent faces and all; when a view stops drawing it, the same frame is kept, hidden, and its words show', async () => {
    const render = (rich: boolean) => <HtmlItemFacesProvider faces={faces}>{view(item, { rich })}</HtmlItemFacesProvider>;
    const el = await mount(render(true));
    const frame = el.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe(HTML_ITEM_SANDBOX);
    expect(frame.hasAttribute('inert')).toBe(true);
    const srcdoc = frame.getAttribute('srcdoc')!;
    expect(srcdoc.indexOf(HTML_ITEM_CSP.replace(/"/g, '&quot;'))).toBeGreaterThan(0);
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('@font-face{font-family:"Geist"'));
    expect(srcdoc.indexOf('@font-face')).toBeLessThan(srcdoc.indexOf('<body>'));
    expect(el.querySelector('.pcv-missing')).toBeNull();
    // Zoomed out among many: words, and the frame that was drawn is still the same element, not a new one.
    act(() => root!.render(render(false)));
    expect(el.querySelector('.pcv-missing')!.textContent).toBe('Width');
    expect(el.querySelector('iframe')).toBe(frame);
    expect(el.querySelector('.pcv-html-frame')!.hasAttribute('hidden')).toBe(true);
    expect(getComputedStyle(el.querySelector('.pcv-html-frame')!).display).toBe('none');
    act(() => root!.render(render(true)));
    expect(el.querySelector('iframe')).toBe(frame);
    expect(el.querySelector('.pcv-html-frame')!.hasAttribute('hidden')).toBe(false);
    expect(el.querySelector('.pcv-missing')).toBeNull();
  });

  test('one that was never drawn loads nothing while it shows its words, and one with no words says what it is and how big', async () => {
    const el = await mount(<>{view(item, { rich: false })}{view({ ...item, id: 'bare', alt: undefined, w: 320.4, h: 119.6 }, { rich: false })}</>);
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.querySelector('[data-id="h"] .pcv-missing')!.textContent).toBe('Width');
    expect(el.querySelector('[data-id="bare"] .pcv-missing')!.textContent).toBe('Embedded content, 320 × 120');
  });
});

describe.skipIf(!hasDom)('a mark over a picture', () => {
  const picture = { id: 'p', type: 'image', x: 0, y: 0, w: 240, h: 240, src: 'objects-dom/pale.png', alt: 'Pale' } as ImageObject;
  const label = { id: 't', type: 'text', x: 20, y: 20, w: 100, h: 30, text: 'Label', color: { custom: '#ffd23f' } } as CanvasObject;
  const pale = lookOfPixels(new Array(24 * 24 * 4).fill(255), 1);

  test('has no ground until its picture has been looked at, then takes the picture\'s, and nothing on the board says so twice', async () => {
    const el = await mount(view(label, { over: picture, overSrc: 'objects-dom/pale.png' }), 'dark');
    const text = el.querySelector('[data-id="t"]')!;
    // Not looked at yet (still loading, or it cannot be read): the board's own rule for a custom colour holds.
    expect(text.getAttribute('data-ground')).toBe('picture');
    await act(async () => {
      rememberLook('objects-dom/pale.png', pale);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(text.getAttribute('data-ground')).toBe('light');
    // A picture that cannot be loaded at all, and a mark on the board.
    act(() => root!.render(<>{view(label, { over: picture, overSrc: null })}{view({ ...label, id: 'free' })}</>));
    expect(el.querySelector('[data-id="t"]')!.getAttribute('data-ground')).toBe('picture');
    expect(el.querySelector('[data-id="free"]')!.hasAttribute('data-ground')).toBe(false);
  });
});
