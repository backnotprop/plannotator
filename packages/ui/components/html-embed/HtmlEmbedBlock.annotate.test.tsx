/**
 * Comments in place on a live html block (`HtmlEmbedHost.annotate`; the
 * owner's pick "A · In place", 2026-11-20), in the REAL Viewer (DOM-gated,
 * DOM_TESTS=1). What regresses if these fail:
 * - a host that passes no `annotate` gains a pen, or a block nobody
 *   annotates loads the heavy annotatable document (the resting cost);
 * - the annotatable frame loses the embed's sandbox, gains
 *   `allow-same-origin`, or is drawn from a srcdoc (the window's own policy)
 *   or from a document that is not the embed's own with the bridge in it;
 * - the block's page can put words into a comment: a comment's text is what
 *   the person typed in the window's box, never anything a message carried;
 * - a message from another window opens the comment box, or sets the height;
 * - a comment made on another source, or on another block, is drawn here
 *   (a wrong element), or one this block cannot draw is not reported;
 * - the pen stays on after a comment is added, or stays on with the page gone;
 * - Escape with the pen on also closes the thread under the block (it must be
 *   used), or takes the pen off while the comment box is still open;
 * - the comment box names one element twice (a header that reads like debug
 *   text and a chip that repeats it);
 * - a bar with no id loses its marker on every reload (its structural anchor
 *   is dropped on the way in, or not asked for on restore), or the window
 *   keeps a structural anchor that is past the caps.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EMBED_BOOTSTRAP } from '@plannotator/core/html-embed';
import type { Annotation } from '../../types';
import type { HtmlEmbedAnnotate, HtmlEmbedHost } from './HtmlEmbedBlock';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('../Viewer') : null;
const parserModule = hasDom ? await import('../../utils/parser') : null;
const gateModule = hasDom ? await import('./loadGate') : null;
const bridgeModule = hasDom ? await import('../html-viewer/bridge-script') : null;
const blockModule = hasDom ? await import('./HtmlEmbedBlock') : null;

const ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';
const EMBED_URL = `/api/inbox/embeds/${ID}`;
const SERVED = '/api/inbox/embed-pages/served';
const PAGE = '<svg><rect id="pro-3"/></svg>';
const MARKDOWN = ['Signups by plan:', '', '```html', PAGE, '```', '', 'Which helps more?', ''].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreObserver: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  gateModule!.resetEmbedGateForTests();
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

async function mount(htmlEmbeds: HtmlEmbedHost): Promise<HTMLElement> {
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

interface World {
  embeds: HtmlEmbedHost;
  /** The annotatable documents the block asked the host to keep. */
  documents: string[];
  added: Annotation[];
  reports: { attempted: readonly string[]; unanchored: readonly string[] }[];
}

function world(annotations: Annotation[] = [], extra: Partial<HtmlEmbedAnnotate> = {}): World {
  const documents: string[] = [];
  const added: Annotation[] = [];
  const reports: World['reports'] = [];
  const annotate: HtmlEmbedAnnotate = {
    frameUrl: async (document) => (documents.push(document), SERVED),
    indexOf: () => 1,
    annotations,
    onAdd: async (annotation) => (added.push(annotation), true),
    onRestoreReport: (report) => reports.push(report),
    ...extra,
  };
  return { embeds: { frameUrl: async () => EMBED_URL, author: 'Claude Code', annotate }, documents, added, reports };
}

const saved = (id: string, anchor: Record<string, unknown>): Annotation =>
  ({ id, blockId: 'block-1', startOffset: 0, endOffset: 0, type: 'COMMENT', text: 'Saved words.', originalText: 'Pro, W3', createdA: 1, htmlAnchor: { selector: '#pro-3', tagName: 'rect', text: '' }, htmlBlockAnchor: anchor }) as unknown as Annotation;

