/**
 * HtmlViewer `frameScale` and `onContentWidth` (DOM-gated).
 *
 * A host can show the page scaled (the Inbox on a phone, "Desktop size": the
 * page laid out at 1280 px and scaled down to the phone's width). The bridge
 * measures in the page's own pixels, so everything the parent places from a
 * bridge measure has to go through the scale, and every parent distance sent
 * to the bridge has to come back out of it, or a comment lands away from what
 * was tapped.
 *
 * Guards: with a scale, a pin's composer anchor sits on the pinned element as
 * it is drawn on screen (and follows it when the page scrolls); `revealPin`'s
 * `clearBottom` reaches the bridge in page pixels; with no scale (every other
 * host) the numbers are exactly as before. `onContentWidth` gets the bridge's
 * report, also on a read-only page, and a forged or out-of-range report never
 * reaches it. `onPageTap` gets where a tap landed on screen (through the
 * scale) and `onPageScrollUp` a scroll back up, on a read-only page too; a
 * forged tap does not reach it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { createRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ViewerHandle } from '../Viewer';

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

/** Where the frame sits on screen (happy-dom lays nothing out). */
const FRAME = { left: 10, top: 50 };

async function mount(
  props: {
    frameScale?: number;
    readOnly?: boolean;
    onContentWidth?: (r: { width: number; viewport: number }) => void;
    onPageTap?: (clientY: number) => void;
    onPageScrollUp?: () => void;
  } = {},
) {
  if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
  const HtmlViewer = htmlViewerModule.HtmlViewer;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const ref = createRef<ViewerHandle>();
  await act(async () => {
    root.render(
      <HtmlViewer
        ref={ref}
        rawHtml="<html><body><p>Pinpoint target</p></body></html>"
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        {...props}
      />,
    );
  });
  const iframe = host.querySelector<HTMLIFrameElement>('iframe');
  if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
  iframe.getBoundingClientRect = () =>
    ({ x: FRAME.left, y: FRAME.top, left: FRAME.left, top: FRAME.top, right: FRAME.left + 390, bottom: FRAME.top + 700, width: 390, height: 700, toJSON: () => ({}) }) as DOMRect;
  const post = async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
    });
  };
  const sent: Record<string, unknown>[] = [];
  const win = iframe.contentWindow as Window;
  win.postMessage = ((msg: Record<string, unknown>) => {
    sent.push(msg);
  }) as typeof win.postMessage;
  return { ref, post, sent };
}

/** The fixed 1 px anchor the composer is placed on (useHtmlAnnotation's positionAnchor). */
function anchor(): { top: number; left: number } {
  const found = Array.from(document.body.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.style.position === 'fixed' && el.style.width === '1px',
  );
  expect(found.length).toBe(1);
  return { top: parseFloat(found[0]!.style.top), left: parseFloat(found[0]!.style.left) };
}

/** A pin on an element the bridge measured at (200, 100), 40 × 20 page pixels. */
const pin = {
  type: 'plannotator-bridge-selection',
  text: 'Pinpoint target',
  pinpoint: true,
  rect: { top: 100, left: 200, width: 40, height: 20 },
  anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Pinpoint target' },
};

describe.if(hasDom)('a scaled frame', () => {
  test('a pin on a page scaled to 0.5 puts its composer on the element as it is drawn, and follows a scroll', async () => {
    const { post } = await mount({ frameScale: 0.5 });
    await post(pin);
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
    // Top edge 100 page px down, at half size: 50 px under the frame's top. Centre of 200..240 → 220 → 110 px in.
    expect(anchor()).toEqual({ top: FRAME.top + 50, left: FRAME.left + 110 });

    await post({ type: 'plannotator-bridge-selection-rect', rect: { top: 40, left: 200, width: 40, height: 20 } });
    expect(anchor()).toEqual({ top: FRAME.top + 20, left: FRAME.left + 110 });
  });

  test('with no scale the anchor is where it always was', async () => {
    const { post } = await mount();
    await post(pin);
    expect(anchor()).toEqual({ top: FRAME.top + 100, left: FRAME.left + 220 });
  });

  test("revealPin's clearBottom reaches the bridge in the page's pixels", async () => {
    const scaled = await mount({ frameScale: 0.25 });
    scaled.ref.current!.revealPin!({ clearBottom: 120 });
    expect(scaled.sent.filter((m) => m.type === 'plannotator-bridge-reveal-pin')).toEqual([{ type: 'plannotator-bridge-reveal-pin', clearBottom: 480 }]);

    await act(async () => {
      for (const root of mountedRoots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    const plain = await mount();
    plain.ref.current!.revealPin!({ clearBottom: 120 });
    expect(plain.sent.filter((m) => m.type === 'plannotator-bridge-reveal-pin')).toEqual([{ type: 'plannotator-bridge-reveal-pin', clearBottom: 120 }]);
  });

  test('a scale that is not a positive number counts as 1', async () => {
    const { post } = await mount({ frameScale: 0 });
    await post(pin);
    expect(anchor()).toEqual({ top: FRAME.top + 100, left: FRAME.left + 220 });
  });
});

describe.if(hasDom)('the page width report', () => {
  test('reaches onContentWidth, also on a read-only page; a forged report does not', async () => {
    const reports: { width: number; viewport: number }[] = [];
    const { post } = await mount({ readOnly: true, onContentWidth: (r) => reports.push(r) });
    await post({ type: 'plannotator-bridge-content-width', width: 1180, viewport: 390 });
    await post({ type: 'plannotator-bridge-content-width', width: '1180', viewport: 390 });
    await post({ type: 'plannotator-bridge-content-width', width: Number.POSITIVE_INFINITY, viewport: 390 });
    await post({ type: 'plannotator-bridge-content-width', width: -4, viewport: 390 });
    await post({ type: 'plannotator-bridge-content-width', width: 5_000_000, viewport: 390 });
    expect(reports).toEqual([{ width: 1180, viewport: 390 }]);
  });

  test('a report from another window is not the page', async () => {
    const reports: { width: number; viewport: number }[] = [];
    await mount({ onContentWidth: (r) => reports.push(r) });
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'plannotator-bridge-content-width', width: 1180, viewport: 390 } }));
    });
    expect(reports).toEqual([]);
  });
});

describe.if(hasDom)('a tap and a scroll up on the page', () => {
  test('a tap reaches onPageTap where it is drawn on screen, also on a read-only page; a forged one does not', async () => {
    const taps: number[] = [];
    let ups = 0;
    const { post } = await mount({ readOnly: true, frameScale: 0.5, onPageTap: (y) => taps.push(y), onPageScrollUp: () => ups++ });
    // 60 page px down, at half size: 30 px under the frame's top.
    await post({ type: 'plannotator-bridge-page-tap', y: 60 });
    await post({ type: 'plannotator-bridge-page-tap', y: '60' });
    await post({ type: 'plannotator-bridge-page-tap', y: Number.NaN });
    await post({ type: 'plannotator-bridge-page-scroll-up' });
    expect(taps).toEqual([FRAME.top + 30]);
    expect(ups).toBe(1);
  });
});
