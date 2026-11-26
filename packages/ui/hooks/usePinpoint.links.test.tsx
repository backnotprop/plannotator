/**
 * Pinpoint input mode over links in the markdown Viewer.
 *
 * Same rule as the HTML viewer (owner's ruling `html-link-click`): a plain
 * click on a followable link follows it through the link's own handler (the
 * path Select mode takes), Cmd/Ctrl-click pins it, and a link that goes
 * nowhere (`#`, `""`, no href) pins on a plain click as before.
 *
 * What regresses if this fails: a plain click on a link in Pinpoint pins it
 * instead of opening it (the old `preventDefault` on every link), so a
 * reviewer cannot open the documents the plan links to without switching to
 * Select; or a Cmd-click pins the link AND opens the linked document; or a
 * followable link shows a pin outline a click would not make.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseMarkdownToBlocks } from '../utils/parser';
import { BlockRenderer } from '../components/BlockRenderer';

const hasDom = typeof document !== 'undefined';
const mod = hasDom ? await import('./usePinpoint') : null;
const usePinpoint = mod?.usePinpoint as typeof import('./usePinpoint')['usePinpoint'];
const linkMod = hasDom ? await import('../utils/followableLink') : null;

const DOC = `See [External](https://example.com/page) and [Other](./other.md) and [Notes](#notes) and [**Bold**](./bold.md) and [Save](#) here.
`;

let pinned: string[] = [];
let linkedDocs: string[] = [];
let anchors: string[] = [];

function Harness() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blocks = parseMarkdownToBlocks(DOC);
  usePinpoint({
    containerRef,
    inputMethod: 'pinpoint',
    enabled: true,
    onSelectRange: (range) => { pinned.push(range.toString()); },
    onCodeBlockClick: () => {},
  });
  return (
    <div ref={containerRef}>
      {blocks.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          onOpenLinkedDoc={(path) => { linkedDocs.push(path); }}
          onNavigateAnchor={(hash) => { anchors.push(hash); }}
        />
      ))}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  pinned = [];
  linkedDocs = [];
  anchors = [];
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
  return host;
}

const linkNamed = (el: HTMLElement, label: string) =>
  Array.from(el.querySelectorAll<HTMLAnchorElement>('a')).find((a) => a.textContent?.includes(label))!;

async function click(node: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, ...init });
  // Keep an external link's default from opening a window under happy-dom;
  // the test reads whether the pinpoint handler prevented it first.
  let preventedBeforeDefault: boolean | null = null;
  const watch = (e: Event) => { preventedBeforeDefault = e.defaultPrevented; e.preventDefault(); };
  window.addEventListener('click', watch);
  await act(async () => { node.dispatchEvent(event); });
  window.removeEventListener('click', watch);
  return { event, preventedBeforeDefault };
}

async function move(node: Element, init: MouseEventInit = {}) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, ...init }));
  });
}

describe('usePinpoint link navigation', () => {
  test.skipIf(!hasDom)('armed pinpoint: a plain click on an external link follows it and does not pin', async () => {
    const el = await mount();
    const { preventedBeforeDefault } = await click(linkNamed(el, 'External'));
    expect(preventedBeforeDefault).toBe(false);
    expect(pinned).toEqual([]);
  });

  test.skipIf(!hasDom)('armed pinpoint: a plain click on a .md link opens it as a linked document', async () => {
    const el = await mount();
    await click(linkNamed(el, 'Other'));
    expect(linkedDocs).toEqual(['./other.md']);
    expect(pinned).toEqual([]);
  });

  test.skipIf(!hasDom)('armed pinpoint: a plain click on an in-page anchor navigates to it', async () => {
    const el = await mount();
    await click(linkNamed(el, 'Notes'));
    expect(anchors).toEqual(['#notes']);
    expect(pinned).toEqual([]);
  });

  test.skipIf(!hasDom)('armed pinpoint: a plain click on a child of a link follows the link', async () => {
    const el = await mount();
    const link = linkNamed(el, 'Bold');
    const child = link.querySelector('strong')!;
    expect(child).not.toBeNull();
    await click(child);
    expect(linkedDocs).toEqual(['./bold.md']);
    expect(pinned).toEqual([]);
  });

  for (const modifier of ['metaKey', 'ctrlKey'] as const) {
    test.skipIf(!hasDom)(`armed pinpoint: ${modifier} click pins the link only and does not follow it`, async () => {
      const el = await mount();
      const { event } = await click(linkNamed(el, 'Other'), { [modifier]: true });
      expect(event.defaultPrevented).toBe(true);
      expect(pinned).toEqual(['Other']);
      expect(linkedDocs).toEqual([]);
    });
  }

  test.skipIf(!hasDom)('armed pinpoint: a link that goes nowhere (href="#") pins on a plain click, as before', async () => {
    const el = await mount();
    const { event } = await click(linkNamed(el, 'Save'));
    expect(event.defaultPrevented).toBe(true);
    expect(pinned).toEqual(['Save']);
    expect(anchors).toEqual([]);
  });

  for (const [label, attrs] of [['href=""', { href: '' }], ['no href', {}]] as const) {
    test.skipIf(!hasDom)(`armed pinpoint: a link that goes nowhere (${label}) pins on a plain click, as before`, async () => {
      const el = await mount();
      const paragraph = el.querySelector('p')!;
      const link = document.createElement('a');
      for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
      link.textContent = 'Nowhere';
      paragraph.appendChild(link);
      const { event } = await click(link);
      expect(event.defaultPrevented).toBe(true);
      expect(pinned).toEqual(['Nowhere']);
    });
  }

  test.skipIf(!hasDom)('armed pinpoint: a followable link shows no hover until Cmd/Ctrl is held', async () => {
    const el = await mount();
    const link = linkNamed(el, 'Other');
    await move(link);
    expect(el.querySelector('[data-pinpoint-hover]')).toBeNull();
    await move(link, { ctrlKey: true });
    expect(link.hasAttribute('data-pinpoint-hover')).toBe(true);
  });

  test.skipIf(!hasDom)('armed pinpoint: pressing Control over a followable link shows its hover, releasing hides it', async () => {
    const el = await mount();
    const link = linkNamed(el, 'Other');
    await move(link);
    expect(el.querySelector('[data-pinpoint-hover]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    });
    expect(link.hasAttribute('data-pinpoint-hover')).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));
    });
    expect(el.querySelector('[data-pinpoint-hover]')).toBeNull();
  });

  test.skipIf(!hasDom)('armed pinpoint: the click that ends a drag over a link neither follows nor pins', async () => {
    const el = await mount();
    const link = linkNamed(el, 'Other');
    const range = document.createRange();
    range.selectNodeContents(el.querySelector('p')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const { event } = await click(link);
    expect(event.defaultPrevented).toBe(true);
    expect(linkedDocs).toEqual([]);
    expect(pinned).toEqual([]);
  });
});

describe('followableLinkOf', () => {
  test.skipIf(!hasDom)('returns the link around a node when it has a real destination', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<a id="go" href="./a.md"><strong>A</strong></a><a id="no" href="#">B</a><svg><a id="svg" xlink:href="#x"><text>C</text></a></svg>';
    const strong = wrap.querySelector('strong')!;
    expect(linkMod!.followableLinkOf(strong.firstChild)).toBe(wrap.querySelector('#go'));
    expect(linkMod!.followableLinkOf(wrap.querySelector('#no'))).toBeNull();
    expect(linkMod!.followableLinkOf(wrap.querySelector('text'))).toBe(wrap.querySelector('#svg'));
    expect(linkMod!.followableLinkOf(wrap)).toBeNull();
  });
});
