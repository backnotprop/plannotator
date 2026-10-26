/**
 * The rich-text Copy on HTML surfaces (DOM-gated, DOM_TESTS=1): the parent
 * asks the bridge for the pending range's markup when the button is pressed.
 *
 * Failures to catch: the button appearing for a host that did not opt in,
 * markup requested before the press, a forged or late answer reaching the
 * clipboard, a fallback that writes outside the click (a rejected html
 * promise, a second write), and a tooltip that misstates what was copied.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;
const policy = hasDom ? await import('../../utils/richCopyPolicy') : null;
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];
const restorers: Array<() => void> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  while (restorers.length > 0) restorers.pop()!();
  policy!.resetRichCopyEnabled();
  document.body.replaceChildren();
});

function override(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}

/** A clipboard whose ClipboardItem keeps its (promised) blobs; every write is recorded resolved. */
function fakeClipboard() {
  const writes: Array<Record<string, string>> = [];
  class TestClipboardItem {
    constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
  }
  const write = mock(async (written: TestClipboardItem[]) => {
    const out: Record<string, string> = {};
    for (const [type, blob] of Object.entries(written[0].items)) out[type] = await (await blob).text();
    writes.push(out);
  });
  const writeText = mock(async (_text: string) => {});
  override(globalThis, 'ClipboardItem', TestClipboardItem);
  override(navigator, 'clipboard', { write, writeText });
  return { writes, write, writeText };
}

const selection = {
  type: 'plannotator-bridge-selection',
  text: 'Pinpoint target',
  rect: { top: 10, left: 10, width: 120, height: 24 },
  richCopy: true,
};

async function mount() {
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <HtmlViewer
        rawHtml="<html><body><p>Pinpoint target</p></body></html>"
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
  const toIframe: Array<Record<string, unknown>> = [];
  const realPost = iframe.contentWindow!.postMessage.bind(iframe.contentWindow!);
  (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage =
    ((data: unknown, ...rest: unknown[]) => {
      if (data && typeof data === 'object') toIframe.push(data as Record<string, unknown>);
      return (realPost as (...args: unknown[]) => unknown)(data, ...rest);
    }) as typeof iframe.contentWindow.postMessage;
  const fromBridge = async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
    });
  };
  const requests = () => toIframe.filter((m) => m.type === 'plannotator-bridge-rich-copy-request');
  return { fromBridge, requests };
}

const titles = () => Array.from(
  document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button'),
).map((button) => button.title);

async function press() {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button'))
    .find((b) => b.title === 'Copy');
  if (!button) throw new Error('Copy missing');
  await act(async () => { button.click(); });
}

async function settle(ms = 20) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const answer = (id: unknown, rest: Record<string, unknown>) => ({
  type: 'plannotator-bridge-rich-copy', id, html: '', text: '', truncated: false, tooLarge: false, ...rest,
});

