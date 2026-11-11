import { plugin } from 'bun';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolve } from 'node:path';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapes } from './shape/useInboxShapes';

const NO_BOARDS: InboxShapes = { shapes: null, byThread: new Map(), changed: 0, rowShown: false, subscribe: () => () => {}, refresh: () => {} };

// The window's tsconfig points `#guide-reader` at the reader's type shape (reader-module.d.ts), which Bun
// would load as the module; the real reader is package.json's `imports` entry (as guideDiffStyle.test.tsx).
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

const OLD = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
const NEW = OLD.map((line, i) => (i === 30 ? 'changed' : line));
const whole = (lines: string[]) => `${lines.join('\n')}\n`;
const MODIFIED = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -28,7 +28,7 @@
 line 28
 line 29
 line 30
-line 31
+changed
 line 32
 line 33
 line 34
`;
const ADDED = 'diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n';
const DELETED = 'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 3333333..0000000\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
const RENAMED = 'diff --git a/from.ts b/to.ts\nsimilarity index 90%\nrename from from.ts\nrename to to.ts\nindex 4444444..5555555 100644\n--- a/from.ts\n+++ b/to.ts\n@@ -1 +1 @@\n-a\n+b\n';

function snapshotOf(patch: string, files: string[]) {
  return buildGuideSnapshot({
    guide: { title: 'T', intent: 'I', sections: [{ title: 'S', overview: 'O', diffs: files.map((file) => ({ file, summary: 's' })) }] },
    reviewed: [false],
    review: { rawPatch: patch, gitRef: 'main...HEAD', source: { kind: 'local' } },
    exportedAt: '2026-10-11T10:40:00.000Z',
  });
}

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
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'T', sections: 1, files: 1, additions: 1, deletions: 1, chapters: ['S'] },
} as unknown as InboxMessageWire;
const thread = { thread_id: MESSAGE, project: PROJECT, subject: 'T', thread_name: null, resolved_at: null, messages: [message], labels: [] } as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedObserver: typeof ResizeObserver;
let savedHeight: PropertyDescriptor | undefined;
let observers: (() => void)[] = [];

const views = () => [...host!.querySelectorAll('diffs-container')];
const inView = <T extends Element>(selector: string) => views().flatMap((view) => [...view.shadowRoot!.querySelectorAll<T>(selector)]);
const arrows = () => inView<HTMLElement>('[data-expand-button]');
const rows = () => inView('[data-code] [data-line]').length;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  savedObserver = globalThis.ResizeObserver;
  observers = [];
  globalThis.ResizeObserver = class {
    constructor(private readonly heard: ResizeObserverCallback) {}
    observe(target: Element) {
      observers.push(() => this.heard([{ target, contentRect: { width: 800, height: 0 }, borderBoxSize: [{ inlineSize: 800, blockSize: 0 }], contentBoxSize: [{ inlineSize: 800, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // happy-dom lays nothing out: the list's height follows the rows Pierre really drew.
  savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => rows() * 20 });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  globalThis.ResizeObserver = savedObserver;
  if (savedHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', savedHeight);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
});

async function settle(times = 20) {
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

const boxHeight = (path: string) => Number.parseFloat(host!.querySelector<HTMLElement>(`[data-guide-file-shell="${path}"] [data-guide-code-view-mounted]`)!.style.minHeight);
const reader = (patch: string, files: string[], fileContents?: (path: string, signal: AbortSignal, patch: string) => Promise<{ oldContent: string | null; newContent: string | null; failed?: true }>) => (
  <GuideReader snapshot={snapshotOf(patch, files)} reviewed={[false]} onReviewedChange={() => {}} {...(fileContents ? { fileContents } : {})} />
);

test.skipIf(!hasDom)("a thread's guided review: the arrows come from the message's file route, and opening a gap grows the box", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide/file')) {
      asked.push(path);
      return Response.json({ oldContent: whole(OLD), newContent: whole(NEW) });
    }
    if (path.includes('/guide')) return Response.json({ message_id: MESSAGE, guide: message.guide, snapshot: snapshotOf(MODIFIED, ['a.ts']) });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    return Response.json({});
  }) as typeof fetch;
  await draw(<ReviewPane thread={thread} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />);
  expect(asked).toEqual([]);
  expect(arrows().length).toBeGreaterThan(0);
  const before = rows();
  await act(async () => observers.forEach((heard) => heard()));
  const boxBefore = boxHeight('a.ts');

  await act(async () => arrows()[0]!.click());
  await settle();
  expect(asked).toEqual([`/api/inbox/messages/${MESSAGE}/guide/file?path=a.ts`]);
  expect(rows()).toBeGreaterThan(before);
  await act(async () => observers.forEach((heard) => heard()));
  expect(boxHeight('a.ts')).toBeGreaterThan(boxBefore);
});

test.skipIf(!hasDom)("a tailnet guest's page asks nothing (each file would be a silent 403) and still reads the diff", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide/file')) {
      asked.push(path);
      return Response.json({ error: 'local only', code: 'local_only' }, { status: 403 });
    }
    if (path.includes('/guide')) return Response.json({ message_id: MESSAGE, guide: message.guide, snapshot: snapshotOf(MODIFIED, ['a.ts']) });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    return Response.json({});
  }) as typeof fetch;
  await draw(<ReviewPane thread={thread} message={message} codeReview guest onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />);
  expect(rows()).toBeGreaterThan(0);
  expect(asked).toEqual([]);
  expect(arrows().length).toBe(0);
});

test.skipIf(!hasDom)('a read-only diff (a resolved thread, a PR with no comments) still has its arrows', async () => {
  await draw(reader(MODIFIED, ['a.ts'], async () => ({ oldContent: whole(OLD), newContent: whole(NEW) })));
  expect(arrows().length).toBeGreaterThan(0);
});

test.skipIf(!hasDom)('nothing to open (no contents, text that does not fit): the first click takes the arrows away, the diff as it came, nothing logged', async () => {
  const answers: (() => Promise<{ oldContent: string | null; newContent: string | null; failed?: true }>)[] = [
    async () => ({ oldContent: null, newContent: null }),
    async () => ({ oldContent: whole(OLD), newContent: whole([...NEW, 'one more']) }),
  ];
  const logged = spyOn(console, 'error');
  for (const answer of answers) {
    await draw(reader(MODIFIED, ['a.ts'], answer));
    const before = rows();
    expect(before).toBeGreaterThan(0);
    expect(arrows().length).toBeGreaterThan(0);
    await act(async () => arrows()[0]!.click());
    await settle();
    expect(rows()).toBe(before);
    expect(arrows().length).toBe(0);
    expect(logged).not.toHaveBeenCalled();
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
  logged.mockRestore();
});

test.skipIf(!hasDom)('while a first read is on its way the file says so; once it lands it stops', async () => {
  let land: (contents: { oldContent: string; newContent: string }) => void = () => {};
  await draw(reader(MODIFIED, ['a.ts'], () => new Promise((resolve) => (land = resolve))));
  const view = views()[0]!;
  expect(view.hasAttribute('data-reading-whole-file')).toBe(false);
  await act(async () => arrows()[0]!.click());
  expect(view.hasAttribute('data-reading-whole-file')).toBe(true);
  await act(async () => land({ oldContent: whole(OLD), newContent: whole(NEW) }));
  await settle();
  expect(view.hasAttribute('data-reading-whole-file')).toBe(false);
});

test.skipIf(!hasDom)('a read that failed keeps the arrows, and the next click asks again and opens', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  for (const failure of [
    () => Promise.reject(new Error('offline')),
    async () => ({ oldContent: null, newContent: null, failed: true as const }),
  ]) {
    let asks = 0;
    await draw(
      reader(MODIFIED, ['a.ts'], async () => {
        asks += 1;
        return asks === 1 ? failure() : { oldContent: whole(OLD), newContent: whole(NEW) };
      }),
    );
    const before = rows();
    await act(async () => arrows()[0]!.click());
    await settle();
    expect(asks).toBe(1);
    expect(arrows().length).toBeGreaterThan(0);
    await act(async () => arrows()[0]!.click());
    await settle();
    expect(asks).toBe(2);
    expect(rows()).toBeGreaterThan(before);
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
  logged.mockRestore();
});

test.skipIf(!hasDom)('an added or deleted file costs no read and has no arrows; a changed one and a renamed one beside them do', async () => {
  const asked: string[] = [];
  await draw(
    reader(`${ADDED}${DELETED}${RENAMED}${MODIFIED}`, ['new.ts', 'gone.ts', 'to.ts', 'a.ts'], async (path) => {
      asked.push(path);
      return { oldContent: whole(OLD), newContent: whole(NEW) };
    }),
  );
  expect(asked).toEqual([]);
  const arrowsOf = (path: string) => host!.querySelector(`[data-guide-file-shell="${path}"] diffs-container`)!.shadowRoot!.querySelectorAll<HTMLElement>('[data-expand-button]');
  for (const path of ['new.ts', 'gone.ts']) expect(arrowsOf(path).length).toBe(0);
  expect(arrowsOf('a.ts').length).toBeGreaterThan(0);
  expect(arrowsOf('to.ts').length).toBeGreaterThan(0);
  await act(async () => arrowsOf('to.ts')[0]!.click());
  await settle();
  expect(asked).toEqual(['to.ts']);
});

test.skipIf(!hasDom)('a host that passes no reader: no request of any kind, no arrows, as before', async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return Response.json({});
  }) as typeof fetch;
  await draw(reader(MODIFIED, ['a.ts']));
  expect(rows()).toBeGreaterThan(0);
  expect(arrows().length).toBe(0);
  expect(asked.filter((path) => path.includes('file'))).toEqual([]);
});
