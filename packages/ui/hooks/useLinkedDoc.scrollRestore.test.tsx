/**
 * Back from a linked document returns the reader to where they were in the
 * root document (#2082).
 *
 * The failure this guards: following a link from the middle of a long
 * document, then pressing Back, landed the reader at the top (or the bottom)
 * of the document instead of the paragraph they left.
 *
 * happy-dom has no layout, so the scroll viewport and the blocks carry a tiny
 * stand-in geometry: every block is BLOCK_HEIGHT tall, stacked from the
 * viewport's top, and moves with the viewport's scrollTop.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useCallback, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useLinkedDoc, type UseLinkedDocReturn } from './useLinkedDoc';
import type { ViewerHandle } from '../components/Viewer';
import type { Annotation, DocumentRenderAs, ImageAttachment } from '../types';

const hasDom = typeof document !== 'undefined';

const noopViewerHandle: ViewerHandle = {
  removeHighlight: () => {},
  clearAllHighlights: () => {},
  applySharedAnnotations: () => {},
};

const ROOT_MARKDOWN = 'root';
const LONG_MARKDOWN = '# Long';
const ROOT_BLOCKS = 60;
const LINKED_BLOCKS = 3;

/** Height of every block; a test changes it to model a reflowed column. */
let blockHeight = 100;

/**
 * Who is writing scrollTop. A write while `writer` is 'host' is the host's own
 * scroll; any other write is the restore's. `restoreWrites` counts those, and a
 * running host smooth scroll is aborted by one, the way Chromium cancels a
 * smooth scroll when scrollTop is assigned mid-animation.
 */
let writer: 'restore' | 'host' = 'restore';
let restoreWrites = 0;
let hostAnimationAborted = false;
let hostAnimating = false;

function makeViewport(): HTMLElement {
  const el = document.createElement('main');
  // Like a browser, the scroll offset is clamped to the content's height, so a
  // short document pulls it back to the top for good. (The clamp is applied on
  // read here; each test reads scrollTop while the short document is shown.)
  const maxTop = () => Math.max(0, el.querySelectorAll('[data-block-id]').length * blockHeight - 500);
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => { top = Math.min(top, maxTop()); return top; },
    set: (value: number) => {
      if (writer !== 'host') {
        restoreWrites++;
        if (hostAnimating) hostAnimationAborted = true;
      }
      top = Math.min(Math.max(0, value), maxTop());
    },
  });
  el.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 800, bottom: 500, width: 800, height: 500, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return el;
}

function Blocks({ viewport, count }: { viewport: HTMLElement; count: number }) {
  const place = useCallback((el: HTMLDivElement | null, index: number) => {
    if (!el) return;
    el.getBoundingClientRect = () => {
      const top = index * blockHeight - viewport.scrollTop;
      return {
        top, bottom: top + blockHeight, left: 0, right: 800, width: 800, height: blockHeight,
        x: 0, y: top, toJSON: () => ({}),
      } as DOMRect;
    };
  }, [viewport]);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} data-block-id={`block-${i}`} ref={(el) => place(el, i)}>block {i}</div>
      ))}
    </>
  );
}

function Harness(props: {
  viewport: HTMLElement;
  passViewport: boolean;
  onLatest: (v: UseLinkedDocReturn) => void;
}) {
  const [markdown, setMarkdown] = useState(ROOT_MARKDOWN);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [renderAs, setRenderAs] = useState<DocumentRenderAs>('markdown');
  const [rawHtml, setRawHtml] = useState('');
  const [shareHtml, setShareHtml] = useState('');
  const viewerRef = useRef<ViewerHandle | null>(noopViewerHandle);

  const hook = useLinkedDoc({
    markdown, annotations, selectedAnnotationId, globalAttachments,
    setMarkdown, setAnnotations, setSelectedAnnotationId, setGlobalAttachments,
    renderAs, rawHtml, shareHtml, setRenderAs, setRawHtml, setShareHtml,
    viewerRef,
    sidebar: { open: () => {} },
    scrollViewport: props.passViewport ? props.viewport : undefined,
  });
  props.onLatest(hook);

  // The root document renders as many blocks; a linked HTML document has none
  // (it scrolls inside its own frame), a linked markdown document a few.
  // A long linked document (a file of a review of several files) renders as
  // many blocks as the root.
  const count = (markdown === ROOT_MARKDOWN || markdown.startsWith(LONG_MARKDOWN)) && renderAs === 'markdown'
    ? ROOT_BLOCKS
    : renderAs === 'html' ? 0 : LINKED_BLOCKS;
  return <Blocks viewport={props.viewport} count={count} />;
}

let root: Root | null = null;
let viewport: HTMLElement | null = null;

