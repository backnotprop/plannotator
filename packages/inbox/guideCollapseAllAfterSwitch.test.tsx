/**
 * The top bar's Collapse all in a thread's guided review, after the person switched Walkthrough → All files →
 * Walkthrough. The switch keeps their place by revealing the file in view, and that reveal stays with the card that
 * file is on. Collapse all mounts that file's diff again, folded; a renderer handed the old reveal again opened the
 * file at once, so one file stayed open while the button said "Expand all files".
 *
 * Real ReviewPane, GuideReader, AllFilesCodeView and Pierre's diff, with the network answered here (no Inbox).
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

// The window's tsconfig points `#guide-reader` at the reader's type shape (reader-module.d.ts), which Bun
// would load as the module; the real reader is package.json's `imports` entry (as guideExpandContext.test.tsx).
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

const PATCH = [
  'diff --git a/src/worker.ts b/src/worker.ts\nindex 1111111..2222222 100644\n--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
  'diff --git a/src/deliver.ts b/src/deliver.ts\nindex 3333333..4444444 100644\n--- a/src/deliver.ts\n+++ b/src/deliver.ts\n@@ -1,3 +1,3 @@\n x\n-y\n+Y\n z\n',
].join('');

const snapshot = buildGuideSnapshot({
  guide: {
    title: 'T',
    intent: 'I',
    sections: [
      { title: 'Park paused jobs', overview: 'O', diffs: [{ file: 'src/worker.ts', summary: 's' }] },
      { title: 'Sign each attempt', overview: 'O', diffs: [{ file: 'src/deliver.ts', summary: 's' }] },
    ],
  },
  reviewed: [false, false],
  review: { rawPatch: PATCH, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const MESSAGE = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const message = {
  id: MESSAGE,
  project_id: PROJECT.id,
  thread_id: MESSAGE,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
  subject: 'T',
  body: 'A guide.',
  created_at: '2026-10-11T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'T', sections: 2, files: 2, additions: 2, deletions: 2, chapters: ['Park paused jobs', 'Sign each attempt'] },
} as unknown as InboxMessageWire;
const thread = { thread_id: MESSAGE, project: PROJECT, subject: 'T', thread_name: null, resolved_at: null, messages: [message], labels: [] } as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide/file')) return Response.json({ oldContent: null, newContent: null });
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
});

async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 15));
    });
  }
}

/** The files whose diff shows its lines (a folded file draws only its header). */
const openFiles = () =>
  [...host!.querySelectorAll<HTMLElement>('[data-guide-file-shell]')]
    .filter((shell) => [...shell.querySelectorAll('diffs-container')].some((c) => c.shadowRoot?.querySelector('pre[data-diff] [data-line]')))
    .map((shell) => shell.dataset.guideFileShell)
    .sort();
const collapseAll = () => host!.querySelector<HTMLButtonElement>('[data-diff-collapse-all]')!;
const flip = async (mode: 'walkthrough' | 'files') => {
  await act(async () => host!.querySelector<HTMLInputElement>(`[data-review-mode-choice="${mode}"] input`)!.click());
  await settle();
};

test.skipIf(!hasDom)('after Walkthrough → All files → Walkthrough, Collapse all folds every file, Expand all opens them, and a file still folds on its own', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={thread} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />
      </div>,
    );
  });
  await settle();
  expect(openFiles()).toEqual(['src/deliver.ts', 'src/worker.ts']);

  await flip('files');
  await flip('walkthrough');
  expect(openFiles()).toEqual(['src/deliver.ts', 'src/worker.ts']);

  await act(async () => collapseAll().click());
  await settle();
  expect(collapseAll().getAttribute('aria-label')).toBe('Expand all files');
  expect(openFiles()).toEqual([]);

  await act(async () => collapseAll().click());
  await settle();
  expect(collapseAll().getAttribute('aria-label')).toBe('Collapse all files');
  expect(openFiles()).toEqual(['src/deliver.ts', 'src/worker.ts']);

  // A file's own header still folds it after the host's Expand all.
  const header = host!.querySelector<HTMLElement>('[data-guide-file-shell="src/deliver.ts"] [data-file-header] > div');
  expect(header).not.toBeNull();
  await act(async () => header!.click());
  await settle();
  expect(openFiles()).toEqual(['src/worker.ts']);
}, 30_000);
