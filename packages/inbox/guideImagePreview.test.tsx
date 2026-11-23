/**
 * Code review's image preview on the Inbox's diffs (review parity B2): a host
 * passes `GuideReader` `images` (a thread's guided review through ReviewPane,
 * reading `GET /api/inbox/messages/:id/guide/review-image`), and the review
 * app's own ImageDiffPreview and ImageViewMenu draw each changed image in
 * place of its binary notice, as its All files does.
 *
 * The failures this catches: an image drawn as the binary notice with the
 * preview wired; a side asked of code review's `/api/review-image` (which the
 * Inbox does not serve) or under another snapshot than the message; an added
 * image's before or a deleted image's after asked at all; no view menu on the
 * header, or a compare mode offered for an image with one side; a host that
 * passed no `images` reading anything; Highlight differences reading a side's
 * `blob:` URL with `fetch`, which the Inbox's `connect-src 'self'` refuses
 * (the highlight never drew there), instead of the message's own route.
 * (A real browser: tests/e2e/inbox-review-images.spec.ts.)
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { plugin } from 'bun';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolve } from 'node:path';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapes } from './shape/useInboxShapes';

const NO_BOARDS: InboxShapes = { shapes: null, byThread: new Map(), changed: 0, rowShown: false, subscribe: () => () => {}, refresh: () => {} };

// The window's tsconfig points `#guide-reader` at the reader's type shape; the real reader is package.json's `imports` entry.
plugin({
  name: 'inbox-guide-reader',
  setup(build) {
    build.onLoad({ filter: /guide\/reader-module\.d\.ts$/ }, () => ({
      contents: `export { default } from ${JSON.stringify(resolve(import.meta.dir, 'guide/GuideReader.tsx'))};`,
      loader: 'ts',
    }));
  },
});
// The review app's worker pool imports Vite's `?worker&inline`, which Bun cannot load.
mock.module(resolve(import.meta.dir, '../review-editor/workerPool.tsx'), () => ({
  ReviewWorkerPoolProvider: ({ children }: { children: unknown }) => children,
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== 'undefined';
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const GuideReader = (hasDom ? (await import('#guide-reader')).default : null)!;
const imageSettings = (hasDom ? await import('../review-editor/components/image-diff/imageDiffSettings') : null)!;
const reviewImage = (hasDom ? await import('../review-editor/utils/reviewImage') : null)!;

const PATCH = [
  'diff --git a/img/modified.png b/img/modified.png\nindex 1111111..2222222 100644\nBinary files a/img/modified.png and b/img/modified.png differ\n',
  'diff --git a/img/added.png b/img/added.png\nnew file mode 100644\nindex 0000000..3333333\nBinary files /dev/null and b/img/added.png differ\n',
  'diff --git a/img/deleted.png b/img/deleted.png\ndeleted file mode 100644\nindex 4444444..0000000\nBinary files a/img/deleted.png and /dev/null differ\n',
].join('');
const FILES = ['img/modified.png', 'img/added.png', 'img/deleted.png'];
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const snapshot = buildGuideSnapshot({
  guide: { title: 'Pictures', intent: 'I', sections: [{ title: 'S', overview: 'O', diffs: FILES.map((file) => ({ file, summary: 's' })) }] },
  reviewed: [false],
  review: { rawPatch: PATCH, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const MESSAGE = 'msg_01M4H6G73M9H3Z32T859E72DPZ';
const message = {
  id: MESSAGE,
  project_id: PROJECT.id,
  thread_id: MESSAGE,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
  subject: 'Pictures',
  body: 'A guide.',
  created_at: '2026-10-11T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Pictures', sections: 1, files: 3, additions: 0, deletions: 0, chapters: ['S'] },
} as unknown as InboxMessageWire;
const thread = { thread_id: MESSAGE, project: PROJECT, subject: 'Pictures', thread_name: null, resolved_at: null, messages: [message], labels: [] } as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedIntersection: unknown;
let asked: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  savedFetch = globalThis.fetch;
  // happy-dom lays nothing out, so nothing would ever be "near the viewport": every preview reads at once.
  savedIntersection = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('review-image')) {
      asked.push(path);
      return new Response(PNG, { headers: { 'content-type': 'image/png', 'x-image-width': '1', 'x-image-height': '1' } });
    }
    if (path.includes('/guide')) return Response.json({ message_id: MESSAGE, guide: message.guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIntersection;
});

async function settle(times = 30) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 15));
    });
  }
}

async function draw(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<div className="pn-inbox">{node}</div>);
  });
  await settle();
}

/** Light DOM and every diff's shadow root. */
const everywhere = <T extends Element>(selector: string): T[] => [
  ...host!.querySelectorAll<T>(selector),
  ...[...host!.querySelectorAll('diffs-container')].flatMap((view) => [...(view.shadowRoot?.querySelectorAll<T>(selector) ?? [])]),
];
const previewOf = (path: string) => host!.querySelector(`[data-guide-file-shell="${path}"] [data-image-diff-preview]`);

