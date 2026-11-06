/**
 * One review screen (approval "inbox-one-review-screen"): every guide or
 * review an agent sends opens the full-window review, whatever Settings →
 * Capabilities → Code review says. What regresses:
 *
 *  - a guide (no `review: true`) or a review with Code review off offering
 *    Approve or Send feedback: there is no verdict the agent waits for, and
 *    the server refuses `review_verdict` while Code review is off;
 *  - Code review's own parts (Viewed ticks, Show me and Ask on selected lines,
 *    Open in, the live-session reads behind a verdict) showing, or asking the
 *    server, with Code review off;
 *  - a guide's comments sent, dropped or marked sent by the review itself:
 *    they wait for the person's next Send from the thread, which carries them
 *    as before ("Feedback on the guided review" in the reply to the guide).
 *
 * The diff reader is stubbed to read the props the review hands it.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxAnnotationRecord, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
/** The props the review handed the reader on its last draw. */
let readerProps: Record<string, unknown> | null = null;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: Record<string, unknown>) => {
      readerProps = props;
      return null;
    },
  }));
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const { routeSendAnnotations, sendTargetsOf } = (hasDom ? await import('./sendTargets') : {}) as typeof import('./sendTargets');
const { attachmentFeedback } = (hasDom ? await import('./attachments') : {}) as typeof import('./attachments');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const GUIDE = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const PATCH = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n';
const snapshot = buildGuideSnapshot({
  guide: { title: 'Token refresh', intent: 'Refresh tokens before they expire.', sections: [{ title: 'The guard', overview: 'Where.', diffs: [{ file: 'src/auth.ts', summary: 'Adds the guard.' }] }] },
  reviewed: [false],
  review: { rawPatch: PATCH, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});
const GUIDE_META = { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Token refresh', sections: 1, files: 1, additions: 1, deletions: 1 };
const messageOf = (review: boolean): InboxMessageWire =>
  ({
    id: GUIDE,
    project_id: PROJECT.id,
    thread_id: GUIDE,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    subject: 'Token refresh',
    body: 'A guided review.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    guide: review ? { ...GUIDE_META, review: true, chapters: ['The guard'] } : GUIDE_META,
  }) as InboxMessageWire;
const threadOf = (message: InboxMessageWire): InboxThread => ({ thread_id: GUIDE, project: PROJECT, subject: 'Token refresh', thread_name: null, resolved_at: null, messages: [message] });

const commentRecord = (id: string, text: string): InboxAnnotationRecord =>
  ({
    id, project_id: PROJECT.id, thread_id: GUIDE, message_id: GUIDE, attachment_id: '', path: 'src/auth.ts', version: 'a',
    guide: { title: 'Token refresh', file: 'src/auth.ts', side: 'new', line_start: 1, line_end: 1 },
    annotation: { id, type: 'comment', scope: 'line', filePath: 'src/auth.ts', lineStart: 1, lineEnd: 1, side: 'new', text, createdAt: 1 },
    created_at: '2026-10-11T10:45:00.000Z', updated_at: '2026-10-11T10:45:00.000Z', removed_at: null, sent_reply_id: null,
  }) as unknown as InboxAnnotationRecord;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** Every request the review made, as `METHOD path`. */
let asked: string[] = [];
let annotations: InboxAnnotationRecord[] = [];
let writeReplies = 0;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  asked = [];
  annotations = [];
  writeReplies = 0;
  readerProps = null;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    asked.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST') return Response.json({ reply: {}, questions: [], replayed: false });
    if (path.includes('/guide')) return Response.json({ message_id: GUIDE, guide: GUIDE_META, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_a', live: true } });
    if (path.includes('/ask')) return Response.json({ subject: 'Token refresh', project: PROJECT.name, conversation: null, running: null, can_ask: true, agent: 'Claude Code' });
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

async function render(review: boolean, codeReview: boolean) {
  const message = messageOf(review);
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane
          thread={threadOf(message)}
          message={message}
          codeReview={codeReview}
          onBack={() => {}}
          onClose={() => {}}
          onSent={() => {}}
          onAsk={() => {}}
          onWriteReply={() => (writeReplies += 1)}
        />
      </div>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const pane = () => document.querySelector<HTMLElement>('section[aria-label="Review"][data-review-message]');
/** Booleans, not elements: a failed check on an element prints the whole DOM tree. */
const has = (selector: string) => document.querySelector(selector) !== null;

test.skipIf(!hasDom)('a guide (no review flag) opens the full review: Walkthrough | All files, the chapter menu, and no Approve', async () => {
  await render(false, true);
  expect(pane() !== null).toBe(true);
  expect(has('[data-review-mode-choice="walkthrough"]')).toBe(true);
  expect(has('[data-review-mode-choice="files"]')).toBe(true);
  expect(has('[data-review-jump]')).toBe(true);
  expect(readerProps !== null).toBe(true);
  // No verdict: no decision control, no Approve, no Send feedback.
  expect(has('[data-review-decision]')).toBe(false);
  expect(has('[data-decision-primary]')).toBe(false);
  expect(pane()!.textContent).not.toContain('Approve');
  // The way out with the comments: back to the thread's reply box.
  expect(document.querySelector('[data-review-write-reply]')?.textContent).toContain('Write the reply');
  // Not Code review's review, even with it on: no Viewed ticks, no Show me (the server keeps both for reviews only).
  expect(readerProps!.viewed).toBeUndefined();
  expect(readerProps!.selectionActions).toBeUndefined();
  // Open in follows the switch alone, as it did on a guide.
  expect(typeof readerProps!.fileOpenIn).toBe('function');
});

test.skipIf(!hasDom)('Code review off: a review opens the full review with none of Code review: no verdict, Viewed, Show me, Ask or Open in, and nothing asked of its routes', async () => {
  await render(true, false);
  expect(pane() !== null).toBe(true);
  expect(has('[data-review-mode-choice="files"]')).toBe(true);
  expect(has('[data-review-decision]')).toBe(false);
  expect(has('[data-decision-primary]')).toBe(false);
  expect(has('[data-review-write-reply]')).toBe(true);
  expect(readerProps!.viewed).toBeUndefined();
  expect(readerProps!.selectionActions).toBeUndefined();
  expect(readerProps!.fileOpenIn).toBeUndefined();
  // The heading's Show me (the host's head actions) draws nothing.
  expect((readerProps!.renderHeadActions as () => unknown)()).toBeNull();
  // Only the guide and its comments were read: no Ask, drawings, live sessions or pull requests.
  expect(asked.filter((line) => !/\/guide$|\/guide\?|\/attachments/.test(line))).toEqual([]);
});

test.skipIf(!hasDom)('with Code review on, the same review keeps its verdict and Viewed ticks (the control for the two above)', async () => {
  await render(true, true);
  expect(document.querySelector('[data-review-decision] [data-decision-primary]')?.textContent).toContain('Approve');
  expect(has('[data-review-write-reply]')).toBe(false);
  expect(readerProps!.viewed).toBeDefined();
});

test.skipIf(!hasDom)("a guide's comments wait for the next Send: the panel says so, Write the reply goes back to the thread, and the review sends nothing", async () => {
  annotations = [commentRecord('ann-1', 'Name the retry limit.'), commentRecord('ann-2', 'Log the expiry.')];
  await render(false, true);
  const rides = document.querySelector('[data-review-rides]');
  expect(rides?.textContent).toBe('2 comments ride your next Send to Claude Code.');
  expect(document.querySelector('[data-guide-comments]')?.getAttribute('data-guide-comments')).toBe('2');
  await act(async () => document.querySelector<HTMLElement>('[data-review-write-reply]')!.click());
  expect(writeReplies).toBe(1);
  // Nothing written by the review: no reply, no removal, no verdict.
  expect(asked.filter((line) => line.startsWith('POST'))).toEqual([]);

  // The thread's Send carries them on its reply to the guide, as the review app's export.
  const thread = threadOf(messageOf(false));
  const { carried } = routeSendAnnotations(thread, sendTargetsOf(thread), annotations);
  expect(carried.get(GUIDE)?.map((r) => r.id)).toEqual(['ann-1', 'ann-2']);
  const feedback = attachmentFeedback(carried.get(GUIDE)!, [], new Map(), PROJECT.root, {});
  expect(feedback).toContain('# Feedback on the guided review');
  expect(feedback).toContain('Name the retry limit.');
  expect(feedback).toContain('Log the expiry.');
});

test.skipIf(!hasDom)('one comment rides (the singular), and a resolved thread reads with no way to reply from the review', async () => {
  annotations = [commentRecord('ann-1', 'Name the retry limit.')];
  await render(false, false);
  expect(document.querySelector('[data-review-rides]')?.textContent).toBe('1 comment rides your next Send to Claude Code.');
  act(() => root?.unmount());
  host?.remove();
  const message = { ...messageOf(false), resolved_at: '2026-10-11T11:00:00.000Z' };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={{ ...threadOf(message), resolved_at: '2026-10-11T11:00:00.000Z' }} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} onWriteReply={() => (writeReplies += 1)} />
      </div>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(pane() !== null).toBe(true);
  expect(has('[data-review-write-reply]')).toBe(false);
  expect(has('[data-review-rides]')).toBe(false);
});
