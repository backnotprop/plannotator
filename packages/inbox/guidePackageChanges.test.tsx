/**
 * Code review's generated-file reason and package changes card on the Inbox's diffs (review parity B5): a folded
 * lockfile says why it is folded with code review's own strip ("Generated file collapsed", the header's badge), and a
 * host that passes `GuideReader` `images` (a thread's guided review through ReviewPane) gets the review app's own
 * `PackageChangesCard` under a changed package.json, and under a lockfile while it is folded, its rows read from
 * `GET /api/inbox/messages/:id/guide/package-changes`.
 *
 * The failures this catches: a folded generated file with no reason; the strip not opening the file; a card asked of
 * code review's `/api/package-changes` (which the Inbox does not serve) or under another snapshot than the message; a
 * lockfile's card hidden while it is folded, or cut off by a folded box of the header's height; the npm consent button offered (the Inbox has no lookup); a host that
 * passed no `images` reading anything. (A real browser: tests/e2e/inbox-review-generated.spec.ts.)
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { plugin } from 'bun';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolve } from 'node:path';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { resetPackageChangesSetting } from '@plannotator/ui/hooks/usePackageChangesSetting';
import { resetPackageChangesCache } from '@plannotator/review-editor/hooks/usePackageChanges';

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

const MANIFEST = 'package.json';
const LOCK = 'tools/yarn.lock';
const PATCH = [
  `diff --git a/${MANIFEST} b/${MANIFEST}\nindex 1111111..2222222 100644\n--- a/${MANIFEST}\n+++ b/${MANIFEST}\n@@ -2,3 +2,3 @@\n   "dependencies": {\n-    "left-pad": "^1.1.0"\n+    "left-pad": "^1.3.0"\n   }\n`,
  `diff --git a/${LOCK} b/${LOCK}\nindex 3333333..4444444 100644\n--- a/${LOCK}\n+++ b/${LOCK}\n@@ -1,2 +1,2 @@\n tiny-queue@^0.2.1:\n-  version "0.2.1"\n+  version "0.2.3"\n`,
].join('');
const FILES = [MANIFEST, LOCK];

const row = (name: string, beforeVersion: string, afterVersion: string) => ({ name, registryName: name, kind: 'upgraded', section: 'dependencies', before: `^${beforeVersion}`, after: `^${afterVersion}`, beforeVersion, afterVersion, major: false, source: 'registry' });
const CARDS = {
  snapshot: 'msg',
  cards: [
    { path: MANIFEST, ecosystem: 'npm', role: 'manifest', lockfile: null, changes: [row('left-pad', '1.1.3', '1.3.0')], indirect: [], lookup: { names: [], withheld: ['left-pad'] } },
    { path: LOCK, ecosystem: 'npm', role: 'lockfile', lockfile: LOCK, changes: [row('tiny-queue', '0.2.1', '0.2.3')], indirect: [], lookup: { names: [], withheld: ['tiny-queue'] } },
  ],
  lookup: { total: 0 },
};

const snapshot = buildGuideSnapshot({
  guide: { title: 'Dependencies', intent: 'I', sections: [{ title: 'S', overview: 'O', diffs: FILES.map((file) => ({ file, summary: 's' })) }] },
  reviewed: [false],
  review: { rawPatch: PATCH, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-10-11T10:00:00.000Z' };
const MESSAGE = 'msg_01M4H6G73M9H3Z32T859E72DPZ';
const message = {
  id: MESSAGE,
  project_id: PROJECT.id,
  thread_id: MESSAGE,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
  subject: 'Dependencies',
  body: 'A guide.',
  created_at: '2026-10-11T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Dependencies', sections: 1, files: 2, additions: 2, deletions: 2, chapters: ['S'] },
} as unknown as InboxMessageWire;
const thread = { thread_id: MESSAGE, project: PROJECT, subject: 'Dependencies', thread_name: null, resolved_at: null, messages: [message], labels: [] } as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedIntersection: unknown;
let asked: string[] = [];
let commits = 0;

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  commits = 0;
  savedFetch = globalThis.fetch;
  savedIntersection = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('package-changes')) {
      asked.push(path);
      return Response.json(CARDS);
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
  resetPackageChangesSetting();
  resetPackageChangesCache();
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
    root.render(
      <Profiler id="reader" onRender={() => (commits += 1)}>
        <div className="pn-inbox">{node}</div>
      </Profiler>,
    );
  });
  await settle();
}

const shell = (path: string) => host!.querySelector(`[data-guide-file-shell="${path}"]`)!;
const within = <T extends Element>(path: string, selector: string): T[] => [
  ...shell(path).querySelectorAll<T>(selector),
  ...[...shell(path).querySelectorAll('diffs-container')].flatMap((view) => [...(view.shadowRoot?.querySelectorAll<T>(selector) ?? [])]),
];

test.skipIf(!hasDom)("a thread's guided review: code review's package cards, read from the message's own route; the folded lockfile says why and keeps its card", async () => {
  await draw(<ReviewPane thread={thread} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} />);
  expect(within(MANIFEST, '[data-package-changes="ready"]').length).toBe(1);
  expect(within(MANIFEST, '[data-package-row="upgraded"]').length).toBeGreaterThan(0);
  // The lockfile is folded as generated: the strip says so, and its card stays readable.
  expect(within(LOCK, '[data-pn-generated-collapsed-notice]').length).toBe(1);
  expect(within(LOCK, '[data-pn-generated-badge]').length).toBe(1);
  expect(within(LOCK, `[data-package-changes-path="${LOCK}"]`).length).toBe(1);
  expect(within(MANIFEST, '[data-pn-generated-collapsed-notice]').length).toBe(0);
  // The folded file's box follows what is drawn under its header (a floor, not a fixed height that cuts them off).
  const lockBox = shell(LOCK).querySelector<HTMLElement>('[data-guide-code-view-mounted="true"]')!;
  expect([lockBox.style.height, lockBox.style.minHeight !== '']).toEqual(['', true]);
  // Drawn, it stays still: the card's height reports and the file's re-measure do not draw each other for ever.
  const drawn = commits;
  await settle(10);
  expect(commits - drawn).toBeLessThan(5);
  // The npm lookup is code review's alone: no consent button here.
  expect(host!.querySelector('[data-package-lookup-allow]')).toBeNull();
  const route = `/api/inbox/messages/${MESSAGE}/guide/package-changes?`;
  expect(asked.length).toBeGreaterThan(0);
  for (const url of asked) {
    expect(url.startsWith(route)).toBe(true);
    expect(new URLSearchParams(url.slice(route.length)).get('snapshot')).toBe(MESSAGE);
  }
});

test.skipIf(!hasDom)('a host that passes no images: the generated strip opens the lockfile, and no card is read', async () => {
  await draw(<GuideReader snapshot={snapshot} reviewed={[false]} onReviewedChange={() => {}} />);
  const [strip] = within<HTMLButtonElement>(LOCK, '[data-pn-generated-collapsed-notice]');
  expect(strip).toBeDefined();
  await act(async () => strip!.click());
  await settle(10);
  expect(within(LOCK, '[data-pn-generated-collapsed-notice]').length).toBe(0);
  expect(host!.querySelector('[data-package-changes]')).toBeNull();
  expect(asked).toEqual([]);
});