describe.if(hasDom)('Rich-text Copy on HTML surfaces', () => {
  test('a host that did not opt in keeps plain Copy; opted in, nothing is requested before the press', async () => {
    const clipboard = fakeClipboard();
    const { fromBridge, requests } = await mount();
    await fromBridge(selection);
    expect(titles().filter((t) => t === 'Copy')).toHaveLength(1);
    await press();
    await settle();
    expect(requests()).toEqual([]);
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith('Pinpoint target');

    policy!.setRichCopyEnabled(true);
    await fromBridge({ ...selection, text: 'Pinpoint target again' });
    expect(titles().filter((t) => t === 'Copy')).toHaveLength(1);
    expect(requests()).toEqual([]);
  });

  test('the answer to its own request is sanitized and written once; forged and wrong-id answers are ignored', async () => {
    policy!.setRichCopyEnabled(true);
    const clipboard = fakeClipboard();
    const { fromBridge, requests } = await mount();
    await fromBridge(selection);
    await fromBridge(answer('rc-forged', { html: '<p>forged</p>', text: 'forged' }));
    expect(clipboard.write).not.toHaveBeenCalled();

    await press();
    expect(requests()).toHaveLength(1);
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    await fromBridge(answer('rc-wrong', { html: '<p>wrong</p>', text: 'wrong' }));
    await fromBridge(answer(requests()[0].id, {
      html: '<p style="color:red" onclick="x()"><strong>Pinpoint target</strong> <a href="/api/html-assets/tok/x">asset</a></p>',
      text: 'Pinpoint target, whole',
    }));
    await settle();

    expect(clipboard.writes).toEqual([{
      'text/html': '<p><strong>Pinpoint target</strong> <a>asset</a></p>',
      'text/plain': 'Pinpoint target, whole',
    }]);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(titles()).toContain('Copied!');
  });

  test('no answer within 1.5 s: the quote is written once, as plain text, and a late answer changes nothing', async () => {
    policy!.setRichCopyEnabled(true);
    const clipboard = fakeClipboard();
    const { fromBridge, requests } = await mount();
    await fromBridge({ ...selection, text: 'Cut <quote>', textCut: true });
    await press();
    await settle(hookModule!.RICH_COPY_TIMEOUT_MS - 300);
    expect(clipboard.writes).toEqual([]);
    await settle(500);

    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(clipboard.writes).toEqual([{
      'text/html': '<pre>Cut &lt;quote&gt;</pre>',
      'text/plain': 'Cut <quote>',
    }]);
    const label = 'Copied as plain text (formatting not available; first 11 characters only)';
    expect(titles()).toContain(label);

    await fromBridge(answer(requests()[0].id, { html: '<p>late</p>', text: 'late' }));
    await settle();
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(titles()).toContain(label);
  });

  test('markup too large or missing: one write, its html part the escaped text, the tooltip says why', async () => {
    policy!.setRichCopyEnabled(true);
    const clipboard = fakeClipboard();
    const { fromBridge, requests } = await mount();

    await fromBridge(selection);
    await press();
    await fromBridge(answer(requests()[0].id, { text: 'a < b', tooLarge: true }));
    await settle();
    expect(clipboard.writes).toEqual([{ 'text/html': '<pre>a &lt; b</pre>', 'text/plain': 'a < b' }]);
    expect(titles()).toContain('Copied as plain text (too large for rich text)');

    await fromBridge({ ...selection, text: 'Other words' });
    await press();
    await fromBridge(answer(requests()[1].id, { html: '', text: 'Other words, whole' }));
    await settle();
    expect(clipboard.write).toHaveBeenCalledTimes(2);
    expect(clipboard.writes[1]).toEqual({ 'text/html': '<pre>Other words, whole</pre>', 'text/plain': 'Other words, whole' });
    expect(titles()).toContain('Copied as plain text (formatting not available)');
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test('sanitized HTML that grows past 512 KiB is too large; a cut text says how much was copied', async () => {
    policy!.setRichCopyEnabled(true);
    const clipboard = fakeClipboard();
    const { fromBridge, requests } = await mount();
    await fromBridge(selection);
    await press();
    // 200,007 characters in; each "&" serializes as "&amp;": over a megabyte out.
    await fromBridge(answer(requests()[0].id, { html: `<p>${'&'.repeat(200_000)}</p>`, text: 'amps' }));
    await settle();
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(clipboard.writes[0]['text/html']).toBe('<pre>amps</pre>');
    expect(titles()).toContain('Copied as plain text (too large for rich text)');

    await fromBridge({ ...selection, text: 'Long words' });
    await press();
    await fromBridge(answer(requests()[1].id, { text: 'x'.repeat(262_144), truncated: true, tooLarge: true }));
    await settle();
    expect(clipboard.writes[1]['text/plain']).toHaveLength(262_144);
    expect(titles()).toContain('Copied as plain text (too large for rich text; first 262,144 characters only)');
  });
});
