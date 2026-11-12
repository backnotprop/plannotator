import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../../types';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

async function mountViewer(rawHtml: string, added: Annotation[]) {
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <HtmlViewer
        rawHtml={rawHtml}
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
      />,
    );
  });
}

async function openGlobalComposer(): Promise<HTMLTextAreaElement> {
  const button = host!.querySelector<HTMLButtonElement>('button[title="Add global comment"]');
  if (!button) throw new Error('Global comment button missing');
  await act(async () => { button.click(); });
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('composer textarea missing');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

const PAGE_A = '<html><body><p>Page A</p></body></html>';
const PAGE_B = '<html><body><p>Page B</p></body></html>';

describe.if(hasDom)('HtmlViewer global comment draft', () => {
  test('Escape keeps the words for this page, reopening restores them, Save clears them', async () => {
    const added: Annotation[] = [];
    await mountViewer(PAGE_A, added);

    await type(await openGlobalComposer(), 'the header is too loud');
    await press(document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!, 'Escape');
    expect(document.querySelector('[data-comment-popover]')).toBeNull();

    await mountViewer(PAGE_B, added);
    expect((await openGlobalComposer()).value).toBe('');
    await press(document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!, 'Escape');

    await mountViewer(PAGE_A, added);
    const restored = await openGlobalComposer();
    expect(restored.value).toBe('the header is too loud');

    await press(restored, 'Enter', { metaKey: true });
    expect(added).toHaveLength(1);
    expect(added[0]?.text).toBe('the header is too loud');

    expect((await openGlobalComposer()).value).toBe('');
  });
});
