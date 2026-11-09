/**
 * A chapter's diagram in the Inbox (approval "guide-chapter-diagrams": diagrams live inside chapters, not above
 * them). The guided review, the walkthrough and the pull request page draw guides through GuideReader; the pane here
 * is the full-window review (as guideOverviewMermaid.test.tsx), with the Inbox's doors stubbed at `fetch` and the
 * Mermaid runtime stood in for through ui's test hook. What regresses:
 *
 *  - a chapter's Mermaid diagram not drawn, or drawn outside its chapter or below the chapter's words;
 *  - a chapter without a diagram looking any different from before;
 *  - two chapters' drawings sharing one id (one would draw over the other);
 *  - an old guide whose overview carries a diagram no longer opening, or losing that diagram.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { plugin } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolve } from 'node:path';
import { FIXTURE_V1_LOCAL, FIXTURE_V2_OVERVIEW } from '@plannotator/core/guide-format-fixtures';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
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
// Through `#guide-reader` (the window's strict typecheck sees its shape, not review-editor's code).
const GuideReader = (hasDom ? (await import('#guide-reader')).default : null)!;
const mermaid = hasDom ? await import('@plannotator/ui/utils/mermaid') : null;
const diagramSvg = hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : null;

const PROJECT: InboxProject = { id: 'prj_1', key: 'demo-abcdef', name: 'demo', root: '/work/demo', created_at: '2026-10-11T10:00:00.000Z' };
const MESSAGE = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" data-drawn-overview=""><rect width="120" height="40"/></svg>';
/** A source the stand-in runtime refuses, the way Mermaid refuses a parse error. */
const BROKEN = 'flowchart LR\n  A -->';

let snapshot: GuideSnapshot = FIXTURE_V2_OVERVIEW;

const message: InboxMessageWire = {
  id: MESSAGE,
  project_id: PROJECT.id,
  thread_id: MESSAGE,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_guide', name: null },
  subject: 'Auth token refresh',
  body: 'I wrote a guide.',
  created_at: '2026-10-11T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Auth token refresh', sections: 2, files: 2, additions: 2, deletions: 1, chapters: ['Guard the refresh entry point', 'Housekeeping'] },
} as InboxMessageWire;
const thread: InboxThread = { thread_id: MESSAGE, project: PROJECT, subject: 'Auth token refresh', thread_name: null, resolved_at: null, messages: [message] };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let restoreParser: (() => void) | null = null;
/** The sources the stand-in runtime was asked to draw. */
let rendered: string[] = [];

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = diagramSvg!.installInertDiagramSvgParser();
});

afterAll(() => {
  restoreParser?.();
});

beforeEach(() => {
  if (!hasDom) return;
  rendered = [];
  snapshot = FIXTURE_V2_OVERVIEW;
  mermaid!.__setMermaidRuntimeLoaderForTests(async () => ({
    initialize() {},
    render: async (_id: string, source: string) => {
      rendered.push(source);
      if (source === BROKEN) throw new Error('Parse error on line 2');
      return { svg: SVG };
    },
  }) as never);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return Response.json({});
    if (path.includes('/guide')) return Response.json({ message_id: MESSAGE, guide: message.guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_guide', live: true } });
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
  mermaid!.__setMermaidRuntimeLoaderForTests(undefined);
});

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<div className="pn-inbox">{element}</div>);
  });
  await settle();
}


const LR = 'flowchart LR\n  a[request] --> b[guard] --> c[refresh] --> d[retry]';
const TD = 'flowchart TD\n  x[bump] --> y[publish]';
/** FIXTURE_V1_LOCAL with diagrams on the chapters given, as a version-5 snapshot. */
const withChapterDiagrams = (sources: Array<string | null>, base: GuideSnapshot = FIXTURE_V1_LOCAL): GuideSnapshot => ({
  ...base,
  version: 5,
  guide: {
    ...base.guide,
    reviewed: base.guide.sections.map(() => false),
    sections: base.guide.sections.map((section, i) => (sources[i] ? { ...section, diagram: { kind: 'mermaid' as const, source: sources[i]! } } : section)),
  },
});
const chapter = (i: number) => document.querySelector(`[data-guide-section="${i}"] [data-guide-section-narrative]`);
const pane = () => <ReviewPane thread={thread} message={message} codeReview onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />;

test.skipIf(!hasDom)("the pane draws a chapter's Mermaid diagram inside that chapter, above its words, with Expand", async () => {
  snapshot = withChapterDiagrams([LR]);
  await mount(pane());
  const box = chapter(0)!.querySelector('[data-guide-chapter-diagram="mermaid"]');
  expect(box !== null).toBe(true);
  expect(rendered).toContain(LR);
  expect(box!.querySelector('svg[data-drawn-overview]') !== null).toBe(true);
  expect(box!.querySelector('[aria-label="Expand diagram"]') !== null).toBe(true);
  expect(box!.querySelector('pre') === null).toBe(true);
  // Above the chapter's own words.
  const words = Array.from(chapter(0)!.querySelectorAll('p')).find((p) => (p.textContent ?? '').includes(FIXTURE_V1_LOCAL.guide.sections[0]!.overview.slice(0, 20)))!;
  expect(box!.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The other chapter has none; nothing above the chapters either.
  expect(chapter(1)!.querySelector('[data-guide-chapter-diagram]') === null).toBe(true);
  expect(document.querySelector('[data-guide-overview-diagram]') === null).toBe(true);
});

test.skipIf(!hasDom)('a chapter without a diagram is drawn exactly as before', async () => {
  snapshot = { ...withChapterDiagrams([]), version: 1 };
  await mount(pane());
  const before = chapter(1)!.innerHTML;
  act(() => root?.unmount());
  host?.remove();
  snapshot = withChapterDiagrams([LR]);
  await mount(pane());
  expect(chapter(1)!.innerHTML).toBe(before);
});

test.skipIf(!hasDom)("each chapter's drawing has its own id", async () => {
  await mount(<GuideReader snapshot={withChapterDiagrams([LR, TD])} reviewed={[]} onReviewedChange={() => {}} />);
  const ids = [0, 1].map((i) => chapter(i)!.querySelector('[data-guide-chapter-diagram] [data-block-id]')?.getAttribute('data-block-id'));
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBeTruthy();
  expect(ids[0]).not.toBe(ids[1]);
  expect(rendered).toContain(LR);
  expect(rendered).toContain(TD);
});

test.skipIf(!hasDom)("an old guide with an overview diagram still opens and draws it, beside a chapter's", async () => {
  snapshot = { ...withChapterDiagrams([], FIXTURE_V2_OVERVIEW), version: 2 };
  await mount(pane());
  expect(document.querySelector('[data-guide-overview-diagram="mermaid"] svg') !== null).toBe(true);
  expect(document.querySelector('[data-guide-chapter-diagram]') === null).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  rendered = [];
  snapshot = withChapterDiagrams([null, TD], FIXTURE_V2_OVERVIEW);
  await mount(pane());
  expect(document.querySelector('[data-guide-overview-diagram="mermaid"] svg') !== null).toBe(true);
  expect(chapter(1)!.querySelector('[data-guide-chapter-diagram="mermaid"] svg') !== null).toBe(true);
  expect(rendered).toContain(TD);
});
