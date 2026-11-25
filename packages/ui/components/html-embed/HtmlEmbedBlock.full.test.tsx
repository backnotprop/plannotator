/**
 * A live html block opened big: its own Full screen, and the view a host opens on its own (`open`, the Inbox's
 * Artifacts). DOM-gated (DOM_TESTS=1). What regresses if these fail:
 * - the page in the big view is the message's frame (`inline`: as tall as its page, capped at 20,000 px, never
 *   scrolling, no sideways bar) instead of a frame that fills the dialog and scrolls (`full`), with or without the pen;
 * - Full screen waits behind the load gate (two pages loading elsewhere), or asks the host for the page again;
 * - a marker pressed in Full screen selects the comment behind the dialog (the host's list, which then takes the
 *   focus and scrolls the thread) instead of only in the dialog.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation, Block } from '../../types';
import type { HtmlEmbedAnnotate, HtmlEmbedHost } from './HtmlEmbedBlock';

const hasDom = typeof document !== 'undefined';
const blockModule = hasDom ? await import('./HtmlEmbedBlock') : null;
const gateModule = hasDom ? await import('./loadGate') : null;

const ID = '0123456789abcdef0123456789abcdef';
const EMBED_URL = `/api/inbox/embeds/${ID}`;
const SERVED = '/api/inbox/embed-pages/served';
const BLOCK: Block = { id: 'block-1', type: 'code', language: 'html', content: '<svg><rect id="pro-3"/></svg>', order: 0, startLine: 3 };
/** The page's mode as its frame's address hands it over (`#pn=`). */
const FULL = encodeURIComponent('"mode":"full"');

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreObserver: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  gateModule!.resetEmbedGateForTests();
  // happy-dom never reports an intersection: without the observer, an embed counts as near at once.
  const saved = (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  restoreObserver = () => {
    (globalThis as Record<string, unknown>).IntersectionObserver = saved;
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  restoreObserver?.();
  restoreObserver = null;
  if (hasDom) document.body.innerHTML = '';
});

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const say = (source: unknown, data: unknown) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  });

async function mount(embeds: HtmlEmbedHost, open?: { onClose(): void }): Promise<HTMLElement> {
  const HtmlEmbedBlock = blockModule!.HtmlEmbedBlock;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<HtmlEmbedBlock block={BLOCK} host={embeds} open={open} />);
  });
  await settle();
  await settle();
  return host;
}

function world(extra: Partial<HtmlEmbedAnnotate> | null = null): { embeds: HtmlEmbedHost; asked: string[] } {
  const asked: string[] = [];
  const annotate: HtmlEmbedAnnotate | undefined = extra ? { frameUrl: async () => SERVED, indexOf: () => 1, annotations: [], onAdd: () => true, ...extra } : undefined;
  return { asked, embeds: { author: 'Claude Code', frameUrl: async (html) => (asked.push(html), EMBED_URL), annotate } };
}

const dialog = () => document.querySelector<HTMLElement>('[data-html-embed-open]');
/** Two pages loading elsewhere: the load gate is full. */
const fillTheGate = async () => {
  await gateModule!.acquireEmbedLoad();
  await gateModule!.acquireEmbedLoad();
};

test.skipIf(!hasDom)("the block's Full screen fills the dialog with a frame that scrolls, at once and with no second ask", async () => {
  const w = world();
  const el = await mount(w.embeds);
  const inline = el.querySelector<HTMLIFrameElement>('iframe[data-html-embed-frame="inline"]')!;
  expect(inline).not.toBeNull();
  await say(inline.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
  expect(w.asked.length).toBe(1);
  await fillTheGate();

  await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-full]')!.click());
  await settle();
  const big = dialog()!;
  expect(big).not.toBeNull();
  const frame = big.querySelector<HTMLIFrameElement>('iframe[data-html-embed-frame]')!;
  // The Full screen mode: as tall as the dialog under its bar, the page scrolling inside it.
  expect(frame.getAttribute('data-html-embed-frame')).toBe('full');
  expect(frame.style.height).toBe('100%');
  expect(frame.getAttribute('src')!.startsWith(`${EMBED_URL}#pn=`)).toBe(true);
  expect(frame.getAttribute('src')).toContain(FULL);
  expect(frame.closest('[data-html-embed-fill]')).not.toBeNull();
  // Not one more ask of the host, and no "Show page" wait behind the full gate.
  expect(w.asked.length).toBe(1);
  expect(big.querySelector('[data-html-embed-waiting]')).toBeNull();
});

