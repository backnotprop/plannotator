/**
 * Ctrl+C / Cmd+C on an HTML document once a selection's composer is open
 * (DOM-gated, DOM_TESTS=1). The selection lives in the page's frame; the
 * composer's textarea in the parent then has the focus, so the browser's copy
 * has nothing to copy.
 *
 * Failures to catch: the copy carries nothing with the composer open (focus
 * in its empty textarea, or outside it), it fires before any composer is
 * open, or text the person selected in the textarea is overwritten.
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

let root: Root | null = null;

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mount() {
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <HtmlViewer
        rawHtml="<html><body><p>The refund service retries a failed payout.</p></body></html>"
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="drag"
      />,
    );
  });
  const iframe = host.querySelector<HTMLIFrameElement>('iframe')!;
  return async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
    });
    await settle();
  };
}

const selection = {
  type: 'plannotator-bridge-selection',
  text: 'retries a failed payout',
  rect: { top: 10, left: 10, width: 120, height: 24 },
};

async function openComposer() {
  const fromBridge = await mount();
  await fromBridge(selection);
  const comment = document.querySelector<HTMLButtonElement>('.annotation-toolbar button.text-annotation-comment');
  if (!comment) throw new Error('no toolbar Comment button');
  await act(async () => comment.click());
  await settle();
  const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!area) throw new Error('no composer');
  area.focus();
  return area;
}

function copyAt(target: EventTarget) {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' } });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, plain: data.get('text/plain'), html: data.get('text/html') };
}

test.skipIf(!hasDom)('composer open, focus in its empty textarea: Ctrl+C copies the selected words', async () => {
  const area = await openComposer();
  expect(copyAt(area)).toEqual({ prevented: true, plain: 'retries a failed payout', html: undefined });
});

test.skipIf(!hasDom)('composer open, focus outside it: Ctrl+C copies the selected words', async () => {
  const area = await openComposer();
  area.blur();
  expect(copyAt(document.body)).toMatchObject({ prevented: true, plain: 'retries a failed payout' });
});

test.skipIf(!hasDom)('toolbar up, no composer: the parent leaves the copy to the frame', async () => {
  const fromBridge = await mount();
  await fromBridge(selection);
  expect(copyAt(document.body)).toMatchObject({ prevented: false, plain: undefined });
});

test.skipIf(!hasDom)('text selected in the composer copies natively', async () => {
  const area = await openComposer();
  area.value = 'Why a failed one?';
  area.setSelectionRange(4, 12);
  expect(copyAt(area)).toMatchObject({ prevented: false, plain: undefined });
});
