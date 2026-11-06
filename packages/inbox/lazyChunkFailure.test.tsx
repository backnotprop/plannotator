/**
 * The guided review's reader is a chunk the Inbox serves on first use
 * (build/pack-inbox.ts, #2593). When it cannot arrive (the Inbox stopped, or
 * restarted onto a new release under the open page, whose chunk names are
 * gone), React.lazy throws. What regresses without the pane's boundary: React
 * unmounts the whole window, the list and anything the person was writing
 * with it, leaving a blank page.
 *
 * The reader's module is made to fail as a missing chunk does; the rest of
 * the window is a sentinel beside the pane.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  mock.module('#guide-reader', () => {
    throw new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/GuideReader-gone.js');
  });
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const GUIDE = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const snapshot = buildGuideSnapshot({
  guide: { title: 'Token refresh', intent: 'Refresh tokens.', sections: [{ title: 'The guard', overview: 'Where.', diffs: [{ file: 'src/auth.ts', summary: 'Adds the guard.' }] }] },
  reviewed: [false],
  review: { rawPatch: 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n', gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});
const message = {
  id: GUIDE,
  project_id: PROJECT.id,
  thread_id: GUIDE,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
  subject: 'Token refresh',
  body: 'A guide.',
  created_at: '2026-10-11T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Token refresh', sections: 1, files: 1, additions: 1, deletions: 1 },
} as InboxMessageWire;
const thread: InboxThread = { thread_id: GUIDE, project: PROJECT, subject: 'Token refresh', thread_name: null, resolved_at: null, messages: [message] };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide')) return Response.json({ message_id: GUIDE, guide: message.guide, snapshot });
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

test.skipIf(!hasDom)("a reader chunk that cannot load says so in the pane, with Reload, and the window stays mounted", async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  const silence = console.error;
  console.error = () => {};
  try {
    act(() => {
      root = createRoot(host!);
      root.render(
        <div className="pn-inbox">
          <p data-window-sentinel="">the rest of the window</p>
          <ReviewPane thread={thread} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} />
        </div>,
      );
    });
    for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  } finally {
    console.error = silence;
  }
  expect(document.querySelector('[data-window-sentinel]')).not.toBeNull();
  const pane = document.querySelector('section[aria-label="Review"]');
  expect(pane).not.toBeNull();
  // ui's LazyLoadNotice: why the reader is missing, and Reload.
  const notice = pane!.querySelector('[data-lazy-load-failed]');
  expect(notice).not.toBeNull();
  expect(notice!.querySelector('button')).not.toBeNull();
});
