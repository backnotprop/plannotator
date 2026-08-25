/**
 * Live-session protocol contract (DOM-gated).
 *
 * Parent side: with a live session configured, messages from a wrong origin
 * or without the session token never reach parseBridgeMessage effects, and
 * every outbound post carries the token with the live targetOrigin.
 *
 * Bridge side: executes the composed live body (JSON config prelude +
 * LIVE_BRIDGE_BOOTSTRAP + BRIDGE_SCRIPT) in the test window with a stubbed
 * parent/top pair so the frame gate passes, then asserts the live gate:
 * pinpoint-only clamp, vim ignored, ready pageUrl, coalesced page-change,
 * inbound token checks, and the bootstrap-installed CSS. The srcdoc suites
 * run the SAME script with no config and pass unmodified; that is the
 * regression proof that live behavior is inert without it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Annotation } from '../../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;
const bridgeModule = hasDom ? await import('./bridge-script') : null;

const LIVE_ORIGIN = 'http://127.0.0.1:4567';
const LIVE_TOKEN = 'live-token-1234';

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe.if(hasDom)('page-change message validation (trust boundary)', () => {
  test('accepts a bounded pageUrl string', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: '/settings?tab=git',
    })).toEqual({ type: 'plannotator-bridge-page-change', pageUrl: '/settings?tab=git' });
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: 'x'.repeat(hookModule!.MAX_PAGE_URL_LENGTH),
    })).not.toBeNull();
  });

  test('rejects oversize, empty, and non-string pageUrls', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: 'x'.repeat(hookModule!.MAX_PAGE_URL_LENGTH + 1),
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: '',
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: 42,
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
    })).toBeNull();
  });

  test('rejectsLiveMessage keys on exact origin and token', () => {
    const live = { origin: LIVE_ORIGIN, token: LIVE_TOKEN };
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, { token: LIVE_TOKEN })).toBe(false);
    expect(hookModule!.rejectsLiveMessage(live, 'http://evil.example', { token: LIVE_TOKEN })).toBe(true);
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, { token: 'wrong' })).toBe(true);
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, {})).toBe(true);
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, null)).toBe(true);
  });
});

describe.if(hasDom)('live parent side (HtmlViewer with src + liveSession)', () => {
  async function mountLiveViewer(options: {
    onAdd?: (ann: Annotation) => void;
    onPageChange?: (pageUrl: string) => void;
    annotations?: Annotation[];
    currentPageUrl?: string;
    annotateModeActive?: boolean;
    onAnnotateModeExit?: () => void;
    onAnnotateModeToggle?: () => void;
  } = {}) {
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml=""
          src="about:blank"
          liveSession={{ origin: LIVE_ORIGIN, token: LIVE_TOKEN }}
          currentPageUrl={options.currentPageUrl ?? '/'}
          onPageChange={options.onPageChange}
          annotations={options.annotations ?? []}
          onAddAnnotation={options.onAdd ?? (() => {})}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          annotateModeActive={options.annotateModeActive}
          onAnnotateModeExit={options.onAnnotateModeExit}
          onAnnotateModeToggle={options.onAnnotateModeToggle}
          fullViewport
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('live iframe missing');
    const postedToIframe: Array<{ data: Record<string, unknown>; targetOrigin: unknown }> = [];
    const realPost = iframe.contentWindow.postMessage.bind(iframe.contentWindow);
    (iframe.contentWindow as unknown as { postMessage: (data: unknown, origin?: unknown) => void }).postMessage =
      ((data: unknown, targetOrigin?: unknown, ...rest: unknown[]) => {
        if (data && typeof data === 'object') {
          postedToIframe.push({ data: data as Record<string, unknown>, targetOrigin });
        }
        return (realPost as (...args: unknown[]) => unknown)(data, targetOrigin, ...rest);
      }) as typeof iframe.contentWindow.postMessage;
    const post = async (data: Record<string, unknown>, origin: string = LIVE_ORIGIN) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          origin,
          data,
        }));
      });
    };
    return { iframe, post, postedToIframe };
  }

  const selectionMessage = {
    type: 'plannotator-bridge-selection',
    text: 'Live target',
    rect: { top: 10, left: 10, width: 120, height: 24 },
    anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Live target' },
    pinpoint: true,
  };

  test('renders a src iframe with no sandbox and no srcdoc', async () => {
    const { iframe } = await mountLiveViewer();
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(iframe.hasAttribute('sandbox')).toBe(false);
    expect(iframe.hasAttribute('srcdoc')).toBe(false);
  });

  test('a message from the wrong origin never reaches the selection flow', async () => {
    const { post } = await mountLiveViewer();
    await post({ ...selectionMessage, token: LIVE_TOKEN }, 'http://evil.example');
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('a message without (or with a wrong) token is ignored', async () => {
    const { post } = await mountLiveViewer();
    await post(selectionMessage);
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    await post({ ...selectionMessage, token: 'forged' });
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('a correctly authenticated pinpoint selection opens the composer', async () => {
    const { post } = await mountLiveViewer();
    await post({ ...selectionMessage, token: LIVE_TOKEN });
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
  });

  test('outbound posts carry the token and the live targetOrigin', async () => {
    const { post, postedToIframe } = await mountLiveViewer({
      annotations: [],
    });
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/', token: LIVE_TOKEN });
    expect(postedToIframe.length).toBeGreaterThan(0);
    for (const posted of postedToIframe) {
      expect(posted.data.token).toBe(LIVE_TOKEN);
      expect(posted.targetOrigin).toBe(LIVE_ORIGIN);
    }
    // The bridge-config posts a ready surface always sends.
    const types = postedToIframe.map((p) => p.data.type);
    expect(types).toContain('plannotator-bridge-set-input-method');
  });

  test('an unauthenticated ready is ignored; an authenticated one forwards its pageUrl', async () => {
    const pages: string[] = [];
    const { post, postedToIframe } = await mountLiveViewer({ onPageChange: (p) => pages.push(p) });
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/spoofed' }, LIVE_ORIGIN);
    expect(pages).toEqual([]);
    expect(postedToIframe.length).toBe(0);
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/dashboard?x=1', token: LIVE_TOKEN });
    expect(pages).toEqual(['/dashboard?x=1']);
  });

  test('page-change messages update the parent through onPageChange', async () => {
    const pages: string[] = [];
    const { post } = await mountLiveViewer({ onPageChange: (p) => pages.push(p) });
    await post({ type: 'plannotator-bridge-page-change', pageUrl: '/about', token: LIVE_TOKEN });
    expect(pages).toEqual(['/about']);
    // Oversize pageUrl is rejected at the parse boundary.
    await post({
      type: 'plannotator-bridge-page-change',
      pageUrl: 'x'.repeat(3000),
      token: LIVE_TOKEN,
    });
    expect(pages).toEqual(['/about']);
  });

  test('restore filters to the current page; other pages annotations are held back', async () => {
    const pageAnn = (id: string, pageUrl: string): Annotation => ({
      id,
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: 'COMMENT' as Annotation['type'],
      text: 'c',
      originalText: 'o',
      createdA: 1,
      pageUrl,
    } as Annotation);
    const { post, postedToIframe } = await mountLiveViewer({
      annotations: [pageAnn('on-home', '/'), pageAnn('on-about', '/about')],
      currentPageUrl: '/',
    });
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/', token: LIVE_TOKEN });
    const restores = postedToIframe.filter((p) => p.data.type === 'plannotator-bridge-find-and-mark');
    expect(restores.map((p) => p.data.id)).toEqual(['on-home']);
    // Numbering still ships the FULL list (global numbers across pages).
    const syncs = postedToIframe.filter((p) => p.data.type === 'plannotator-bridge-sync-annotations');
    expect(syncs.length).toBeGreaterThan(0);
    expect((syncs.at(-1)!.data.annotations as Array<{ id: string }>).map((a) => a.id)).toEqual([
      'on-home',
      'on-about',
    ]);
  });

  test('the Interact/Annotate mode is pushed on EVERY bridge ready, so it survives page-change reloads and bridge re-injection', async () => {
    const { post, postedToIframe } = await mountLiveViewer({ annotateModeActive: false });
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/', token: LIVE_TOKEN });
    const modePosts = () =>
      postedToIframe.filter((p) => p.data.type === 'plannotator-bridge-set-annotate-mode');
    expect(modePosts().length).toBe(1);
    expect(modePosts()[0]!.data.active).toBe(false);
    // A live navigation / HMR reload re-injects the bridge and posts ready
    // again from a FRESH document: the mode must be re-established, not lost
    // to the fresh bridge's default.
    postedToIframe.length = 0;
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/about', token: LIVE_TOKEN });
    expect(modePosts().length).toBe(1);
    expect(modePosts()[0]!.data.active).toBe(false);
  });

  test('annotate-exit and annotate-toggle reach the parent callbacks only when authenticated', async () => {
    let exits = 0;
    let toggles = 0;
    const { post } = await mountLiveViewer({
      annotateModeActive: true,
      onAnnotateModeExit: () => { exits += 1; },
      onAnnotateModeToggle: () => { toggles += 1; },
    });
    await post({ type: 'plannotator-bridge-annotate-exit' });
    await post({ type: 'plannotator-bridge-annotate-toggle', token: 'forged' });
    await post({ type: 'plannotator-bridge-annotate-exit', token: LIVE_TOKEN }, 'http://evil.example');
    expect(exits).toBe(0);
    expect(toggles).toBe(0);
    await post({ type: 'plannotator-bridge-annotate-exit', token: LIVE_TOKEN });
    await post({ type: 'plannotator-bridge-annotate-toggle', token: LIVE_TOKEN });
    expect(exits).toBe(1);
    expect(toggles).toBe(1);
  });
});

describe.if(hasDom)('live bridge gate (composed body in the eval harness)', () => {
  type ParentPost = { data: Record<string, unknown>; targetOrigin: unknown };
  const parentPosts: ParentPost[] = [];
  const fakeParent = {
    postMessage(data: unknown, targetOrigin?: unknown) {
      if (data && typeof data === 'object') {
        parentPosts.push({ data: data as Record<string, unknown>, targetOrigin });
      }
    },
  };
  const editorOrigin = 'http://localhost:4100';
  const bridgeToken = 'bridge-live-token';

  // The live bridge is evaluated against a DEDICATED iframe window so its DOM
  // side effects (overlay hosts, hover boxes, pinpoint listeners, the page
  // MutationObserver) stay contained: the srcdoc suites run the same script
  // against the shared global document later in this process and must not see
  // a second live instance there. Same-realm Function parameters rebind the
  // globals the bridge touches, including the parent/top pair the frame gate
  // reads.
  let bridgeFrame: HTMLIFrameElement;
  let bridgeWindow: Window & { __plannotatorLiveConfig?: unknown };
  let bridgeDocument: Document;

  // Failed dead-target searches carry a wall-clock backoff (300ms doubling
  // to a 5s cap) on top of the generation gate. Tests asserting legitimate
  // recovery jump the bridge's monotonic clock (performance.now resolves in
  // the test realm's scope chain) instead of sleeping.
  let monotonicOffsetMs = 0;
  const realPerformanceNow = performance.now.bind(performance);
  beforeAll(() => {
    performance.now = () => realPerformanceNow() + monotonicOffsetMs;
  });
  afterAll(() => {
    performance.now = realPerformanceNow;
  });

  function postToBridge(data: Record<string, unknown>, origin: string = editorOrigin) {
    bridgeWindow.dispatchEvent(new MessageEvent('message', {
      data,
      origin,
      // The bridge accepts messages whose source is its parent window.
      source: fakeParent as unknown as Window,
    }));
  }

  beforeAll(() => {
    bridgeFrame = document.createElement('iframe');
    // documentElement, not body: the file-level afterEach clears body
    // children between tests and must not tear the harness frame down.
    document.documentElement.appendChild(bridgeFrame);
    if (!bridgeFrame.contentWindow || !bridgeFrame.contentDocument) {
      throw new Error('bridge harness iframe missing contentWindow');
    }
    bridgeWindow = bridgeFrame.contentWindow as typeof bridgeWindow;
    bridgeDocument = bridgeFrame.contentDocument;
    const config = {
      live: true,
      token: bridgeToken,
      editorOrigins: [editorOrigin, 'http://127.0.0.1:4100'],
      css: '.pn-live-probe { color: red; }',
    };
    bridgeWindow.__plannotatorLiveConfig = config;
    const body = bridgeModule!.LIVE_BRIDGE_BOOTSTRAP + '\n' + bridgeModule!.BRIDGE_SCRIPT;
    // Rebind the globals the bridge reads: its window/document/location/
    // history are the iframe's, and parent/top are the fake editor pair so
    // the frame gate passes (window !== parent, parent === top).
    const run = new Function(
      'window',
      'document',
      'location',
      'history',
      'parent',
      'top',
      body,
    );
    run(
      bridgeWindow,
      bridgeDocument,
      bridgeWindow.location,
      bridgeWindow.history,
      fakeParent,
      fakeParent,
    );
    if (parentPosts.length === 0) {
      // Environments that report a loading readyState defer onReady.
      bridgeDocument.dispatchEvent(new Event('DOMContentLoaded'));
    }
  });

  afterAll(() => {
    bridgeFrame.remove();
  });

  test('the bootstrap installs the annotation CSS from the config', () => {
    const style = bridgeDocument.querySelector('style[data-plannotator-live-css]');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('.pn-live-probe');
  });

  test('ready carries the current pageUrl and token, posted once per listed editor origin', () => {
    // The server cannot know which origin form (localhost vs 127.0.0.1) the
    // editor tab was opened on: the bridge posts to every listed origin and
    // the browser delivers only the matching one. An editor opened at
    // 127.0.0.1 must not silently miss ready.
    const readies = parentPosts.filter((p) => p.data.type === 'plannotator-bridge-ready');
    expect(readies.map((p) => p.targetOrigin)).toEqual([editorOrigin, 'http://127.0.0.1:4100']);
    for (const ready of readies) {
      expect(ready.data.token).toBe(bridgeToken);
      expect(ready.data.pageUrl).toBe(
        (bridgeWindow.location.pathname + bridgeWindow.location.search).slice(0, 2048),
      );
    }
  });

  /** One logical post goes out once per listed editor origin; count only the
   * primary origin's copy so assertions read in logical messages. */
  function primaryPosts(type: string): ParentPost[] {
    return parentPosts.filter(
      (p) => p.data.type === `plannotator-bridge-${type}` && p.targetOrigin === editorOrigin,
    );
  }

  function selectionPosts(): ParentPost[] {
    return primaryPosts('selection');
  }

  /** Dispatch a real cancelable click and report whether the bridge captured
   * it (preventDefault + a posted selection) or let it through to the page. */
  function clickProbe(el: HTMLElement): { prevented: boolean; selections: number } {
    const before = selectionPosts().length;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    return { prevented: click.defaultPrevented, selections: selectionPosts().length - before };
  }

  function pressEscape() {
    bridgeDocument.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  }

  function probeButton(): HTMLElement {
    let btn = bridgeDocument.getElementById('live-probe-button');
    if (!btn) {
      btn = bridgeDocument.createElement('button');
      btn.id = 'live-probe-button';
      btn.textContent = 'Register a click';
      bridgeDocument.body.appendChild(btn);
    }
    return btn as HTMLElement;
  }

  /** Simulate a real text drag over `el`: select its contents, then run the
   * mousedown → >4px mousemove (button held) → mouseup sequence the drag
   * arming keys off. Returns after the 10ms selection pass has run. */
  async function dragSelectContents(el: HTMLElement) {
    const range = bridgeDocument.createRange();
    range.selectNodeContents(el);
    const sel = bridgeWindow.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: 40, clientY: 12 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 12 }));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  function dragProbeParagraph(): HTMLElement {
    let p = bridgeDocument.getElementById('live-drag-probe');
    if (!p) {
      p = bridgeDocument.createElement('p');
      p.id = 'live-drag-probe';
      p.textContent = 'Draggable live copy';
      bridgeDocument.body.appendChild(p);
    }
    return p as HTMLElement;
  }

  test('live sessions start ARMED: pinpoint capture and the cursor affordance are live before any parent message', () => {
    // No set-annotate-mode or set-input-method has arrived yet — the default
    // must already be pinpoint-armed on the live surface.
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(true);
    const probe = clickProbe(probeButton());
    expect(probe.prevented).toBe(true);
    expect(probe.selections).toBe(1);
    expect(selectionPosts().at(-1)!.data.pinpoint).toBe(true);
    postToBridge({ type: 'plannotator-bridge-cancel-selection', token: bridgeToken });
  });

  test('forged disarm attempts (no token / wrong origin) are ignored', () => {
    postToBridge({ type: 'plannotator-bridge-set-annotate-mode', active: false });
    postToBridge({ type: 'plannotator-bridge-set-input-method', method: 'drag' });
    postToBridge(
      { type: 'plannotator-bridge-set-annotate-mode', active: false, token: bridgeToken },
      'http://evil.example',
    );
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(true);
    const probe = clickProbe(probeButton());
    expect(probe.prevented).toBe(true);
    expect(probe.selections).toBe(1);
    postToBridge({ type: 'plannotator-bridge-cancel-selection', token: bridgeToken });
  });

  test('an authenticated drag input-method request stays clamped to pinpoint (clicks still pin)', () => {
    postToBridge({ type: 'plannotator-bridge-set-input-method', method: 'drag', token: bridgeToken });
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(true);
    const probe = clickProbe(probeButton());
    expect(probe.prevented).toBe(true);
    expect(probe.selections).toBe(1);
    expect(selectionPosts().at(-1)!.data.pinpoint).toBe(true);
    postToBridge({ type: 'plannotator-bridge-cancel-selection', token: bridgeToken });
  });

  test('ARMED: a real text drag posts a drag selection, and its trailing click never re-pins', async () => {
    const p = dragProbeParagraph();
    const before = selectionPosts().length;
    await dragSelectContents(p);
    const posts = selectionPosts();
    expect(posts.length).toBe(before + 1);
    expect(posts.at(-1)!.data.text).toBe('Draggable live copy');
    expect(posts.at(-1)!.data.pinpoint).toBeFalsy();
    // The click event that follows a completed drag must not clobber the
    // drag selection with a pinpoint pin.
    const trailing = clickProbe(p);
    expect(trailing.prevented).toBe(false);
    expect(trailing.selections).toBe(0);
    postToBridge({ type: 'plannotator-bridge-cancel-selection', token: bridgeToken });
    bridgeWindow.getSelection()!.removeAllRanges();
  });

  test('ARMED: a drifted click (>4px travel, no selection) still pinpoint-pins and never reaches the page', async () => {
    // Trackpad reality: mousedown → a few pixels of travel → mouseup with
    // nothing selected. The >4px drift alone must not arm the trailing-click
    // suppression — that regression both swallowed the pin AND let the
    // unprevented click through to the page.
    const btn = probeButton();
    bridgeWindow.getSelection()!.removeAllRanges();
    let pageClicks = 0;
    const pageListener = () => { pageClicks += 1; };
    btn.addEventListener('click', pageListener);
    try {
      const before = selectionPosts().length;
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
      btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: 15, clientY: 12 }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: 15, clientY: 12 }));
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 15, clientY: 12 });
      btn.dispatchEvent(click);
      // The click pinned the element under the pointer...
      expect(click.defaultPrevented).toBe(true);
      expect(selectionPosts().length).toBe(before + 1);
      expect(selectionPosts().at(-1)!.data.pinpoint).toBe(true);
      // ...and the page's own handler never saw it (capture-phase stop).
      expect(pageClicks).toBe(0);
      // No trailing drag-selection pass runs to clear the draft just opened.
      const clearsBefore = primaryPosts('selection-clear').length;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(primaryPosts('selection-clear').length).toBe(clearsBefore);
    } finally {
      btn.removeEventListener('click', pageListener);
    }
    postToBridge({ type: 'plannotator-bridge-cancel-selection', token: bridgeToken });
    bridgeWindow.getSelection()!.removeAllRanges();
  });

  test('Esc with only a hover outline: hover clears AND annotate-exit posts on the SAME press', () => {
    // Armed from the previous test, no pending draft. Hover an element so the
    // pinpoint outline is showing:
    const btn = probeButton();
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }));
    const box = bridgeDocument.querySelector<HTMLElement>('[data-plannotator-pinpoint-box]');
    if (!box) throw new Error('pinpoint hover box missing');
    expect(box.style.display).toBe('block');
    const exitsBefore = primaryPosts('annotate-exit').length;
    const clearsBefore = primaryPosts('selection-clear').length;
    pressEscape();
    // One press: the outline is gone AND the exit request went out. Clearing
    // the outline is not a rung the user perceives — only a draft earns one.
    expect(box.style.display).toBe('none');
    expect(primaryPosts('annotate-exit').length).toBe(exitsBefore + 1);
    expect(primaryPosts('selection-clear').length).toBe(clearsBefore);
    // The bridge stays armed until the parent answers set-annotate-mode.
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(true);
  });

  test('Esc ladder: a pending draft clears first, then Esc asks to exit Annotate; the parent flips the mode', () => {
    // Armed from the previous test. A fresh pending pinpoint draft:
    const probe = clickProbe(probeButton());
    expect(probe.prevented).toBe(true);
    const countOf = (type: string) => primaryPosts(type).length;
    const clearsBefore = countOf('selection-clear');
    const exitsBefore = countOf('annotate-exit');
    pressEscape();
    // Rung 1: the draft clears; the mode is untouched (no exit post).
    expect(countOf('selection-clear')).toBe(clearsBefore + 1);
    expect(countOf('annotate-exit')).toBe(exitsBefore);
    pressEscape();
    // Final rung: nothing left to close — ask the parent to exit Annotate.
    // The bridge does NOT flip itself (the parent owns the mode): capture
    // stays armed until set-annotate-mode comes back down.
    expect(countOf('annotate-exit')).toBe(exitsBefore + 1);
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(true);
    // The parent answers: Interact. Cursor affordance drops, clicks are native.
    postToBridge({ type: 'plannotator-bridge-set-annotate-mode', active: false, token: bridgeToken });
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(false);
    const native = clickProbe(probeButton());
    expect(native.prevented).toBe(false);
    expect(native.selections).toBe(0);
  });

  test('INTERACT: text drag-selection commenting still works while plain clicks stay native', async () => {
    // The ladder test above left the session in Interact.
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(false);
    const p = dragProbeParagraph();
    const before = selectionPosts().length;
    await dragSelectContents(p);
    const posts = selectionPosts();
    expect(posts.length).toBe(before + 1);
    expect(posts.at(-1)!.data.text).toBe('Draggable live copy');
    // Esc with the drag draft open closes the draft — and ONLY the draft:
    // there is no armed mode to exit, so no annotate-exit ever posts.
    const clearsBefore = primaryPosts('selection-clear').length;
    const exitsBefore = primaryPosts('annotate-exit').length;
    pressEscape();
    expect(primaryPosts('selection-clear').length).toBe(clearsBefore + 1);
    expect(primaryPosts('annotate-exit').length).toBe(exitsBefore);
    pressEscape();
    expect(primaryPosts('annotate-exit').length).toBe(exitsBefore);
    // Plain clicks reach the page natively in Interact.
    const native = clickProbe(probeButton());
    expect(native.prevented).toBe(false);
    expect(native.selections).toBe(0);
  });

  test('INTERACT: a drifted click reaches the page untouched', async () => {
    // Same trackpad drift as the armed test above, but in Interact the click
    // belongs to the page: nothing is prevented, nothing posts.
    const btn = probeButton();
    bridgeWindow.getSelection()!.removeAllRanges();
    let pageClicks = 0;
    const pageListener = () => { pageClicks += 1; };
    btn.addEventListener('click', pageListener);
    try {
      const before = selectionPosts().length;
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
      btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: 15, clientY: 12 }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: 15, clientY: 12 }));
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 15, clientY: 12 });
      btn.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
      expect(pageClicks).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(selectionPosts().length).toBe(before);
    } finally {
      btn.removeEventListener('click', pageListener);
    }
  });

  test('Mod+Shift+A inside the iframe forwards a toggle request to the parent in both modes', () => {
    const countToggles = () => primaryPosts('annotate-toggle').length;
    const before = countToggles();
    const chord = new KeyboardEvent('keydown', { key: 'A', shiftKey: true, metaKey: true, bubbles: true, cancelable: true });
    bridgeDocument.body.dispatchEvent(chord);
    expect(countToggles()).toBe(before + 1);
    expect(chord.defaultPrevented).toBe(true);
  });

  test('a placed marker still opens its comment in Interact mode', async () => {
    // Committed overlay artifacts are mode-independent: restore an anchored
    // annotation while the session is in Interact, then click its marker.
    const host = bridgeDocument.createElement('div');
    host.id = 'interact-marker-host';
    host.textContent = 'Marker host content';
    bridgeDocument.body.appendChild(host);
    postToBridge({
      type: 'plannotator-bridge-find-and-mark',
      id: 'interact-pin',
      originalText: '',
      annotationType: 'comment',
      anchor: { selector: '#interact-marker-host', tagName: 'div' },
      token: bridgeToken,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overlay = bridgeDocument.querySelector('[data-plannotator-overlay-host]');
    const root = (overlay as HTMLElement | null)?.shadowRoot ?? overlay;
    const marker = root?.querySelector<HTMLElement>(
      'button[data-plannotator-marker][data-annotation-id="interact-pin"]',
    );
    if (!marker) throw new Error('placed marker missing');
    expect(marker.style.display).not.toBe('none');
    const clicksBefore = primaryPosts('mark-click').length;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const clicks = primaryPosts('mark-click');
    expect(clicks.length).toBe(clicksBefore + 1);
    expect(clicks.at(-1)!.data.id).toBe('interact-pin');
    // The page element UNDER the annotation is still natively clickable.
    const probe = clickProbe(host);
    expect(probe.prevented).toBe(false);
    expect(probe.selections).toBe(0);
  });

  test('set-vim-mode is ignored in live mode', () => {
    postToBridge({
      type: 'plannotator-bridge-set-vim-mode',
      enabled: true,
      hudEnabled: true,
      mode: 'selection',
      token: bridgeToken,
    });
    expect(bridgeDocument.body.hasAttribute('data-plannotator-vim-focus-owner')).toBe(false);
    // Vim-owned surfaces only: the shared [data-plannotator-vim-ui] tag also
    // rides the pinpoint hover box, which earlier annotate-mode tests create.
    expect(bridgeDocument.querySelector('[data-plannotator-vim-cursor]')).toBeNull();
    expect(bridgeDocument.querySelector('[data-plannotator-vim-badge]')).toBeNull();
    expect(bridgeDocument.querySelector('[data-plannotator-vim-reticle]')).toBeNull();
  });

  test('a pushState burst posts exactly one coalesced page-change per editor origin', async () => {
    const changesFor = (origin: string) =>
      parentPosts.filter(
        (p) => p.data.type === 'plannotator-bridge-page-change' && p.targetOrigin === origin,
      );
    const beforePrimary = changesFor(editorOrigin).length;
    const beforeAlternate = changesFor('http://127.0.0.1:4100').length;
    bridgeWindow.history.pushState({}, '', '/first');
    bridgeWindow.history.pushState({}, '', '/second?tab=2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const primary = changesFor(editorOrigin);
    expect(primary.length).toBe(beforePrimary + 1);
    expect(changesFor('http://127.0.0.1:4100').length).toBe(beforeAlternate + 1);
    const last = primary.at(-1)!;
    // The reported page is whatever location the environment resolved the
    // pushState to (happy-dom keeps about:blank-relative paths); the CONTRACT
    // is that it always mirrors the live location, capped at 2048.
    expect(last.data.pageUrl).toBe(
      (bridgeWindow.location.pathname + bridgeWindow.location.search).slice(0, 2048),
    );
    expect(last.data.token).toBe(bridgeToken);
  });

  test('a zero-target restore is kept in live mode and re-acquired when its element appears', async () => {
    // SPA navigation race (phase 1 exit bar): the parent re-applies a page's
    // annotations right after a route change, but a lazy route has not
    // rendered its elements yet. The restore resolves nothing; the record
    // must survive so the reconcile machinery re-acquires it once the
    // element exists, instead of the pin staying invisible for the visit.
    postToBridge({
      type: 'plannotator-bridge-find-and-mark',
      id: 'late-pin',
      originalText: '',
      annotationType: 'comment',
      anchor: { selector: '#late-target', tagName: 'div' },
      token: bridgeToken,
    });
    const applied = parentPosts.filter(
      (p) => p.data.type === 'plannotator-bridge-mark-applied' && p.data.id === 'late-pin',
    );
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]!.data.success).toBe(false);
    // Let the queued overlay pass run (and fail its first dead search).
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The route finishes rendering: the anchored element appears.
    const late = bridgeDocument.createElement('div');
    late.id = 'late-target';
    late.textContent = 'late content';
    bridgeDocument.body.appendChild(late);
    // Jump the wall-clock backoff a failed dead search installs, and bump
    // the re-search generation deterministically via a settle event (the
    // harness cannot rely on MutationObserver delivery timing).
    monotonicOffsetMs += 6000;
    late.dispatchEvent(new Event('transitionend', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // scroll-to proves the record still exists and its placeholder target
    // re-resolved to the late element: a dropped record would scroll nothing.
    const scrolled: Element[] = [];
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollProbe(this: Element) {
      scrolled.push(this);
    };
    try {
      postToBridge({ type: 'plannotator-bridge-scroll-to', id: 'late-pin', token: bridgeToken });
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
    expect(scrolled).toContain(late);
  });

  test('the unanchored report is token-stamped and posted per editor origin in live mode', async () => {
    // Guards the rebase seam between the live message contract and the
    // unanchored-transparency report: a raw parent.postMessage(..., '*')
    // emission carries no token, so the live parent would silently drop it
    // (rejectsLiveMessage) exactly where restores fail most. The report must
    // travel like every other live outbound: token stamped, one post per
    // listed editor origin.
    parentPosts.length = 0;
    // No anchor and no text: nothing can seed placeholder targets, so this
    // restore is a total failure and must surface in the unanchored set.
    postToBridge({
      type: 'plannotator-bridge-find-and-mark',
      id: 'ghost-pin',
      originalText: '',
      annotationType: 'comment',
      token: bridgeToken,
    });
    let reports: ParentPost[] = [];
    for (let i = 0; i < 50 && reports.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      reports = parentPosts.filter((p) => p.data.type === 'plannotator-bridge-unanchored');
    }
    expect(reports.length).toBeGreaterThan(0);
    const latest = reports[reports.length - 1]!;
    expect(latest.data.ids as string[]).toContain('ghost-pin');
    expect(latest.data.token).toBe(bridgeToken);
    const reportOrigins = reports.map((p) => p.targetOrigin);
    expect(reportOrigins).toContain(editorOrigin);
    expect(reportOrigins).toContain('http://127.0.0.1:4100');
    expect(reportOrigins).not.toContain('*');
  });
});
