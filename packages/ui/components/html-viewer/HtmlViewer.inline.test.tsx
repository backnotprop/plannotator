/**
 * HtmlViewer `inline` (DOM-gated): the page drawn in the host's own text,
 * with none of the viewer's chrome (the Plannotator Inbox's live html blocks,
 * commented in place).
 *
 * Guards: without the prop the viewer is drawn exactly as before (its card,
 * the bar with the global Comment button, the armed ring, a frame as tall as
 * the bridge reports); with it the card, the bar and the ring are gone, the
 * frame is as tall as the host says whatever the bridge reports, and it
 * carries the host's color-scheme on a transparent background (a page with a
 * transparent background would otherwise sit on an opaque backdrop).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { HtmlViewerInline } from './HtmlViewer';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

const PAGE = '<html><head><title>t</title></head><body><p id="target">Target</p></body></html>';

async function mount(inline?: HtmlViewerInline, fullViewport = false): Promise<HTMLElement> {
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <HtmlViewer
        rawHtml={PAGE}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        annotateModeActive
        onAnnotateModeExit={() => {}}
        inline={inline}
        fullViewport={fullViewport}
      />,
    );
  });
  return host;
}

const resize = (frame: HTMLIFrameElement, height: number) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'plannotator-bridge-resize', height } }));
  });
const globalComment = (host: HTMLElement) => host.querySelector('button[title="Add global comment"]');

describe.if(hasDom)('HtmlViewer inline', () => {
  test('absent: the card, the bar, the armed ring and the bridge-sized frame, as before', async () => {
    const host = await mount();
    const article = host.querySelector('article')!;
    expect(article.className).toBe('relative bg-card rounded-xl shadow-xl overflow-hidden w-full');
    expect(globalComment(host)).not.toBeNull();
    expect(host.querySelector('[data-annotate-armed-ring]')).not.toBeNull();
    const frame = host.querySelector('iframe')!;
    expect(frame.style.height).toBe('600px');
    expect(frame.style.colorScheme).toBe('auto');
    expect(frame.style.background).toBe('');
    await resize(frame, 321);
    expect(frame.style.height).toBe('321px');
  });

  test("present: no chrome of the viewer's own, and the frame is as tall as the host says", async () => {
    const host = await mount({ height: 240, colorScheme: 'dark' });
    const article = host.querySelector('article')!;
    expect(article.className).toBe('relative overflow-hidden w-full');
    expect(globalComment(host)).toBeNull();
    expect(host.querySelector('[data-annotate-armed-ring]')).toBeNull();
    const frame = host.querySelector('iframe')!;
    expect(frame.style.height).toBe('240px');
    expect(frame.style.colorScheme).toBe('dark');
    expect(frame.style.background).toBe('transparent');
    // The host measures the page itself: the bridge's own measure does not move the frame.
    await resize(frame, 999);
    expect(frame.style.height).toBe('240px');
    // Still the viewer's frame: sandboxed, with the document and its bridge.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
    expect(frame.getAttribute('srcdoc')).toContain('<p id="target">Target</p>');
  });

  test('with no color-scheme named the frame keeps auto, and full-viewport ignores the prop', async () => {
    const plain = await mount({ height: 100 });
    expect(plain.querySelector('iframe')!.style.colorScheme).toBe('auto');
    const full = await mount({ height: 100, colorScheme: 'dark' }, true);
    const frame = full.querySelector('iframe')!;
    expect(frame.style.height).toBe('100%');
    expect(frame.style.colorScheme).toBe('auto');
    expect(full.querySelector('article')!.className).toBe('relative overflow-hidden w-full flex-1');
  });
});