test.skipIf(!hasDom)("the view a host opens on its own (Artifacts) is the same scrolling frame, and never waits behind the gate", async () => {
  const w = world();
  await fillTheGate();
  let closed = 0;
  await mount(w.embeds, { onClose: () => void closed++ });
  const frame = dialog()!.querySelector<HTMLIFrameElement>('iframe[data-html-embed-frame]')!;
  expect(frame.getAttribute('data-html-embed-frame')).toBe('full');
  expect(frame.getAttribute('src')).toContain(FULL);
  expect(w.asked.length).toBe(1);
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(closed).toBe(1);
});

test.skipIf(!hasDom)("with the pen, Full screen's frame scrolls too, and a marker pressed there is selected there only, never behind the dialog", async () => {
  const own = {
    id: 'c-own',
    blockId: 'block-1',
    startOffset: 0,
    endOffset: 0,
    type: 'COMMENT',
    text: 'Saved words.',
    originalText: 'Pro, W3',
    createdA: 1,
    htmlAnchor: { selector: '#pro-3', tagName: 'rect', text: '' },
    htmlBlockAnchor: { v: 1, index: 1, id: ID, sourceLine: [3, 5] },
  } as unknown as Annotation;
  const selected: Array<string | null> = [];
  const w = world({ annotations: [own], onSelect: (id) => void selected.push(id) });
  // The served frame's first address carries the page's mode only under a real window address.
  // A frame's page is answered in the test, empty: nothing is asked of that address.
  type Intercept = { beforeAsyncRequest(context: { window: { Response: typeof Response } }): Promise<Response> } | null;
  const happy = (window as unknown as { happyDOM?: { setURL(url: string): void; settings: { fetch: { interceptor: Intercept } } } }).happyDOM;
  const was = window.location.href;
  const interceptor = happy?.settings.fetch.interceptor ?? null;
  if (happy) happy.settings.fetch.interceptor = { beforeAsyncRequest: async ({ window: frame }) => new frame.Response('', { status: 200, headers: { 'Content-Type': 'text/html' } }) };
  happy?.setURL('http://127.0.0.1:1/inbox');
  // The box under the dialog's bar is 640 px tall (happy-dom lays nothing out).
  const measure = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.hasAttribute('data-html-embed-fill') ? ({ top: 0, left: 0, right: 900, bottom: 640, width: 900, height: 640, x: 0, y: 0, toJSON() {} } as DOMRect) : measure.call(this);
  };
  try {
    await penInFullScreen(w, selected);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = measure;
    happy?.setURL(was);
    if (happy) happy.settings.fetch.interceptor = interceptor;
  }
});

async function penInFullScreen(w: ReturnType<typeof world>, selected: Array<string | null>): Promise<void> {
  const el = await mount(w.embeds);
  await settle(60);
  // The block in the text: its marker opens its comment in the host's list, as always.
  const inline = el.querySelector<HTMLIFrameElement>('[data-html-embed-annotatable] iframe')!;
  expect(inline).not.toBeNull();
  await say(inline.contentWindow, { type: 'plannotator-bridge-mark-click', id: 'c-own' });
  expect(selected).toEqual(['c-own']);

  await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-full]')!.click());
  await settle(60);
  await settle(60);
  const big = dialog()!;
  const frame = big.querySelector<HTMLIFrameElement>('[data-html-embed-annotatable] iframe')!;
  expect(frame).not.toBeNull();
  expect(frame.getAttribute('src')).toContain(FULL);
  expect(frame.closest('[data-html-embed-fill]')).not.toBeNull();
  // As tall as the box under the bar, whatever height the page reports: the page scrolls in it.
  expect(frame.style.height).toBe('640px');
  await say(frame.contentWindow, { pnEmbed: 1, kind: 'height', height: 20_000 });
  expect(frame.style.height).toBe('640px');
  // Its marker: nothing behind the dialog is selected (so nothing there takes the focus or scrolls), and it stays open.
  await say(frame.contentWindow, { type: 'plannotator-bridge-mark-click', id: 'c-own' });
  await settle();
  expect(selected).toEqual(['c-own']);
  expect(dialog()).not.toBeNull();
  expect(big.querySelector('figure[data-html-embed]')!.getAttribute('data-html-embed-comments')).toBe('c-own');
}
