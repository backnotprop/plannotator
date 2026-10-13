/**
 * `mentionSource` threaded through the REAL HtmlViewer (DOM-gated).
 *
 * What these catch: a source that reaches only one of this viewer's two
 * composers (the pinpoint/selection one the bridge opens and the global one),
 * ids dropped between the composer and the annotation the host receives, and
 * a `mentions` key appearing on an annotation when no host supplied a source —
 * the raw-HTML half of the no-op guarantee.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../../types';
import type { MentionPerson, MentionSource } from '../../utils/mentions';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const PEOPLE: MentionPerson[] = [
  { id: 'user_1', kind: 'user', label: 'Marcus Chen', detail: 'marcus@example.com', canOpen: true },
  { id: 'user_2', kind: 'user', label: 'Dana Ruiz', detail: 'dana@example.com', canOpen: true },
];

const SELECTION_MESSAGE = {
  type: 'plannotator-bridge-selection',
  text: 'Pinpoint target',
  rect: { top: 10, left: 10, width: 120, height: 24 },
  anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Pinpoint target' },
  pinpoint: true,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

async function mountViewer(
  mentionSource: MentionSource | undefined,
  added: Annotation[],
) {
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <HtmlViewer
        rawHtml="<html><body><p>Pinpoint target</p></body></html>"
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        mentionSource={mentionSource}
      />,
    );
  });
  const iframe = host!.querySelector<HTMLIFrameElement>('iframe');
  if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
  return {
    async openPinpointComposer() {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data: SELECTION_MESSAGE,
        }));
      });
    },
    async openGlobalComposer() {
      const button = host!.querySelector<HTMLButtonElement>('button[title="Add global comment"]');
      if (!button) throw new Error('Global comment button missing');
      await act(async () => { button.click(); });
    },
  };
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('composer textarea missing');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

function picker(): Element | null {
  return document.querySelector('[data-mention-picker]');
}

async function mentionAndSubmit(): Promise<void> {
  const el = textarea();
  await type(el, 'ask @dan');
  expect(picker()).not.toBeNull();
  await press(el, 'ArrowDown');
  await press(el, 'Enter');
  expect(el.value).toBe('ask @Dana Ruiz ');
  await press(el, 'Enter', { metaKey: true });
}

describe.if(hasDom)('HtmlViewer mentionSource', () => {
  test('the pinpoint composer opens the picker and puts the ids on the annotation', async () => {
    const added: Annotation[] = [];
    const viewer = await mountViewer({ people: PEOPLE }, added);
    await viewer.openPinpointComposer();
    await mentionAndSubmit();

    expect(added).toHaveLength(1);
    expect(added[0]?.mentions).toEqual(['user_2']);
    expect(added[0]?.htmlAnchor?.selector).toBe('p:nth-of-type(1)');
  });

  test('the global composer opens the picker and puts the ids on the annotation', async () => {
    const added: Annotation[] = [];
    const viewer = await mountViewer({ people: PEOPLE }, added);
    await viewer.openGlobalComposer();
    await mentionAndSubmit();

    expect(added).toHaveLength(1);
    expect(added[0]?.mentions).toEqual(['user_2']);
  });

  test('WITHOUT a source both composers stay as they were: no menu, no mentions key', async () => {
    const added: Annotation[] = [];
    const viewer = await mountViewer(undefined, added);

    await viewer.openPinpointComposer();
    const pinpointEl = textarea();
    await type(pinpointEl, 'ask @dan');
    expect(picker()).toBeNull();
    await press(pinpointEl, 'Enter', { metaKey: true });

    await viewer.openGlobalComposer();
    const globalEl = textarea();
    await type(globalEl, 'ask @dan');
    expect(picker()).toBeNull();
    await press(globalEl, 'Enter', { metaKey: true });

    expect(added).toHaveLength(2);
    for (const ann of added) expect('mentions' in (ann as object)).toBe(false);
  });
});
