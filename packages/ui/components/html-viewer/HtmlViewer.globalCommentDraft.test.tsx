/**
 * The raw-HTML viewer's global comment keeps the words typed (DOM-gated).
 *
 * What regresses: Escape (or X) on the global composer throwing the words
 * away, so reopening it shows an empty box; one page's kept words showing up
 * in another page's global comment; Save leaving the words behind.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../../types';
import type { HtmlViewerProps } from './HtmlViewer';
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from './bridge-script';

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

async function mountViewer(rawHtml: string, added: Annotation[], displayedContextAttributes?: HtmlViewerProps['displayedContextAttributes']) {
  const HtmlViewer = htmlViewerModule!.HtmlViewer;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (html: string) => act(async () => {
    root!.render(
      <HtmlViewer
        rawHtml={html}
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        displayedContextAttributes={displayedContextAttributes}
      />,
    );
  });
  await render(rawHtml);
  return render;
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

    // Another page's global comment starts empty.
    await mountViewer(PAGE_B, added);
    expect((await openGlobalComposer()).value).toBe('');
    await press(document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!, 'Escape');

    // Back on the first page the words come back.
    await mountViewer(PAGE_A, added);
    const restored = await openGlobalComposer();
    expect(restored.value).toBe('the header is too loud');

    await press(restored, 'Enter', { metaKey: true });
    expect(added).toHaveLength(1);
    expect(added[0]?.text).toBe('the header is too loud');

    // Saved words never come back as a draft.
    expect((await openGlobalComposer()).value).toBe('');
  });
});

const PREFIX = 'plannotator-bridge-';
const ATTRIBUTES = [{ key: 'state', attribute: 'data-demo-state' }];
const PAGE_CONTEXT = '<html data-demo-state="empty"><body><p>Cart review</p></body></html>';
const displayedState = (value: string) => ({ entries: [{ key: 'state', value }] });

describe.if(hasDom)('HtmlViewer global displayed context', () => {
  async function connectBridge(
    options: { holdReplies?: boolean; attributes?: HtmlViewerProps['displayedContextAttributes'] } = {},
  ) {
    const added: Annotation[] = [];
    const replaceDocument = await mountViewer(PAGE_CONTEXT, added, options.attributes);
    const iframe = host!.querySelector('iframe')!;
    const child = iframe.contentWindow!;
    const page = iframe.contentDocument!;
    page.documentElement.setAttribute('data-demo-state', 'empty');
    const outgoing: Record<string, unknown>[] = [];
    const heldReplies: Record<string, unknown>[] = [];
    const deliver = (data: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
    };
    const hostPort = { postMessage(data: Record<string, unknown>) {
      if (options.holdReplies && data.type === `${PREFIX}displayed-context`) heldReplies.push(data);
      else deliver(data);
    } };
    child.postMessage = (data: Record<string, unknown>) => {
      outgoing.push(data);
      child.dispatchEvent(new MessageEvent('message', { data, source: hostPort as unknown as Window }));
    };
    await act(async () => {
      // happy-dom does not run the srcdoc script in this fixture; execute the
      // real bridge in that document and wire its messages across the frame boundary.
      new Function('window', 'document', 'location', 'history', 'parent', BRIDGE_SCRIPT)(
        child, page, child.location, child.history, hostPort,
      );
      if (page.readyState === 'loading') page.dispatchEvent(new Event('DOMContentLoaded'));
    });
    return {
      added, outgoing, heldReplies, replaceDocument,
      setState: (state: string) => page.documentElement.setAttribute('data-demo-state', state),
      reply: (message: Record<string, unknown>) => act(async () => deliver(message)),
    };
  }

  async function saveGlobal(composer: HTMLTextAreaElement, text: string) {
    await type(composer, text);
    await press(composer, 'Enter', { metaKey: true });
  }

  test('the real bridge captures on open; a reopened draft gets the state at its new opening', async () => {
    const { added, outgoing, setState } = await connectBridge({ attributes: ATTRIBUTES });
    const first = await openGlobalComposer();
    setState('full');
    await saveGlobal(first, 'First cart comment');
    expect(added[0]).toMatchObject({ text: 'First cart comment', displayedContext: displayedState('empty') });

    const kept = await openGlobalComposer();
    await type(kept, 'Kept cart comment');
    await press(kept, 'Escape');
    setState('loaded');
    const reopened = await openGlobalComposer();
    expect(reopened.value).toBe('Kept cart comment');
    setState('checkout');
    await press(reopened, 'Enter', { metaKey: true });
    expect(added[1]).toMatchObject({ text: 'Kept cart comment', displayedContext: displayedState('loaded') });
    const next = await openGlobalComposer();
    await saveGlobal(next, 'Checkout review');
    expect(added[2]).toMatchObject({ text: 'Checkout review', displayedContext: displayedState('checkout') });
    expect(outgoing.filter(({ type }) => type === `${PREFIX}displayed-context-request`)).toHaveLength(4);
  });

  test('closing and opening again invalidates the old reply, even if it arrives after the new one', async () => {
    const { added, heldReplies, reply, setState } = await connectBridge({ attributes: ATTRIBUTES, holdReplies: true });
    await press(await openGlobalComposer(), 'Escape');
    setState('full');
    const reopened = await openGlobalComposer();
    expect(heldReplies).toHaveLength(2);
    // Deliver the old reply first: a one-shot consumer must wait for the matching id.
    await reply(heldReplies[0]!);
    await reply(heldReplies[1]!);
    await reply(heldReplies[0]!);
    await saveGlobal(reopened, 'New composer');
    expect(added[0]).toMatchObject({ text: 'New composer', displayedContext: displayedState('full') });
  });

  test.each(['document replacement', 'new bridge ready'] as const)('%s invalidates a pending reply', async (change) => {
    const { added, outgoing, heldReplies, reply, replaceDocument } = await connectBridge({ attributes: ATTRIBUTES, holdReplies: true });
    const open = await openGlobalComposer();
    expect(heldReplies).toHaveLength(1);
    if (change === 'document replacement') await replaceDocument(PAGE_B);
    else {
      await reply({ type: `${PREFIX}ready`, protocolVersion: BRIDGE_PROTOCOL_VERSION });
      expect(outgoing.filter(({ type }) => type === `${PREFIX}set-displayed-context`)).toHaveLength(2);
    }
    await reply(heldReplies[0]!);
    await saveGlobal(open, 'Comment without old page state');
    expect(added[0]?.text).toBe('Comment without old page state');
    expect(added[0]).not.toHaveProperty('displayedContext');
  });

  test('missing or malformed replies never block Save and never reach the annotation', async () => {
    const { added, heldReplies, reply } = await connectBridge({ attributes: ATTRIBUTES, holdReplies: true });
    await saveGlobal(await openGlobalComposer(), 'Saved without waiting');
    const second = await openGlobalComposer();
    await reply({ ...heldReplies[1], displayedContext: { entries: [{ key: 'state', value: 42 }] } });
    await saveGlobal(second, 'Saved with invalid reply');
    expect(added.map(({ text }) => text)).toEqual(['Saved without waiting', 'Saved with invalid reply']);
    for (const annotation of added) expect(annotation).not.toHaveProperty('displayedContext');
  });

  test.each([
    { attributes: undefined },
    { attributes: [{ key: 'state', attribute: 'value' }] },
  ])('absent or invalid configuration sends no context messages (%j)', async ({ attributes }) => {
    const warn = spyOn(console, 'warn');
    try {
      const { added, outgoing, reply } = await connectBridge({ attributes });
      await reply({ type: `${PREFIX}ready`, protocolVersion: BRIDGE_PROTOCOL_VERSION });
      await saveGlobal(await openGlobalComposer(), 'Works without capture');
      expect(outgoing.filter(({ type }) => String(type).includes('displayed-context'))).toEqual([]);
      expect(added[0]?.text).toBe('Works without capture');
      expect(added[0]).not.toHaveProperty('displayedContext');
      expect(warn.mock.calls.filter(([message]) => String(message).includes('invalid displayedContextAttributes')))
        .toHaveLength(attributes ? 1 : 0);
    } finally {
      warn.mockRestore();
    }
  });
});
