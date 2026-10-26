/**
 * The rich-text Copy through the REAL Viewer and web-highlighter (DOM-gated,
 * DOM_TESTS=1).
 *
 * Failures to catch: the toolbar button stops writing text/html beside
 * text/plain, the copied HTML carries annotation marks, review attributes or
 * theme styles, or the button's arrival changes ordinary copy: Ctrl+C / Cmd+C
 * must still write only the captured plain text through the native copy event
 * and never touch navigator.clipboard (exactly as before the button existed).
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const policy = hasDom ? await import('../utils/richCopyPolicy') : null;

const MARKDOWN = 'The backoff is **two, four and eight** seconds.\n';

let root: Root | null = null;
let host: HTMLElement | null = null;
const restorers: Array<() => void> = [];

function override(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  while (restorers.length > 0) restorers.pop()!();
  policy?.resetRichCopyEnabled();
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mountAndSelect(phrase: string): Promise<void> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
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
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? host!).dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

function toolbarButton(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')]
    .find((b) => (b.getAttribute('aria-label') ?? b.title) === name);
}

/** A clipboard that records every call, plus a ClipboardItem that keeps its blobs. */
function fakeClipboard() {
  const items: Array<Record<string, Blob>> = [];
  class TestClipboardItem {
    constructor(value: Record<string, Blob>) { items.push(value); }
  }
  const write = mock(async () => {});
  const writeText = mock(async (_text: string) => {});
  override(globalThis, 'ClipboardItem', TestClipboardItem);
  override(navigator, 'clipboard', { write, writeText });
  return { items, write, writeText };
}

test.skipIf(!hasDom)('a @plannotator/ui host that does not opt in keeps the toolbar as it was: no Copy on desktop', async () => {
  await mountAndSelect('four and eight');
  expect(document.querySelector('.annotation-toolbar')).not.toBeNull();
  expect(toolbarButton('Copy')).toBeUndefined();
});

test.skipIf(!hasDom)('the toolbar button copies the selection as text/html plus text/plain, without review markup', async () => {
  policy!.setRichCopyEnabled(true);
  await mountAndSelect('four and eight');
  const clipboard = fakeClipboard();
  // One Copy button (the copy icon), shown on desktop too once rich copy is on.
  const copyButtons = [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')]
    .filter((b) => /^Cop(y|ied)/.test(b.getAttribute('aria-label') ?? b.title));
  expect(copyButtons).toHaveLength(1);
  const button = toolbarButton('Copy');
  if (!button) throw new Error('Copy missing from the selection toolbar');

  await act(async () => { button.click(); });
  await settle();

  expect(clipboard.write).toHaveBeenCalledTimes(1);
  expect(clipboard.writeText).not.toHaveBeenCalled();
  const [item] = clipboard.items;
  expect(Object.keys(item).sort()).toEqual(['text/html', 'text/plain']);
  const html = await item['text/html'].text();
  expect(html).toContain('<strong>four and eight</strong>');
  expect(html).not.toMatch(/<mark|data-|class=|style=/);
  expect(await item['text/plain'].text()).toBe('four and eight');
});

test.skipIf(!hasDom)('Ctrl+C / Cmd+C are unchanged: plain text through the copy event only, no clipboard API call', async () => {
  policy!.setRichCopyEnabled(true);
  await mountAndSelect('four and eight');
  const clipboard = fakeClipboard();
  expect(toolbarButton('Copy')).toBeDefined();

  for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
    const keydown = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true, ...init });
    await act(async () => { document.body.dispatchEvent(keydown); });
    expect(keydown.defaultPrevented).toBe(false);

    const data = new Map<string, string>();
    const copy = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copy, 'clipboardData', {
      value: { setData: (type: string, value: string) => data.set(type, value) },
    });
    await act(async () => { document.body.dispatchEvent(copy); });
    expect(copy.defaultPrevented).toBe(true);
    expect([...data]).toEqual([['text/plain', 'four and eight']]);
  }
  await settle();
  expect(clipboard.write).not.toHaveBeenCalled();
  expect(clipboard.writeText).not.toHaveBeenCalled();
});
