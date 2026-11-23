/**
 * Code review's rendered files on the Inbox's diffs (review parity B3): a host
 * that reads whole files (a thread's guided review through ReviewPane) gets the
 * review app's own Source / Changes / Read menu on a changed Markdown file and
 * its rendered card, and a changed SVG's Image / Source, as its All files has
 * them, with the same starting view (code review's remembered cookie).
 *
 * The failures this catches: no menu or card with the wiring in place; a card
 * whose texts are not the host's reader's (or an added file's not its patch's);
 * a picture asked of code review's `/api/review-markdown-image` (the Inbox does
 * not serve it) or under another snapshot than the message; a document's
 * web picture loaded, or offered to load (the window allows only its own pictures); a
 * view menu promising select-to-comment or the P key; an SVG drawn as source only; a host that
 * reads no whole files and names no images drawing any of it.
 * (A real browser: tests/e2e/inbox-review-markdown.spec.ts.)
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
const { pullReviewImages } = (hasDom ? await import('./reviewImages') : {}) as typeof import('./reviewImages');
const storage = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');

const README_OLD = '# Ledger\n\nOld words.\n';
const README_NEW = '# Ledger\n\nNew words.\n![chart](img/chart.png)\n';
const PATCH = [
  'diff --git a/README.md b/README.md\nindex 1111111..2222222 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,4 @@\n # Ledger\n \n-Old words.\n+New words.\n+![chart](img/chart.png)\n',
  'diff --git a/docs/NEW.md b/docs/NEW.md\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/docs/NEW.md\n@@ -0,0 +1,2 @@\n+# New page\n+Fresh words here.\n',
  'diff --git a/img/logo.svg b/img/logo.svg\nindex 4444444..5555555 100644\n--- a/img/logo.svg\n+++ b/img/logo.svg\n@@ -1 +1 @@\n-<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n+<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>\n',
].join('');
const FILES = ['README.md', 'docs/NEW.md', 'img/logo.svg'];
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');

const snapshotOf = (patch: string, source: { kind: 'local' } | { kind: 'pr'; pr: { url: string; number: number; title: string; platform: 'github' } } = { kind: 'local' }) =>
  buildGuideSnapshot({
    guide: { title: 'Docs', intent: 'I', sections: [{ title: 'S', overview: 'O', diffs: FILES.map((file) => ({ file, summary: 's' })) }] },
    reviewed: [false],
    review: { rawPatch: patch, gitRef: 'main...HEAD', source },
    exportedAt: '2026-11-23T10:40:00.000Z',
  });
let snapshot = snapshotOf(PATCH);

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-23T10:00:00.000Z' };
const MESSAGE = 'msg_01M4H6G73M9H3Z32T859E72DPZ';
const message = {
  id: MESSAGE,
  project_id: PROJECT.id,
  thread_id: MESSAGE,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
  subject: 'Docs',
  body: 'A guide.',
  created_at: '2026-11-23T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Docs', sections: 1, files: 3, additions: 4, deletions: 2, chapters: ['S'] },
} as unknown as InboxMessageWire;
const thread = { thread_id: MESSAGE, project: PROJECT, subject: 'Docs', thread_name: null, resolved_at: null, messages: [message], labels: [] } as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedIntersection: unknown;
let asked: string[] = [];

// Code review's settings, held in memory for the test (the window keeps them in cookies).
const kept = new Map<string, string>();
const setStartingView = (view: string | null) => {
  if (view === null) kept.delete('plannotator-markdown-view');
  else kept.set('plannotator-markdown-view', view);
};

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  snapshot = snapshotOf(PATCH);
  kept.clear();
  storage.setStorageBackend({ getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => void kept.set(key, value), removeItem: (key) => void kept.delete(key) });
  savedFetch = globalThis.fetch;
  // happy-dom lays nothing out, so nothing would ever be "near the viewport": every preview reads at once.
  savedIntersection = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    asked.push(path);
    if (path.includes('review-image')) return new Response(SVG, { headers: { 'content-type': 'image/svg+xml', 'x-image-width': '2', 'x-image-height': '2' } });
    if (path.includes('/guide/file')) {
      const file = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('path');
      return Response.json(file === 'README.md' ? { serverSession: 's', oldContent: README_OLD, newContent: README_NEW } : { serverSession: 's', oldContent: null, newContent: null });
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
  storage.resetStorageBackend();
});

async function settle(times = 40) {
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
const inShell = <T extends Element>(path: string, selector: string): T[] => {
  const shell = host!.querySelector(`[data-guide-file-shell="${path}"]`);
  if (!shell) return [];
  return [...shell.querySelectorAll<T>(selector), ...[...shell.querySelectorAll('diffs-container')].flatMap((view) => [...(view.shadowRoot?.querySelectorAll<T>(selector) ?? [])])];
};
const pane = () => <ReviewPane thread={thread} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />;

test.skipIf(!hasDom)("a thread's guided review, starting in Source: code review's menu on each Markdown file, the source diff under it", async () => {
  await draw(pane());
  for (const path of ['README.md', 'docs/NEW.md']) {
    const menus = inShell<HTMLElement>(path, '[data-markdown-view-menu]');
    expect(menus.length).toBe(1);
    expect(menus[0]!.getAttribute('data-markdown-view')).toBe('source');
  }
  expect(everywhere('[data-markdown-preview]').length).toBe(0);
  // Nothing read for a view nobody picked.
  expect(asked.filter((url) => url.includes('/guide/file?path=README.md'))).toEqual([]);
  // A changed SVG starts as its picture (code review's default): both sides read from the message's own route.
  const sides = asked.filter((url) => url.includes('review-image') && url.includes('path=img%2Flogo.svg'));
  expect(sides.length).toBe(2);
  for (const url of sides) expect(url.startsWith(`/api/inbox/messages/${MESSAGE}/guide/review-image?`)).toBe(true);
});

test.skipIf(!hasDom)("starting in Changes (code review's remembered view): each Markdown file rendered from the host's reader, its pictures from the message's route", async () => {
  setStartingView('changes');
  await draw(pane());
  const readme = inShell<HTMLElement>('README.md', '[data-markdown-preview]');
  expect(readme.length).toBe(1);
  expect(readme[0]!.getAttribute('data-markdown-preview-view')).toBe('diff');
  expect(readme[0]!.textContent).toContain('New words.');
  expect(asked.some((url) => url.includes(`/api/inbox/messages/${MESSAGE}/guide/file?path=README.md`))).toBe(true);
  // The picture the document shows: the Inbox's own route, the message as its snapshot.
  const img = readme[0]!.querySelector<HTMLImageElement>('img[src*="review-markdown-image"]');
  expect(img).not.toBeNull();
  const src = img!.getAttribute('src')!;
  expect(src.startsWith(`/api/inbox/messages/${MESSAGE}/guide/review-markdown-image?`)).toBe(true);
  const query = new URLSearchParams(src.slice(src.indexOf('?') + 1));
  expect([query.get('doc'), query.get('side'), query.get('src'), query.get('snapshot')]).toEqual(['README.md', 'new', 'img/chart.png', MESSAGE]);
  // An added file has one side: Read, its words from the patch itself (the host's reader has none for it).
  const added = inShell<HTMLElement>('docs/NEW.md', '[data-markdown-preview]');
  expect(added[0]!.getAttribute('data-markdown-preview-view')).toBe('whole');
  expect(added[0]!.textContent).toContain('Fresh words here.');
  expect(asked.filter((url) => url.includes('path=docs%2FNEW.md'))).toEqual([]);
});

test.skipIf(!hasDom)("a changed SVG: code review's picture with its Image / Source menu", async () => {
  await draw(pane());
  expect(inShell('img/logo.svg', '[data-image-diff-preview]').length).toBe(1);
  const menu = inShell<HTMLElement>('img/logo.svg', '[data-image-view-menu]');
  expect(menu.length).toBe(1);
  expect(menu[0]!.getAttribute('title')).toContain('or Source');
  // Never code review's own route.
  expect(asked.filter((url) => url.startsWith('/api/review-'))).toEqual([]);
});

// The window loads only its own pictures: a web picture is code review's quiet placeholder, in a PR's guide or a local
// one, with no notice or button offering to load it (that would load nothing).
for (const [name, source] of [
  ['a pull request', { kind: 'pr', pr: { url: 'https://github.com/northwind/ledger/pull/7', number: 7, title: 'Docs', platform: 'github' } }],
  ['a local guide', { kind: 'local' }],
] as const) {
  test.skipIf(!hasDom)(`${name}'s document: its web pictures are placeholders, never loaded, with nothing offering to load them`, async () => {
    setStartingView('changes');
    snapshot = snapshotOf(PATCH.replace('+![chart](img/chart.png)\n', '+![web](https://example.com/track.png)\n'), source);
    globalThis.fetch = ((original) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes('/guide/file') && path.includes('README.md')) return Response.json({ serverSession: 's', oldContent: README_OLD, newContent: README_NEW.replace('![chart](img/chart.png)', '![web](https://example.com/track.png)') });
      return original(input, init);
    }) as typeof fetch)(globalThis.fetch);
    await draw(pane());
    const readme = inShell<HTMLElement>('README.md', '[data-markdown-preview]')[0]!;
    expect(readme.querySelectorAll('[data-image-unavailable]').length).toBe(1);
    expect(readme.querySelector('img[src^="https:"]')).toBeNull();
    expect(readme.querySelector('[data-markdown-preview-remote-images]')).toBeNull();
    await act(async () => readme.querySelector<HTMLElement>('[data-image-unavailable]')!.click());
    await settle(5);
    expect(readme.querySelector('img[src^="https:"]')).toBeNull();
  });
}

test.skipIf(!hasDom)("the view menu promises no select-to-comment and no P key: neither works in the Inbox", async () => {
  setStartingView('changes');
  await draw(pane());
  const menu = inShell<HTMLElement>('README.md', '[data-markdown-view-menu]')[0]!;
  expect(menu.getAttribute('title')).not.toMatch(/select text|P:/i);
});

test.skipIf(!hasDom)('a host that reads no whole files and names no images: the source diff, no menu, nothing read', async () => {
  setStartingView('changes');
  await draw(<GuideReader snapshot={snapshot} reviewed={[false]} onReviewedChange={() => {}} />);
  expect(everywhere('[data-markdown-view-menu]').length).toBe(0);
  expect(everywhere('[data-markdown-preview]').length).toBe(0);
  expect(everywhere('[data-image-diff-preview]').length).toBe(0);
  expect(asked.filter((url) => url.includes('review-image') || url.includes('/guide/file'))).toEqual([]);
});

test.skipIf(!hasDom)("a pull request's pictures: code review's URL turned into the PR's route at the head on screen", () => {
  const head = 'c'.repeat(40);
  const images = pullReviewImages('github.com/northwind/ledger#7', 'layer', undefined, head)!;
  const url = images.markdownImageUrl(`/api/review-markdown-image?doc=README.md&side=old&src=img%2Fa.png&snapshot=${encodeURIComponent(images.snapshotId)}`);
  expect(url.startsWith('/api/inbox/pulls/review-markdown-image?')).toBe(true);
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  expect([query.get('key'), query.get('scope'), query.get('doc'), query.get('side'), query.get('src'), query.get('snapshot')]).toEqual(['github.com/northwind/ledger#7', 'layer', 'README.md', 'old', 'img/a.png', head]);
  // Anything else is never asked.
  expect(images.markdownImageUrl('/api/review-image?path=a.png')).toBe('data:,');
});
