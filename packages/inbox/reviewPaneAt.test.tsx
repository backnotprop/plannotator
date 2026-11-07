/**
 * The review opened from a Shape board at a place (ReviewPane with Code review on, GuidePane without it) (approval "shape-whats-changed": `#thread=…&guide=…&code=…`,
 * `&step=N`, `&files`). The Inbox's doors are stubbed at `fetch` and the diff reader is stubbed to record what it is
 * told. What regresses:
 *  - a board's `file:line` opens the review at its top, not at that file with the lines painted;
 *  - a guide step opens a chapter other than that step's, or Full review opens the walkthrough;
 *  - the place is not let go once there (a reload would jump again), or is let go before the review is read.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeReviewAt } from '@plannotator/ui/components/shape/types';

type ReaderProps = { mode?: string; reveal?: { path: string } | null; highlight?: { path: string; start: number; end: number } | null };
let reader: ReaderProps | null = null;
const hasDom = typeof document !== 'undefined';
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: ReaderProps) => {
      reader = props;
      return null;
    },
  }));
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const { GuidePane } = (hasDom ? await import('./components/GuidePane') : {}) as typeof import('./components/GuidePane');

const PROJECT: InboxProject = { id: 'prj_1', key: 'kettle-abcdef', name: 'kettle', root: '/work/kettle', created_at: '2026-11-05T10:00:00.000Z' };
const REVIEW = 'msg_01M4H6G73M9H3Z32T859E7KETL';
const patch = ['src/kettle.ts', 'src/settings.ts', 'src/timer.ts'].map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n`).join('');
const snapshot = buildGuideSnapshot({
  guide: {
    title: 'Kettle',
    intent: 'One whistle.',
    sections: [
      { title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts', summary: '' }] },
      { title: 'The setting', overview: '', diffs: [{ file: 'src/settings.ts', summary: '' }] },
    ],
  },
  reviewed: [false, false],
  review: { rawPatch: patch, gitRef: 'main...HEAD', source: { kind: 'local' } },
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
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Kettle', sections: 2, files: 3, additions: 3, deletions: 3, review: true, chapters: ['The whistle', 'The setting'] },
} as InboxMessageWire;
const thread: InboxThread = { thread_id: REVIEW, project: PROJECT, subject: 'Kettle', thread_name: null, resolved_at: null, messages: [message] };

let root: Root | null = null;
let el: HTMLElement | null = null;
let savedFetch: typeof fetch;
beforeEach(() => {
  if (!hasDom) return;
  reader = null;
  savedFetch = globalThis.fetch;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide')) return Response.json({ message_id: REVIEW, guide: message.guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_review', live: true } });
    return Response.json({});
  }) as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  globalThis.fetch = savedFetch;
});

async function open(at: ShapeReviewAt | null, pane: 'review' | 'guide' = 'review'): Promise<{ landed: () => number }> {
  let landed = 0;
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(
      <div className="pn-inbox">
        {pane === 'review' ? (
          <ReviewPane thread={thread} message={message} onBack={() => {}} onClose={() => {}} onSent={() => {}} at={at} onLanded={() => (landed += 1)} />
        ) : (
          <GuidePane thread={thread} message={message} onBack={() => {}} onClose={() => {}} at={at} onLanded={() => (landed += 1)} />
        )}
      </div>,
    );
  });
  for (let i = 0; i < 6; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  return { landed: () => landed };
}
const chapterName = () => document.querySelector('[data-review-jump]')?.textContent ?? '';

test.skipIf(!hasDom)("a board's file:line opens the review at that file's chapter, the line painted, and lets the place go", async () => {
  const { landed } = await open({ path: 'src/settings.ts', line: 2 });
  expect(reader?.mode).toBe('walkthrough');
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(reader?.highlight).toMatchObject({ path: 'src/settings.ts', start: 2, end: 2 });
  expect(chapterName()).toContain('The setting');
  expect(landed()).toBe(1);
});

test.skipIf(!hasDom)('a file no chapter holds opens in All files', async () => {
  await open({ path: 'src/timer.ts', line: 1 });
  expect(reader?.mode).toBe('files');
  expect(reader?.reveal?.path).toBe('src/timer.ts');
});

test.skipIf(!hasDom)("a guide step opens that step's chapter", async () => {
  await open({ step: 2 });
  expect(reader?.mode).toBe('walkthrough');
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(chapterName()).toContain('The setting');
});

test.skipIf(!hasDom)('Full review opens All files; Guided review opens the walkthrough at its top', async () => {
  const full = await open({ files: true });
  expect(reader?.mode).toBe('files');
  expect(full.landed()).toBe(1);
  act(() => root?.unmount());
  el?.remove();
  const guided = await open(null);
  expect(reader?.mode).toBe('walkthrough');
  expect(reader?.reveal ?? null).toBeNull();
  expect(reader?.highlight ?? null).toBeNull();
  // Nothing to let go.
  expect(guided.landed()).toBe(0);
});

test.skipIf(!hasDom)('with Code review off, the guide opens at the file with the line painted, or at a step\'s first file', async () => {
  const line = await open({ path: 'src/settings.ts', line: 2 }, 'guide');
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(reader?.highlight).toMatchObject({ path: 'src/settings.ts', start: 2, end: 2 });
  expect(line.landed()).toBe(1);
  act(() => root?.unmount());
  el?.remove();
  await open({ step: 2 }, 'guide');
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(reader?.highlight ?? null).toBeNull();
});