test.skipIf(!hasDom)("a thread's guided review: each changed image is code review's preview, its sides read from the message's own route", async () => {
  await draw(<ReviewPane thread={thread} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />);
  for (const path of FILES) expect(previewOf(path)).not.toBeNull();
  const route = `/api/inbox/messages/${MESSAGE}/guide/review-image?`;
  const sides = asked.map((url) => {
    expect(url.startsWith(route)).toBe(true);
    const query = new URLSearchParams(url.slice(route.length));
    expect(query.get('snapshot')).toBe(MESSAGE);
    return `${query.get('path')} ${query.get('side')}`;
  });
  // An added image has no before and a deleted one no after: never asked.
  expect(sides.sort()).toEqual(['img/added.png new', 'img/deleted.png old', 'img/modified.png new', 'img/modified.png old']);
  expect(host!.querySelectorAll('[data-image-diff-preview] img[src^="blob:"]').length).toBeGreaterThan(0);
  // Code review's view menu on each image's header.
  expect(everywhere('[data-image-view-menu]').length).toBe(FILES.length);
});

test.skipIf(!hasDom)('a host that passes no images: the binary notice, and nothing is read', async () => {
  await draw(<GuideReader snapshot={snapshot} reviewed={[false]} onReviewedChange={() => {}} />);
  expect(host!.querySelector('[data-image-diff-preview]')).toBeNull();
  expect(everywhere('[data-image-view-menu]').length).toBe(0);
  expect(asked).toEqual([]);
});

test.skipIf(!hasDom)("Highlight differences: each side read again through the message's route, never fetched from its blob: URL, and drawn", async () => {
  const requests: string[] = [];
  const decoded: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('review-image')) {
      // Two different pictures, so the image is compared and not "contents unchanged".
      const side = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('side');
      return new Response(Uint8Array.from([...PNG, side === 'old' ? 1 : 2]), { headers: { 'content-type': 'image/png', 'x-image-width': '1', 'x-image-height': '1' } });
    }
    if (url.includes('/guide')) return Response.json({ message_id: MESSAGE, guide: message.guide, snapshot });
    if (url.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    return Response.json({});
  }) as typeof fetch;
  // happy-dom has no worker, offscreen canvas or bitmap decoder: stand-ins that note which bytes were decoded.
  const globals = globalThis as Record<string, unknown>;
  const saved = { Worker: globals.Worker, OffscreenCanvas: globals.OffscreenCanvas, createImageBitmap: globals.createImageBitmap };
  globals.OffscreenCanvas = class {};
  globals.createImageBitmap = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    decoded.push(bytes[bytes.length - 1]!);
    return {};
  };
  globals.Worker = class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage(data: { id: number }) {
      setTimeout(() => this.onmessage?.({ data: { id: data.id, mask: {}, changed: 1 } }), 0);
    }
  };
  imageSettings.setImageDiffSettings({ differences: true });
  // The first test's sides (one picture for both) are cached under this message: read them again.
  reviewImage.resetReviewImageCache();
  try {
    await draw(<ReviewPane thread={thread} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />);
    // Every request is a path on the window's own origin: no blob: URL (or any other origin) the page policy refuses.
    expect(requests.filter((url) => !/^\/(?!\/)/.test(url))).toEqual([]);
    const route = `/api/inbox/messages/${MESSAGE}/guide/review-image?`;
    const modified = requests.filter((url) => url.startsWith(route) && new URLSearchParams(url.slice(route.length)).get('path') === 'img/modified.png');
    // Each side once for the preview and once again for the highlight, both under the message's own snapshot.
    expect(modified.map((url) => new URLSearchParams(url.slice(route.length)).get('side')).sort()).toEqual(['new', 'new', 'old', 'old']);
    expect(modified.every((url) => new URLSearchParams(url.slice(route.length)).get('snapshot') === MESSAGE)).toBe(true);
    expect(decoded.sort()).toEqual([1, 2]);
    expect(previewOf('img/modified.png')!.textContent).toContain('100.0% of pixels differ');
  } finally {
    imageSettings.resetImageDiffSettingsForTests();
    Object.assign(globals, saved);
  }
});
