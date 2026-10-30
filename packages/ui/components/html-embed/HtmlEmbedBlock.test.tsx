/**
 * ```html and ```svg fences in the REAL Viewer (approval "inbox-inline-html";
 * DOM-gated, DOM_TESTS=1). What regresses if these fail:
 * - a host that passes nothing (plan review, annotate, code review) starts
 *   framing pages instead of showing code;
 * - the frame loses its sandbox, or gains a token beyond `allow-scripts
 *   allow-forms`;
 * - another window's message (another embed, a page a page framed) resizes
 *   this frame or opens a link: only the frame's own page may;
 * - a tall page is not clipped with Show more, or Show more does not open it;
 * - Code no longer swaps the page for its source, or a host that cannot
 *   serve the page (or a frame that never speaks) leaves a blank box instead
 *   of the code;
 * - a link the page hands over opens while the frame does not have focus, or
 *   without the person's activation (T3 Code's rule).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { HtmlEmbedHost } from './HtmlEmbedBlock';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('../Viewer') : null;
const parserModule = hasDom ? await import('../../utils/parser') : null;
const gateModule = hasDom ? await import('./loadGate') : null;
const readyModule = hasDom ? await import('./HtmlEmbedBlock') : null;

const PAGE = '<div id="chart">bars</div>';
const MARKDOWN = ['Here is the chart:', '', '```html', PAGE, '```', '', 'And a drawing:', '', '```svg', '<svg width="10" height="10"><rect width="10" height="10"/></svg>', '```', ''].join('\n');

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

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

async function mount(htmlEmbeds?: HtmlEmbedHost, markdown = MARKDOWN): Promise<HTMLElement> {
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
        disableCodePathValidation
        answerOnly
        htmlEmbeds={htmlEmbeds}
      />,
    );
  });
  await settle();
  await settle();
  return host;
}

const servedAt = (url: string | null): HtmlEmbedHost & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, author: 'Claude Code', frameUrl: async (html) => (asked.push(html), url) };
};

const frameOf = (el: HTMLElement) => el.querySelector<HTMLIFrameElement>('iframe[data-html-embed-frame="inline"]');
const say = (source: unknown, data: unknown) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  });

describe.skipIf(!hasDom)('fences a host draws', () => {
  test('without htmlEmbeds both fences stay code, and no page is asked for', async () => {
    const el = await mount();
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.querySelector('[data-html-embed]')).toBeNull();
    expect(el.querySelector('[data-svg-fence]')).toBeNull();
    expect(el.textContent).toContain('<div id="chart">bars</div>');
  });

  test('with a host: the page is asked for once and framed sandboxed (allow-scripts allow-forms), lazily', async () => {
    const embeds = servedAt('/api/inbox/embeds/abc');
    const el = await mount(embeds);
    expect(embeds.asked).toEqual([PAGE]);
    const frame = frameOf(el)!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(frame.getAttribute('loading')).toBe('lazy');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')!.startsWith('/api/inbox/embeds/abc#pn=')).toBe(true);
    // The svg fence is an image: it never runs.
    const image = el.querySelector<HTMLImageElement>('[data-svg-fence] img')!;
    expect(image.getAttribute('src')!.startsWith('data:image/svg+xml')).toBe(true);
  });

  test("only the frame's own page sets its height; a tall page is clipped until Show more", async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await say({}, { pnEmbed: 1, kind: 'height', height: 300 });
    expect(frame.style.height).not.toBe('300px');
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
    expect(frame.style.height).toBe('300px');
    expect(el.querySelector('[data-html-embed-more]')).toBeNull();

    await say(frame.contentWindow, { pnEmbed: 1, kind: 'height', height: 1200 });
    expect(frame.style.height).toBe('1200px');
    const clip = el.querySelector<HTMLElement>('[data-html-embed-clip]')!;
    expect(clip.style.maxHeight).toBe('480px');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-more]')!.click());
    expect(clip.style.maxHeight).toBe('');
    expect(el.querySelector('[data-html-embed-more]')).toBeNull();
  });

  test('Code swaps the page for its source and back', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const code = el.querySelector<HTMLButtonElement>('[data-html-embed-code]')!;
    await act(async () => code.click());
    expect(frameOf(el)).toBeNull();
    expect(code.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-html-embed]')!.textContent).toContain('<div id="chart">bars</div>');
    await act(async () => code.click());
    await settle();
    expect(frameOf(el)).not.toBeNull();
  });

  test('a host that cannot serve the page shows the code', async () => {
    const el = await mount(servedAt(null));
    expect(frameOf(el)).toBeNull();
    expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('failed');
    expect(el.querySelector('[data-html-embed]')!.textContent).toContain('<div id="chart">bars</div>');
  });
});

describe.skipIf(!hasDom)('readiness', () => {
  test('a frame whose page never speaks (the browser refused it) shows the code, not a blank box', async () => {
    readyModule!.setEmbedReadyTimeoutForTests(400);
    try {
      const el = await mount(servedAt('/api/inbox/embeds/abc'));
      // The frame loading (a blank, refused frame loads too) is not the page running.
      await settle();
      expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).not.toBe('ready');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
      expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('failed');
      expect(el.querySelector('[data-html-embed]')!.textContent).toContain('<div id="chart">bars</div>');
    } finally {
      readyModule!.setEmbedReadyTimeoutForTests(10_000);
    }
  });

  test('a page that speaks is ready', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'height', height: 200 });
    expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('ready');
  });
});

describe.skipIf(!hasDom)('a link the page hands over', () => {
  let opened: unknown[][] = [];
  let restore: (() => void) | null = null;
  let active = true;
  beforeEach(() => {
    opened = [];
    active = true;
    const saved = window.open;
    window.open = ((...args: unknown[]) => (opened.push(args), null)) as typeof window.open;
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: active, hasBeenActive: true }) });
    restore = () => {
      window.open = saved;
      if (descriptor) Object.defineProperty(navigator, 'userActivation', descriptor);
      else delete (navigator as unknown as Record<string, unknown>).userActivation;
    };
  });
  afterEach(() => restore?.());
  const link = { pnEmbed: 1, kind: 'link', url: 'https://example.com/docs?a=1' };

  test('opens in a new tab while the frame has focus and the person is active', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    frame.focus();
    await say(frame.contentWindow, link);
    expect(opened).toEqual([['https://example.com/docs?a=1', '_blank', 'noopener,noreferrer']]);
  });

  test('ignored when the frame does not have focus, without the activation, or from another window', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await say(frame.contentWindow, link);
    frame.focus();
    active = false;
    await say(frame.contentWindow, link);
    active = true;
    await say({}, link);
    expect(opened).toEqual([]);
  });
});