const lightFrame = (el: HTMLElement) => el.querySelector<HTMLIFrameElement>('iframe[data-html-embed-frame="inline"]');
const annotatableFrame = (el: HTMLElement) => el.querySelector<HTMLIFrameElement>('[data-html-embed-annotatable] iframe');
const pen = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-embed-annotate]');
const say = (source: unknown, data: unknown) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  });
const turnPenOn = async (el: HTMLElement) => {
  await act(async () => pen(el)!.click());
  await settle(60);
  await settle(60);
};
const PIN = {
  type: 'plannotator-bridge-selection',
  text: 'Pro, W3',
  rect: { top: 10, left: 10, width: 22, height: 50 },
  anchor: { selector: '#pro-3', tagName: 'rect', text: '' },
  pinpoint: true,
};
const composer = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
async function typeAndSave(value: string) {
  const box = composer()!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(box, value);
    else box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')).find((b) => b.textContent === 'Save' || b.textContent === 'Comment');
  await act(async () => button!.click());
  await settle();
}

describe.skipIf(!hasDom)('the block at rest', () => {
  test('a host that takes no comments has no pen', async () => {
    const el = await mount({ frameUrl: async () => EMBED_URL });
    expect(lightFrame(el)).not.toBeNull();
    expect(pen(el)).toBeNull();
  });

  test('with the pen off and no comment, the page is the light frame and the annotatable document is never asked for', async () => {
    const w = world();
    const el = await mount(w.embeds);
    expect(pen(el)).not.toBeNull();
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
    expect(pen(el)!.getAttribute('aria-label') ?? pen(el)!.getAttribute('title')).toBe('Annotate');
    expect(lightFrame(el)!.getAttribute('src')!.startsWith(`${EMBED_URL}#pn=`)).toBe(true);
    expect(annotatableFrame(el)).toBeNull();
    expect(w.documents).toEqual([]);
  });

  test('a block the host does not count (indexOf 0) has no pen', async () => {
    const w = world([], { indexOf: () => 0 });
    const el = await mount(w.embeds);
    expect(pen(el)).toBeNull();
  });
});

