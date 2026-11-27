/**
 * The review draws nothing of Shape (it was removed; the review stays as it shipped with Shape off). What regresses:
 *  - selected lines offering more than Comment · Ask (a Show me), or the heading a Show me;
 *  - a drawn (version-3) Overview picture drawn, or a note left in its place;
 *  - a chapter's html picture drawn by the pane (the reader's own Mermaid is the only chapter diagram);
 *  - a board or any Shape word over or in the review.
 *
 * The diff reader is stubbed: it records what the review hands it and draws the heading's actions and the Overview.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { GuideReaderProps } from './guide/types';

const hasDom = typeof document !== 'undefined';
let reader: GuideReaderProps | null = null;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    PullChangesTree: () => null,
    default: (props: GuideReaderProps) => {
      reader = props;
      const diagram = props.snapshot.guide.overview?.diagram;
      return (
        <div data-stub-reader>
          <div data-stub-head>{props.renderHeadActions?.()}</div>
          {diagram && <div data-stub-overview />}
        </div>
      );
    },
  }));
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
/** A drawn Overview picture (snapshot version 3: it has a width and height), and a chapter's html picture. */
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

/** The review, Code review on, its agent live (it can take a question). Every route it asks is kept. */
async function openReview(diagram?: GuideOverviewDiagram): Promise<{ props: GuideReaderProps; asked: string[] }> {
  const snapshot = snapshotWith(diagram);
  const asked: string[] = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]!;
    asked.push(path);
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
        <ReviewPane thread={thread} message={message} codeReview onBack={() => {}} onClose={() => {}} onSent={() => {}} onAsk={() => {}} />
      </div>,
    );
  });
  // Until the reader draws: the first open in a file waits for its chunk (a cold import).
  for (let i = 0; i < 200 && reader === null; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  await settle();
  expect(reader).not.toBeNull();
  return { props: reader!, asked };
}

test.skipIf(!hasDom)('selected lines offer Comment · Ask only, and the heading has no Show me', async () => {
  const { props } = await openReview();
  // Ask waits for the agent's read: it can take a question now.
  expect(props.selectionActions?.onAsk).toBeFunction();
  expect(Object.keys(props.selectionActions ?? {})).toEqual(['onAsk']);
  expect(document.querySelector('[data-overview-show-me-button]')).toBeNull();
  expect(document.querySelector('[data-stub-head]')!.childElementCount).toBe(0);
});

test.skipIf(!hasDom)('a drawn Overview picture is left out with no note; chapter pictures are the reader\'s own; no board and no Shape words', async () => {
  const { props, asked } = await openReview(DRAWN);
  expect(props.snapshot.guide.overview?.text).toBe('The kettle whistles once.');
  expect(props.snapshot.guide.overview?.diagram).toBeUndefined();
  expect(document.querySelector('[data-stub-overview]')).toBeNull();
  expect(document.querySelector('[data-overview-figure]')).toBeNull();
  // The pane draws no picture of its own: the reader shows a chapter's Mermaid, or the chapter as without a diagram.
  expect(props.renderOverviewDiagram).toBeUndefined();
  expect(props.renderChapterDiagram).toBeUndefined();
  expect(document.querySelector('[data-shape-layer], [data-chapter-figure], [data-review-narrow]')).toBeNull();
  const words = document.body.textContent ?? '';
  for (const word of ['Show me', 'Shape', 'board', 'picture']) expect(words).not.toContain(word);
  expect(asked.filter((path) => path.includes('/shapes'))).toEqual([]);
});
