/**
 * Code review ships with Shape off (approval "code-review-029-shape-off"): every Shape piece in a review rides Shape's
 * own switch, not Code review's. What regresses:
 *  - Code review on, Shape off: the selection bar offers Show me, the review's heading has its Show me, the Overview
 *    draws its picture (or says there is one it does not draw), or a board opens over the review;
 *  - Code review and Shape on: any of these missing (as before the switch split).
 *
 * The diff reader is stubbed: it records what the review hands it (the selection actions, the snapshot, the
 * Overview's renderer, the heading's actions) and draws only the last two. The board is stubbed too.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapes } from './shape/useInboxShapes';
import type { GuideReaderProps } from './guide/types';

const hasDom = typeof document !== 'undefined';
let reader: GuideReaderProps | null = null;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: GuideReaderProps) => {
      reader = props;
      const diagram = props.snapshot.guide.overview?.diagram;
      return (
        <div data-stub-reader>
          <div data-stub-head>{props.renderHeadActions?.()}</div>
          {diagram && <div data-stub-overview>{props.renderOverviewDiagram?.(diagram) ?? <p data-stub-viewer-note />}</div>}
        </div>
      );
    },
  }));
  mock.module('#shape-board', () => ({ default: () => <div data-stub-board /> }));
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');

let root: Root | null = null;
let el: HTMLElement | null = null;
let savedFetch: typeof fetch | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  reader = null;
  if (savedFetch) globalThis.fetch = savedFetch;
  savedFetch = null;
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
};

const PROJECT: InboxProject = { id: 'prj_1', key: 'kettle-abcdef', name: 'kettle', root: '/work/kettle', created_at: '2026-11-05T10:00:00.000Z' };
const REVIEW = 'msg_01M4H6G73M9H3Z32T859E7KETL';
/** A drawn Overview picture (snapshot version 3: it has a width and height). */
const DRAWN: GuideOverviewDiagram = { kind: 'html', source: '<div data-mark="whistle" data-code="src/kettle.ts#L1">The whistle</div>', width: 800, height: 360 };
const snapshotWith = (diagram?: GuideOverviewDiagram): GuideSnapshot =>
  buildGuideSnapshot({
    guide: {
      title: 'Kettle',
      intent: 'One whistle.',
      overview: { text: 'The kettle whistles once.', ...(diagram ? { diagram } : {}) },
      sections: [{ title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts', summary: '' }] }],
    },
    reviewed: [false],
    review: { rawPatch: 'diff --git a/src/kettle.ts b/src/kettle.ts\n--- a/src/kettle.ts\n+++ b/src/kettle.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n', gitRef: 'main...HEAD', source: { kind: 'local' } },
    exportedAt: '2026-11-05T10:40:00.000Z',
  });
const message = {
  id: REVIEW,
  project_id: PROJECT.id,
  thread_id: REVIEW,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
  subject: 'Kettle',
  body: 'I wrote a review.',
  created_at: '2026-11-05T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Kettle', sections: 1, files: 1, additions: 1, deletions: 1, review: true, chapters: ['The whistle'] },
} as InboxMessageWire;
const thread: InboxThread = { thread_id: REVIEW, project: PROJECT, subject: 'Kettle', thread_name: null, resolved_at: null, messages: [message] };
const NO_BOARDS: InboxShapes = { shapes: null, byThread: new Map(), changed: 0, rowShown: false, subscribe: () => () => {}, refresh: () => {} };

/** The review, Code review on, its agent live (it can take a question), with `shape` as given. */
async function openReview({ shape, diagram, board = null }: { shape: boolean; diagram?: GuideOverviewDiagram; board?: string | null }) {
  const snapshot = snapshotWith(diagram);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]!;
    if (path.endsWith('/ask')) return Response.json({ subject: 'Kettle', project: PROJECT.name, conversation: null, running: null, can_ask: true, agent: { name: 'Claude Code' } });
    if (path.includes('/guide')) return Response.json({ message_id: REVIEW, guide: message.guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_review', live: true } });
    return Response.json({});
  }) as typeof fetch;
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane
          thread={thread}
          message={message}
          codeReview
          shape={shape}
          onBack={() => {}}
          onClose={() => {}}
          onSent={() => {}}
          onAsk={() => {}}
          shapeHost={{} as ShapeHost}
          shapes={NO_BOARDS}
          board={board}
          onBoard={() => {}}
        />
      </div>,
    );
  });
  await settle();
  expect(reader).not.toBeNull();
  return reader!;
}

const showMeButton = () => document.querySelector('[data-overview-show-me-button]');

test.skipIf(!hasDom)('Code review on, Shape off: selected lines offer Comment and Ask, and the heading has no Show me', async () => {
  const props = await openReview({ shape: false });
  expect(props.selectionActions?.onAsk).toBeFunction();
  expect(props.selectionActions?.onShowMe).toBeUndefined();
  expect(showMeButton()).toBeNull();
});

test.skipIf(!hasDom)("Code review on, Shape off: a drawn Overview picture is neither drawn nor noted, and no board opens over the review", async () => {
  const props = await openReview({ shape: false, diagram: DRAWN, board: 'shp_a' });
  // The picture is left out of what the reader draws (no "custom picture" note in its place); the words stay.
  expect(props.snapshot.guide.overview?.text).toBe('The kettle whistles once.');
  expect(props.snapshot.guide.overview?.diagram).toBeUndefined();
  expect(document.querySelector('[data-stub-overview]')).toBeNull();
  expect(document.querySelector('[data-overview-figure]')).toBeNull();
  expect(document.querySelector('[data-shape-layer]')).toBeNull();
  expect(document.querySelector('[data-stub-board]')).toBeNull();
});

test.skipIf(!hasDom)('Code review and Shape on: Show me on selected lines and in the heading, as before', async () => {
  const props = await openReview({ shape: true });
  expect(props.selectionActions?.onAsk).toBeFunction();
  expect(props.selectionActions?.onShowMe).toBeFunction();
  expect(showMeButton()).not.toBeNull();
});

test.skipIf(!hasDom)('Code review and Shape on: the drawn Overview picture is drawn, and the board opens over the review', async () => {
  const props = await openReview({ shape: true, diagram: DRAWN, board: 'shp_a' });
  expect(props.snapshot.guide.overview?.diagram).toEqual(DRAWN);
  expect(document.querySelector('[data-overview-figure]')).not.toBeNull();
  expect(document.querySelector('[data-shape-layer="shp_a"]')).not.toBeNull();
});

test.skipIf(!hasDom)("a chapter's drawn html picture is drawn only with Shape on; with Shape off the chapter shows as with no diagram", async () => {
  // Shape off: the pane draws none (null), so the guide chain shows the chapter as without a diagram.
  const off = await openReview({ shape: false });
  const offDrawn = off.renderChapterDiagram?.(DRAWN, 0) ?? null;
  expect(offDrawn).toBeNull();
  act(() => root?.unmount());
  el?.remove();
  root = null;
  if (savedFetch) globalThis.fetch = savedFetch;
  savedFetch = null;
  // Shape on: the capped ChapterFigure.
  const on = await openReview({ shape: true });
  const drawn = on.renderChapterDiagram?.(DRAWN, 0) ?? null;
  expect(drawn).not.toBeNull();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  act(() => r.render(<>{drawn}</>));
  expect(host.querySelector('[data-chapter-figure] .ib-ch-fig-box')).not.toBeNull();
  act(() => r.unmount());
  host.remove();
});
