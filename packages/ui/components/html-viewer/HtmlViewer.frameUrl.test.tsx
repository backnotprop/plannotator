import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SERVED_FRAME_GONE } from '@plannotator/core/html-embed';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;
const bridgeModule = hasDom ? await import('./bridge-script') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

const PAGE = '<html><head><title>t</title></head><body><p id="target">Target</p></body></html>';

async function frameFor(frameUrl?: (document: string) => Promise<string | null>): Promise<HTMLIFrameElement> {
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
        frameUrl={frameUrl}
      />,
    );
  });
  return host.querySelector<HTMLIFrameElement>('iframe')!;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe.if(hasDom)('HtmlViewer frameUrl', () => {
  test('the host gets the srcdoc document and the frame loads its URL, sandboxed, with no srcdoc', async () => {
    const documents: string[] = [];
    const frame = await frameFor(async (document) => {
      documents.push(document);
      return 'about:blank#served';
    });
    await settle();
    expect(documents.length).toBe(1);
    expect(documents[0]).toContain('<p id="target">Target</p>');
    expect(documents[0]).toContain(bridgeModule!.BRIDGE_SCRIPT.slice(0, 200));
    expect(frame.getAttribute('src')).toBe('about:blank#served');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
  });

  test('no URL (or a failure): an empty frame, never a srcdoc', async () => {
    const none = await frameFor(async () => null);
    await settle();
    expect(none.hasAttribute('srcdoc')).toBe(false);
    expect(none.hasAttribute('src')).toBe(false);
    const failed = await frameFor(async () => {
      throw new Error('down');
    });
    await settle();
    expect(failed.hasAttribute('srcdoc')).toBe(false);
    expect(failed.hasAttribute('src')).toBe(false);
  });

  test('a page the host says is gone is asked for again, at most twice in a row', async () => {
    let asked = 0;
    const frame = await frameFor(async () => {
      asked += 1;
      return `about:blank#served-${asked}`;
    });
    await settle();
    expect(asked).toBe(1);
    const gone = async () => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: SERVED_FRAME_GONE }, source: frame.contentWindow }));
      });
      await settle();
    };
    await gone();
    expect(asked).toBe(2);
    expect(frame.getAttribute('src')).toBe('about:blank#served-2');
    await gone();
    await gone();
    expect(asked).toBe(3);
  });

  test("the page's own script cannot loop it: gone after every ready still asks at most twice", async () => {
    let asked = 0;
    const frame = await frameFor(async () => {
      asked += 1;
      return `about:blank#served-${asked}`;
    });
    await settle();
    expect(asked).toBe(1);
    const post = async (data: unknown) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
      });
      await settle();
    };
    const ready = { type: 'plannotator-bridge-ready', protocolVersion: bridgeModule!.BRIDGE_PROTOCOL_VERSION };
    await post({ type: SERVED_FRAME_GONE });
    await post(ready);
    await post({ type: SERVED_FRAME_GONE });
    await post(ready);
    await post({ type: SERVED_FRAME_GONE });
    // The first load plus two asks for "gone", never a third.
    expect(asked).toBe(3);
  });

  test('with no prop the frame is a srcdoc, as before', async () => {
    const frame = await frameFor();
    expect(frame.getAttribute('srcdoc')).toContain('<p id="target">Target</p>');
    expect(frame.hasAttribute('src')).toBe(false);
  });
});
