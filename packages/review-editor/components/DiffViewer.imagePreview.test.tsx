/**
 * Before/After image preview in the single-file view (#1598).
 *
 * Regressions guarded:
 *  - a session without the capability advert (static patch, old server, guide
 *    hosts) must issue NO image request and keep the plain notice;
 *  - only the sides that exist are requested (an addition has no Before);
 *  - a file the server cannot show as an image falls back to the notice;
 *  - identical bytes read as "Contents unchanged", not as a change;
 *  - a card unmounted mid-fetch aborts its request (no fetch storm on scroll);
 *  - nothing is fetched until the card is near the viewport.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * isolated diff-renderer step.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost() {
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');
const { resetReviewImageCache } = await import('../utils/reviewImage');

const hasDom = typeof document !== 'undefined';

const MODIFIED = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 1111111111aa..2222222222bb 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

const ADDED = [
  'diff --git a/assets/new.png b/assets/new.png',
  'new file mode 100644',
  'index 000000000000..2222222222bb',
  'Binary files /dev/null and b/assets/new.png differ',
  '',
].join('\n');

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

type Responder = (side: string) => Response | Promise<Response>;

describe.if(hasDom)('image preview in the single-file view (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;
  const originalObserver = globalThis.IntersectionObserver;
  let imageRequests: Array<{ url: string; signal?: AbortSignal | null }> = [];
  let intersect: (() => void) | null = null;

  /** An IntersectionObserver the test drives; `autoIntersect` fires on observe. */
  function installObserver(autoIntersect: boolean) {
    globalThis.IntersectionObserver = class {
      private cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe() {
        intersect = () => this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
        if (autoIntersect) intersect();
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  }

  function installFetch(respond: Responder) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/review-image')) {
        imageRequests.push({ url, signal: init?.signal });
        return respond(new URL(url, 'http://x').searchParams.get('side') ?? '');
      }
      return new Response(JSON.stringify({ oldContent: null, newContent: null }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  const image = (bytes: Uint8Array) =>
    new Response(bytes, { headers: { 'content-type': 'image/png', 'x-image-width': '4', 'x-image-height': '3' } });

  async function render(patch: string, filePath: string, available: boolean) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <DiffViewer
          patch={patch}
          filePath={filePath}
          status={patch === ADDED ? 'added' : 'modified'}
          reviewSnapshotId="snap-1"
          imagePreviewAvailable={available}
          diffStyle="unified"
          annotations={[]}
          selectedAnnotationId={null}
          scrollTargetAnnotation={null}
          pendingSelection={null}
          onLineSelection={() => {}}
          onAddAnnotation={() => {}}
          onAddFileComment={() => {}}
          onEditAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          onDeleteAnnotation={() => {}}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    return host;
  }

  beforeEach(() => {
    imageRequests = [];
    intersect = null;
    resetReviewImageCache();
    installObserver(true);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    globalThis.fetch = originalFetch;
    globalThis.IntersectionObserver = originalObserver;
  });

  test('with the advert, a changed image renders Before and After instead of the notice', async () => {
    installFetch((side) => image(side === 'old' ? PNG_A : PNG_B));
    const el = await render(MODIFIED, 'assets/logo.png', true);
    expect(el.querySelector('[data-image-diff-preview]')).not.toBeNull();
    expect(el.querySelector('[data-binary-file-notice]')).toBeNull();
    expect(el.querySelectorAll('[data-image-side] img').length).toBe(2);
    expect(imageRequests.map((r) => new URL(r.url, 'http://x').searchParams.get('snapshot'))).toEqual(['snap-1', 'snap-1']);
  });

  test('without the advert nothing is requested and the notice stays', async () => {
    installFetch((side) => image(side === 'old' ? PNG_A : PNG_B));
    const el = await render(MODIFIED, 'assets/logo.png', false);
    expect(el.querySelector('[data-binary-file-notice]')).not.toBeNull();
    expect(el.querySelector('[data-image-diff-preview]')).toBeNull();
    expect(imageRequests).toHaveLength(0);
  });

  test('an added image requests only its After side', async () => {
    installFetch(() => image(PNG_B));
    const el = await render(ADDED, 'assets/new.png', true);
    expect(imageRequests.map((r) => new URL(r.url, 'http://x').searchParams.get('side'))).toEqual(['new']);
    expect(el.querySelectorAll('[data-image-side]').length).toBe(1);
  });

  test('a file the server cannot show as an image falls back to the plain notice', async () => {
    installFetch(() =>
      new Response(JSON.stringify({ reason: 'not-image', error: 'x' }), {
        status: 415,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const el = await render(MODIFIED, 'assets/logo.png', true);
    expect(el.querySelector('[data-binary-file-notice]')).not.toBeNull();
    expect(el.querySelector('[data-image-diff-preview]')).toBeNull();
  });

  test('identical bytes on both sides read as unchanged, in one pane', async () => {
    installFetch(() => image(PNG_A));
    const el = await render(MODIFIED, 'assets/logo.png', true);
    expect(el.querySelector('[data-image-unchanged]')).not.toBeNull();
    expect(el.querySelectorAll('[data-image-side]').length).toBe(1);
  });

  test('unmounting mid-fetch aborts the requests', async () => {
    installFetch(() => new Promise<Response>(() => {}));
    await render(MODIFIED, 'assets/logo.png', true);
    expect(imageRequests).toHaveLength(2);
    await act(async () => root!.unmount());
    root = null;
    expect(imageRequests.every((r) => r.signal?.aborted)).toBe(true);
  });

  test('nothing is fetched until the card is near the viewport', async () => {
    installObserver(false);
    installFetch(() => image(PNG_A));
    await render(MODIFIED, 'assets/logo.png', true);
    expect(imageRequests).toHaveLength(0);
    await act(async () => {
      intersect!();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(imageRequests).toHaveLength(2);
  });
});