describe.skipIf(!hasDom)('the pen on', () => {
  test("the page is framed again from the embed's own document with the bridge in it, under the embed's sandbox", async () => {
    const w = world();
    const el = await mount(w.embeds);
    await say(lightFrame(el)!.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
    await turnPenOn(el);
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('true');
    expect(pen(el)!.getAttribute('aria-label') ?? pen(el)!.getAttribute('title')).toBe('Interact');
    expect(lightFrame(el)).toBeNull();
    const frame = annotatableFrame(el)!;
    expect(frame).not.toBeNull();
    // Exactly the embed's sandbox: an opaque origin, never allow-same-origin.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    // A served document under the host's policy for it, never a srcdoc (which would run under the window's).
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('src')).toMatch(/^\/api\/inbox\/embed-pages\/served\?__pnk=[0-9a-f]{32}/);
    // As tall as the light frame was: nothing jumps.
    expect(frame.style.height).toBe('300px');
    expect(w.documents.length).toBe(1);
    const document_ = w.documents[0]!;
    // Standards mode kept, the embed's own first script, then the bridge, all ahead of the agent's HTML.
    expect(document_.startsWith('<!doctype html>')).toBe(true);
    const bootstrap = document_.indexOf(EMBED_BOOTSTRAP);
    const bridge = document_.indexOf(bridgeModule!.BRIDGE_SCRIPT.slice(0, 200));
    const page = document_.indexOf(PAGE);
    expect(bootstrap).toBeGreaterThan(0);
    expect(bridge).toBeGreaterThan(bootstrap);
    expect(page).toBeGreaterThan(bridge);
  });

  test('an annotatable document that never speaks is never a blank box: back to the light frame, pen off, the code reachable', async () => {
    blockModule!.setEmbedReadyTimeoutForTests(300);
    try {
      const w = world();
      const el = await mount(w.embeds);
      await say(lightFrame(el)!.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
      expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('ready');
      await turnPenOn(el);
      expect(annotatableFrame(el)).not.toBeNull();
      // The second load never speaks.
      await settle(450);
      expect(annotatableFrame(el)).toBeNull();
      expect(lightFrame(el)).not.toBeNull();
      expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
      expect(el.querySelector<HTMLButtonElement>('[data-html-embed-code]')!.disabled).toBe(false);
      // The light frame has its own wait: it speaks, the block is ready; it would not, its code shows.
      await say(lightFrame(el)!.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
      expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('ready');
      // The pen again: the annotatable document is asked for again, and one that speaks stays.
      await turnPenOn(el);
      const frame = annotatableFrame(el)!;
      expect(frame).not.toBeNull();
      await say(frame.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
      await settle(450);
      expect(annotatableFrame(el)).not.toBeNull();
      expect(pen(el)!.getAttribute('aria-pressed')).toBe('true');
    } finally {
      blockModule!.setEmbedReadyTimeoutForTests(10_000);
    }
  });

  test('when neither load speaks, the code shows', async () => {
    blockModule!.setEmbedReadyTimeoutForTests(300);
    try {
      const w = world();
      const el = await mount(w.embeds);
      await say(lightFrame(el)!.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
      await turnPenOn(el);
      await settle(450);
      expect(lightFrame(el)).not.toBeNull();
      await settle(450);
      expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('failed');
      expect(el.querySelector('pre, code')).not.toBeNull();
    } finally {
      blockModule!.setEmbedReadyTimeoutForTests(10_000);
    }
  });

  test("the comment's words are the person's, typed in the window: nothing a message from the page carries becomes them", async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    const frame = annotatableFrame(el)!;
    // The page says a comment was written, every way it could spell it: nothing is added.
    for (const forged of [
      { type: 'plannotator-bridge-comment', id: 'x', text: 'FORGED' },
      { type: 'plannotator-bridge-create-mark', id: 'x', annotationType: 'comment', text: 'FORGED' },
      { type: 'plannotator-bridge-add-annotation', annotation: { id: 'x', type: 'COMMENT', text: 'FORGED', originalText: 'x' } },
      { pnEmbed: 1, kind: 'comment', text: 'FORGED' },
    ]) {
      await say(frame.contentWindow, forged);
    }
    expect(w.added).toEqual([]);
    expect(composer()).toBeNull();
    // A real pin, carrying words of its own beside what a pin carries: the box opens empty.
    await say(frame.contentWindow, { ...PIN, comment: 'FORGED', annotationText: 'FORGED', initialText: 'FORGED', draft: 'FORGED' });
    expect(composer()).not.toBeNull();
    expect(composer()!.value).toBe('');
    expect(w.added).toEqual([]);
    await typeAndSave('Label this dip.');
    expect(w.added.length).toBe(1);
    const comment = w.added[0]!;
    expect(comment.text).toBe('Label this dip.');
    expect(JSON.stringify(comment)).not.toContain('FORGED');
    // Where it sits: this block (its place, its source, its fence's lines) and the element the page named.
    expect(comment.blockId).toBe('block-1');
    expect(comment.htmlBlockAnchor).toEqual({ v: 1, index: 1, id: ID, sourceLine: [3, 5] });
    expect(comment.htmlAnchor).toEqual({ selector: '#pro-3', tagName: 'rect', text: '' });
    expect(comment.originalText).toBe('Pro, W3');
    // Back to Interact once the comment is added.
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
  });

  test('a pin from another window opens nothing, and an oversized anchor from the page is not kept', async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    const frame = annotatableFrame(el)!;
    await say({}, PIN);
    await say(window, PIN);
    expect(composer()).toBeNull();
    await say(frame.contentWindow, { ...PIN, anchor: { selector: `#${'a'.repeat(5000)}`, tagName: 'rect', text: '' } });
    expect(composer()).not.toBeNull();
    await typeAndSave('On this one.');
    expect(w.added.length).toBe(1);
    expect(w.added[0]!.htmlAnchor).toBeUndefined();
  });

  test("the frame's height is the embed's own report, from this frame only", async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    const frame = annotatableFrame(el)!;
    await say({}, { pnEmbed: 1, kind: 'height', height: 444 });
    expect(frame.style.height).not.toBe('444px');
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'height', height: 444 });
    expect(frame.style.height).toBe('444px');
    // The bridge's own measure does not size an inline frame.
    await say(frame.contentWindow, { type: 'plannotator-bridge-resize', height: 999 });
    expect(frame.style.height).toBe('444px');
  });

  test('off again: a pin from the page opens no box (the markers stay, nothing new is made)', async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    await act(async () => pen(el)!.click());
    await settle();
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
    // The annotatable document stays: going back would load the page again.
    const frame = annotatableFrame(el)!;
    expect(frame).not.toBeNull();
    await say(frame.contentWindow, PIN);
    expect(composer()).toBeNull();
    expect(w.added).toEqual([]);
  });

  test('Code turns the pen off with the page', async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-code]')!.click());
    await settle();
    expect(annotatableFrame(el)).toBeNull();
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
    expect(pen(el)!.disabled).toBe(true);
  });

  test('a host that cannot keep the annotatable document: the light frame comes back with the pen off, never a blank box', async () => {
    const w = world([], { frameUrl: async () => null });
    const el = await mount(w.embeds);
    await turnPenOn(el);
    await settle(60);
    expect(annotatableFrame(el)).toBeNull();
    expect(lightFrame(el)).not.toBeNull();
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
    expect(pen(el)!.disabled).toBe(false);
  });

  test('a comment the host did not keep is not left as the pen state: the pen is off either way', async () => {
    const w = world([], { onAdd: async () => false });
    const el = await mount(w.embeds);
    await turnPenOn(el);
    await say(annotatableFrame(el)!.contentWindow, PIN);
    await typeAndSave('Refused.');
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe.skipIf(!hasDom)("the annotatable frame's first address", () => {
  test("carries the embed's theme in its fragment, as the light frame's does (no flash), and stays the served document", async () => {
    const { servedFrameStartUrl } = await import('../html-viewer/HtmlViewer');
    const { embedFragment } = await import('@plannotator/core/html-embed');
    const start = embedFragment({ vars: { '--foreground': 'oklch(18% .02 260)', '--font-sans': '"Inter", system-ui' }, scheme: 'dark' }, 'inline');
    const address = servedFrameStartUrl(SERVED, 'http://localhost:1234/', start);
    expect(address).toBe(`http://localhost:1234${SERVED}${start}`);
    expect(new URL(address).pathname).toBe(SERVED);
  });
});

describe.skipIf(!hasDom)('saved comments', () => {
  test("a block with a comment of its own loads the annotatable document at once and names the comment; the pen stays off", async () => {
    const own = saved('c-own', { v: 1, index: 1, id: ID, sourceLine: [3, 5] });
    const w = world([own]);
    const el = await mount(w.embeds);
    await settle(60);
    expect(annotatableFrame(el)).not.toBeNull();
    expect(lightFrame(el)).toBeNull();
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-comments')).toBe('c-own');
    expect(w.documents.length).toBe(1);
  });

  test('a comment made on another source at this place is never drawn here: it is reported unanchored', async () => {
    const changed = saved('c-changed', { v: 1, index: 1, id: OTHER_ID, sourceLine: [3, 5] });
    const w = world([changed]);
    const el = await mount(w.embeds);
    await settle(60);
    expect(el.querySelector('[data-html-embed]')!.hasAttribute('data-html-embed-comments')).toBe(false);
    expect(w.reports).toContainEqual({ attempted: ['c-changed'], unanchored: ['c-changed'] });
  });

  test("a marker's click opens only this block's own comment: an id the page makes up, or another block's, opens nothing", async () => {
    const own = saved('c-own', { v: 1, index: 1, id: ID, sourceLine: [3, 5] });
    const changed = saved('c-changed', { v: 1, index: 1, id: OTHER_ID, sourceLine: [3, 5] });
    const elsewhere = saved('c-elsewhere', { v: 1, index: 2, id: ID, sourceLine: [9, 12] });
    const opened: Array<string | null> = [];
    const w = world([own, changed, elsewhere], { onSelect: (id) => void opened.push(id) });
    const el = await mount(w.embeds);
    await settle(60);
    const frame = annotatableFrame(el)!;
    expect(frame).not.toBeNull();
    for (const id of ['c-elsewhere', 'c-changed', 'msg_01K7SOMEONE', 'x'.repeat(200)]) {
      await say(frame.contentWindow, { type: 'plannotator-bridge-mark-click', id });
    }
    expect(opened).toEqual([]);
    await say(frame.contentWindow, { type: 'plannotator-bridge-mark-click', id: 'c-own' });
    expect(opened).toEqual(['c-own']);
  });

  test("another block's comment is not this block's: nothing is drawn or reported, and the light frame stays", async () => {
    const elsewhere = saved('c-elsewhere', { v: 1, index: 2, id: ID, sourceLine: [9, 12] });
    const w = world([elsewhere]);
    const el = await mount(w.embeds);
    await settle(60);
    expect(lightFrame(el)).not.toBeNull();
    expect(annotatableFrame(el)).toBeNull();
    expect(w.reports).toEqual([]);
    expect(w.documents).toEqual([]);
  });

  test("what the page says it could not find is reported with the block's own verdict, complete over its comments", async () => {
    const found = saved('c-found', { v: 1, index: 1, id: ID, sourceLine: [3, 5] });
    const lost = saved('c-lost', { v: 1, index: 1, id: ID, sourceLine: [3, 5] });
    const changed = saved('c-changed', { v: 1, index: 1, id: OTHER_ID, sourceLine: [3, 5] });
    const w = world([found, lost, changed]);
    const el = await mount(w.embeds);
    await settle(60);
    const frame = annotatableFrame(el)!;
    await say(frame.contentWindow, { type: 'plannotator-bridge-ready', protocolVersion: bridgeModule!.BRIDGE_PROTOCOL_VERSION });
    await say(frame.contentWindow, { type: 'plannotator-bridge-unanchored', ids: ['c-lost'] });
    await settle();
    const last = w.reports[w.reports.length - 1]!;
    expect([...last.attempted].sort()).toEqual(['c-changed', 'c-found', 'c-lost']);
    expect([...last.unanchored].sort()).toEqual(['c-changed', 'c-lost']);
  });

  test('the comment the host points at opens a clipped block', async () => {
    const own = saved('c-own', { v: 1, index: 1, id: ID, sourceLine: [3, 5] });
    const w = world([own]);
    const el = await mount(w.embeds);
    await settle(60);
    await say(annotatableFrame(el)!.contentWindow, { pnEmbed: 1, kind: 'height', height: 1200 });
    const clip = el.querySelector<HTMLElement>('[data-html-embed-clip]')!;
    expect(clip.style.maxHeight).toBe('480px');
    const pointed = world([own], { selectedId: 'c-own' });
    await act(async () => {
      root!.render(
        React.createElement(viewerModule!.Viewer, {
          blocks: parserModule!.parseMarkdownToBlocks(MARKDOWN),
          markdown: MARKDOWN,
          annotations: [],
          onAddAnnotation: () => {},
          onSelectAnnotation: () => {},
          selectedAnnotationId: null,
          mode: 'selection',
          taterMode: false,
          disableCodePathValidation: true,
          answerOnly: true,
          htmlEmbeds: { ...pointed.embeds, annotate: { ...pointed.embeds.annotate!, annotations: w.embeds.annotate!.annotations } },
        } as never),
      );
    });
    await settle();
    expect(el.querySelector<HTMLElement>('[data-html-embed-clip]')!.style.maxHeight).toBe('');
  });
});

const escape = async (target: EventTarget) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
};
/** A bar with no text: the bridge quotes it by its label, and says which element it is. */
const BAR_PIN = { ...PIN, text: '[element: Pro, W3]', targetKey: 't1', targetLabel: 'Pro, W3', context: { tag: 'rect', name: 'Pro, W3' } };
const STRUCTURE = { path: [1, 0, 0], ns: 'http://www.w3.org/2000/svg', attrs: [['fill', 'var(--chart-2)'], ['height', '118']] };

describe.skipIf(!hasDom)('Escape with the pen on', () => {
  test('turns the pen off and is used: what the host does on Escape (close the thread) does not also run', async () => {
    const hostEscapes: boolean[] = [];
    const hostListener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hostEscapes.push(event.defaultPrevented);
    };
    // The host's own listener was there first (the Inbox's is on the window, and skips a used key).
    window.addEventListener('keydown', hostListener);
    try {
      const w = world();
      const el = await mount(w.embeds);
      await turnPenOn(el);
      const event = await escape(pen(el)!);
      expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
      expect(event.defaultPrevented).toBe(true);
      expect(hostEscapes.filter((used) => !used)).toEqual([]);
      // With the pen off the key is the host's again.
      const next = await escape(pen(el)!);
      expect(next.defaultPrevented).toBe(false);
      expect(hostEscapes[hostEscapes.length - 1]).toBe(false);
    } finally {
      window.removeEventListener('keydown', hostListener);
    }
  });

  test('with the comment box open it closes the box first and the pen stays on; the next one turns the pen off', async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    await say(annotatableFrame(el)!.contentWindow, PIN);
    expect(composer()).not.toBeNull();
    await escape(composer()!);
    expect(composer()).toBeNull();
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('true');
    const second = await escape(document.body);
    expect(second.defaultPrevented).toBe(true);
    expect(pen(el)!.getAttribute('aria-pressed')).toBe('false');
    expect(w.added).toEqual([]);
  });
});