async function mount(passViewport = true): Promise<{ get: () => UseLinkedDocReturn; viewport: HTMLElement }> {
  viewport = makeViewport();
  document.body.appendChild(viewport);
  root = createRoot(viewport);
  let latest: UseLinkedDocReturn | null = null;
  const vp = viewport;
  await act(async () => {
    root!.render(<Harness viewport={vp} passViewport={passViewport} onLatest={(v) => { latest = v; }} />);
  });
  return {
    get: () => {
      if (!latest) throw new Error('hook was not mounted');
      return latest;
    },
    viewport: vp,
  };
}

/** Let the restore's frames and its settle timers run. */
async function settle(ms = 1200) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/** Wait until `check` holds, up to `ms`. */
async function until(check: () => boolean, ms = 1000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

/** The host scrolls by itself: set at once, or animated over `ms`. */
function hostScroll(vp: HTMLElement, to: number) {
  writer = 'host';
  vp.scrollTop = to;
  writer = 'restore';
}
async function hostSmoothScroll(vp: HTMLElement, to: number, ms: number, startDelay = 0) {
  hostAnimating = true;
  hostAnimationAborted = false;
  await act(async () => { await new Promise((r) => setTimeout(r, startDelay)); });
  const from = vp.scrollTop;
  const steps = 10;
  for (let i = 1; i <= steps && !hostAnimationAborted; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, ms / steps)); });
    if (hostAnimationAborted) break;
    hostScroll(vp, from + ((to - from) * i) / steps);
  }
  hostAnimating = false;
}

/** The first block whose bottom is below the viewport's top, and its top. */
function topBlock(vp: HTMLElement): { id: string | null; top: number } {
  for (const el of vp.querySelectorAll<HTMLElement>('[data-block-id]')) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 1) return { id: el.getAttribute('data-block-id'), top: rect.top };
  }
  return { id: null, top: 0 };
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  viewport?.remove();
  viewport = null;
  blockHeight = 100;
  writer = 'restore';
  restoreWrites = 0;
  hostAnimationAborted = false;
  hostAnimating = false;
});

async function openNotes(get: () => UseLinkedDocReturn, filepath = '/site/notes.md') {
  await act(async () => {
    get().openLoaded({ filepath, markdown: '# Notes', renderAs: 'markdown' });
  });
}

