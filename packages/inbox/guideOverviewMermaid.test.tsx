/**
 * A guide's Mermaid overview diagram in the Inbox: drawn, not left as its
 * source in a grey code box. The guide brief offers agents `{ kind:
 * "mermaid" }`, and the guided review, the walkthrough and the pull request
 * page all draw guides through GuideReader. The full-window review is the pane
 * here (as guideGlobalComment.test.tsx), with the Inbox's doors stubbed at
 * `fetch` and the Mermaid runtime stood in for through ui's test hook. What
 * regresses:
 *
 *  - the pane no longer handing a Mermaid diagram to Plannotator's renderer
 *    (the source shows in the guide chain's code box again);
 *  - a source that does not render showing the red error panel instead of
 *    its plain fence;
 *  - GuideReader drawing it only for a host that passes a renderer (the
 *    pull request page passes none; its snapshot has no overview today).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { plugin } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolve } from 'node:path';
import { FIXTURE_V2_OVERVIEW } from '@plannotator/core/guide-format-fixtures';
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
const { default: GuideReader } = (hasDom ? await import('./guide/GuideReader') : {}) as typeof import('./guide/GuideReader');
const mermaid = hasDom ? await import('@plannotator/ui/utils/mermaid') : null;
const diagramSvg = hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : null;

const PROJECT: InboxProject = { id: 'prj_1', key: 'demo-abcdef', name: 'demo', root: '/work/demo', created_at: '2026-10-11T10:00:00.000Z' };
const MESSAGE = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" data-drawn-overview=""><rect width="120" height="40"/></svg>';
/** A source the stand-in runtime refuses, the way Mermaid refuses a parse error. */
const BROKEN = 'flowchart LR\n  A -->';

const overviewOf = (source: string): GuideSnapshot => {
  const guide = FIXTURE_V2_OVERVIEW.guide;
  return { ...FIXTURE_V2_OVERVIEW, guide: { ...guide, overview: { text: guide.overview!.text, diagram: { kind: 'mermaid', source } } } };
};
const DRAWN = (FIXTURE_V2_OVERVIEW.guide.overview!.diagram as { source: string }).source;
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

const box = () => document.querySelector('[data-guide-overview-diagram="mermaid"]');

test.skipIf(!hasDom)('the guide pane draws a Mermaid overview diagram instead of showing its source', async () => {
  await mount(<ReviewPane thread={thread} message={message} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />);
  expect(box()).not.toBeNull();
  expect(rendered).toContain(DRAWN);
  expect(box()!.querySelector('svg[data-drawn-overview]')).not.toBeNull();
  // Drawn: no source in a code box, and the block's Show source is there to read it.
  expect(box()!.querySelector('pre')).toBeNull();
  expect(box()!.querySelector('[aria-label="Show source"]')).not.toBeNull();
});

test.skipIf(!hasDom)('a Mermaid source that does not render stays readable as its plain fence, without the error panel', async () => {
  snapshot = overviewOf(BROKEN);
  await mount(<ReviewPane thread={thread} message={message} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />);
  expect(rendered).toContain(BROKEN);
  expect(box()!.querySelector('pre')?.textContent).toBe(BROKEN);
  expect(box()!.textContent).not.toContain('Error');
  expect(box()!.textContent).not.toContain('Parse error');
});

test.skipIf(!hasDom)('the reader draws it on its own, for a host with no diagram renderer', async () => {
  await mount(<GuideReader snapshot={FIXTURE_V2_OVERVIEW} reviewed={[]} onReviewedChange={() => {}} />);
  expect(box()).not.toBeNull();
  expect(box()!.querySelector('svg[data-drawn-overview]')).not.toBeNull();
  expect(box()!.querySelector('pre')).toBeNull();
});