describe.skipIf(!hasDom)('the comment box on one element', () => {
  test('its header names the element by tag and label, and there is no chip until a second element is added', async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    const frame = annotatableFrame(el)!;
    await say(frame.contentWindow, BAR_PIN);
    const box = document.querySelector<HTMLElement>('[data-comment-popover]')!;
    expect(box.textContent).toContain('rect · Pro, W3');
    expect(box.textContent).not.toContain('[element:');
    expect(box.querySelector('[data-target-chips]')).toBeNull();
    await say(frame.contentWindow, { type: 'plannotator-bridge-multi-target-added', key: 't2', label: 'Pro, W4', text: '[element: Pro, W4]', context: { tag: 'rect' } });
    expect(document.querySelectorAll('[data-comment-popover] [data-target-chip]').length).toBe(2);
  });
});

describe.skipIf(!hasDom)('an element with no text and no id', () => {
  test("its structural anchor is kept with the comment, and a saved one is restored with the host's word that the source is the same", async () => {
    const w = world();
    const el = await mount(w.embeds);
    await turnPenOn(el);
    await say(annotatableFrame(el)!.contentWindow, { ...BAR_PIN, anchor: { selector: 'svg > rect', tagName: 'rect', structure: STRUCTURE } });
    await typeAndSave('Label this dip.');
    expect(w.added[0]!.htmlAnchor).toEqual({ selector: 'svg > rect', tagName: 'rect', structure: STRUCTURE } as never);
    expect(w.added[0]!.htmlBlockAnchor!.id).toBe(ID);
  });

  test('a saved one goes back to the page only on the source it was made on, flagged structural', async () => {
    const own = { ...saved('c-own', { v: 1, index: 1, id: ID, sourceLine: [3, 5] }), htmlAnchor: { selector: 'svg > rect', tagName: 'rect', structure: STRUCTURE } } as unknown as Annotation;
    const moved = { ...saved('c-moved', { v: 1, index: 1, id: OTHER_ID, sourceLine: [3, 5] }), htmlAnchor: { selector: 'svg > rect', tagName: 'rect', structure: STRUCTURE } } as unknown as Annotation;
    const w = world([own, moved]);
    const el = await mount(w.embeds);
    await settle(60);
    const frame = annotatableFrame(el)!;
    const posted: Record<string, unknown>[] = [];
    frame.contentWindow!.postMessage = ((message: Record<string, unknown>) => void posted.push(message)) as never;
    await say(frame.contentWindow, { type: 'plannotator-bridge-ready', protocolVersion: bridgeModule!.BRIDGE_PROTOCOL_VERSION });
    await settle(60);
    const marks = posted.filter((message) => message.type === 'plannotator-bridge-find-and-mark');
    expect(marks.map((message) => message.id)).toEqual(['c-own']);
    expect(marks[0]!.structural).toBe(true);
    expect((marks[0]!.anchor as { structure: unknown }).structure).toEqual(STRUCTURE);
    expect(posted.some((message) => message.type === 'plannotator-bridge-set-structural-anchors' && message.active === true)).toBe(true);
    // The one made on another source is never sent to this page: it is unanchored.
    expect(w.reports.some((report) => report.unanchored.includes('c-moved'))).toBe(true);
  });

  test('a structural anchor past the caps, or forged, is not kept by the window', async () => {
    for (const structure of [
      { ...STRUCTURE, path: Array(65).fill(0) },
      { ...STRUCTURE, attrs: Array.from({ length: 25 }, (_, i) => [`a${String(i).padStart(2, '0')}`, 'v']) },
      { ...STRUCTURE, attrs: [['fill', 'v'.repeat(161)]] },
      { ...STRUCTURE, path: [1, '0', 0] },
    ]) {
      const w = world();
      const el = await mount(w.embeds);
      await turnPenOn(el);
      await say(annotatableFrame(el)!.contentWindow, { ...BAR_PIN, anchor: { selector: 'svg > rect', tagName: 'rect', structure } });
      await typeAndSave('On this one.');
      expect(w.added.length).toBe(1);
      expect(w.added[0]!.htmlAnchor).toBeUndefined();
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
      host = null;
      gateModule!.resetEmbedGateForTests();
    }
  });
});