describe.if(hasDom)('useLinkedDoc back() scroll restore', () => {
  test('back from a linked HTML document returns to the block the reader left', async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350; // block-23, its top 50px above the viewport's
    expect(topBlock(vp)).toEqual({ id: 'block-23', top: -50 });

    await act(async () => {
      get().openLoaded(
        { filepath: '/site/figure.html', rawHtml: '<h1>Figure</h1>', renderAs: 'html' },
        undefined,
        { revealSidebar: false },
      );
    });
    // The HTML document fills the viewport; nothing in the main pane scrolls.
    expect(vp.scrollTop).toBe(0);

    await act(async () => { get().back(); });
    await settle();

    expect(topBlock(vp)).toEqual({ id: 'block-23', top: -50 });
  });

  test('back from a linked markdown document anchors by block, not by pixels', async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350;

    await act(async () => {
      get().openLoaded({ filepath: '/site/notes.md', markdown: '# Notes', renderAs: 'markdown' });
    });
    expect(vp.scrollTop).toBe(0); // three short blocks clamp the scroll

    // The column reflowed while the reader was away (the sidebar changed the
    // reading width): every block is now shorter, so 2350px is a different
    // place. The reader must still land on block-23.
    blockHeight = 80;
    await act(async () => { get().back(); });
    await settle();

    expect(topBlock(vp)).toEqual({ id: 'block-23', top: -50 });
    expect(vp.scrollTop).toBe(23 * 80 + 50);
  });

  test('a scroll the reader makes while the restore settles wins', async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350;
    await openNotes(get);
    expect(vp.scrollTop).toBe(0);
    await act(async () => { get().back(); });
    // The first re-anchor lands; the reader scrolls before the later passes.
    await until(() => topBlock(vp).id === 'block-23');
    hostScroll(vp, 400);
    await settle();
    expect(vp.scrollTop).toBe(400);
  });

  test("the reader's own input ends the restore, even before the page moves", async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350;
    await openNotes(get);
    expect(vp.scrollTop).toBe(0);
    await act(async () => { get().back(); });
    await until(() => topBlock(vp).id === 'block-23');
    const at = vp.scrollTop;
    restoreWrites = 0;
    window.dispatchEvent(new Event('wheel'));
    // A late image would make a later pass re-anchor; after the reader's
    // input there is no later pass.
    blockHeight = 80;
    await settle();
    expect(restoreWrites).toBe(0);
    expect(vp.scrollTop).toBe(Math.min(at, 60 * 80 - 500));
  });

  test('a host scroll during the settle window wins once it cancels the restore', async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350;
    await openNotes(get);
    expect(vp.scrollTop).toBe(0);
    await act(async () => { get().back(); });
    await until(() => topBlock(vp).id === 'block-23');
    // The jump to a comment: the host cancels the restore, then smooth-scrolls
    // to the comment. Its first step lands after the restore's next pass
    // would have run, so without the cancel that pass would abort it.
    restoreWrites = 0;
    get().cancelScrollRestore();
    blockHeight = 90; // late layout: a live restore would re-anchor here
    await hostSmoothScroll(vp, 400, 300, 200);
    await settle();
    expect(hostAnimationAborted).toBe(false);
    expect(restoreWrites).toBe(0);
    expect(vp.scrollTop).toBe(400);
  });

  test('back({ restoreScroll: false }) leaves the scroll to the caller', async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350;
    await openNotes(get);
    expect(vp.scrollTop).toBe(0);
    restoreWrites = 0;
    await act(async () => { get().back({ restoreScroll: false }); });
    await settle();
    expect(restoreWrites).toBe(0);
    expect(vp.scrollTop).toBe(0);
  });

  test('A → B → Back returns to the place in the root, not in A', async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350;
    await openNotes(get, '/site/a.md');
    expect(vp.scrollTop).toBe(0);
    await openNotes(get, '/site/b.md');
    expect(get().filepath).toBe('/site/b.md');
    await act(async () => { get().back(); });
    await settle();
    expect(topBlock(vp)).toEqual({ id: 'block-23', top: -50 });
  });

  // A review of several files (#2128): each file is a linked document, and
  // Back from a document it links to reopens that file instead of calling
  // back(). The reader's place in it must come back the same way.
  async function openLong(get: () => UseLinkedDocReturn, options?: { restoreScroll?: boolean }) {
    await act(async () => {
      get().openLoaded(
        { filepath: '/site/review-alpha.md', markdown: `${LONG_MARKDOWN} alpha`, renderAs: 'markdown' },
        undefined,
        options,
      );
    });
  }

  test('reopening a linked document with restoreScroll returns to where the reader left it', async () => {
    const { get, viewport: vp } = await mount();
    await openLong(get);
    vp.scrollTop = 2350;
    expect(topBlock(vp)).toEqual({ id: 'block-23', top: -50 });
    await openNotes(get, '/site/linked.md');
    expect(vp.scrollTop).toBe(0);

    blockHeight = 80; // the column reflowed meanwhile: anchored by block
    await openLong(get, { restoreScroll: true });
    expect(get().filepath).toBe('/site/review-alpha.md');
    await settle();
    expect(topBlock(vp)).toEqual({ id: 'block-23', top: -50 });
  });

  test('the same holds when the document left was a linked HTML page', async () => {
    const { get, viewport: vp } = await mount();
    await openLong(get);
    vp.scrollTop = 2350;
    await act(async () => {
      get().openLoaded(
        { filepath: '/site/module.html', rawHtml: '<h1>Module</h1>', renderAs: 'html' },
        undefined,
        { revealSidebar: false },
      );
    });
    expect(vp.scrollTop).toBe(0);
    await openLong(get, { restoreScroll: true });
    await settle();
    expect(topBlock(vp)).toEqual({ id: 'block-23', top: -50 });
  });

  test('reopening a linked document without restoreScroll leaves scrolling alone', async () => {
    const { get, viewport: vp } = await mount();
    await openLong(get);
    vp.scrollTop = 2350;
    await openNotes(get, '/site/linked.md');
    expect(vp.scrollTop).toBe(0);
    restoreWrites = 0;
    await openLong(get);
    await settle();
    expect(restoreWrites).toBe(0);
    expect(vp.scrollTop).toBe(0);
  });

  test('unmounting while the restore settles stops it', async () => {
    const { get, viewport: vp } = await mount();
    vp.scrollTop = 2350;
    await openNotes(get);
    expect(vp.scrollTop).toBe(0);
    await act(async () => { get().back(); });
    await act(async () => { root!.unmount(); });
    root = null;
    restoreWrites = 0;
    await settle();
    expect(restoreWrites).toBe(0);
  });

  test('without a scroll viewport, back() leaves scrolling alone', async () => {
    const { get, viewport: vp } = await mount(false);
    vp.scrollTop = 2350;
    await act(async () => {
      get().openLoaded({ filepath: '/site/notes.md', markdown: '# Notes', renderAs: 'markdown' });
    });
    expect(vp.scrollTop).toBe(0);
    await act(async () => { get().back(); });
    await settle();
    expect(vp.scrollTop).toBe(0);
  });
});
