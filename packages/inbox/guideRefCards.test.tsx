/**
 * Hover cards on the links in a guided review's prose in the Inbox (GuideReader's card region), over the
 * window's own ref transport, as a message body has them. What regresses: a Linear issue link or a pull request
 * link in a chapter's prose that opens no card in the guide reader (the region missing or not around the prose).
 * The transport is a stub here (the window's is the Inbox's `/api/inbox/ref`); the Linear provider is the plain
 * one (the Inbox's own adds bare identifiers, linearCards.test.tsx).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { plugin } from 'bun';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
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
const { setRefCardTransport } = (hasDom ? await import('@plannotator/ui/utils/refCard') : {}) as typeof import('@plannotator/ui/utils/refCard');
const { registerRefCardProvider } = (hasDom ? await import('@plannotator/ui/utils/refCardProviders') : {}) as typeof import('@plannotator/ui/utils/refCardProviders');
const { linearLinkCardProvider } = (hasDom ? await import('@plannotator/ui/utils/linearLinkCards') : {}) as typeof import('@plannotator/ui/utils/linearLinkCards');

const LINEAR_URL = 'https://linear.app/acme/issue/ENG-123/retry-webhook-deliveries';
const PR_URL = 'https://github.com/acme/widgets/pull/12';

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const FIRST = 'msg_01M4H6G73M9H3Z32T859E72DPY';

const snapshot = buildGuideSnapshot({
  guide: {
    title: 'Token refresh',
    intent: 'Refresh tokens before they expire.',
    sections: [{ title: 'The guard', overview: `Where the refresh happens; tracked in [ENG-123](${LINEAR_URL}), shipped in [#12](${PR_URL}).`, diffs: [{ file: 'src/auth.ts', summary: 'Adds the refresh guard.' }] }],
  },
  reviewed: [false],
  review: { rawPatch: 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n', gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});

function messageOf(id: string): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: id,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
    subject: 'Token refresh',
    body: 'I wrote a review.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Token refresh', sections: 1, files: 1, additions: 1, deletions: 0, review: true, chapters: ['The guard'] },
  } as InboxMessageWire;
}
const threadOf = (message: InboxMessageWire): InboxThread => ({ thread_id: message.id, project: PROJECT, subject: 'Token refresh', thread_name: null, resolved_at: null, messages: [message] });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let asked: string[] = [];
let undo: (() => void)[] = [];

const LINEAR_CARD = {
  ok: true,
  fetchedAt: 0,
  data: {
    platform: 'linear', kind: 'issue', repo: 'ENG', number: 123, url: LINEAR_URL, title: 'Retry webhook deliveries', state: 'open',
    author: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', closedAt: null, labels: [], assignees: [],
    comments: 0, body: '', bodyCut: false, lastComment: null, linked: [],
    linear: { identifier: 'ENG-123', team: 'Engineering', stateName: 'In Review', stateType: 'started', stateColor: '0f783c', priority: null, project: null, estimate: null },
  },
} as unknown as ForgeRefCardResult;
const PR_CARD = {
  ok: true,
  fetchedAt: 0,
  data: {
    platform: 'github', kind: 'pull', repo: 'acme/widgets', number: 12, url: PR_URL, title: 'Ship the widget', state: 'open',
    author: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', closedAt: null, labels: [], assignees: [],
    comments: 0, body: '', bodyCut: false, lastComment: null, linked: [],
    pull: { base: 'main', head: 'widget', additions: 1, deletions: 0, files: 1, review: null, checks: null },
  },
} as unknown as ForgeRefCardResult;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  asked = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide')) return Response.json({ message_id: FIRST, guide: messageOf(FIRST).guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_review', live: true } });
    return Response.json({});
  }) as typeof fetch;
  setRefCardTransport(async (href) => {
    asked.push(href);
    return href === LINEAR_URL ? LINEAR_CARD : href === PR_URL ? PR_CARD : null;
  });
  undo = [registerRefCardProvider(linearLinkCardProvider), () => setRefCardTransport(null)];
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const step of undo.splice(0)) step();
  globalThis.fetch = savedFetch;
});

async function settle(ms = 0) {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, ms));
    });
  }
}

async function render() {
  const message = messageOf(FIRST);
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={threadOf(message)} message={message} codeReview onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />
      </div>,
    );
  });
  await settle();
}

/** Rest the pointer on the link past the card's delay, then let the answer land. */
async function hover(link: HTMLAnchorElement) {
  await act(async () => {
    link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  });
  await settle(100);
}

const linkTo = (href: string) => {
  const link = document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
  if (!link) throw new Error(`the guide's prose has no link to ${href}`);
  return link;
};

test.skipIf(!hasDom)("a Linear issue link in a guide's prose opens Linear's card", async () => {
  await render();
  await hover(linkTo(LINEAR_URL));
  expect(asked).toEqual([LINEAR_URL]);
  const card = document.querySelector<HTMLElement>('[data-ref-card]');
  expect(card?.textContent).toContain('Retry webhook deliveries');
  expect(card?.getAttribute('aria-label')).toContain('Linear issue ENG-123');
});

test.skipIf(!hasDom)("a pull request link in a guide's prose opens its card", async () => {
  await render();
  await hover(linkTo(PR_URL));
  expect(asked).toEqual([PR_URL]);
  expect(document.querySelector<HTMLElement>('[data-ref-card]')?.textContent).toContain('Ship the widget');
});
