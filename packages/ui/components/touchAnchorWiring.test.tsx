/**
 * The touch toolbar goes below the WHOLE selection, which only the surfaces
 * know: the markdown Viewer (a selection split into several marks; the
 * toolbar's `element` is the first) and HtmlViewer (a 1px anchor over the
 * frame; the bridge reports the selection's rect). These drive the real
 * Viewer and HtmlViewer, so dropping their `touchAnchorRect` wiring, or
 * getting the frame-plus-bridge math wrong, fails here. DOM-gated
 * (DOM_TESTS=1).
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const htmlViewerModule = hasDom ? await import('./html-viewer/HtmlViewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const placement = hasDom ? await import('../utils/touchToolbarPlacement') : null;

let root: Root | null = null;
let host: HTMLElement | null = null;
const restorers: Array<() => void> = [];

function stubProperty(target: object, key: string, descriptor: PropertyDescriptor) {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorers.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

const rect = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
}) as DOMRect;

/** An opted-in host on a 390x844 touch phone; the toolbar measures 276x54. */
function touchPhone() {
  placement!.setTouchSelectionToolbar(true);
  restorers.push(() => placement!.resetTouchSelectionToolbar());
  stubProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }),
    writable: true,
  });
  stubProperty(window, 'innerWidth', { value: 390 });
  stubProperty(window, 'innerHeight', { value: 844 });
  stubProperty(window, 'visualViewport', { value: null });
  const measured = (size: number) => function (this: HTMLElement) {
    return this.classList?.contains('annotation-toolbar') ? size : 0;
  };
  stubProperty(HTMLElement.prototype, 'offsetWidth', { get: measured(276) });
  stubProperty(HTMLElement.prototype, 'offsetHeight', { get: measured(54) });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  while (restorers.length) restorers.pop()!();
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

function toolbarTop(): number {
  const toolbar = document.querySelector<HTMLElement>('.annotation-toolbar');
  if (!toolbar) throw new Error('annotation toolbar did not render');
  expect(toolbar.dataset.pnAnnotationToolbarTouch).toBeDefined();
  return parseFloat(toolbar.style.top);
}

test.skipIf(!hasDom)('Viewer: a selection across two paragraphs puts the toolbar under the second, not the first mark', async () => {
  touchPhone();
  // Each highlight mark draws on its paragraph's line: the first at 100..120, the second at 200..220.
  const markRect = function (this: HTMLElement) {
    const blocks = Array.from(document.querySelectorAll('[data-block-id]'));
    const index = blocks.findIndex((b) => b.contains(this));
    return index <= 0 ? rect(150, 100, 200, 20) : rect(16, 200, 120, 20);
  };
  const originalRects = HTMLElement.prototype.getClientRects;
  const originalBox = HTMLElement.prototype.getBoundingClientRect;
  stubProperty(HTMLElement.prototype, 'getClientRects', {
    value: function (this: HTMLElement) {
      return this.tagName === 'MARK' ? [markRect.call(this)] : originalRects.call(this);
    },
    writable: true,
  });
  stubProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    value: function (this: HTMLElement) {
      return this.tagName === 'MARK' ? markRect.call(this) : originalBox.call(this);
    },
    writable: true,
  });

  const markdown = 'The timer and the rain sensor both started the cycle.\n\nThe sensor now waits for the timer.\n';
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(markdown)}
        markdown={markdown}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
      />,
    );
  });
  await settle();
  const texts: Text[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? '').includes('sensor')) texts.push(n as Text);
  const [first, second] = texts;
  const range = document.createRange();
  range.setStart(first!, first!.textContent!.indexOf('sensor'));
  range.setEnd(second!, second!.textContent!.indexOf('waits'));
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (first!.parentElement!.closest('article') ?? host!).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();

  expect(document.querySelectorAll('mark').length).toBeGreaterThan(1);
  expect(toolbarTop()).toBeGreaterThanOrEqual(220 + 28);
});

test.skipIf(!hasDom)('HtmlViewer: the toolbar goes under the bridge\'s whole selection rect, offset by the frame, and follows it', async () => {
  touchPhone();
  stubProperty(HTMLIFrameElement.prototype, 'getBoundingClientRect', { value: () => rect(0, 100, 390, 700), writable: true });
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <HtmlViewer
        rawHtml="<html><body><p>Two lines of selected words</p></body></html>"
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="drag"
      />,
    );
  });
  const iframe = host.querySelector<HTMLIFrameElement>('iframe');
  if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
  const post = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
  });

  // Two lines, 10..58 inside the frame: the frame starts at 100, so the selection ends at 158.
  await post({ type: 'plannotator-bridge-selection', text: 'Two lines of selected words', rect: { top: 10, left: 20, width: 300, height: 48 } });
  await settle();
  const first = toolbarTop();
  expect(first).toBeGreaterThanOrEqual(100 + 10 + 48 + 28);
  expect(first).toBeLessThan(100 + 10 + 48 + 60);

  // The page inside the frame scrolled: the bridge reports the new rect.
  await post({ type: 'plannotator-bridge-selection-rect', rect: { top: 300, left: 20, width: 300, height: 24 } });
  await settle();
  const moved = toolbarTop();
  expect(moved).toBeGreaterThanOrEqual(100 + 300 + 24 + 28);
  expect(moved).toBeLessThan(100 + 300 + 24 + 60);
});
