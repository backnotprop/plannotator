import { afterEach, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapes } from './shape/useInboxShapes';
import type { BoardPlaces } from './shape/boardPlace';
import type { ShapeBoardPlace, ShapeBoardProps } from './shape/types';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  mock.module('#guide-reader', () => ({ default: () => null }));
  mock.module('#shape-board', () => ({
    default: ({ initialView, initialPanel, onNavigate }: ShapeBoardProps) => {
      const [view, setView] = useState(initialView ?? 'picture');
      const [panel] = useState(initialPanel ?? null);
      return (
        <div data-stub-board data-view={view} data-panel={panel ?? ''}>
          <button type="button" data-to-how onClick={() => { setView('how'); onNavigate?.({ view: 'how', panel }); }} />
        </div>
      );
    },
  }));
}
const { useBoardPlaces } = (hasDom ? await import('./shape/boardPlace') : {}) as typeof import('./shape/boardPlace');
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
  if (savedFetch) globalThis.fetch = savedFetch;
  savedFetch = null;
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
};
function mount(node: React.ReactNode) {
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(node);
  });
}

test.skipIf(!hasDom)("a link keeps the board's view and panel until the board closes; another board's place is not kept", () => {
  let places: BoardPlaces | null = null;
  let setOpen: (id: string | null) => void = () => {};
  function Harness() {
    const [open, set] = useState<string | null>('shp_a');
    setOpen = set;
    places = useBoardPlaces(open);
    return null;
  }
  mount(<Harness />);
  const p = () => places!;
  const changed: ShapeBoardPlace = { view: 'changed', panel: 'refs' };
  act(() => p().moved('shp_a', { view: 'picture', panel: null }));
  expect(p().placeOf('shp_a')).toBeNull();
  act(() => p().moved('shp_a', changed));
  act(() => p().leave('shp_a'));
  expect(p().placeOf('shp_a')).toEqual(changed);
  expect(p().placeOf('shp_b')).toBeNull();
  act(() => p().moved('shp_a', { view: 'know', panel: null }));
  expect(p().placeOf('shp_a')).toEqual({ view: 'know', panel: null });
  act(() => setOpen(null));
  expect(p().placeOf('shp_a')).toBeNull();
  act(() => setOpen('shp_b'));
  act(() => p().leave('shp_b'));
  expect(p().placeOf('shp_b')).toBeNull();
});

const PROJECT: InboxProject = { id: 'prj_1', key: 'kettle-abcdef', name: 'kettle', root: '/work/kettle', created_at: '2026-11-05T10:00:00.000Z' };
const REVIEW = 'msg_01M4H6G73M9H3Z32T859E7KETL';
const snapshot = buildGuideSnapshot({
  guide: { title: 'Kettle', intent: 'One whistle.', sections: [{ title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts', summary: '' }] }] },
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

test.skipIf(!hasDom)("Grow from the corner card shows the board on the view and panel the link left it on", async () => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide')) return Response.json({ message_id: REVIEW, guide: message.guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_review', live: true } });
    return Response.json({});
  }) as typeof fetch;
  const moves: ShapeBoardPlace[] = [];
  mount(
    <div className="pn-inbox">
      <ReviewPane
        thread={thread}
        message={message}
        codeReview
        shape
        onBack={() => {}}
        onClose={() => {}}
        onSent={() => {}}
        shapeHost={{} as ShapeHost}
        shapes={NO_BOARDS}
        board="shp_a"
        onBoard={() => {}}
        boardShrunk
        boardPlace={{ view: 'changed', panel: 'refs' }}
        onBoardNavigate={(place) => moves.push(place)}
        at={{ path: 'src/kettle.ts', line: 1 }}
      />
    </div>,
  );
  await settle();
  const layer = () => document.querySelector<HTMLElement>('[data-shape-layer="shp_a"]')!;
  expect(document.querySelector('[data-show-me-corner]')).not.toBeNull();
  expect(layer().hidden).toBe(true);
  act(() => document.querySelector<HTMLButtonElement>('[data-show-me-corner] [aria-label="Grow the board"]')!.click());
  await settle();
  expect(document.querySelector('[data-show-me-corner]')).toBeNull();
  expect(layer().hidden).toBe(false);
  const board = layer().querySelector<HTMLElement>('[data-stub-board]')!;
  expect(board.dataset.view).toBe('changed');
  expect(board.dataset.panel).toBe('refs');
  act(() => board.querySelector<HTMLButtonElement>('[data-to-how]')!.click());
  expect(moves.at(-1)).toEqual({ view: 'how', panel: 'refs' });
});
