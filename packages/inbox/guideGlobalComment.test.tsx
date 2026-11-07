/**
 * A global comment (on the whole review, not a line or a file) in the Inbox's
 * guide reader, driven from its own "Global comment" button through the
 * composer to the store, with the Inbox's doors stubbed at `fetch`. The
 * full-window review is the pane (its comments panel is folded into a sheet
 * when unmeasured, as on a narrow pane). What regresses:
 *
 *  - the button saving something other than the review app's general comment
 *    (scope "general", no file, no lines);
 *  - a refused save losing the words typed (the composer clears its draft on
 *    submit);
 *  - one unsaved draft shared by two messages that carry the same guide;
 *  - a global comment chosen in the guide doing nothing visible on a narrow
 *    pane (the comments, with its edit and delete, are in the folded sheet).
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

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const FIRST = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const SECOND = 'msg_01M4H6G73M9H3Z32T859E72DPZ';

const snapshot = buildGuideSnapshot({
  guide: {
    title: 'Token refresh',
    intent: 'Refresh tokens before they expire.',
    sections: [{ title: 'The guard', overview: 'Where the refresh happens.', diffs: [{ file: 'src/auth.ts', summary: 'Adds the refresh guard.' }] }],
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
/** Every annotation the window asked the store to keep. */
let saves: Record<string, unknown>[] = [];
let refuse = false;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  saves = [];
  refuse = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST' && path.includes('/guide/annotations')) {
      const annotation = (JSON.parse(String(init.body)) as { annotation: Record<string, unknown> }).annotation;
      saves.push(annotation);
      if (refuse) return Response.json({ code: 'validation_error', error: 'annotation.text: the comment (1 to 10000 characters).' }, { status: 422 });
      const messageId = /messages\/([^/]+)\/guide/.exec(path)![1]!;
      return Response.json({
        annotation: {
          id: annotation.id, project_id: PROJECT.id, thread_id: messageId, message_id: messageId, attachment_id: '', path: '', version: 'a',
          guide: { title: 'Token refresh', file: '', side: 'new', line_start: 0, line_end: 0, scope: 'general' },
          annotation, created_at: '2026-10-11T10:45:00.000Z', updated_at: '2026-10-11T10:45:00.000Z', removed_at: null, sent_reply_id: null,
        },
      });
    }
    if (init?.method === 'POST') return Response.json({});
    if (path.includes('/guide')) return Response.json({ message_id: FIRST, guide: messageOf(FIRST).guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_review', live: true } });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  unmount();
  globalThis.fetch = savedFetch;
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function render(id: string) {
  const message = messageOf(id);
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={threadOf(message)} message={message} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />
      </div>,
    );
  });
  await settle();
}

const composer = () => document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Add a global comment..."]');

async function openComposer() {
  const button = document.querySelector<HTMLButtonElement>('[data-guide-global-comment-add]');
  if (!button) throw new Error('no Global comment button');
  await act(async () => button.click());
  await settle();
  const field = composer();
  if (!field) throw new Error('the composer did not open');
  return field;
}

async function type(field: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  setter?.call(field, text);
  await act(async () => field.dispatchEvent(new Event('input', { bubbles: true })));
}

async function add() {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Add');
  if (!button) throw new Error('no Add button');
  await act(async () => button.click());
  await settle();
}

test.skipIf(!hasDom)('the button saves a global comment; a refused save keeps the words for the next open', async () => {
  await render(FIRST);

  refuse = true;
  await type(await openComposer(), 'Split the guard and the retry into two PRs.');
  await add();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, text: 'Split the guard and the retry into two PRs.' });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('10000');
  expect(composer()).toBeNull();

  // Refused: the words are back when the composer opens again, and go on the next Add.
  refuse = false;
  const again = await openComposer();
  expect(again.value).toBe('Split the guard and the retry into two PRs.');
  await add();
  expect(saves).toHaveLength(2);
  expect(document.querySelector('[data-guide-global-comments]')?.getAttribute('data-guide-global-comments')).toBe('1');
  // Saved: the draft is gone.
  expect((await openComposer()).value).toBe('');
});

test.skipIf(!hasDom)('an unsaved draft belongs to its message, not to the guide it carries', async () => {
  await render(FIRST);
  await type(await openComposer(), 'Only for the first thread.');
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close"], [title="Close (Esc)"], [title="Close"]');
  if (close) await act(async () => close.click());
  else await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  unmount();

  // The same guide, sent in another thread: its composer opens empty.
  await render(SECOND);
  expect((await openComposer()).value).toBe('');
  unmount();
  await render(FIRST);
  expect((await openComposer()).value).toBe('Only for the first thread.');
});

test.skipIf(!hasDom)('a global comment chosen in the guide opens the folded comments sheet on it', async () => {
  await render(FIRST);
  await type(await openComposer(), 'Ship the retry behind a flag.');
  await add();
  const sheet = document.querySelector<HTMLButtonElement>('[data-guide-comments-sheet]');
  expect(sheet?.getAttribute('aria-expanded')).toBe('false');
  const item = document.querySelector<HTMLButtonElement>('[data-guide-global-comment] button');
  if (!item) throw new Error('the global comment is not listed');
  await act(async () => item.click());
  await settle();
  expect(document.querySelector('[data-guide-comments-sheet]')?.getAttribute('aria-expanded')).toBe('true');
  expect(item.getAttribute('aria-current')).toBe('true');
});
